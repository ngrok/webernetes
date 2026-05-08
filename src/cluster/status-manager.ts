import type {
	V1Container,
	V1ContainerState,
	V1ContainerStatus,
	V1Pod,
	V1PodCondition,
	V1PodStatus,
} from "../client";
import type { Clock } from "../clock";
import { retryConflicts } from "../retry-update";
import type { PodStore } from "./storage";

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

	// Models kubernetes/pkg/kubelet/status/status_manager.go SetContainerReadiness.
	async setContainerReadiness(podUid: string, containerId: string, ready: boolean): Promise<void> {
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
					this.generatePodReadyCondition(
						pod,
						oldStatus,
						status.conditions ?? [],
						allContainerStatuses,
						status.phase,
					),
				);
				updateConditionFunc(
					"ContainersReady",
					this.generateContainersReadyCondition(pod, oldStatus, allContainerStatuses, status.phase),
				);
				await this.updateStatusInternal(pod, status, false, false);
			},
			{
				clock: this.options.clock,
			},
		);
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go SetContainerStartup.
	async setContainerStartup(podUid: string, containerId: string, started: boolean): Promise<void> {
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
				this.generatePodReadyCondition(pod, status, conditions, allContainerStatuses, status.phase),
				this.generateContainersReadyCondition(pod, status, allContainerStatuses, status.phase),
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
					this.containerShouldRestart(container, pod, oldStatus.state.terminated.exitCode)
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

	// Models kubernetes/pkg/api/v1/pod/util.go ContainerShouldRestart.
	private containerShouldRestart(container: V1Container, pod: V1Pod, exitCode: number): boolean {
		if (container.restartPolicy !== undefined) {
			const rule = this.findMatchingContainerRestartRule(container, exitCode);
			if (rule) {
				switch (rule.action) {
					case "Restart":
						return true;
					case "RestartAllContainers":
						// The default as of 1.36, see feature gate
						// RestartAllContainersOnContainerExits
						return true;
				}
			}

			switch (container.restartPolicy) {
				case "Always":
					return true;
				case "OnFailure":
					return exitCode !== 0;
				case "Never":
					return false;
			}
		}

		switch (pod.spec?.restartPolicy) {
			case "Always":
				return true;
			case "OnFailure":
				return exitCode !== 0;
			case "Never":
				return false;
			default:
				return true;
		}
	}

	// Models kubernetes/pkg/api/v1/pod/util.go FindMatchingContainerRestartRule.
	private findMatchingContainerRestartRule(
		container: V1Container,
		exitCode: number,
	): NonNullable<V1Container["restartPolicyRules"]>[number] | undefined {
		for (const rule of container.restartPolicyRules ?? []) {
			if (rule.exitCodes) {
				const exitCodeMatched = (rule.exitCodes.values ?? []).includes(exitCode);
				switch (rule.exitCodes.operator) {
					case "In":
						if (exitCodeMatched) {
							return rule;
						}
						break;
					case "NotIn":
						if (!exitCodeMatched) {
							return rule;
						}
						break;
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

	// Models kubernetes/pkg/kubelet/status/generate.go GeneratePodReadyCondition.
	private generatePodReadyCondition(
		pod: V1Pod,
		oldStatus: V1PodStatus,
		conditions: V1PodCondition[],
		containerStatuses: V1ContainerStatus[],
		phase: V1PodStatus["phase"],
	): V1PodCondition {
		const containersReady = this.generateContainersReadyCondition(
			pod,
			oldStatus,
			containerStatuses,
			phase,
		);
		if (containersReady.status !== "True") {
			return {
				type: "Ready",
				observedGeneration: this.calculatePodConditionObservedGeneration(
					oldStatus,
					pod.metadata?.generation ?? 0,
					"Ready",
				),
				status: containersReady.status,
				reason: containersReady.reason,
				message: containersReady.message,
			};
		}

		const unreadyMessages: string[] = [];
		for (const readinessGate of pod.spec?.readinessGates ?? []) {
			const condition = conditions.find(
				(condition) => condition.type === readinessGate.conditionType,
			);
			if (!condition) {
				unreadyMessages.push(
					`corresponding condition of pod readiness gate "${readinessGate.conditionType}" does not exist.`,
				);
			} else if (condition.status !== "True") {
				unreadyMessages.push(
					`the status of pod readiness gate "${readinessGate.conditionType}" is not "True", but ${condition.status}`,
				);
			}
		}

		if (unreadyMessages.length !== 0) {
			const unreadyMessage = unreadyMessages.join(", ");
			return {
				type: "Ready",
				observedGeneration: this.calculatePodConditionObservedGeneration(
					oldStatus,
					pod.metadata?.generation ?? 0,
					"Ready",
				),
				status: "False",
				reason: "ReadinessGatesNotReady",
				message: unreadyMessage,
			};
		}

		return {
			type: "Ready",
			observedGeneration: this.calculatePodConditionObservedGeneration(
				oldStatus,
				pod.metadata?.generation ?? 0,
				"Ready",
			),
			status: "True",
		};
	}

	// Models kubernetes/pkg/kubelet/status/generate.go GenerateContainersReadyCondition.
	private generateContainersReadyCondition(
		pod: V1Pod,
		oldStatus: V1PodStatus,
		containerStatuses: V1ContainerStatus[] | undefined,
		phase: V1PodStatus["phase"],
	): V1PodCondition {
		if (containerStatuses === undefined) {
			return {
				type: "ContainersReady",
				observedGeneration: this.calculatePodConditionObservedGeneration(
					oldStatus,
					pod.metadata?.generation ?? 0,
					"ContainersReady",
				),
				status: "False",
				reason: "UnknownContainerStatuses",
			};
		}

		const unknownContainers: string[] = [];
		const unreadyContainers: string[] = [];

		for (const container of pod.spec?.containers ?? []) {
			const containerStatus = containerStatuses.find((status) => status.name === container.name);
			if (containerStatus) {
				if (!containerStatus.ready) {
					unreadyContainers.push(container.name);
				}
			} else {
				unknownContainers.push(container.name);
			}
		}

		if (phase === "Succeeded" && unknownContainers.length === 0) {
			return this.generateContainersReadyConditionForTerminalPhase(pod, oldStatus, phase);
		}

		if (phase === "Failed") {
			return this.generateContainersReadyConditionForTerminalPhase(pod, oldStatus, phase);
		}

		const unreadyMessages: string[] = [];
		if (unknownContainers.length > 0) {
			unreadyMessages.push(
				`containers with unknown status: ${formatContainerNames(unknownContainers)}`,
			);
		}
		if (unreadyContainers.length > 0) {
			unreadyMessages.push(
				`containers with unready status: ${formatContainerNames(unreadyContainers)}`,
			);
		}
		const unreadyMessage = unreadyMessages.join(", ");
		if (unreadyMessage !== "") {
			return {
				type: "ContainersReady",
				observedGeneration: this.calculatePodConditionObservedGeneration(
					oldStatus,
					pod.metadata?.generation ?? 0,
					"ContainersReady",
				),
				status: "False",
				reason: "ContainersNotReady",
				message: unreadyMessage,
			};
		}

		return {
			type: "ContainersReady",
			observedGeneration: this.calculatePodConditionObservedGeneration(
				oldStatus,
				pod.metadata?.generation ?? 0,
				"ContainersReady",
			),
			status: "True",
		};
	}

	private generateContainersReadyConditionForTerminalPhase(
		pod: V1Pod,
		oldStatus: V1PodStatus,
		phase: V1PodStatus["phase"],
	): V1PodCondition {
		return {
			type: "ContainersReady",
			observedGeneration: this.calculatePodConditionObservedGeneration(
				oldStatus,
				pod.metadata?.generation ?? 0,
				"ContainersReady",
			),
			status: "False",
			reason: phase === "Failed" ? "PodFailed" : "PodCompleted",
		};
	}

	// Models kubernetes/pkg/api/v1/pod/util.go CalculatePodConditionObservedGeneration.
	private calculatePodConditionObservedGeneration(
		podStatus: V1PodStatus | undefined,
		generation: number,
		_conditionType: V1PodCondition["type"],
	): number {
		if (!podStatus) {
			return 0;
		}
		// In Go this does a check against a feature gate called
		// PodObservedGenerationTrackingEnabled, which defaults to true in 1.35 and
		// is slated for removal in 1.38. When true, it just returns generation, so
		// that's all I'm opting to do here.
		return generation;
	}

	private findContainerStatus(
		status: V1PodStatus,
		containerId: string,
	): V1ContainerStatus | undefined {
		return status.containerStatuses?.find(
			(containerStatus) => simulatorContainerId(containerStatus.containerID) === containerId,
		);
	}

	private async findPodByUid(uid: string): Promise<V1Pod | undefined> {
		return (await this.options.pods.list()).find((pod) => pod.metadata?.uid === uid);
	}
}

function podStatusKey(pod: V1Pod): string {
	return pod.metadata?.uid ?? `${pod.metadata?.namespace ?? "default"}/${pod.metadata?.name ?? ""}`;
}

function simulatorContainerId(containerId: string | undefined): string | undefined {
	return containerId?.startsWith("simulator://")
		? containerId.slice("simulator://".length)
		: undefined;
}

function formatContainerNames(names: string[]): string {
	return `[${names.join(" ")}]`;
}
