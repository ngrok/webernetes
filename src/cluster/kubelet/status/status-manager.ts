import type {
	V1ContainerState,
	V1ContainerStatus,
	V1Pod,
	V1PodCondition,
	V1PodSpec,
	V1PodStatus,
} from "../../../client";
import { isNotFoundError } from "../../../client/errors";
import type { Clock } from "../../../clock";
import type { KubeClient } from "../../cluster";
import { deepEqual } from "../../../deep-equal";
import { Channel, select } from "../../../go/channel";
import type { Context } from "../../../go/context";
import * as time from "../../../go/time";
import * as podutil from "../../api/v1/pod/util";
import * as statusutil from "../../util/pod/pod";
import { type ContainerID, parseContainerID } from "../container";
import type { PodManager } from "../pod";
import * as kubetypes from "../types";
import {
	generateContainersReadyCondition,
	generateContainersReadyConditionForTerminalPhase,
	generatePodReadyCondition,
	generatePodReadyConditionForTerminalPhase,
} from "./generate";

export interface StatusManagerOptions {
	clock: Clock;
	kubeClient: KubeClient;
	podManager: PodManager;
}

// Models kubernetes/pkg/kubelet/status/status_manager.go PodUpdateNotifier.
export interface PodUpdateNotifier {
	onPodUpdated(pod: V1Pod, status: V1PodStatus, isAdded: boolean): void;
	onPodRemoved(pod: V1Pod): void;
}

interface VersionedPodStatus {
	version: number;
	podName: string;
	podNamespace: string | undefined;
	at?: Date;
	podIsFinished: boolean;
	status: V1PodStatus;
}

// Models kubernetes/pkg/kubelet/status/status_manager.go podStatusNotification.
interface PodStatusNotification {
	pod: V1Pod;
	status: V1PodStatus;
	isAdded: boolean;
	podIsFinished: boolean;
}

const syncPeriodMs = 10 * 1000;

// Models kubernetes/pkg/kubelet/status/status_manager.go manager.
export class StatusManager {
	private readonly podStatuses = new Map<string, VersionedPodStatus>();
	private readonly podStatusChannel = new Channel<void>(1);
	private readonly apiStatusVersions = new Map<string, number>();
	// TypeScript-only teardown handle. Upstream Start launches a goroutine and
	// returns void; kubelet.close awaits this promise so the ticker is stopped.
	private startPromise: Promise<void> | undefined;
	private readonly clock: Clock;
	private readonly kubeClient: KubeClient;
	private readonly podManager: PodManager;
	private readonly notifiers: PodUpdateNotifier[] = [];

	constructor({ clock, kubeClient, podManager }: StatusManagerOptions) {
		this.clock = clock;
		this.kubeClient = kubeClient;
		this.podManager = podManager;
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go isPodStatusByKubeletEqual.
	private isPodStatusByKubeletEqual(oldStatus: V1PodStatus, status: V1PodStatus): boolean {
		const oldCopy = structuredClone(oldStatus);

		const newConditions = new Map<string, V1PodCondition>();
		const oldConditions = new Map<string, V1PodCondition>();
		for (const c of status.conditions ?? []) {
			if (
				kubetypes.podConditionByKubelet(c.type) ||
				kubetypes.podConditionSharedByKubelet(c.type)
			) {
				newConditions.set(c.type, c);
			}
		}
		for (const c of oldStatus.conditions ?? []) {
			if (
				kubetypes.podConditionByKubelet(c.type) ||
				kubetypes.podConditionSharedByKubelet(c.type)
			) {
				oldConditions.set(c.type, c);
			}
		}

		if (newConditions.size !== oldConditions.size) {
			return false;
		}
		for (const newCondition of newConditions.values()) {
			const oldCondition = oldConditions.get(newCondition.type);
			if (
				!oldCondition ||
				oldCondition.status !== newCondition.status ||
				oldCondition.message !== newCondition.message ||
				oldCondition.reason !== newCondition.reason
			) {
				return false;
			}
		}

		oldCopy.conditions = status.conditions;
		oldCopy.resourceClaimStatuses = status.resourceClaimStatuses;
		oldCopy.extendedResourceClaimStatus = status.extendedResourceClaimStatus;
		oldCopy.nodeAllocatableResourceClaimStatuses = status.nodeAllocatableResourceClaimStatuses;

		return deepEqual(oldCopy, status);
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go Start.
	start(ctx: Context): Promise<void> {
		this.startPromise ??= (async () => {
			const syncTicker = new time.Ticker(this.clock, syncPeriodMs);
			try {
				while (!ctx.err()) {
					await select()
						.case(this.podStatusChannel, async () => {
							await this.syncBatch(ctx, false);
						})
						.case(syncTicker.C, async () => {
							await this.syncBatch(ctx, true);
						})
						.case(ctx.done(), () => undefined);
				}
			} finally {
				syncTicker.stop();
			}
		})();
		return this.startPromise;
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go AddPodUpdateNotifier.
	addPodUpdateNotifier(notifier: PodUpdateNotifier): void {
		this.notifiers.push(notifier);
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go GetPodStatus.
	getPodStatus(podUid: string): V1PodStatus | undefined {
		const status = this.podStatuses.get(this.podManager.translatePodUid(podUid));
		if (!status) {
			return undefined;
		}
		return structuredClone(status.status);
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go SetPodStatus.
	async setPodStatus(pod: V1Pod, status: V1PodStatus): Promise<[V1PodStatus, boolean]> {
		let notification: PodStatusNotification | undefined;
		try {
			status = structuredClone(status);
			status.observedGeneration = podutil.calculatePodStatusObservedGeneration(pod);

			const [changed, notif] = this.updateStatusInternal(
				pod,
				status,
				pod.metadata?.deletionTimestamp !== undefined,
				false,
			);
			notification = notif;
			return [structuredClone(this.podStatuses.get(podStatusKey(pod))?.status ?? status), changed];
		} finally {
			if (notification) {
				this.sendNotification(notification);
			}
		}
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go SetContainerReadiness.
	setContainerReadiness(podUid: string, containerId: ContainerID, ready: boolean): void {
		let notification: PodStatusNotification | undefined;
		try {
			const pod = this.podManager.getPodByUid(podUid);
			if (!pod) {
				return;
			}

			const oldStatus = this.podStatuses.get(podStatusKey(pod));
			if (!oldStatus) {
				return;
			}

			let containerStatus = this.findContainerStatus(oldStatus.status, containerId);
			if (!containerStatus) {
				return;
			}

			if (containerStatus.ready === ready) {
				return;
			}

			const status = structuredClone(oldStatus.status);
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
					oldStatus.status,
					status.conditions ?? [],
					allContainerStatuses,
					status.phase,
				),
			);
			updateConditionFunc(
				"ContainersReady",
				generateContainersReadyCondition(pod, oldStatus.status, allContainerStatuses, status.phase),
			);
			const [, notif] = this.updateStatusInternal(pod, status, false, false);
			notification = notif;
		} finally {
			if (notification) {
				this.sendNotification(notification);
			}
		}
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go SetContainerStartup.
	setContainerStartup(podUid: string, containerId: ContainerID, started: boolean): void {
		let notification: PodStatusNotification | undefined;
		try {
			const pod = this.podManager.getPodByUid(podUid);
			if (!pod) {
				return;
			}

			const oldStatus = this.podStatuses.get(podStatusKey(pod));
			if (!oldStatus) {
				return;
			}

			let containerStatus = this.findContainerStatus(oldStatus.status, containerId);
			if (!containerStatus) {
				return;
			}

			if (containerStatus.started === started) {
				return;
			}

			const status = structuredClone(oldStatus.status);
			containerStatus = this.findContainerStatus(status, containerId);
			if (!containerStatus) {
				return;
			}
			containerStatus.started = started;
			const [, notif] = this.updateStatusInternal(pod, status, false, false);
			notification = notif;
		} finally {
			if (notification) {
				this.sendNotification(notification);
			}
		}
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go findContainerStatus.
	private findContainerStatus(
		status: V1PodStatus,
		containerId: ContainerID,
	): V1ContainerStatus | undefined {
		// In real k8s this also searches init containers and returns a bool
		// indicating whether the status came from an init container or not.
		return status.containerStatuses?.find(
			(containerStatus) =>
				parseContainerID(containerStatus.containerID).toString() === containerId.toString(),
		);
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go TerminatePod.
	terminatePod(pod: V1Pod) {
		let notification: PodStatusNotification | undefined;
		let oldStatus = pod.status ?? {};
		const cachedStatus = this.podStatuses.get(podStatusKey(pod));
		const isCached = cachedStatus !== undefined;
		if (isCached) {
			oldStatus = cachedStatus.status;
		}
		const status = structuredClone(oldStatus);

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

		if (!kubetypes.isStaticPod(pod)) {
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
		}

		try {
			const [, notif] = this.updateStatusInternal(pod, status, true, true);
			notification = notif;
		} finally {
			if (notification) {
				this.sendNotification(notification);
			}
		}
	}

	private hasPodInitialized(_pod: V1Pod): boolean {
		// The simulator does not currently model init containers, so regular
		// containers are considered initialized as in Kubernetes' no-init case.
		return true;
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go checkContainerStateTransition.
	private checkContainerStateTransition(
		oldStatuses: V1PodStatus,
		newStatuses: V1PodStatus,
		podSpec: V1PodSpec | undefined,
	): Error | undefined {
		if (podSpec?.restartPolicy === "Always") {
			return undefined;
		}
		// In Kubernetes 1.36 the RestartAllContainersOnContainerExits feature gate
		// defaults to true.
		if (podutil.allContainersCouldRestart(podSpec)) {
			return undefined;
		}

		for (const oldStatus of oldStatuses.containerStatuses ?? []) {
			if (!oldStatus.state?.terminated) {
				continue;
			}
			if (oldStatus.state.terminated.exitCode !== 0 && podSpec?.restartPolicy === "OnFailure") {
				continue;
			}
			let restartable = false;
			for (const container of podSpec?.containers ?? []) {
				if (
					container.name === oldStatus.name &&
					podutil.containerShouldRestart(container, podSpec, oldStatus.state.terminated.exitCode)
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

	// Models kubernetes/pkg/kubelet/status/status_manager.go updateStatusInternal.
	private updateStatusInternal(
		pod: V1Pod,
		status: V1PodStatus,
		forceUpdate: boolean,
		podIsFinished: boolean,
	): [boolean, PodStatusNotification | undefined] {
		const name = pod.metadata?.name;
		if (!name) {
			return [false, undefined];
		}

		const key = podStatusKey(pod);
		const cachedStatus = this.podStatuses.get(key);
		let oldStatus: V1PodStatus;
		const isCached = cachedStatus !== undefined;
		if (isCached) {
			oldStatus = structuredClone(cachedStatus.status);
			if (!kubetypes.isStaticPod(pod)) {
				if (cachedStatus.podIsFinished && !podIsFinished) {
					podIsFinished = true;
				}
			}
		} else if (this.podManager.getMirrorPodByPod(pod)) {
			oldStatus = structuredClone(this.podManager.getMirrorPodByPod(pod)?.status ?? {});
		} else {
			oldStatus = structuredClone(pod.status ?? {});
		}

		const err = this.checkContainerStateTransition(oldStatus, status, pod.spec);
		if (err) {
			return [false, undefined];
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
			status.startTime = this.clock.now();
		}

		if ((oldStatus.observedGeneration ?? 0) > (status.observedGeneration ?? 0)) {
			status.observedGeneration = oldStatus.observedGeneration;
		}

		this.normalizeStatus(pod, status);

		if (isCached && this.isPodStatusByKubeletEqual(cachedStatus.status, status) && !forceUpdate) {
			return [false, undefined];
		}

		const newStatus: VersionedPodStatus = {
			status: structuredClone(status),
			version: (cachedStatus?.version ?? 0) + 1,
			podName: name,
			podNamespace: pod.metadata?.namespace,
			podIsFinished,
		};

		// Multiple status updates can be generated before we update the API server,
		// so we track the time from the first status update until we retire it to
		// the API.
		if (cachedStatus?.at === undefined) {
			newStatus.at = this.clock.now();
		} else {
			newStatus.at = cachedStatus.at;
		}

		this.podStatuses.set(key, newStatus);
		this.podStatusChannel.trySend(undefined);

		const podCopy = structuredClone(pod);
		podCopy.status = structuredClone(status);
		const notification: PodStatusNotification = {
			pod: podCopy,
			status: structuredClone(status),
			isAdded: !isCached && pod.metadata?.deletionTimestamp === undefined,
			podIsFinished,
		};

		return [true, notification];
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go sendNotification.
	private sendNotification(n: PodStatusNotification): void {
		for (const notifier of this.notifiers) {
			if (!n.podIsFinished) {
				notifier.onPodUpdated(n.pod, n.status, n.isAdded);
			} else {
				notifier.onPodRemoved(n.pod);
			}
		}
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go updateLastTransitionTime.
	private updateLastTransitionTime(
		status: V1PodStatus,
		oldStatus: V1PodStatus,
		conditionType: V1PodCondition["type"],
	): void {
		const condition = podutil.getPodCondition(status, conditionType);
		if (!condition) {
			return;
		}

		let lastTransitionTime: Date | undefined = this.clock.now();
		const oldCondition = podutil.getPodCondition(oldStatus, conditionType);
		if (oldCondition && condition.status === oldCondition.status) {
			lastTransitionTime = oldCondition.lastTransitionTime;
		}
		condition.lastTransitionTime = lastTransitionTime;
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go deletePodStatus.
	private deletePodStatus(uid: string): void {
		this.podStatuses.delete(uid);
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go RemoveOrphanedStatuses.
	removeOrphanedStatuses(podUids: Set<string>): void {
		for (const key of this.podStatuses.keys()) {
			if (!podUids.has(key)) {
				this.podStatuses.delete(key);
			}
		}
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go syncBatch.
	private async syncBatch(ctx: Context, all: boolean): Promise<number> {
		const updatedStatuses: Array<{
			podUid: string;
			statusUid: string;
			status: VersionedPodStatus;
		}> = [];
		const { podToMirror, mirrorToPod } = this.podManager.getUidTranslations();

		if (all) {
			for (const uid of this.apiStatusVersions.keys()) {
				const hasPod = this.podStatuses.has(uid);
				const hasMirror = mirrorToPod.has(uid);
				if (!hasPod && !hasMirror) {
					this.apiStatusVersions.delete(uid);
				}
			}
		}

		for (const [uid, status] of this.podStatuses) {
			let uidOfStatus = uid;
			if (podToMirror.has(uid)) {
				const mirrorUid = podToMirror.get(uid);
				// Static pods without mirror pods should not sync status to the API.
				// The simulator does not currently model static pods or mirror pods,
				// so this branch is dormant until those pod sources are added.
				if (mirrorUid === "") {
					continue;
				}
				uidOfStatus = mirrorUid ?? uid;
			}

			if (!all) {
				if ((this.apiStatusVersions.get(uidOfStatus) ?? 0) >= status.version) {
					continue;
				}
				updatedStatuses.push({ podUid: uid, statusUid: uidOfStatus, status });
				continue;
			}

			if (this.needsUpdate(uidOfStatus, status)) {
				updatedStatuses.push({ podUid: uid, statusUid: uidOfStatus, status });
			} else if (this.needsReconcile(uid, status.status)) {
				this.apiStatusVersions.delete(uidOfStatus);
				updatedStatuses.push({ podUid: uid, statusUid: uidOfStatus, status });
			}
		}

		for (const update of updatedStatuses) {
			await this.syncPod(ctx, update.podUid, update.status);
		}

		return updatedStatuses.length;
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go syncPod.
	private async syncPod(ctx: Context, uid: string, status: VersionedPodStatus): Promise<void> {
		const namespace = status.podNamespace ?? "default";
		let pod: V1Pod;
		try {
			pod = await this.kubeClient.corev1.readNamespacedPod({
				name: status.podName,
				namespace,
			});
		} catch (error) {
			if (isNotFoundError(error)) {
				return;
			}
			return;
		}
		if (ctx.err()) {
			return;
		}

		const translatedUid = this.podManager.translatePodUid(pod.metadata?.uid ?? "");
		if (translatedUid !== "" && translatedUid !== uid) {
			this.deletePodStatus(uid);
			return;
		}

		const mergedStatus = this.mergePodStatus(pod, pod.status ?? {}, status.status, false);
		try {
			const result = await statusutil.patchPodStatus(
				this.kubeClient,
				namespace,
				status.podName,
				pod.metadata?.uid ?? "",
				pod.status ?? {},
				mergedStatus,
			);
			if (!result.unchanged && result.pod) {
				pod = result.pod;
			}
		} catch {
			return;
		}
		this.apiStatusVersions.set(podStatusKey(pod), status.version);

		if (this.canBeDeleted(pod, status.status, status.podIsFinished)) {
			try {
				await this.kubeClient.corev1.deleteNamespacedPod({
					name: status.podName,
					namespace,
					gracePeriodSeconds: 0,
					body: {
						gracePeriodSeconds: 0,
					},
				});
			} catch {
				return;
			}
			this.deletePodStatus(uid);
		}
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go needsUpdate.
	private needsUpdate(uid: string, status: VersionedPodStatus): boolean {
		const latest = this.apiStatusVersions.get(uid);
		if (latest === undefined || latest < status.version) {
			return true;
		}
		const pod = this.podManager.getPodByUid(uid);
		if (!pod) {
			return false;
		}
		return this.canBeDeleted(pod, status.status, status.podIsFinished);
	}

	private canBeDeleted(pod: V1Pod, status: V1PodStatus, podIsFinished: boolean): boolean {
		if (pod.metadata?.deletionTimestamp === undefined || kubetypes.isMirrorPod(pod)) {
			return false;
		}
		if (!podutil.isPodPhaseTerminal(pod.status?.phase)) {
			return false;
		}
		return podIsFinished;
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go needsReconcile.
	private needsReconcile(uid: string, status: V1PodStatus): boolean {
		let pod = this.podManager.getPodByUid(uid);
		if (!pod) {
			return false;
		}
		if (kubetypes.isStaticPod(pod)) {
			const mirrorPod = this.podManager.getMirrorPodByPod(pod);
			if (!mirrorPod) {
				return false;
			}
			pod = mirrorPod;
		}

		const podStatus = structuredClone(pod.status ?? {});
		this.normalizeStatus(pod, podStatus);
		return !this.isPodStatusByKubeletEqual(podStatus, status);
	}

	// Models kubernetes/pkg/kubelet/status/status_manager.go normalizeStatus.
	private normalizeStatus(pod: V1Pod, status: V1PodStatus): V1PodStatus {
		let bytesPerStatus = 1024 * 12;
		const containers =
			(pod.spec?.containers?.length ?? 0) +
			(pod.spec?.initContainers?.length ?? 0) +
			(pod.spec?.ephemeralContainers?.length ?? 0);
		if (containers > 0) {
			bytesPerStatus = Math.floor(bytesPerStatus / containers);
		}

		const normalizeTimeStamp = (time: Date | string | undefined): Date | undefined =>
			time ? new Date(time instanceof Date ? time.toISOString() : time) : undefined;

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

	// Models kubernetes/pkg/kubelet/status/status_manager.go mergePodStatus.
	private mergePodStatus(
		pod: V1Pod,
		oldPodStatus: V1PodStatus,
		newPodStatus: V1PodStatus,
		couldHaveRunningContainers: boolean,
	): V1PodStatus {
		newPodStatus = structuredClone(newPodStatus);
		oldPodStatus = structuredClone(oldPodStatus);

		let podConditions: V1PodCondition[] = [];
		for (const c of oldPodStatus.conditions ?? []) {
			if (!kubetypes.podConditionByKubelet(c.type)) {
				podConditions.push(c);
			}
		}

		const transitioningToTerminalPhase =
			!podutil.isPodPhaseTerminal(oldPodStatus.phase) &&
			podutil.isPodPhaseTerminal(newPodStatus.phase);

		for (const c of newPodStatus.conditions ?? []) {
			if (kubetypes.podConditionByKubelet(c.type)) {
				podConditions.push(c);
			} else if (kubetypes.podConditionSharedByKubelet(c.type)) {
				if (c.type === "DisruptionTarget") {
					if (transitioningToTerminalPhase && !couldHaveRunningContainers) {
						this.updateLastTransitionTime(newPodStatus, oldPodStatus, c.type);
						const [, updatedCondition] = podutil.getPodConditionFromList(
							newPodStatus.conditions,
							c.type,
						);
						if (updatedCondition) {
							podConditions = statusutil.replaceOrAppendPodCondition(
								podConditions,
								updatedCondition,
							);
						}
					}
				}
			}
		}
		newPodStatus.conditions = podConditions;

		newPodStatus.resourceClaimStatuses = oldPodStatus.resourceClaimStatuses;
		newPodStatus.extendedResourceClaimStatus = oldPodStatus.extendedResourceClaimStatus;
		newPodStatus.nodeAllocatableResourceClaimStatuses =
			oldPodStatus.nodeAllocatableResourceClaimStatuses;

		if (transitioningToTerminalPhase && couldHaveRunningContainers) {
			newPodStatus.phase = oldPodStatus.phase;
			newPodStatus.reason = oldPodStatus.reason;
			newPodStatus.message = oldPodStatus.message;
		}

		if (
			podutil.isPodPhaseTerminal(newPodStatus.phase) &&
			(podutil.isPodReadyConditionTrue(newPodStatus) ||
				podutil.isContainersReadyConditionTrue(newPodStatus))
		) {
			const containersReadyCondition = generateContainersReadyConditionForTerminalPhase(
				pod,
				oldPodStatus,
				newPodStatus.phase,
			);
			podutil.updatePodCondition(this.clock, newPodStatus, containersReadyCondition);

			const podReadyCondition = generatePodReadyConditionForTerminalPhase(
				pod,
				oldPodStatus,
				newPodStatus.phase,
			);
			podutil.updatePodCondition(this.clock, newPodStatus, podReadyCondition);
		}

		return newPodStatus;
	}
}

function podStatusKey(pod: V1Pod): string {
	return pod.metadata?.uid ?? `${pod.metadata?.namespace ?? "default"}/${pod.metadata?.name ?? ""}`;
}
