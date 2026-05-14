import type {
	V1ContainerState,
	V1ContainerStatus,
	V1Pod,
	V1PodCondition,
	V1PodStatus,
} from "../../../client";
import type { Clock } from "../../../clock";
import { retryConflicts } from "../../../retry-update";
import * as podutil from "../../pod-util";
import { type ContainerID, parseContainerID } from "../container";
import type { PodStore } from "../../storage";
import { generateContainersReadyCondition, generatePodReadyCondition } from "./generate";

export interface StatusManagerOptions {
	clock: Clock;
	pods: PodStore;
}

// Models kubernetes/pkg/kubelet/status/status_manager.go manager.
export class StatusManager {
	private readonly podStatuses = new Map<string, V1PodStatus>();
	private readonly lastStatusJson = new Map<string, string>();

	constructor(private readonly options: StatusManagerOptions) {}

	// Models kubernetes/pkg/kubelet/status/status_manager.go SetPodStatus.
	async setPodStatus(pod: V1Pod, status: V1PodStatus): Promise<[V1PodStatus, boolean]> {
		status = this.copyPodStatus(status);
		status.observedGeneration = pod.metadata?.generation ?? status.observedGeneration;

		const changed = await this.updateStatusInternal(
			pod,
			status,
			pod.metadata?.deletionTimestamp !== undefined,
			false,
		);
		return [this.podStatuses.get(podStatusKey(pod)) ?? status, changed];
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go GetPodStatus.
	getPodStatus(podUid: string): V1PodStatus | undefined {
		const status = this.podStatuses.get(podUid);
		if (!status) {
			return undefined;
		}
		return this.copyPodStatus(status);
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go SetContainerReadiness.
	async setContainerReadiness(
		podUid: string,
		containerId: ContainerID,
		ready: boolean,
	): Promise<void> {
		await retryConflicts(
			async () => {
				const pod = await this.findPodByUid(podUid);
				if (!pod) {
					return;
				}

				const oldStatus = this.podStatuses.get(podStatusKey(pod));
				if (!oldStatus) {
					return;
				}

				let containerStatus = this.findContainerStatus(oldStatus, containerId);
				if (!containerStatus) {
					return;
				}

				if (containerStatus.ready === ready) {
					return;
				}

				const status = this.copyPodStatus(oldStatus);
				containerStatus = this.findContainerStatus(status, containerId);
				if (!containerStatus) {
					return;
				}
				containerStatus.ready = ready;

				const updateConditionFunc = (
					conditionType: V1PodCondition["type"],
					condition: V1PodCondition,
				) => {
					status.conditions ??= [];
					const conditionIndex = status.conditions.findIndex(
						(condition) => condition.type === conditionType,
					);
					if (conditionIndex !== -1) {
						status.conditions[conditionIndex] = condition;
					} else {
						status.conditions.push(condition);
					}
				};

				const allContainerStatuses = status.containerStatuses ?? [];
				updateConditionFunc(
					"Ready",
					generatePodReadyCondition(
						pod,
						oldStatus,
						status.conditions ?? [],
						allContainerStatuses,
						status.phase,
					),
				);
				updateConditionFunc(
					"ContainersReady",
					generateContainersReadyCondition(pod, oldStatus, allContainerStatuses, status.phase),
				);
				await this.updateStatusInternal(pod, status, false, false);
			},
			{
				clock: this.options.clock,
			},
		);
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go SetContainerStartup.
	async setContainerStartup(
		podUid: string,
		containerId: ContainerID,
		started: boolean,
	): Promise<void> {
		await retryConflicts(
			async () => {
				const pod = await this.findPodByUid(podUid);
				if (!pod) {
					return;
				}

				const oldStatus = this.podStatuses.get(podStatusKey(pod));
				if (!oldStatus) {
					return;
				}

				let containerStatus = this.findContainerStatus(oldStatus, containerId);
				if (!containerStatus) {
					return;
				}

				if (containerStatus.started === started) {
					return;
				}

				const status = this.copyPodStatus(oldStatus);
				containerStatus = this.findContainerStatus(status, containerId);
				if (!containerStatus) {
					return;
				}
				containerStatus.started = started;
				await this.updateStatusInternal(pod, status, false, false);
			},
			{
				clock: this.options.clock,
			},
		);
	}

	derivePodConditions(pod: V1Pod, status: V1PodStatus): V1PodStatus {
		const conditions = (status.conditions ?? []).filter(
			(condition) => condition.type !== "Ready" && condition.type !== "ContainersReady",
		);
		const allContainerStatuses = status.containerStatuses ?? [];
		return {
			...status,
			conditions: [
				...conditions,
				generatePodReadyCondition(pod, status, conditions, allContainerStatuses, status.phase),
				generateContainersReadyCondition(pod, status, allContainerStatuses, status.phase),
			],
		};
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go TerminatePod.
	async terminatePod(pod: V1Pod): Promise<void> {
		const oldStatus = this.podStatuses.get(podStatusKey(pod)) ?? pod.status ?? {};
		const status = this.copyPodStatus(oldStatus);

		if (this.hasPodInitialized(pod)) {
			for (const containerStatus of status.containerStatuses ?? []) {
				if (containerStatus.state?.terminated) {
					continue;
				}
				containerStatus.state = {
					terminated: {
						reason: "ContainerStatusUnknown",
						message: "The container could not be located when the pod was terminated",
						exitCode: 137,
					},
				};
			}
		}

		switch (status.phase) {
			case "Succeeded":
			case "Failed":
				break;
			case "Pending":
			case "Running":
			default:
				status.phase = "Failed";
				break;
		}

		await this.updateStatusInternal(pod, status, true, true);
	}

	removePod(pod: V1Pod): void {
		const key = podStatusKey(pod);
		this.podStatuses.delete(key);
		this.lastStatusJson.delete(key);
	}

	close(): void {
		this.podStatuses.clear();
		this.lastStatusJson.clear();
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go updateStatusInternal.
	private async updateStatusInternal(
		pod: V1Pod,
		status: V1PodStatus,
		forceUpdate: boolean,
		podIsFinished: boolean,
	): Promise<boolean> {
		const name = pod.metadata?.name;
		if (!name) {
			return false;
		}

		const key = podStatusKey(pod);
		const cachedStatus = this.podStatuses.get(key);
		let oldStatus: V1PodStatus;
		const isCached = cachedStatus !== undefined;
		if (isCached) {
			oldStatus = this.copyPodStatus(cachedStatus);
		} else {
			oldStatus = this.copyPodStatus(pod.status ?? {});
		}

		const err = this.checkContainerStateTransition(oldStatus, status, pod);
		if (err) {
			return false;
		}

		this.updateLastTransitionTime(status, oldStatus, "ContainersReady");
		this.updateLastTransitionTime(status, oldStatus, "Ready");
		this.updateLastTransitionTime(status, oldStatus, "Initialized");
		this.updateLastTransitionTime(status, oldStatus, "PodReadyToStartContainers");
		this.updateLastTransitionTime(status, oldStatus, "PodScheduled");
		this.updateLastTransitionTime(status, oldStatus, "DisruptionTarget");
		this.updateLastTransitionTime(status, oldStatus, "AllContainersRestarting");

		if (oldStatus.startTime) {
			status.startTime = new Date(oldStatus.startTime);
		} else if (!status.startTime) {
			status.startTime = this.options.clock.now();
		}

		if ((oldStatus.observedGeneration ?? 0) > (status.observedGeneration ?? 0)) {
			status.observedGeneration = oldStatus.observedGeneration;
		}

		this.normalizeStatus(pod, status);

		if (isCached && this.isPodStatusByKubeletEqual(oldStatus, status) && !forceUpdate) {
			return false;
		}

		const latestPod = await this.options.pods.get(name, pod.metadata?.namespace);
		if (!latestPod) {
			return false;
		}

		latestPod.status = status;
		const updated = await this.options.pods.update(name, latestPod);
		this.podStatuses.set(key, this.copyPodStatus(updated.status ?? status));
		this.lastStatusJson.set(podStatusKey(updated), JSON.stringify(updated.status));
		if (this.canBeDeleted(updated, updated.status ?? status, podIsFinished)) {
			await this.options.pods.delete(name, updated.metadata?.namespace);
			this.removePod(updated);
		}
		return true;
	}

	private hasPodInitialized(_pod: V1Pod): boolean {
		// The simulator does not currently model init containers, so regular
		// containers are considered initialized as in Kubernetes' no-init case.
		return true;
	}

	private canBeDeleted(pod: V1Pod, status: V1PodStatus, podIsFinished: boolean): boolean {
		if (pod.metadata?.deletionTimestamp === undefined) {
			return false;
		}
		if (pod.status?.phase !== "Failed" && pod.status?.phase !== "Succeeded") {
			return false;
		}
		return podIsFinished && (status.phase === "Failed" || status.phase === "Succeeded");
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go checkContainerStateTransition.
	private checkContainerStateTransition(
		oldStatuses: V1PodStatus,
		newStatuses: V1PodStatus,
		pod: V1Pod,
	): Error | undefined {
		if (pod.spec?.restartPolicy === "Always") {
			return undefined;
		}

		for (const oldStatus of oldStatuses.containerStatuses ?? []) {
			if (!oldStatus.state?.terminated) {
				continue;
			}
			if (oldStatus.state.terminated.exitCode !== 0 && pod.spec?.restartPolicy === "OnFailure") {
				continue;
			}
			let restartable = false;
			for (const container of pod.spec?.containers ?? []) {
				if (
					container.name === oldStatus.name &&
					podutil.containerShouldRestart(container, pod.spec, oldStatus.state.terminated.exitCode)
				) {
					restartable = true;
				}
			}
			if (restartable) {
				continue;
			}
			for (const newStatus of newStatuses.containerStatuses ?? []) {
				if (oldStatus.name === newStatus.name && !newStatus.state?.terminated) {
					return new Error(
						`terminated container ${newStatus.name} attempted illegal transition to non-terminated state`,
					);
				}
			}
		}

		return undefined;
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go updateLastTransitionTime.
	private updateLastTransitionTime(
		status: V1PodStatus,
		oldStatus: V1PodStatus,
		conditionType: V1PodCondition["type"],
	): void {
		const condition = status.conditions?.find((condition) => condition.type === conditionType);
		if (!condition) {
			return;
		}

		let lastTransitionTime: Date | undefined = this.options.clock.now();
		const oldCondition = oldStatus.conditions?.find(
			(condition) => condition.type === conditionType,
		);
		if (oldCondition && condition.status === oldCondition.status) {
			lastTransitionTime = oldCondition.lastTransitionTime;
		}
		condition.lastTransitionTime = lastTransitionTime;
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go normalizeStatus.
	private normalizeStatus(pod: V1Pod, status: V1PodStatus): V1PodStatus {
		let bytesPerStatus = 1024 * 12;
		const containers =
			(pod.spec?.containers.length ?? 0) +
			(pod.spec?.initContainers?.length ?? 0) +
			(pod.spec?.ephemeralContainers?.length ?? 0);
		if (containers > 0) {
			bytesPerStatus = Math.floor(bytesPerStatus / containers);
		}

		const normalizeTimeStamp = (time: Date | undefined): Date | undefined =>
			time ? new Date(time.toISOString()) : undefined;

		const normalizeContainerState = (containerState: V1ContainerState | undefined): void => {
			if (containerState?.running) {
				containerState.running.startedAt = normalizeTimeStamp(containerState.running.startedAt);
			}
			if (containerState?.terminated) {
				containerState.terminated.startedAt = normalizeTimeStamp(
					containerState.terminated.startedAt,
				);
				containerState.terminated.finishedAt = normalizeTimeStamp(
					containerState.terminated.finishedAt,
				);
				if (
					containerState.terminated.message &&
					containerState.terminated.message.length > bytesPerStatus
				) {
					containerState.terminated.message = containerState.terminated.message.slice(
						0,
						bytesPerStatus,
					);
				}
			}
		};

		if (status.startTime) {
			status.startTime = normalizeTimeStamp(status.startTime);
		}
		for (const condition of status.conditions ?? []) {
			condition.lastProbeTime = normalizeTimeStamp(condition.lastProbeTime);
			condition.lastTransitionTime = normalizeTimeStamp(condition.lastTransitionTime);
		}

		const normalizeContainerStatuses = (
			containerStatuses: V1ContainerStatus[] | undefined,
		): void => {
			for (const containerStatus of containerStatuses ?? []) {
				normalizeContainerState(containerStatus.state);
				normalizeContainerState(containerStatus.lastState);
			}
		};

		normalizeContainerStatuses(status.containerStatuses);
		status.containerStatuses?.sort((left, right) => left.name.localeCompare(right.name));

		normalizeContainerStatuses(status.initContainerStatuses);
		status.initContainerStatuses?.sort((left, right) => left.name.localeCompare(right.name));

		normalizeContainerStatuses(status.ephemeralContainerStatuses);
		status.ephemeralContainerStatuses?.sort((left, right) => left.name.localeCompare(right.name));

		return status;
	}

	private isPodStatusByKubeletEqual(oldStatus: V1PodStatus, status: V1PodStatus): boolean {
		return JSON.stringify(oldStatus) === JSON.stringify(status);
	}

	private copyPodStatus(status: V1PodStatus): V1PodStatus {
		return {
			...status,
			conditions: status.conditions?.map((condition) => ({ ...condition })),
			containerStatuses: status.containerStatuses?.map((containerStatus) => ({
				...containerStatus,
			})),
		};
	}

	private findContainerStatus(
		status: V1PodStatus,
		containerId: ContainerID,
	): V1ContainerStatus | undefined {
		return status.containerStatuses?.find(
			(containerStatus) =>
				parseContainerID(containerStatus.containerID).toString() === containerId.toString(),
		);
	}

	private async findPodByUid(uid: string): Promise<V1Pod | undefined> {
		return (await this.options.pods.list()).find((pod) => pod.metadata?.uid === uid);
	}
}

function podStatusKey(pod: V1Pod): string {
	return pod.metadata?.uid ?? `${pod.metadata?.namespace ?? "default"}/${pod.metadata?.name ?? ""}`;
}
