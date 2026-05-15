import { Channel, type SendChannel } from "../../go/channel";
import * as context from "../../go/context";
import type { V1Pod, V1PodStatus } from "../../client";
import type { Clock } from "../../clock";
import type { PodRuntimeStatus } from "../cri";
import * as kubecontainer from "./container";

export interface UpdatePodOptions {
	pod?: V1Pod;
	runningPod?: RunningPod;
	updateType: "create" | "kill" | "sync" | "update";
	startTime: Date;
	killPodOptions?: KillPodOptions;
}

interface RunningPod {
	id: string;
	namespace: string;
	name: string;
}

interface KillPodOptions {
	completedCh?: SendChannel<void>;
	evict?: boolean;
	podStatusFunc?: (status: V1PodStatus) => void;
	podTerminationGracePeriodSecondsOverride?: number;
}

interface PodSyncStatus {
	syncedAt: Date;
	fullname: string;
	working: boolean;
	deleted: boolean;
	evicted: boolean;
	restartRequested: boolean;
	startedTerminating: boolean;
	finished: boolean;
	gracePeriod: number;
	notifyPostTerminating: Array<SendChannel<void>>;
	startedAt?: Date;
	terminatingAt?: Date;
	terminatedAt?: Date;
	activeUpdate?: UpdatePodOptions;
	pendingUpdate?: UpdatePodOptions;
	cancelFn?: context.CancelFunc;
}

type PodWorkerState = "SyncPod" | "TerminatingPod" | "TerminatedPod";

interface PodWork {
	workType: PodWorkerState;
	options: UpdatePodOptions;
}

type SyncPodFn = (ctx: context.Context, pod: V1Pod, podStatus: PodRuntimeStatus) => Promise<void>;
type GetPodStatusFn = (
	ctx: context.Context,
	podUID: string,
	minTime: Date,
) => Promise<PodRuntimeStatus>;
type SyncTerminatingPodFn = (
	ctx: context.Context,
	pod: V1Pod,
	podStatus: PodRuntimeStatus,
	gracePeriod: number | undefined,
	podStatusFunc: ((status: V1PodStatus) => void) | undefined,
) => Promise<void>;
type SyncTerminatedPodFn = (
	ctx: context.Context,
	pod: V1Pod,
	podStatus: PodRuntimeStatus,
) => Promise<void>;

// Models kubernetes/pkg/kubelet/pod_workers.go podWorkers.
export class PodWorkers {
	private readonly podUpdates = new Map<string, Channel<void>>();
	// Simulator-only bookkeeping: Kubernetes starts pod workers as goroutines
	// and does not retain handles, but async close() needs promises it can await.
	private readonly workerRuns = new Map<string, Promise<void>>();
	private readonly podSyncStatuses = new Map<string, PodSyncStatus>();
	private stopped = false;

	constructor(
		private readonly clock: Clock,
		private readonly syncPod: SyncPodFn,
		private readonly getPodStatus: GetPodStatusFn,
		private readonly syncTerminatingPod: SyncTerminatingPodFn,
		private readonly syncTerminatedPod: SyncTerminatedPodFn,
	) {}

	// Models kubernetes/pkg/kubelet/pod_workers.go UpdatePod.
	updatePod(ctx: context.Context, options: UpdatePodOptions): void {
		if (this.stopped || ctx.err()) {
			return;
		}

		let isRuntimePod = false;
		let uid: string;
		let namespace: string;
		let name: string;
		if (options.runningPod) {
			if (!options.pod) {
				if (options.updateType !== "kill") {
					return;
				}
				uid = options.runningPod.id;
				namespace = options.runningPod.namespace;
				name = options.runningPod.name;
				isRuntimePod = true;
			} else {
				options.runningPod = undefined;
				uid = podUID(options.pod);
				namespace = podNamespace(options.pod);
				name = podName(options.pod);
			}
		} else {
			if (!options.pod) {
				return;
			}
			uid = podUID(options.pod);
			namespace = podNamespace(options.pod);
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
				fullname: kubecontainer.buildPodFullName(name, namespace),
				working: false,
				deleted: false,
				evicted: false,
				restartRequested: false,
				startedTerminating: false,
				finished: false,
				gracePeriod: 0,
				notifyPostTerminating: [],
			};

			// Kubernetes checks podCache here when the first observed API pod is
			// already terminal. If the runtime cache also says the pod is terminal,
			// kubelet records terminatedAt/terminatingAt so the worker can finish the
			// SyncTerminatedPod cleanup path after a kubelet restart. The simulator
			// does not have a separate runtime status cache yet, so there is no
			// equivalent terminal-runtime signal to inspect.
			if (options.pod && isTerminalPhase(options.pod.status?.phase)) {
				// Intentionally omitted until a runtime status cache is modeled.
			}

			this.podSyncStatuses.set(uid, status);
		}

		let pod = options.pod;
		// Kubernetes can send a runtime-only pod update when the container runtime
		// still has a sandbox/container but the kubelet no longer has a normal API
		// Pod object for it. Those updates are only useful for teardown because a
		// runtime pod does not carry enough spec to do a full sync. The simulator
		// currently only calls updatePod with a real Pod, but this branch stays in
		// the same position as Kubernetes' UpdatePod so the control flow is easy to
		// compare when runtime-only cleanup is added.
		if (isRuntimePod) {
			if (status.pendingUpdate?.pod) {
				pod = status.pendingUpdate.pod;
				options.pod = pod;
				isRuntimePod = false;
			} else if (status.activeUpdate?.pod) {
				pod = status.activeUpdate.pod;
				options.pod = pod;
				isRuntimePod = false;
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
		this.notifyPodWorker(podUpdates);

		if ((becameTerminating || wasGracePeriodShortened) && status.cancelFn) {
			status.cancelFn();
		}
	}

	removePod(pod: V1Pod): void {
		const key = podUID(pod);
		if (key) {
			this.podSyncStatuses.delete(key);
			this.cleanupPodUpdates(key);
		}
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
			let syncError: unknown;
			try {
				const podStatus = update.options.runningPod
					? undefined
					: await this.getPodStatus(ctx, podUID, lastSyncTime);
				switch (update.workType) {
					case "TerminatedPod":
						if (update.options.pod && podStatus) {
							await this.syncTerminatedPod(ctx, update.options.pod, podStatus);
						}
						break;
					case "TerminatingPod":
						if (update.options.pod && podStatus) {
							await this.syncTerminatingPod(
								ctx,
								update.options.pod,
								podStatus,
								update.options.killPodOptions?.podTerminationGracePeriodSecondsOverride,
								update.options.killPodOptions?.podStatusFunc,
							);
						}
						break;
					default:
						if (update.options.pod && podStatus) {
							await this.syncPod(ctx, update.options.pod, podStatus);
							isTerminal = isTerminalPhase(update.options.pod.status?.phase);
						}
						break;
				}
				lastSyncTime = this.clock.now();
			} catch (error) {
				syncError = error;
			}

			let phaseTransition = false;
			switch (true) {
				case syncError === context.Canceled:
					break;
				case syncError !== undefined:
					break;
				case update.workType === "TerminatedPod":
					this.completeTerminated(podUID);
					return;
				case update.workType === "TerminatingPod":
					this.completeTerminating(podUID);
					phaseTransition = true;
					break;
				case isTerminal:
					this.completeSync(podUID);
					phaseTransition = true;
					break;
			}

			this.completeWork(podUID, phaseTransition, syncError);
		}
	}

	private startPodSync(
		parentCtx: context.Context,
		uid: string,
	): {
		ctx: context.Context;
		update: PodWork;
		canStart: boolean;
		canEverStart: boolean;
		ok: boolean;
	} {
		const emptyUpdate: PodWork = {
			workType: "SyncPod",
			options: { updateType: "sync", startTime: this.clock.now() },
		};
		const status = this.podSyncStatuses.get(uid);
		if (!status) {
			return {
				ctx: parentCtx,
				update: emptyUpdate,
				canStart: false,
				canEverStart: false,
				ok: false,
			};
		}

		if (!status.working) {
			// Kubernetes logs this as a programmer error. The simulator only needs to
			// recover by continuing with the pending update if one exists.
		}

		if (!status.pendingUpdate) {
			status.working = false;
			return {
				ctx: parentCtx,
				update: emptyUpdate,
				canStart: false,
				canEverStart: false,
				ok: false,
			};
		}

		const update: PodWork = {
			workType: podWorkType(status),
			options: status.pendingUpdate,
		};
		status.pendingUpdate = undefined;
		const [ctx, cancel] = context.withCancel(parentCtx);
		status.cancelFn = cancel;

		if (isStarted(status)) {
			this.mergeLastUpdate(status, update.options);
			return { ctx, update, canStart: true, canEverStart: true, ok: true };
		}

		if (update.options.runningPod && update.workType === "TerminatingPod") {
			this.mergeLastUpdate(status, update.options);
			return { ctx, update, canStart: true, canEverStart: true, ok: true };
		}

		if (!update.options.pod) {
			this.mergeLastUpdate(status, update.options);
			status.finished = true;
			status.working = false;
			status.terminatedAt = this.clock.now();
			return { ctx, update, canStart: false, canEverStart: false, ok: true };
		}

		status.startedAt = this.clock.now();
		this.mergeLastUpdate(status, update.options);
		return { ctx, update, canStart: true, canEverStart: true, ok: true };
	}

	private mergeLastUpdate(status: PodSyncStatus, options: UpdatePodOptions): void {
		const active = status.activeUpdate ?? {
			updateType: options.updateType,
			startTime: options.startTime,
		};
		if (!active.pod || !options.runningPod) {
			active.pod = options.pod;
		}
		active.runningPod = options.runningPod;
		active.updateType = options.updateType;
		active.startTime = options.startTime;
		active.killPodOptions = options.killPodOptions;
		status.activeUpdate = active as UpdatePodOptions;
	}

	private completeSync(uid: string): void {
		const status = this.podSyncStatuses.get(uid);
		if (!status) {
			return;
		}
		status.terminatingAt ??= this.clock.now();
		status.startedTerminating = true;
		this.requeueLastPodUpdate(uid, status);
	}

	private completeTerminating(uid: string): void {
		const status = this.podSyncStatuses.get(uid);
		if (!status) {
			return;
		}
		status.terminatedAt = this.clock.now();
		for (const ch of status.notifyPostTerminating) {
			ch.close();
		}
		status.notifyPostTerminating = [];
		this.requeueLastPodUpdate(uid, status);
	}

	private completeTerminated(uid: string): void {
		const status = this.podSyncStatuses.get(uid);
		if (!status) {
			return;
		}
		this.cleanupPodUpdates(uid);
		status.finished = true;
		status.working = false;
	}

	private completeWork(uid: string, phaseTransition: boolean, syncError: unknown): void {
		void phaseTransition;
		const status = this.podSyncStatuses.get(uid);
		if (!status) {
			return;
		}

		// Kubernetes requeues through workerQueue with either no delay, normal
		// resync delay, or backoff. The simulator has no workerQueue yet, so only
		// immediately deliver already-pending updates.
		if (status.pendingUpdate && !this.stopped) {
			this.notifyPodWorker(this.podUpdates.get(uid));
			return;
		}

		if (syncError === undefined) {
			status.working = false;
		}
	}

	private requeueLastPodUpdate(uid: string, status: PodSyncStatus): void {
		if (!status.pendingUpdate && status.activeUpdate) {
			status.pendingUpdate = status.activeUpdate;
			status.working = true;
			this.notifyPodWorker(this.podUpdates.get(uid));
		}
	}

	private cleanupPodUpdates(uid: string): void {
		const podUpdates = this.podUpdates.get(uid);
		if (podUpdates) {
			podUpdates.close();
			this.podUpdates.delete(uid);
		}
	}

	private notifyPodWorker(podUpdates: Channel<void> | undefined): void {
		if (!podUpdates) {
			return;
		}
		podUpdates.trySend(undefined);
	}
}

function podUID(pod: V1Pod): string {
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

function isTerminationRequested(status: PodSyncStatus): boolean {
	return status.terminatingAt !== undefined;
}

function isTerminated(status: PodSyncStatus): boolean {
	return status.terminatedAt !== undefined;
}

function isFinished(status: PodSyncStatus): boolean {
	return status.finished;
}

function isStarted(status: PodSyncStatus): boolean {
	return status.startedAt !== undefined;
}

function podWorkType(status: PodSyncStatus): PodWorkerState {
	if (isTerminated(status)) {
		return "TerminatedPod";
	}
	if (isTerminationRequested(status)) {
		return "TerminatingPod";
	}
	return "SyncPod";
}

function isTerminalPhase(phase: NonNullable<V1Pod["status"]>["phase"]): boolean {
	return phase === "Failed" || phase === "Succeeded";
}

// Models kubernetes/pkg/kubelet/pod_workers.go calculateEffectiveGracePeriod.
function calculateEffectiveGracePeriod(
	status: PodSyncStatus,
	pod: V1Pod | undefined,
	options: KillPodOptions | undefined,
): [number, boolean] {
	let gracePeriod = status.gracePeriod;
	let overridden = false;

	const deletionGracePeriodSeconds = pod?.metadata?.deletionGracePeriodSeconds;
	if (
		deletionGracePeriodSeconds !== undefined &&
		(gracePeriod === 0 || deletionGracePeriodSeconds < gracePeriod)
	) {
		gracePeriod = deletionGracePeriodSeconds;
		overridden = true;
	}

	const override = options?.podTerminationGracePeriodSecondsOverride;
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
