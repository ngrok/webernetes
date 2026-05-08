import type { V1Pod, V1PodStatus } from "../../client";
import type { Clock } from "../../clock";
import type { PodRuntimeStatus } from "../cri";

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
	completed?: () => void;
	evict?: boolean;
	podStatusFunc?: (status: V1PodStatus) => void;
	podTerminationGracePeriodSecondsOverride?: number;
}

interface PodSyncStatus {
	syncedAt: Date;
	fullname: string;
	active: boolean;
	working: boolean;
	deleted: boolean;
	evicted: boolean;
	restartRequested: boolean;
	startedTerminating: boolean;
	finished: boolean;
	gracePeriod: number;
	terminatingAt?: Date;
	terminatedAt?: Date;
	activeUpdate?: UpdatePodOptions;
	pendingUpdate?: UpdatePodOptions;
}

type SyncPodFn = (pod: V1Pod) => Promise<void>;
type GetPodStatusFn = (pod: V1Pod) => PodRuntimeStatus;
type SyncTerminatingPodFn = (
	pod: V1Pod,
	podStatus: PodRuntimeStatus,
	gracePeriod: number | undefined,
	podStatusFunc: ((status: V1PodStatus) => void) | undefined,
) => Promise<void>;
type SyncTerminatedPodFn = (pod: V1Pod, podStatus: PodRuntimeStatus) => Promise<void>;

// Models kubernetes/pkg/kubelet/pod_workers.go podWorkers.
export class PodWorkers {
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
	updatePod(options: UpdatePodOptions): void {
		if (this.stopped) {
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
				fullname: buildPodFullName(name, namespace),
				active: false,
				working: false,
				deleted: false,
				evicted: false,
				restartRequested: false,
				startedTerminating: false,
				finished: false,
				gracePeriod: 0,
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
				options.killPodOptions?.completed?.();
				options.killPodOptions = undefined;
				break;
			case isTerminationRequested(status):
				options.killPodOptions ??= {};
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
				options.killPodOptions?.completed?.();
				options.killPodOptions = undefined;
				break;
		}

		if (status.pendingUpdate && status.pendingUpdate.startTime < options.startTime) {
			options.startTime = status.pendingUpdate.startTime;
		}

		status.pendingUpdate = options;
		status.working = true;

		if (!status.active) {
			status.active = true;
			void this.podWorkerLoop(uid, status);
		}

		if ((becameTerminating || wasGracePeriodShortened) && status.activeUpdate) {
			// Kubernetes cancels the active pod sync here. The simulator sync path is
			// not cancellable, so the pending update will be picked up by the loop.
			return;
		}
	}

	removePod(pod: V1Pod): void {
		const key = podUID(pod);
		if (key) {
			this.podSyncStatuses.delete(key);
		}
	}

	close(): void {
		this.stopped = true;
		this.podSyncStatuses.clear();
	}

	private async podWorkerLoop(key: string, status: PodSyncStatus): Promise<void> {
		while (status.pendingUpdate && !this.stopped) {
			const update = status.pendingUpdate;
			status.pendingUpdate = undefined;
			status.activeUpdate = update;
			if (update.pod) {
				if (isTerminationRequested(status)) {
					const podStatus = this.getPodStatus(update.pod);
					try {
						await this.syncTerminatingPod(
							update.pod,
							podStatus,
							update.killPodOptions?.podTerminationGracePeriodSecondsOverride,
							update.killPodOptions?.podStatusFunc,
						);
					} catch {
						status.activeUpdate = undefined;
						continue;
					}
					status.terminatedAt = this.clock.now();
					try {
						await this.syncTerminatedPod(update.pod, this.getPodStatus(update.pod));
					} catch {
						status.activeUpdate = undefined;
						continue;
					}
					status.finished = true;
					update.killPodOptions?.completed?.();
				} else {
					await this.syncPod(update.pod).catch(() => undefined);
				}
			}
			status.activeUpdate = undefined;
		}

		status.active = false;
		status.working = false;
		if (status.pendingUpdate && !this.stopped) {
			status.active = true;
			status.working = true;
			void this.podWorkerLoop(key, status);
		}
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

function buildPodFullName(name: string, namespace: string): string {
	return `${name}_${namespace}`;
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
