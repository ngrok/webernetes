import { Channel, type SendChannel } from "../../go/channel";
import * as context from "../../go/context";
import type { V1Pod, V1PodStatus } from "../../client";
import type { Clock } from "../../clock";
import * as kubecontainer from "./container";
import type { PodStatus as PodRuntimeStatus } from "./container";
import { networkNotReadyErrorMsg } from "./errors";
import { isStaticPod, type SyncPodType } from "./types/pod-update";
import type { WorkQueue } from "./util/queue/work-queue";

// Models kubernetes/pkg/kubelet/pod_workers.go workerResyncIntervalJitterFactor.
const workerResyncIntervalJitterFactor = 0.5;
// Models kubernetes/pkg/kubelet/pod_workers.go workerBackOffPeriodJitterFactor.
const workerBackOffPeriodJitterFactor = 0.5;
// Models kubernetes/pkg/kubelet/pod_workers.go backOffOnTransientErrorPeriod.
const backOffOnTransientErrorPeriodMs = 1000;
// Models kubernetes/pkg/kubelet/pod_workers.go PodStatusFunc.
type PodStatusFunc = (podStatus: V1PodStatus) => void;

// Models kubernetes/pkg/kubelet/pod_workers.go KillPodOptions.
interface KillPodOptions {
	completedCh?: SendChannel<void>;
	evict?: boolean;
	podStatusFunc?: PodStatusFunc;
	podTerminationGracePeriodSecondsOverride?: number;
}

// Models kubernetes/pkg/kubelet/pod_workers.go UpdatePodOptions.
export interface UpdatePodOptions {
	updateType: SyncPodType;
	startTime: Date;
	pod?: V1Pod;
	mirrorPod?: V1Pod;
	runningPod?: kubecontainer.Pod;
	killPodOptions?: KillPodOptions;
}

// Models kubernetes/pkg/kubelet/pod_workers.go PodWorkerState.
export type PodWorkerState = "SyncPod" | "TerminatingPod" | "TerminatedPod";

// Models kubernetes/pkg/kubelet/pod_workers.go PodWorkerSync.
export interface PodWorkerSync {
	state: PodWorkerState;
	orphan: boolean;
	hasConfig: boolean;
	static: boolean;
}

// Models kubernetes/pkg/kubelet/pod_workers.go podWorkers.
export interface PodWorkers {
	updatePod(ctx: context.Context, options: UpdatePodOptions): Promise<void>;
	syncKnownPods(desiredPods: V1Pod[]): Map<string, PodWorkerSync>;
	isPodKnownTerminated(uid: string): boolean;
	couldHaveRunningContainers(uid: string): boolean;
	shouldPodBeFinished(uid: string): boolean;
	isPodTerminationRequested(uid: string): boolean;
	shouldPodContainersBeTerminating(uid: string): boolean;
	shouldPodRuntimeBeRemoved(uid: string): boolean;
	shouldPodContentBeRemoved(uid: string): boolean;
	isPodForMirrorPodTerminatingByFullName(podFullname: string): boolean;
}

// Models kubernetes/pkg/kubelet/pod_workers.go podWork.
interface PodWork {
	workType: PodWorkerState;
	options: UpdatePodOptions;
}

// Models kubernetes/pkg/kubelet/pod_workers.go syncPodFnType return values.
export type SyncPodResult = [
	isTerminal: boolean,
	postSync: (() => void) | undefined,
	syncError: Error | undefined,
];

// Internal zero-value shape used by podSyncStatus.activeUpdate. Go can allocate
// &UpdatePodOptions{} with zero-valued fields; external simulator callers still
// provide the required UpdatePodOptions fields enforced by TypeScript.
export type ActiveUpdatePodOptions = Omit<UpdatePodOptions, "updateType" | "startTime"> & {
	updateType: SyncPodType;
	startTime: Date;
};

// Models kubernetes/pkg/kubelet/pod_workers.go podSyncer.
interface PodSyncer {
	syncPod(
		ctx: context.Context,
		updateType: SyncPodType,
		pod: V1Pod | undefined,
		mirrorPod: V1Pod | undefined,
		podStatus: PodRuntimeStatus,
	): Promise<SyncPodResult>;
	syncTerminatingPod(
		ctx: context.Context,
		pod: V1Pod,
		podStatus: PodRuntimeStatus,
		gracePeriod: number | undefined,
		podStatusFunc: PodStatusFunc | undefined,
	): Promise<void>;
	syncTerminatingRuntimePod(ctx: context.Context, runningPod: kubecontainer.Pod): Promise<void>;
	syncTerminatedPod(ctx: context.Context, pod: V1Pod, podStatus: PodRuntimeStatus): Promise<void>;
}

// Models kubernetes/pkg/kubelet/pod_workers.go podSyncStatus.
export interface PodSyncStatus {
	cancelFn?: context.CancelFunc;
	fullname: string;
	working: boolean;
	pendingUpdate?: UpdatePodOptions;
	activeUpdate?: ActiveUpdatePodOptions;
	syncedAt: Date;
	startedAt?: Date;
	terminatingAt?: Date;
	terminatedAt?: Date;
	gracePeriod: number;
	notifyPostTerminating: Array<SendChannel<void>>;
	statusPostTerminating: PodStatusFunc[];
	startedTerminating: boolean;
	deleted: boolean;
	evicted: boolean;
	finished: boolean;
	restartRequested: boolean;
	observedRuntime: boolean;
}

// Models kubernetes/pkg/kubelet/pod_workers.go podSyncStatus.IsTerminationRequested.
function isTerminationRequested(status: PodSyncStatus): boolean {
	return status.terminatingAt !== undefined;
}

// Models kubernetes/pkg/kubelet/pod_workers.go podSyncStatus.IsTerminated.
function isTerminated(status: PodSyncStatus): boolean {
	return status.terminatedAt !== undefined;
}

// Models kubernetes/pkg/kubelet/pod_workers.go podSyncStatus.IsFinished.
function isFinished(status: PodSyncStatus): boolean {
	return status.finished;
}

// Models kubernetes/pkg/kubelet/pod_workers.go podSyncStatus.IsTerminationStarted.
function isTerminationStarted(status: PodSyncStatus): boolean {
	return status.startedTerminating;
}

// Models kubernetes/pkg/kubelet/pod_workers.go podSyncStatus.IsDeleted.
function isDeleted(status: PodSyncStatus): boolean {
	return status.deleted;
}

// Models kubernetes/pkg/kubelet/pod_workers.go podSyncStatus.IsEvicted.
function isEvicted(status: PodSyncStatus): boolean {
	return status.evicted;
}

// Models kubernetes/pkg/kubelet/pod_workers.go podSyncStatus.IsStarted.
function isStarted(status: PodSyncStatus): boolean {
	return status.startedAt !== undefined;
}

// Models kubernetes/pkg/kubelet/pod_workers.go podSyncStatus.WorkType.
function workType(status: PodSyncStatus): PodWorkerState {
	if (isTerminated(status)) {
		return "TerminatedPod";
	}
	if (isTerminationRequested(status)) {
		return "TerminatingPod";
	}
	return "SyncPod";
}

// Models kubernetes/pkg/kubelet/pod_workers.go isPodStatusCacheTerminal.
function isPodStatusCacheTerminal(status: PodRuntimeStatus): boolean {
	for (const containerStatus of status.containerStatuses) {
		if (containerStatus.state === "Running") {
			return false;
		}
	}
	for (const sandboxStatus of status.sandboxStatuses) {
		if (sandboxStatus.state === "Ready") {
			return false;
		}
	}
	return true;
}

// Models kubernetes/pkg/kubelet/pod_workers.go podWorkers.
export class PodWorkersImpl implements PodWorkers {
	private readonly podUpdates = new Map<string, Channel<void>>();
	// Simulator-only bookkeeping: Kubernetes starts pod workers as goroutines
	// and does not retain handles, but async close() needs promises it can await.
	private readonly workerRuns = new Map<string, Promise<void>>();
	readonly podSyncStatuses = new Map<string, PodSyncStatus>();
	private podsSynced = false;
	private stopped = false;

	constructor(
		private readonly clock: Clock,
		private readonly workQueue: WorkQueue,
		private readonly resyncIntervalMs: number,
		private readonly backOffPeriodMs: number,
		private readonly podSyncer: PodSyncer,
		private readonly podCache: kubecontainer.ROCache,
	) {}

	// Models kubernetes/pkg/kubelet/pod_workers.go UpdatePod.
	async updatePod(ctx: context.Context, options: UpdatePodOptions): Promise<void> {
		if (this.stopped || ctx.err()) {
			return;
		}

		let isRuntimePod = false;
		let uid: string;
		let ns: string;
		let name: string;
		if (options.runningPod) {
			if (!options.pod) {
				if (options.updateType !== "kill") {
					return;
				}
				uid = options.runningPod.id;
				ns = options.runningPod.namespace;
				name = options.runningPod.name;
				isRuntimePod = true;
			} else {
				options.runningPod = undefined;
				uid = podUIDFromPod(options.pod);
				ns = podNamespace(options.pod);
				name = podName(options.pod);
			}
		} else {
			if (!options.pod) {
				return;
			}
			uid = podUIDFromPod(options.pod);
			ns = podNamespace(options.pod);
			name = podName(options.pod);
		}
		if (!uid) {
			return;
		}

		let firstTime = false;
		const now = this.clock.now();
		let status = this.podSyncStatuses.get(uid);
		if (!status) {
			firstTime = true;
			status = {
				syncedAt: now,
				fullname: kubecontainer.buildPodFullName(name, ns),
				// Rest are zero values
				working: false,
				deleted: false,
				evicted: false,
				restartRequested: false,
				startedTerminating: false,
				finished: false,
				observedRuntime: false,
				gracePeriod: 0,
				notifyPostTerminating: [],
				statusPostTerminating: [],
			};

			if (
				options.pod &&
				(options.pod.status?.phase === "Failed" || options.pod.status?.phase === "Succeeded")
			) {
				const [cachedPodStatus, statusCacheErr] = await this.podCache.get(uid);
				if (!statusCacheErr && isPodStatusCacheTerminal(cachedPodStatus)) {
					status = {
						terminatingAt: now,
						terminatedAt: now,
						syncedAt: now,
						startedTerminating: true,
						finished: false,
						fullname: kubecontainer.buildPodFullName(name, ns),
						// Rest are zero values
						working: false,
						deleted: false,
						evicted: false,
						restartRequested: false,
						observedRuntime: false,
						gracePeriod: 0,
						notifyPostTerminating: [],
						statusPostTerminating: [],
					};
				}
			}

			this.podSyncStatuses.set(uid, status);
		}

		let pod = options.pod;
		// Kubernetes can send a runtime-only pod update when the container runtime
		// still has a sandbox/container but the kubelet no longer has a normal API
		// Pod object for it. Those updates are only useful for teardown because a
		// runtime pod does not carry enough spec to do a full sync.
		if (isRuntimePod) {
			status.observedRuntime = true;
			if (status.pendingUpdate?.pod) {
				pod = status.pendingUpdate.pod;
				options.pod = pod;
				options.runningPod = undefined;
			} else if (status.activeUpdate?.pod) {
				pod = status.activeUpdate.pod;
				options.pod = pod;
				options.runningPod = undefined;
			} else if (options.runningPod) {
				pod = kubecontainer.toAPIPod(options.runningPod);
			}
		}

		if (!firstTime && isTerminationRequested(status)) {
			if (options.updateType === "create") {
				status.restartRequested = true;
				return;
			}
		}

		if (isFinished(status)) {
			return;
		}

		let becameTerminating = false;
		if (!isTerminationRequested(status)) {
			switch (true) {
				case isRuntimePod:
					status.deleted = true;
					status.terminatingAt = now;
					becameTerminating = true;
					break;
				case pod?.metadata?.deletionTimestamp !== undefined:
					status.deleted = true;
					status.terminatingAt = now;
					becameTerminating = true;
					break;
				case pod?.status?.phase === "Failed":
				case pod?.status?.phase === "Succeeded":
					status.terminatingAt = now;
					becameTerminating = true;
					break;
				case options.updateType === "kill":
					if (options.killPodOptions?.evict) {
						status.evicted = true;
					}
					status.terminatingAt = now;
					becameTerminating = true;
					break;
			}
		}

		let wasGracePeriodShortened = false;
		switch (true) {
			case isTerminated(status):
				if (isRuntimePod) {
					return;
				}
				options.killPodOptions?.completedCh?.close();
				options.killPodOptions = undefined;
				break;
			case isTerminationRequested(status):
				options.killPodOptions ??= {};
				if (options.killPodOptions.completedCh) {
					status.notifyPostTerminating.push(options.killPodOptions.completedCh);
				}
				if (options.killPodOptions.podStatusFunc) {
					status.statusPostTerminating.push(options.killPodOptions.podStatusFunc);
				}
				const [gracePeriod, gracePeriodShortened] = calculateEffectiveGracePeriod(
					status,
					pod,
					options.killPodOptions,
				);
				wasGracePeriodShortened = gracePeriodShortened;
				status.gracePeriod = gracePeriod;
				options.killPodOptions.podTerminationGracePeriodSecondsOverride = gracePeriod;
				break;
			default:
				options.killPodOptions?.completedCh?.close();
				options.killPodOptions = undefined;
				break;
		}

		let podUpdates = this.podUpdates.get(uid);
		if (!podUpdates) {
			podUpdates = new Channel<void>(1);
			this.podUpdates.set(uid, podUpdates);
			// Mirrors the goroutine defer that observes worker exit upstream; the
			// map itself is simulator-only bookkeeping for awaitable shutdown.
			const run = this.podWorkerLoop(ctx, uid, podUpdates).finally(() => {
				this.workerRuns.delete(uid);
			});
			this.workerRuns.set(uid, run);
		}

		if (status.pendingUpdate && status.pendingUpdate.startTime < options.startTime) {
			options.startTime = status.pendingUpdate.startTime;
		}

		// Kubernetes rewrites pendingUpdate.Pod from allocationManager here when
		// InPlacePodVerticalScaling is enabled. The simulator does not yet model
		// resource requests/limits, resize admission, or allocated resources.
		status.pendingUpdate = options;
		status.working = true;
		podUpdates.trySend(undefined);

		if ((becameTerminating || wasGracePeriodShortened) && status.cancelFn) {
			status.cancelFn();
		}
	}

	// Models kubernetes/pkg/kubelet/pod_workers.go startPodSync.
	private startPodSync(
		parentCtx: context.Context,
		podUID: string,
	): {
		ctx: context.Context;
		update: PodWork;
		canStart: boolean;
		canEverStart: boolean;
		ok: boolean;
	} {
		let update: PodWork = {
			workType: "SyncPod",
			options: { updateType: "sync", startTime: this.clock.now() },
		};
		const status = this.podSyncStatuses.get(podUID);
		if (!status) {
			return {
				ctx: parentCtx,
				update,
				canStart: false,
				canEverStart: false,
				ok: false,
			};
		}

		if (!status.pendingUpdate) {
			status.working = false;
			return {
				ctx: parentCtx,
				update,
				canStart: false,
				canEverStart: false,
				ok: false,
			};
		}

		update = {
			workType: workType(status),
			options: status.pendingUpdate,
		};
		status.pendingUpdate = undefined;
		// ensure the pod update channel is empty
		this.podUpdates.get(podUID)?.tryReceive();

		const [ctx, cancel] = context.withCancel(parentCtx);
		status.cancelFn = cancel;

		if (isStarted(status)) {
			mergeLastUpdate(status, update.options);
			return { ctx, update, canStart: true, canEverStart: true, ok: true };
		}

		if (update.options.runningPod && update.workType === "TerminatingPod") {
			mergeLastUpdate(status, update.options);
			return { ctx, update, canStart: true, canEverStart: true, ok: true };
		}

		if (!update.options.pod) {
			mergeLastUpdate(status, update.options);
			return { ctx, update, canStart: false, canEverStart: false, ok: true };
		}

		status.startedAt = this.clock.now();
		mergeLastUpdate(status, update.options);
		return { ctx, update, canStart: true, canEverStart: true, ok: true };
	}

	// Models kubernetes/pkg/kubelet/pod_workers.go podWorkerLoop.
	private async podWorkerLoop(
		parentCtx: context.Context,
		podUID: string,
		podUpdates: Channel<void>,
	): Promise<void> {
		let lastSyncTime = new Date(0);
		for await (const _ of podUpdates) {
			const { ctx, update, canStart, canEverStart, ok } = this.startPodSync(parentCtx, podUID);
			if (!ok) {
				continue;
			}
			if (!canEverStart) {
				return;
			}
			if (!canStart) {
				continue;
			}

			let isTerminal = false;
			let postSync: (() => void) | undefined;
			let err: unknown;
			try {
				let status: PodRuntimeStatus | undefined;
				switch (true) {
					case update.options.runningPod !== undefined:
						break;
					default:
						if (!update.options.pod) {
							throw new Error("pod status requested without pod");
						}
						const [podStatusResult, podStatusErr] = await this.podCache.getNewerThan(
							ctx,
							podUIDFromPod(update.options.pod),
							lastSyncTime,
						);
						if (podStatusErr) {
							throw podStatusErr;
						}
						status = podStatusResult;
						break;
				}

				if (update.workType === "TerminatedPod" && (!update.options.pod || !status)) {
					throw new Error("terminated pod sync requires pod and status");
				}
				if (
					update.workType === "TerminatingPod" &&
					!update.options.runningPod &&
					(!update.options.pod || !status)
				) {
					throw new Error("terminating pod sync requires pod and status");
				}
				if (update.workType === "SyncPod" && (!update.options.pod || !status)) {
					throw new Error("pod sync requires pod and status");
				}

				switch (update.workType) {
					case "TerminatedPod":
						{
							const pod = requiredPod(update);
							const podStatus = requiredStatus(status);
							await this.podSyncer.syncTerminatedPod(ctx, pod, podStatus);
						}
						break;
					case "TerminatingPod":
						const gracePeriod =
							update.options.killPodOptions?.podTerminationGracePeriodSecondsOverride;
						const podStatusFunc = this.acknowledgeTerminating(podUID);
						if (update.options.runningPod) {
							await this.podSyncer.syncTerminatingRuntimePod(ctx, update.options.runningPod);
						} else {
							const pod = requiredPod(update);
							const podStatus = requiredStatus(status);
							await this.podSyncer.syncTerminatingPod(
								ctx,
								pod,
								podStatus,
								gracePeriod,
								podStatusFunc,
							);
						}
						break;
					default:
						{
							const pod = requiredPod(update);
							const podStatus = requiredStatus(status);
							const [terminal, syncPostSync, syncErr] = await this.podSyncer.syncPod(
								ctx,
								update.options.updateType,
								pod,
								update.options.mirrorPod,
								podStatus,
							);
							isTerminal = terminal;
							if (syncErr) {
								err = syncErr;
							} else {
								postSync = syncPostSync;
							}
						}
						break;
				}
				lastSyncTime = this.clock.now();
				postSync?.();
			} catch (error) {
				err = error;
			}

			let phaseTransition = false;
			switch (true) {
				case err === context.Canceled:
					// when the context is cancelled we expect an update to already be queued
					break;
				case err !== undefined:
					// we will queue a retry
					break;
				case update.workType === "TerminatedPod":
					this.completeTerminated(podUID);
					return;
				case update.workType === "TerminatingPod":
					if (update.options.runningPod) {
						this.completeTerminatingRuntimePod(podUID);
						return;
					}
					this.completeTerminating(podUID);
					phaseTransition = true;
					break;
				case isTerminal:
					this.completeSync(podUID);
					phaseTransition = true;
					break;
			}

			this.completeWork(podUID, phaseTransition, err);
		}
	}

	// Models kubernetes/pkg/kubelet/pod_workers.go completeSync.
	private completeSync(podUID: string): void {
		const status = this.podSyncStatuses.get(podUID);
		if (!status) {
			return;
		}
		status.terminatingAt ??= this.clock.now();
		status.startedTerminating = true;
		this.requeueLastPodUpdate(podUID, status);
	}

	// Models kubernetes/pkg/kubelet/pod_workers.go completeTerminating.
	private completeTerminating(podUID: string): void {
		const status = this.podSyncStatuses.get(podUID);
		if (!status) {
			return;
		}
		status.terminatedAt = this.clock.now();
		for (const ch of status.notifyPostTerminating) {
			ch.close();
		}
		status.notifyPostTerminating = [];
		status.statusPostTerminating = [];
		this.requeueLastPodUpdate(podUID, status);
	}

	// Models kubernetes/pkg/kubelet/pod_workers.go completeTerminatingRuntimePod.
	private completeTerminatingRuntimePod(podUID: string): void {
		this.cleanupPodUpdates(podUID);
		const status = this.podSyncStatuses.get(podUID);
		if (!status) {
			return;
		}
		status.terminatedAt = this.clock.now();
		status.finished = true;
		status.working = false;
		this.podSyncStatuses.delete(podUID);
	}

	// Models kubernetes/pkg/kubelet/pod_workers.go acknowledgeTerminating.
	private acknowledgeTerminating(podUID: string): PodStatusFunc | undefined {
		const status = this.podSyncStatuses.get(podUID);
		if (!status) {
			return undefined;
		}

		if (isTerminationRequested(status) && !status.startedTerminating) {
			status.startedTerminating = true;
		}

		return status.statusPostTerminating.at(-1);
	}

	// Models kubernetes/pkg/kubelet/pod_workers.go completeTerminated.
	private completeTerminated(podUID: string): void {
		this.cleanupPodUpdates(podUID);
		const status = this.podSyncStatuses.get(podUID);
		if (!status) {
			return;
		}
		status.finished = true;
		status.working = false;
	}

	// Models kubernetes/pkg/kubelet/pod_workers.go completeWork.
	private completeWork(podUID: string, phaseTransition: boolean, syncError: unknown): void {
		switch (true) {
			case phaseTransition:
				this.workQueue.enqueue(podUID, 0);
				break;
			case syncError === undefined:
				this.workQueue.enqueue(
					podUID,
					jitter(this.resyncIntervalMs, workerResyncIntervalJitterFactor),
				);
				break;
			case errorMessage(syncError).includes(networkNotReadyErrorMsg):
				this.workQueue.enqueue(
					podUID,
					jitter(backOffOnTransientErrorPeriodMs, workerBackOffPeriodJitterFactor),
				);
				break;
			default:
				let backoff = this.backOffPeriodMs;
				const [backoffAt, isBackoffError] = kubecontainer.minBackoffExpiration(syncError);
				if (isBackoffError && backoffAt) {
					backoff = backoffAt.getTime() - this.clock.now().getTime();
				}
				if (backoff < 0) {
					backoff = 0;
				} else if (backoff > this.resyncIntervalMs) {
					backoff = this.resyncIntervalMs;
				}
				this.workQueue.enqueue(podUID, jitter(backoff, workerBackOffPeriodJitterFactor));
				break;
		}

		const status = this.podSyncStatuses.get(podUID);
		if (status) {
			if (status.pendingUpdate) {
				this.podUpdates.get(podUID)?.trySend(undefined);
			} else {
				status.working = false;
			}
		}
	}

	// Models kubernetes/pkg/kubelet/pod_workers.go SyncKnownPods.
	syncKnownPods(desiredPods: V1Pod[]): Map<string, PodWorkerSync> {
		const workers = new Map<string, PodWorkerSync>();
		const known = new Set<string>();
		for (const pod of desiredPods) {
			known.add(podUIDFromPod(pod));
		}

		this.podsSynced = true;
		for (const [uid, status] of this.podSyncStatuses) {
			const orphan = !known.has(uid);
			if (status.restartRequested || orphan) {
				if (this.removeTerminatedWorker(uid, status, orphan)) {
					continue;
				}
			}

			const sync: PodWorkerSync = {
				state: workType(status),
				orphan,
				// Rest are zero values
				hasConfig: false,
				static: false,
			};
			switch (true) {
				case status.activeUpdate !== undefined:
					if (status.activeUpdate.pod) {
						sync.hasConfig = true;
						sync.static = isStaticPod(status.activeUpdate.pod);
					}
					break;
				case status.pendingUpdate !== undefined:
					if (status.pendingUpdate.pod) {
						sync.hasConfig = true;
						sync.static = isStaticPod(status.pendingUpdate.pod);
					}
					break;
			}
			workers.set(uid, sync);
		}
		return workers;
	}

	// Models kubernetes/pkg/kubelet/pod_workers.go IsPodKnownTerminated.
	isPodKnownTerminated(uid: string): boolean {
		const status = this.podSyncStatuses.get(uid);
		if (status) {
			return isTerminated(status);
		}
		return false;
	}

	// Models kubernetes/pkg/kubelet/pod_workers.go CouldHaveRunningContainers.
	couldHaveRunningContainers(uid: string): boolean {
		const status = this.podSyncStatuses.get(uid);
		if (status) {
			return !isTerminated(status);
		}
		return !this.podsSynced;
	}

	// Models kubernetes/pkg/kubelet/pod_workers.go ShouldPodBeFinished.
	shouldPodBeFinished(uid: string): boolean {
		const status = this.podSyncStatuses.get(uid);
		if (status) {
			return isFinished(status);
		}
		return this.podsSynced;
	}

	// Models kubernetes/pkg/kubelet/pod_workers.go IsPodTerminationRequested.
	isPodTerminationRequested(uid: string): boolean {
		const status = this.podSyncStatuses.get(uid);
		if (status) {
			return isTerminationRequested(status);
		}
		return false;
	}

	// Models kubernetes/pkg/kubelet/pod_workers.go ShouldPodContainersBeTerminating.
	shouldPodContainersBeTerminating(uid: string): boolean {
		const status = this.podSyncStatuses.get(uid);
		if (status) {
			return isTerminationStarted(status);
		}
		return this.podsSynced;
	}

	// Models kubernetes/pkg/kubelet/pod_workers.go ShouldPodRuntimeBeRemoved.
	shouldPodRuntimeBeRemoved(uid: string): boolean {
		const status = this.podSyncStatuses.get(uid);
		if (status) {
			return isTerminated(status);
		}
		return this.podsSynced;
	}

	// Models kubernetes/pkg/kubelet/pod_workers.go ShouldPodContentBeRemoved.
	shouldPodContentBeRemoved(uid: string): boolean {
		const status = this.podSyncStatuses.get(uid);
		if (status) {
			return isEvicted(status) || (isDeleted(status) && isTerminated(status));
		}
		return this.podsSynced;
	}

	// Models kubernetes/pkg/kubelet/pod_workers.go IsPodForMirrorPodTerminatingByFullName.
	isPodForMirrorPodTerminatingByFullName(_podFullname: string): boolean {
		// Static pods are not implemented end to end in this simulator, so there is
		// no local startedStaticPodsByFullname equivalent to consult yet.
		return false;
	}

	// Models kubernetes/pkg/kubelet/pod_workers.go removeTerminatedWorker.
	private removeTerminatedWorker(uid: string, status: PodSyncStatus, orphaned: boolean): boolean {
		if (!status.finished) {
			if (!orphaned) {
				return false;
			}

			status.deleted = true;
			switch (true) {
				case !isStarted(status) && !status.observedRuntime:
					break;
				case !isTerminationRequested(status):
					status.terminatingAt = this.clock.now();
					if (status.activeUpdate?.pod) {
						const [gracePeriod] = calculateEffectiveGracePeriod(
							status,
							status.activeUpdate.pod,
							undefined,
						);
						status.gracePeriod = gracePeriod;
					} else {
						status.gracePeriod = 1;
					}
					this.requeueLastPodUpdate(uid, status);
					return false;
				default:
					this.requeueLastPodUpdate(uid, status);
					return false;
			}
		}

		this.podSyncStatuses.delete(uid);
		this.cleanupPodUpdates(uid);
		return true;
	}

	// Models kubernetes/pkg/kubelet/pod_workers.go cleanupPodUpdates.
	private cleanupPodUpdates(uid: string): void {
		const podUpdates = this.podUpdates.get(uid);
		if (podUpdates) {
			podUpdates.close();
			this.podUpdates.delete(uid);
		}
	}

	// Models kubernetes/pkg/kubelet/pod_workers.go requeueLastPodUpdate.
	private requeueLastPodUpdate(uid: string, status: PodSyncStatus): void {
		if (status.pendingUpdate || !status.activeUpdate) {
			return;
		}
		const copied = { ...status.activeUpdate };
		status.pendingUpdate = copied;

		status.working = true;
		this.podUpdates.get(uid)?.trySend(undefined);
	}

	async close(): Promise<void> {
		this.stopped = true;
		for (const status of this.podSyncStatuses.values()) {
			status.cancelFn?.();
		}
		for (const uid of [...this.podUpdates.keys()]) {
			this.cleanupPodUpdates(uid);
		}
		await Promise.all(this.workerRuns.values());
		this.podSyncStatuses.clear();
	}
}

// Models kubernetes/pkg/kubelet/pod_workers.go podSyncStatus.mergeLastUpdate.
function mergeLastUpdate(s: PodSyncStatus, other: UpdatePodOptions): void {
	let opts = s.activeUpdate;
	if (!opts) {
		opts = { updateType: "create", startTime: new Date(0) };
		s.activeUpdate = opts;
	}

	if (!opts.pod || !other.runningPod) {
		opts.pod = other.pod;
	}
	opts.runningPod = other.runningPod;
	if (other.mirrorPod) {
		opts.mirrorPod = other.mirrorPod;
	}
	if (other.killPodOptions) {
		opts.killPodOptions = {};
		if (other.killPodOptions.evict) {
			opts.killPodOptions.evict = true;
		}
		const override = other.killPodOptions.podTerminationGracePeriodSecondsOverride;
		if (override !== undefined) {
			opts.killPodOptions.podTerminationGracePeriodSecondsOverride = override;
		}
	}
}

function podUIDFromPod(pod: V1Pod): string {
	return pod.metadata?.uid ?? podWorkerKey(pod);
}

function podNamespace(pod: V1Pod): string {
	return pod.metadata?.namespace ?? "default";
}

function podName(pod: V1Pod): string {
	return pod.metadata?.name ?? "";
}

function podWorkerKey(pod: V1Pod): string {
	const name = podName(pod);
	return `${podNamespace(pod)}/${name}`;
}

// Models k8s.io/apimachinery/pkg/util/wait.Jitter for pod worker queue delays.
function jitter(durationMs: number, maxFactor: number): number {
	if (maxFactor <= 0) {
		maxFactor = 1;
	}
	const wait = durationMs + Math.random() * maxFactor * durationMs;
	return wait;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function requiredPod(update: PodWork): V1Pod {
	if (!update.options.pod) {
		throw new Error(`${update.workType} requires pod`);
	}
	return update.options.pod;
}

function requiredStatus(status: PodRuntimeStatus | undefined): PodRuntimeStatus {
	if (!status) {
		throw new Error("pod work requires status");
	}
	return status;
}

// Models kubernetes/pkg/kubelet/pod_workers.go calculateEffectiveGracePeriod.
function calculateEffectiveGracePeriod(
	status: PodSyncStatus,
	pod: V1Pod | undefined,
	options: KillPodOptions | undefined,
): [number, boolean] {
	let gracePeriod = status.gracePeriod;
	let overridden = false;

	let override = pod?.metadata?.deletionGracePeriodSeconds;
	if (override !== undefined && (gracePeriod === 0 || override < gracePeriod)) {
		gracePeriod = override;
		overridden = true;
	}

	override = options?.podTerminationGracePeriodSecondsOverride;
	if (override !== undefined && (gracePeriod === 0 || override < gracePeriod)) {
		gracePeriod = override;
		overridden = true;
	}

	if (!overridden && gracePeriod === 0 && pod?.spec?.terminationGracePeriodSeconds !== undefined) {
		gracePeriod = pod.spec.terminationGracePeriodSeconds;
	}

	if (gracePeriod < 1) {
		gracePeriod = 1;
	}
	return [gracePeriod, status.gracePeriod !== 0 && status.gracePeriod !== gracePeriod];
}
