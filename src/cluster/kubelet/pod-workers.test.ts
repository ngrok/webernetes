// oxlint-disable jest/no-conditional-expect
import { expect, it } from "vitest";
import type { V1Pod } from "../../client";
import { newAggregate } from "../../apimachinery/pkg/util/errors/errors";
import { deepEqual } from "../../deep-equal";
import { Channel, type ReadOnlyChannel } from "../../go/channel";
import * as context from "../../go/context";
import { Mutex } from "../../go/sync/mutex";
import { wait } from "../../promise";
import { browser } from "../../test/describe";
import { newFakePassiveClock, type FakePassiveClock } from "../../utils/clock/testing/fake-clock";
import {
	newBackoffError,
	newPod,
	newPodStatus,
	type ROCache,
	type PodStatus as PodRuntimeStatus,
} from "./container";
import { networkNotReadyErrorMsg } from "./errors";
import { FakeRuntime } from "./container/testing";
import {
	createPodWorkers,
	drainAllWorkers,
	FakeQueue,
	type syncPodRecord,
} from "./kubelet-test-helpers";
import {
	calculateEffectiveGracePeriod,
	isTerminated,
	isTerminationRequested,
	newPodSyncStatus,
	newUpdatePodOptions,
	PodWorkersImpl,
	type PodSyncer,
	type PodSyncStatus,
	type PodWorkerSync,
	type SyncPodResult,
	type UpdatePodOptions,
} from "./pod-workers";

type AfterUpdateFn = () => void | Promise<void>;

function newNamedPod(uid: string, namespace: string, name: string, isStatic: boolean): V1Pod {
	if (isStatic) {
		throw new Error("static pods are not implemented in this simulator yet");
	}
	return {
		metadata: { uid, namespace, name },
		spec: {
			containers: [{ name: "container" }],
			terminationGracePeriodSeconds: 30,
		},
	};
}

// Models kubernetes/pkg/kubelet/pod_workers_test.go TestUpdatePod withLabel.
function withLabel(pod: V1Pod, label: string, value: string): V1Pod {
	pod.metadata ??= {};
	pod.metadata.labels ??= {};
	pod.metadata.labels[label] = value;
	return pod;
}

// Models kubernetes/pkg/kubelet/pod_workers_test.go TestUpdatePod withDeletionTimestamp.
function withDeletionTimestamp(pod: V1Pod, ts: Date, gracePeriod: number): V1Pod {
	pod.metadata ??= {};
	pod.metadata.deletionTimestamp = ts;
	pod.metadata.deletionGracePeriodSeconds = gracePeriod;
	return pod;
}

// Models kubernetes/pkg/kubelet/pod_workers_test.go newPodWithPhase.
function newPodWithPhase(
	uid: string,
	name: string,
	phase: NonNullable<NonNullable<V1Pod["status"]>["phase"]>,
): V1Pod {
	const pod = newNamedPod(uid, "ns", name, false);
	pod.status = { phase };
	return pod;
}

// Models kubernetes/pkg/kubelet/pod_workers_test.go terminalPhaseSync.
class terminalPhaseSync {
	readonly lock = new Mutex();
	readonly terminal = new Set<string>();

	constructor(readonly fn: PodSyncer["syncPod"]) {}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go terminalPhaseSync.SyncPod.
	async syncPod(
		ctx: context.Context,
		updateType: UpdatePodOptions["updateType"],
		pod: V1Pod | undefined,
		mirrorPod: V1Pod | undefined,
		podStatus: PodRuntimeStatus,
	): Promise<SyncPodResult> {
		const [isTerminal, , err] = await this.fn(ctx, updateType, pod, mirrorPod, podStatus);
		if (err) {
			return [false, undefined, err];
		}
		let terminal = isTerminal;
		if (!terminal) {
			await this.lock.lock();
			try {
				terminal = this.terminal.has(pod?.metadata?.uid ?? "");
			} finally {
				this.lock.unlock();
			}
		}
		return [terminal, undefined, undefined];
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go terminalPhaseSync.SetTerminal.
	async setTerminal(uid: string): Promise<void> {
		await this.lock.lock();
		try {
			this.terminal.add(uid);
		} finally {
			this.lock.unlock();
		}
	}
}

// Models kubernetes/pkg/kubelet/pod_workers_test.go newTerminalPhaseSync.
function newTerminalPhaseSync(fn: PodSyncer["syncPod"]): terminalPhaseSync {
	return new terminalPhaseSync(fn);
}

// Models kubernetes/pkg/kubelet/pod_workers_test.go WorkChannelItem.
class WorkChannelItem {
	readonly out = new Channel<void>(1);
	readonly lock = new Mutex();
	pause = false;
	queue = 0;

	// Models kubernetes/pkg/kubelet/pod_workers_test.go WorkChannelItem.Handle.
	async handle(): Promise<void> {
		await this.lock.lock();
		try {
			if (this.pause) {
				this.queue++;
				return;
			}
			this.out.trySend(undefined);
		} finally {
			this.lock.unlock();
		}
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go WorkChannelItem.Hold.
	async hold(): Promise<void> {
		await this.lock.lock();
		try {
			this.pause = true;
		} finally {
			this.lock.unlock();
		}
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go WorkChannelItem.Close.
	async close(): Promise<void> {
		await this.lock.lock();
		try {
			this.out.close();
		} finally {
			this.lock.unlock();
		}
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go WorkChannelItem.Release.
	async release(): Promise<void> {
		await this.lock.lock();
		try {
			this.pause = false;
			for (let i = 0; i < this.queue; i++) {
				this.out.trySend(undefined);
			}
			this.queue = 0;
		} finally {
			this.lock.unlock();
		}
	}
}

// Models kubernetes/pkg/kubelet/pod_workers_test.go WorkChannel.
class WorkChannel {
	readonly lock = new Mutex();
	readonly channels = new Map<string, WorkChannelItem>();

	// Models kubernetes/pkg/kubelet/pod_workers_test.go WorkChannel.Channel.
	async channel(uid: string): Promise<WorkChannelItem> {
		await this.lock.lock();
		try {
			let channel = this.channels.get(uid);
			if (!channel) {
				channel = new WorkChannelItem();
				this.channels.set(uid, channel);
			}
			return channel;
		} finally {
			this.lock.unlock();
		}
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go WorkChannel.Intercept.
	async intercept(uid: string, ch: ReadOnlyChannel<void>): Promise<ReadOnlyChannel<void>> {
		const channel = await this.channel(uid);
		await this.lock.lock();
		try {
			void (async () => {
				try {
					for await (const _ of ch) {
						await channel.handle();
					}
				} finally {
					await channel.close();
					await this.lock.lock();
					try {
						this.channels.delete(uid);
					} finally {
						this.lock.unlock();
					}
				}
			})();
			return channel.out.readOnly();
		} finally {
			this.lock.unlock();
		}
	}
}

// Models kubernetes/pkg/kubelet/pod_workers_test.go timeIncrementingWorkers.
class timeIncrementingWorkers {
	readonly holds = new Map<string, Channel<void>>();

	constructor(
		readonly w: PodWorkersImpl,
		readonly runtime: FakeRuntime,
		private readonly clock: FakePassiveClock,
	) {}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go timeIncrementingWorkers.UpdatePod.
	async updatePod(
		ctx: context.Context,
		options: UpdatePodOptions,
		...afterFns: AfterUpdateFn[]
	): Promise<void> {
		await this.w.updatePod(ctx, options);
		this.tick();
		for (const fn of afterFns) {
			await fn();
		}
		await this.drainUnpausedWorkers();
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go timeIncrementingWorkers.SyncKnownPods.
	async syncKnownPods(desiredPods: V1Pod[]): Promise<Map<string, PodWorkerSync>> {
		this.tick();
		return await this.w.syncKnownPods(desiredPods);
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go timeIncrementingWorkers.PauseWorkers.
	pauseWorkers(...uids: string[]): void {
		for (const uid of uids) {
			if (this.holds.has(uid)) {
				continue;
			}
			this.holds.set(uid, new Channel<void>());
		}
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go timeIncrementingWorkers.ReleaseWorkers.
	async releaseWorkers(...uids: string[]): Promise<void> {
		this.releaseWorkersUnderLock(...uids);
		await this.drainUnpausedWorkers();
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go timeIncrementingWorkers.ReleaseWorkersUnderLock.
	releaseWorkersUnderLock(...uids: string[]): void {
		for (const uid of uids) {
			const ch = this.holds.get(uid);
			if (!ch) {
				continue;
			}
			this.holds.delete(uid);
			ch.close();
		}
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go timeIncrementingWorkers.WaitForPod.
	async waitForPod(uid: string): Promise<void> {
		const ch = this.holds.get(uid);
		if (!ch) {
			return;
		}
		await ch.receive();
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go timeIncrementingWorkers.DrainUnpausedWorkers.
	async drainUnpausedWorkers(): Promise<void> {
		for (;;) {
			let stillWorking = false;
			for (const [uid, status] of this.w.podSyncStatuses) {
				if (this.holds.has(uid)) {
					continue;
				}
				if (status.working) {
					stillWorking = true;
					break;
				}
			}
			if (!stillWorking) {
				return;
			}
			await wait(50);
		}
	}

	// Models kubernetes/pkg/kubelet/pod_workers_test.go timeIncrementingWorkers.Tick.
	tick(): void {
		this.clock.setTime(new Date(this.clock.now().getTime() + 1000));
	}
}

// Models kubernetes/pkg/kubelet/pod_workers_test.go createTimeIncrementingPodWorkers.
function createTimeIncrementingPodWorkers(): [
	podWorkers: timeIncrementingWorkers,
	processed: Map<string, syncPodRecord[]>,
] {
	const [nested, runtime, processed, clock] = createPodWorkers();
	const podWorkers = new timeIncrementingWorkers(nested, runtime, clock);
	nested.workerChannelFn = (uid: string, inCh: ReadOnlyChannel<void>) => {
		const outCh = new Channel<void>();
		void (async () => {
			try {
				for await (const _ of inCh) {
					await podWorkers.waitForPod(uid);
					podWorkers.tick();
					await outCh.send(undefined);
				}
			} finally {
				outCh.close();
			}
		})();
		return outCh.readOnly();
	};
	return [podWorkers, processed];
}

// Models kubernetes/pkg/kubelet/pod_workers_test.go drainWorkers.
async function drainWorkers(podWorkers: PodWorkersImpl, numPods: number): Promise<void> {
	for (;;) {
		let stillWorking = false;
		for (let i = 0; i < numPods; i++) {
			const status = podWorkers.podSyncStatuses.get(String(i));
			if (status?.working) {
				stillWorking = true;
				break;
			}
		}
		if (!stillWorking) {
			return;
		}
		await wait(50);
	}
}

// Models kubernetes/pkg/kubelet/pod_workers_test.go TestUpdatePodParallel.
browser.describe("TestUpdatePodParallel", () => {
	it("runs", async () => {
		const tCtx = context.background();
		const [podWorkers, , processed] = createPodWorkers();
		try {
			const numPods = 20;
			for (let i = 0; i < numPods; i++) {
				for (let j = i; j < numPods; j++) {
					await podWorkers.updatePod(
						tCtx,
						newUpdatePodOptions({
							pod: newNamedPod(String(j), "ns", String(i), false),
							updateType: "create",
						}),
					);
				}
			}
			await drainWorkers(podWorkers, numPods);

			expect(processed.size).toBe(numPods);
			for (let i = 0; i < numPods; i++) {
				const uid = String(i);
				const events = processed.get(uid) ?? [];
				if (events.length < 1 || events.length > i + 1) {
					expect.fail(`Pod ${i} processed ${events.length} times`);
				}

				const last = events.length - 1;
				if (events[last]?.name !== String(i)) {
					expect.fail(`Pod ${i}: incorrect order ${last}, ${JSON.stringify(events)}`);
				}
			}
		} finally {
			await podWorkers.close();
		}
	});
});

// Models kubernetes/pkg/kubelet/pod_workers_test.go TestCompleteWork_Enqueue.
browser.describe("completeWork_Enqueue", () => {
	const noJitter = 0;
	const defaultBackoff = 10 * 1000;
	const resyncInterval = 20 * 1000;
	const clock = newFakePassiveClock(new Date(1_000));

	const testCases: Array<{
		name: string;
		phaseTransition?: boolean;
		syncErr?: Error;
		expectedMin: number;
		jitterFactor: number;
	}> = [
		{
			name: "phase transition requeues for immediate processing",
			phaseTransition: true,
			expectedMin: 0,
			jitterFactor: noJitter,
		},
		{
			name: "no error uses regular resync interval",
			expectedMin: resyncInterval,
			jitterFactor: 0.5,
		},
		{
			name: "generic error uses default backoff",
			syncErr: new Error("generic error"),
			expectedMin: defaultBackoff,
			jitterFactor: 0.5,
		},
		{
			name: "BackoffError uses error's backoff",
			syncErr: newBackoffError(
				new Error("backoff error"),
				new Date(clock.now().getTime() + 5 * 1000),
			),
			expectedMin: 5 * 1000,
			jitterFactor: 0.5,
		},
		{
			name: "Aggregate error with one BackoffError uses its backoff",
			syncErr: newAggregate([
				new Error("some other error"),
				newBackoffError(
					new Error("backoff error in aggregate"),
					new Date(clock.now().getTime() + 7 * 1000),
				),
			]),
			expectedMin: 7 * 1000,
			jitterFactor: 0.5,
		},
		{
			name: "Aggregate error with multiple BackoffErrors uses minimum backoff",
			syncErr: newAggregate([
				newBackoffError(new Error("backoff error 1"), new Date(clock.now().getTime() + 10 * 1000)),
				newBackoffError(new Error("backoff error 2"), new Date(clock.now().getTime() + 3 * 1000)),
			]),
			expectedMin: 3 * 1000,
			jitterFactor: 0.5,
		},
		{
			name: "BackoffError in the past enqueues for immediate processing with jitter",
			syncErr: newBackoffError(
				new Error("backoff error"),
				new Date(clock.now().getTime() - 5 * 1000),
			),
			expectedMin: 0,
			jitterFactor: 0.5,
		},
		{
			name: "Excessively long backoff duration enqueues for the maximum allowed",
			syncErr: newBackoffError(
				new Error("backoff error"),
				new Date(clock.now().getTime() + resyncInterval * 2),
			),
			expectedMin: resyncInterval,
			jitterFactor: 0.5,
		},
		{
			name: "NetworkNotReadyError uses backOffOnTransientErrorPeriod",
			syncErr: new Error(networkNotReadyErrorMsg),
			expectedMin: 1000,
			jitterFactor: 0.5,
		},
		{
			name: "Aggregate with NetworkNotReadyError",
			syncErr: newAggregate([new Error("some other error"), new Error(networkNotReadyErrorMsg)]),
			expectedMin: 1000,
			jitterFactor: 0.5,
		},
		{
			name: "Aggregate with NetworkNotReadyError and BackoffError",
			syncErr: newAggregate([
				new Error("some other error"),
				new Error(networkNotReadyErrorMsg),
				newBackoffError(new Error("backoff error 2"), new Date(clock.now().getTime() + 3 * 1000)),
			]),
			expectedMin: 1000,
			jitterFactor: 0.5,
		},
	];

	it.each(testCases)("$name", async (tc) => {
		const [podWorkers] = createPodWorkers();
		try {
			const fakeQueue = podWorkers.workQueue as FakeQueue;
			const podUID = "12345";

			podWorkers.clock = clock;
			podWorkers.resyncIntervalMs = resyncInterval;
			podWorkers.backOffPeriodMs = defaultBackoff;
			podWorkers.podSyncStatuses.set(podUID, newPodSyncStatus({}));
			await podWorkers.completeWork(podUID, tc.phaseTransition ?? false, tc.syncErr);

			expect(fakeQueue.empty()).toBe(false);
			const items = fakeQueue.items();
			expect(items).toHaveLength(1);
			const item = items[0];
			expect(item?.uid).toBe(podUID);

			const expectedMax = tc.expectedMin + tc.expectedMin * tc.jitterFactor;
			expect(item?.delay).toBeGreaterThanOrEqual(tc.expectedMin);
			expect(item?.delay).toBeLessThanOrEqual(expectedMax);
		} finally {
			await podWorkers.close();
		}
	});
});

// Models kubernetes/pkg/kubelet/pod_workers_test.go TestCompleteWork_PendingUpdate.
browser.describe("completeWork_PendingUpdate", () => {
	const podUID = "pod-with-pending-update-check";

	it("with nil pendingUpdate, clears working status", async () => {
		const [p] = createPodWorkers();
		try {
			p.podSyncStatuses.set(podUID, newPodSyncStatus({ working: true }));

			await p.completeWork(podUID, false, undefined);

			expect(p.podSyncStatuses.get(podUID)?.working).toBe(false);
		} finally {
			await p.close();
		}
	});

	it("with non-nil pendingUpdate, queues an update signal", async () => {
		const [p] = createPodWorkers();
		try {
			p.podUpdates.set(podUID, new Channel<void>(1));
			p.podSyncStatuses.set(
				podUID,
				newPodSyncStatus({
					working: true,
					pendingUpdate: {
						pod: newNamedPod("1", "ns", "running-pod", false),
					},
				}),
			);

			await p.completeWork(podUID, false, undefined);

			const queued = p.podUpdates.get(podUID)?.tryReceive();
			expect(queued?.ok).toBe(true);
		} finally {
			await p.close();
		}
	});
});

browser.describe("updatePod locking", () => {
	it("serializes updates while first-time terminal status checks await the pod cache", async () => {
		const tCtx = context.background();
		const clock = newFakePassiveClock(new Date(1_000));
		let releaseGet: (() => void) | undefined;
		let getStarted = false;
		const cache: ROCache = {
			async get(id) {
				getStarted = true;
				await new Promise<void>((resolve) => {
					releaseGet = resolve;
				});
				return [newPodStatus({ id }), undefined];
			},
			async getNewerThan(_ctx, id) {
				return [newPodStatus({ id }), undefined];
			},
		};
		const p = new PodWorkersImpl(
			clock,
			new FakeQueue(),
			60 * 1000,
			1000,
			{
				async syncPod() {
					return [false, undefined, undefined];
				},
				async syncTerminatingPod() {
					return undefined;
				},
				async syncTerminatingRuntimePod() {
					return undefined;
				},
				async syncTerminatedPod() {
					return undefined;
				},
			},
			cache,
		);
		try {
			const pod = newPodWithPhase("pod-with-lock", "pod-with-lock", "Failed");
			const first = p.updatePod(tCtx, newUpdatePodOptions({ pod, updateType: "update" }));
			await wait(0);
			expect(getStarted).toBe(true);

			let secondDone = false;
			const second = (async () => {
				await p.updatePod(tCtx, newUpdatePodOptions({ pod, updateType: "kill" }));
				secondDone = true;
			})();
			await wait(0);
			expect(secondDone).toBe(false);

			releaseGet?.();
			await first;
			await second;

			expect(p.podSyncStatuses.size).toBe(1);
			expect(secondDone).toBe(true);
		} finally {
			await p.close();
		}
	});
});

// Models kubernetes/pkg/kubelet/pod_workers_test.go TestUpdatePodForRuntimePod.
browser.describe("updatePodForRuntimePod", () => {
	it("creates synthetic pod only for runtime kill updates", async () => {
		const tCtx = context.background();
		const [podWorkers, , processed] = createPodWorkers();
		try {
			await podWorkers.updatePod(
				tCtx,
				newUpdatePodOptions({
					updateType: "create",
					runningPod: newPod({ id: "1", namespace: "test", name: "1" }),
				}),
			);
			await drainAllWorkers(podWorkers);
			expect(processed.size).toBe(0);

			await podWorkers.updatePod(
				tCtx,
				newUpdatePodOptions({
					updateType: "kill",
					runningPod: newPod({ id: "1", namespace: "test", name: "1" }),
				}),
			);
			await drainAllWorkers(podWorkers);

			const updates = processed.get("1") ?? [];
			expect(updates).toHaveLength(1);
			expect(updates[0]?.runningPod).toBeDefined();
			expect(updates[0]).toMatchObject({ name: "1", updateType: "kill" });
		} finally {
			await podWorkers.close();
		}
	});
});

// Models kubernetes/pkg/kubelet/pod_workers_test.go TestUpdatePodForTerminatedRuntimePod.
browser.describe("updatePodForTerminatedRuntimePod", () => {
	it("ignores runtime kill updates after runtime pod termination is complete", async () => {
		const tCtx = context.background();
		const [podWorkers, , processed] = createPodWorkers();
		try {
			const now = new Date();
			podWorkers.podSyncStatuses.set("1", {
				startedTerminating: true,
				terminatedAt: new Date(now.getTime() - 1000),
				terminatingAt: new Date(now.getTime() - 2000),
				gracePeriod: 1,
				// Rest are zero values
				syncedAt: now,
				fullname: "1_test",
				working: false,
				deleted: false,
				evicted: false,
				finished: false,
				restartRequested: false,
				observedRuntime: false,
				notifyPostTerminating: [],
				statusPostTerminating: [],
			});

			await podWorkers.updatePod(
				tCtx,
				newUpdatePodOptions({
					updateType: "kill",
					runningPod: newPod({ id: "1", namespace: "test", name: "1" }),
					startTime: new Date(),
				}),
			);
			await drainAllWorkers(podWorkers);

			expect(processed.get("1") ?? []).toHaveLength(0);
		} finally {
			await podWorkers.close();
		}
	});
});

// Models kubernetes/pkg/kubelet/pod_workers_test.go TestUpdatePod.
browser.describe("updatePod", () => {
	const one = 1;
	const hasCancelFn = (status: PodSyncStatus): PodSyncStatus => {
		status.cancelFn = () => {};
		return status;
	};
	const expectPodSyncStatus = (
		expected: PodSyncStatus | undefined,
		status: PodSyncStatus | undefined,
	) => {
		if (status !== undefined) {
			const e = expected?.cancelFn !== undefined;
			const a = status.cancelFn !== undefined;
			if (e !== a) {
				throw new Error(`expected cancelFn ${e}, has cancelFn ${a}`);
			} else {
				if (expected) {
					expected.cancelFn = undefined;
				}
				status.cancelFn = undefined;
			}
		}
		expect(status).toEqual(expected);
	};

	const tests: Array<{
		name: string;
		update: UpdatePodOptions;
		runtimeStatus?: PodRuntimeStatus;
		prepare?: (
			tCtx: context.Context,
			podWorkers: timeIncrementingWorkers,
		) => Promise<AfterUpdateFn | undefined>;
		expect?: PodSyncStatus;
		expectBeforeWorker?: PodSyncStatus;
		expectKnownTerminated?: boolean;
	}> = [
		{
			name: "a new pod is recorded and started",
			update: newUpdatePodOptions({
				updateType: "create",
				pod: newNamedPod("1", "ns", "running-pod", false),
			}),
			expect: hasCancelFn(
				newPodSyncStatus({
					fullname: "running-pod_ns",
					syncedAt: new Date(1_000),
					startedAt: new Date(3_000),
					activeUpdate: {
						pod: newNamedPod("1", "ns", "running-pod", false),
					},
				}),
			),
		},
		{
			name: "a new pod is recorded and started unless it is a duplicate of an existing terminating pod UID",
			update: newUpdatePodOptions({
				updateType: "create",
				pod: withLabel(newNamedPod("1", "ns", "running-pod", false), "updated", "value"),
			}),
			prepare: async (tCtx, w) => {
				await w.updatePod(
					tCtx,
					newUpdatePodOptions({
						updateType: "create",
						pod: newNamedPod("1", "ns", "running-pod", false),
					}),
				);
				w.pauseWorkers("1");
				await w.updatePod(
					tCtx,
					newUpdatePodOptions({
						updateType: "kill",
						pod: newNamedPod("1", "ns", "running-pod", false),
					}),
				);
				return () => {
					w.releaseWorkersUnderLock("1");
				};
			},
			expect: hasCancelFn(
				newPodSyncStatus({
					fullname: "running-pod_ns",
					syncedAt: new Date(1_000),
					startedAt: new Date(3_000),
					terminatingAt: new Date(3_000),
					terminatedAt: new Date(6_000),
					gracePeriod: 30,
					startedTerminating: true,
					restartRequested: true,
					finished: true,
					activeUpdate: {
						pod: newNamedPod("1", "ns", "running-pod", false),
						killPodOptions: {
							podTerminationGracePeriodSecondsOverride: 30,
						},
					},
				}),
			),
			expectKnownTerminated: true,
		},
		{
			name: "a new pod is recorded and started and running pod is ignored",
			update: newUpdatePodOptions({
				updateType: "create",
				pod: newNamedPod("1", "ns", "running-pod", false),
				runningPod: newPod({ id: "1", namespace: "ns", name: "orphaned-pod" }),
			}),
			expect: hasCancelFn(
				newPodSyncStatus({
					fullname: "running-pod_ns",
					syncedAt: new Date(1_000),
					startedAt: new Date(3_000),
					activeUpdate: {
						pod: newNamedPod("1", "ns", "running-pod", false),
					},
				}),
			),
		},
		{
			name: "a running pod is terminated when an update contains a deletionTimestamp",
			update: newUpdatePodOptions({
				updateType: "update",
				pod: withDeletionTimestamp(
					newNamedPod("1", "ns", "running-pod", false),
					new Date(1_000),
					15,
				),
			}),
			prepare: async (tCtx, w) => {
				await w.updatePod(
					tCtx,
					newUpdatePodOptions({
						updateType: "create",
						pod: newNamedPod("1", "ns", "running-pod", false),
					}),
				);
				return undefined;
			},
			expect: hasCancelFn(
				newPodSyncStatus({
					fullname: "running-pod_ns",
					syncedAt: new Date(1_000),
					startedAt: new Date(3_000),
					terminatingAt: new Date(3_000),
					terminatedAt: new Date(5_000),
					gracePeriod: 15,
					startedTerminating: true,
					finished: true,
					deleted: true,
					activeUpdate: {
						pod: withDeletionTimestamp(
							newNamedPod("1", "ns", "running-pod", false),
							new Date(1_000),
							15,
						),
						killPodOptions: {
							podTerminationGracePeriodSecondsOverride: 15,
						},
					},
				}),
			),
			expectKnownTerminated: true,
		},
		{
			name: "a running pod is terminated when an eviction is requested",
			update: newUpdatePodOptions({
				updateType: "kill",
				pod: newNamedPod("1", "ns", "running-pod", false),
				killPodOptions: {
					evict: true,
				},
			}),
			prepare: async (tCtx, podWorkers) => {
				await podWorkers.updatePod(
					tCtx,
					newUpdatePodOptions({
						updateType: "create",
						pod: newNamedPod("1", "ns", "running-pod", false),
					}),
				);
				return undefined;
			},
			expect: hasCancelFn(
				newPodSyncStatus({
					fullname: "running-pod_ns",
					syncedAt: new Date(1_000),
					startedAt: new Date(3_000),
					terminatingAt: new Date(3_000),
					terminatedAt: new Date(5_000),
					gracePeriod: 30,
					startedTerminating: true,
					finished: true,
					evicted: true,
					activeUpdate: {
						pod: newNamedPod("1", "ns", "running-pod", false),
						killPodOptions: {
							podTerminationGracePeriodSecondsOverride: 30,
							evict: true,
						},
					},
				}),
			),
			expectKnownTerminated: true,
		},
		{
			name: "a pod that is terminal and has never started must be terminated if the runtime does not have a cached terminal state",
			update: newUpdatePodOptions({
				updateType: "create",
				pod: newPodWithPhase("1", "done-pod", "Succeeded"),
			}),
			expect: hasCancelFn(
				newPodSyncStatus({
					fullname: "done-pod_ns",
					syncedAt: new Date(1_000),
					terminatingAt: new Date(1_000),
					startedAt: new Date(3_000),
					terminatedAt: new Date(3_000),
					activeUpdate: {
						pod: newPodWithPhase("1", "done-pod", "Succeeded"),
						killPodOptions: {
							podTerminationGracePeriodSecondsOverride: 30,
						},
					},
					gracePeriod: 30,
					startedTerminating: true,
					finished: true,
				}),
			),
			expectKnownTerminated: true,
		},
		{
			name: "a pod that is terminal and has never started advances to finished if the runtime has a cached terminal state",
			update: newUpdatePodOptions({
				updateType: "create",
				pod: newPodWithPhase("1", "done-pod", "Succeeded"),
			}),
			runtimeStatus: newPodStatus(),
			expectBeforeWorker: newPodSyncStatus({
				fullname: "done-pod_ns",
				syncedAt: new Date(1_000),
				terminatingAt: new Date(1_000),
				terminatedAt: new Date(1_000),
				pendingUpdate: {
					updateType: "create",
					pod: newPodWithPhase("1", "done-pod", "Succeeded"),
				},
				finished: false,
				startedTerminating: true,
				working: true,
			}),
			expect: hasCancelFn(
				newPodSyncStatus({
					fullname: "done-pod_ns",
					syncedAt: new Date(1_000),
					terminatingAt: new Date(1_000),
					terminatedAt: new Date(1_000),
					startedAt: new Date(3_000),
					startedTerminating: true,
					finished: true,
					activeUpdate: {
						updateType: "sync",
						pod: newPodWithPhase("1", "done-pod", "Succeeded"),
					},
					restartRequested: false,
				}),
			),
			expectKnownTerminated: true,
		},
		{
			name: "an orphaned running pod we have not seen is marked terminating and advances to finished and then is removed",
			update: newUpdatePodOptions({
				updateType: "kill",
				runningPod: newPod({ id: "1", namespace: "ns", name: "orphaned-pod" }),
			}),
			runtimeStatus: newPodStatus(),
			expectBeforeWorker: newPodSyncStatus({
				fullname: "orphaned-pod_ns",
				syncedAt: new Date(1_000),
				terminatingAt: new Date(1_000),
				pendingUpdate: {
					updateType: "kill",
					runningPod: newPod({ id: "1", namespace: "ns", name: "orphaned-pod" }),
					killPodOptions: {
						podTerminationGracePeriodSecondsOverride: one,
					},
				},
				gracePeriod: 1,
				deleted: true,
				observedRuntime: true,
				working: true,
			}),
			expectKnownTerminated: false,
		},
		{
			name: "an orphaned running pod with a non-kill update type does nothing",
			update: newUpdatePodOptions({
				updateType: "create",
				runningPod: newPod({ id: "1", namespace: "ns", name: "orphaned-pod" }),
			}),
			runtimeStatus: newPodStatus(),
			expect: undefined,
			expectKnownTerminated: false,
		},
	];

	it.each(tests)("$name", async (tc) => {
		let uid: string;
		if (tc.update.pod) {
			uid = tc.update.pod.metadata?.uid ?? "";
		} else if (tc.update.runningPod) {
			uid = tc.update.runningPod.id;
		} else {
			throw new Error("unable to find uid for update");
		}

		const tCtx = context.background();
		const [podWorkers] = createTimeIncrementingPodWorkers();
		try {
			const fns: AfterUpdateFn[] = [];
			if (tc.expectBeforeWorker) {
				fns.push(() => {
					expectPodSyncStatus(tc.expectBeforeWorker, podWorkers.w.podSyncStatuses.get(uid));
				});
			}
			if (tc.prepare) {
				const fn = await tc.prepare(tCtx, podWorkers);
				if (fn) {
					fns.push(fn);
				}
			}

			if (tc.runtimeStatus) {
				podWorkers.runtime.podStatus = tc.runtimeStatus;
				podWorkers.runtime.err = undefined;
			} else {
				podWorkers.runtime.podStatus = newPodStatus();
				podWorkers.runtime.err = new Error("No such pod");
			}
			fns.push(() => {
				podWorkers.runtime.podStatus = newPodStatus();
				podWorkers.runtime.err = undefined;
			});

			await podWorkers.updatePod(tCtx, tc.update, ...fns);

			expect(await podWorkers.w.isPodKnownTerminated(uid)).toBe(tc.expectKnownTerminated ?? false);
			expectPodSyncStatus(tc.expect, podWorkers.w.podSyncStatuses.get(uid));
		} finally {
			await podWorkers.w.close();
		}
	});
});

// Models kubernetes/pkg/kubelet/pod_workers_test.go TestTerminalPhaseTransition.
browser.describe("TestTerminalPhaseTransition", () => {
	it("runs", async () => {
		const tCtx = context.background();
		const [podWorkers] = createPodWorkers();
		const channels = new WorkChannel();
		podWorkers.workerChannelFn = channels.intercept.bind(channels);
		const terminalPhaseSyncer = newTerminalPhaseSync(
			podWorkers.podSyncer.syncPod.bind(podWorkers.podSyncer),
		);
		podWorkers.podSyncer.syncPod = terminalPhaseSyncer.syncPod.bind(terminalPhaseSyncer);
		try {
			await podWorkers.updatePod(
				tCtx,
				newUpdatePodOptions({
					pod: newNamedPod("1", "test1", "pod1", false),
					updateType: "update",
				}),
			);
			await drainAllWorkers(podWorkers);

			let pod1 = podWorkers.podSyncStatuses.get("1");
			if (!pod1 || isTerminated(pod1)) {
				expect.fail(`unexpected pod state: ${JSON.stringify(pod1)}`);
			}

			await podWorkers.updatePod(
				tCtx,
				newUpdatePodOptions({
					pod: newNamedPod("1", "test1", "pod1", false),
					updateType: "update",
				}),
			);
			await drainAllWorkers(podWorkers);

			pod1 = podWorkers.podSyncStatuses.get("1");
			if (!pod1 || isTerminated(pod1)) {
				expect.fail(`unexpected pod state: ${JSON.stringify(pod1)}`);
			}

			await terminalPhaseSyncer.setTerminal("1");
			await podWorkers.updatePod(
				tCtx,
				newUpdatePodOptions({
					pod: newNamedPod("1", "test1", "pod1", false),
					updateType: "update",
				}),
			);
			await drainAllWorkers(podWorkers);

			pod1 = podWorkers.podSyncStatuses.get("1");
			if (!pod1 || !isTerminationRequested(pod1) || !isTerminated(pod1)) {
				expect.fail(`unexpected pod state: ${JSON.stringify(pod1)}`);
			}
		} finally {
			await podWorkers.close();
		}
	});
});

// Models kubernetes/pkg/kubelet/pod_workers_test.go TestUpdatePodDoesNotForgetSyncPodKill.
browser.describe("updatePodDoesNotForgetSyncPodKill", () => {
	it("preserves kill update when a later update is received", async () => {
		const tCtx = context.background();
		const [podWorkers, , processed] = createPodWorkers();
		try {
			const numPods = 20;
			for (let i = 0; i < numPods; i++) {
				const uid = String(i);
				const pod = newNamedPod(uid, "ns", uid, false);
				await podWorkers.updatePod(
					tCtx,
					newUpdatePodOptions({
						pod,
						updateType: "create",
					}),
				);
				await podWorkers.updatePod(
					tCtx,
					newUpdatePodOptions({
						pod,
						updateType: "kill",
					}),
				);
				await podWorkers.updatePod(
					tCtx,
					newUpdatePodOptions({
						pod,
						updateType: "update",
					}),
				);
			}
			await drainWorkers(podWorkers, numPods);
			expect(processed.size).toBe(numPods);
			for (let i = 0; i < numPods; i++) {
				const uid = String(i);
				// each pod should be processed two or three times (kill,terminate or create,kill,terminate) because
				// we buffer pending updates and the pod worker may compress the create and kill
				const syncPodRecords = processed.get(uid);
				let match = false;
				const possible: syncPodRecord[][] = [
					[
						{ name: uid, updateType: "kill", gracePeriod: 30 },
						{ name: uid, terminated: true },
					],
					[
						{ name: uid, updateType: "create" },
						{ name: uid, updateType: "kill", gracePeriod: 30 },
						{ name: uid, terminated: true },
					],
				];
				for (const item of possible) {
					if (deepEqual(item, syncPodRecords)) {
						match = true;
						break;
					}
				}
				expect(match).toBe(true);
			}
		} finally {
			await podWorkers.close();
		}
	});
});

// Models kubernetes/pkg/kubelet/pod_workers_test.go Test_removeTerminatedWorker.
browser.describe("Test_removeTerminatedWorker", () => {
	const podUID = "pod-uid";

	const testCases: Array<{
		desc: string;
		orphan: boolean;
		podSyncStatus: PodSyncStatus;
		removed: boolean;
		expectGracePeriod: number;
		expectPending?: UpdatePodOptions;
	}> = [
		{
			desc: "finished worker",
			podSyncStatus: newPodSyncStatus({
				finished: true,
			}),
			removed: true,
			orphan: false,
			expectGracePeriod: 0,
		},
		{
			desc: "orphaned not started worker",
			podSyncStatus: newPodSyncStatus({
				finished: false,
				fullname: "fake-fullname",
			}),
			orphan: true,
			removed: true,
			expectGracePeriod: 0,
		},
		{
			desc: "orphaned started worker",
			podSyncStatus: newPodSyncStatus({
				startedAt: new Date(1_000),
				finished: false,
				fullname: "fake-fullname",
			}),
			orphan: true,
			removed: false,
			expectGracePeriod: 0,
		},
		{
			desc: "orphaned terminating worker with no activeUpdate",
			podSyncStatus: newPodSyncStatus({
				startedAt: new Date(1_000),
				terminatingAt: new Date(2_000),
				finished: false,
				fullname: "fake-fullname",
			}),
			orphan: true,
			removed: false,
			expectGracePeriod: 0,
		},
		{
			desc: "orphaned terminating worker",
			podSyncStatus: newPodSyncStatus({
				startedAt: new Date(1_000),
				terminatingAt: new Date(2_000),
				finished: false,
				fullname: "fake-fullname",
				activeUpdate: {
					pod: { metadata: { uid: podUID, name: "1" } },
				},
			}),
			orphan: true,
			removed: false,
			expectGracePeriod: 0,
			expectPending: newUpdatePodOptions({
				pod: { metadata: { uid: podUID, name: "1" } },
			}),
		},
		{
			desc: "orphaned terminating worker with pendingUpdate",
			podSyncStatus: newPodSyncStatus({
				startedAt: new Date(1_000),
				terminatingAt: new Date(2_000),
				finished: false,
				fullname: "fake-fullname",
				working: true,
				pendingUpdate: {
					pod: { metadata: { uid: podUID, name: "2" } },
				},
				activeUpdate: {
					pod: { metadata: { uid: podUID, name: "1" } },
				},
			}),
			orphan: true,
			removed: false,
			expectGracePeriod: 0,
			expectPending: newUpdatePodOptions({
				pod: { metadata: { uid: podUID, name: "2" } },
			}),
		},
		{
			desc: "orphaned terminated worker with no activeUpdate",
			podSyncStatus: newPodSyncStatus({
				startedAt: new Date(1_000),
				terminatingAt: new Date(2_000),
				terminatedAt: new Date(3_000),
				finished: false,
				fullname: "fake-fullname",
			}),
			orphan: true,
			removed: false,
			expectGracePeriod: 0,
		},
		{
			desc: "orphaned terminated worker",
			podSyncStatus: newPodSyncStatus({
				startedAt: new Date(1_000),
				terminatingAt: new Date(2_000),
				terminatedAt: new Date(3_000),
				finished: false,
				fullname: "fake-fullname",
				activeUpdate: {
					pod: { metadata: { uid: podUID, name: "1" } },
				},
			}),
			orphan: true,
			removed: false,
			expectGracePeriod: 0,
			expectPending: newUpdatePodOptions({
				pod: { metadata: { uid: podUID, name: "1" } },
			}),
		},
		{
			desc: "orphaned terminated worker with pendingUpdate",
			podSyncStatus: newPodSyncStatus({
				startedAt: new Date(1_000),
				terminatingAt: new Date(2_000),
				terminatedAt: new Date(3_000),
				finished: false,
				working: true,
				fullname: "fake-fullname",
				pendingUpdate: {
					pod: { metadata: { uid: podUID, name: "2" } },
				},
				activeUpdate: {
					pod: { metadata: { uid: podUID, name: "1" } },
				},
			}),
			orphan: true,
			removed: false,
			expectGracePeriod: 0,
			expectPending: newUpdatePodOptions({
				pod: { metadata: { uid: podUID, name: "2" } },
			}),
		},
	];

	it.each(testCases)("$desc", async (tc) => {
		const normalizeUpdatePodOptions = (
			opts: UpdatePodOptions | undefined,
		): UpdatePodOptions | undefined => {
			if (!opts) {
				return undefined;
			}
			return { ...opts };
		};

		const [podWorkers] = createPodWorkers();
		try {
			podWorkers.podSyncStatuses.set(podUID, tc.podSyncStatus);
			podWorkers.podUpdates.set(podUID, new Channel<void>(1));
			if (tc.podSyncStatus.working) {
				podWorkers.podUpdates.get(podUID)?.trySend(undefined);
			}

			const podSyncStatus = podWorkers.podSyncStatuses.get(podUID);
			if (!podSyncStatus) {
				expect.fail("Expected pod worker status to exist");
			}

			podWorkers.removeTerminatedWorker(podUID, podSyncStatus, tc.orphan);
			const status = podWorkers.podSyncStatuses.get(podUID);
			const exists = status !== undefined;
			if (tc.removed && exists) {
				expect.fail("Expected pod worker to be removed");
			}
			if (!tc.removed && !exists) {
				expect.fail("Expected pod worker to not be removed");
			}
			if (tc.removed) {
				return;
			}
			if (!status) {
				expect.fail("Expected pod worker status to exist");
			}
			if (tc.expectGracePeriod > 0 && status.gracePeriod !== tc.expectGracePeriod) {
				expect.fail(`Unexpected grace period ${status.gracePeriod}`);
			}
			const expectedPending = normalizeUpdatePodOptions(tc.expectPending);
			const actualPending = normalizeUpdatePodOptions(status.pendingUpdate);
			if (!deepEqual(expectedPending, actualPending)) {
				expect.fail(`Unexpected pending: ${JSON.stringify(actualPending)}`);
			}
			if (tc.expectPending) {
				if (!status.working) {
					expect.fail("Should be working");
				}
				if (podWorkers.podUpdates.get(podUID)?.tryReceive()?.ok !== true) {
					expect.fail("Should have one entry in podUpdates");
				}
			}
		} finally {
			await podWorkers.close();
		}
	});
});

// Models kubernetes/pkg/kubelet/pod_workers_test.go Test_calculateEffectiveGracePeriod.
browser.describe("Test_calculateEffectiveGracePeriod", () => {
	const zero = 0;
	const two = 2;
	const five = 5;
	const thirty = 30;
	const testCases: Array<{
		desc: string;
		podSpecTerminationGracePeriodSeconds?: number;
		podDeletionGracePeriodSeconds?: number;
		gracePeriodOverride?: number;
		expectedGracePeriod: number;
	}> = [
		{
			desc: "use termination grace period from the spec when no overrides",
			podSpecTerminationGracePeriodSeconds: thirty,
			expectedGracePeriod: thirty,
		},
		{
			desc: "use pod DeletionGracePeriodSeconds when set",
			podSpecTerminationGracePeriodSeconds: thirty,
			podDeletionGracePeriodSeconds: five,
			expectedGracePeriod: five,
		},
		{
			desc: "use grace period override when set",
			podSpecTerminationGracePeriodSeconds: thirty,
			podDeletionGracePeriodSeconds: five,
			gracePeriodOverride: two,
			expectedGracePeriod: two,
		},
		{
			desc: "use 1 when pod DeletionGracePeriodSeconds is zero",
			podSpecTerminationGracePeriodSeconds: thirty,
			podDeletionGracePeriodSeconds: zero,
			expectedGracePeriod: 1,
		},
		{
			desc: "use 1 when grace period override is zero",
			podSpecTerminationGracePeriodSeconds: thirty,
			podDeletionGracePeriodSeconds: five,
			gracePeriodOverride: zero,
			expectedGracePeriod: 1,
		},
	];

	it.each(testCases)("$desc", (tc) => {
		const pod = newNamedPod("1", "ns", "running-pod", false);
		pod.spec ??= { containers: [] };
		pod.spec.terminationGracePeriodSeconds = tc.podSpecTerminationGracePeriodSeconds;
		pod.metadata ??= {};
		pod.metadata.deletionGracePeriodSeconds = tc.podDeletionGracePeriodSeconds;
		const [gracePeriod] = calculateEffectiveGracePeriod(newPodSyncStatus({}), pod, {
			podTerminationGracePeriodSecondsOverride: tc.gracePeriodOverride,
		});
		if (gracePeriod !== tc.expectedGracePeriod) {
			expect.fail(`Expected a grace period of ${tc.expectedGracePeriod}, but was ${gracePeriod}`);
		}
	});
});

// Models kubernetes/pkg/kubelet/pod_workers_test.go TestSyncKnownPods.
browser.describe("syncKnownPods", () => {
	it("tracks lifecycle query state while forgetting terminated workers", async () => {
		const tCtx = context.background();
		const [podWorkers] = createPodWorkers();
		try {
			const numPods = 20;
			for (let i = 0; i < numPods; i++) {
				await podWorkers.updatePod(
					tCtx,
					newUpdatePodOptions({
						pod: newNamedPod(String(i), "ns", "name", false),
						updateType: "update",
					}),
				);
			}
			await drainWorkers(podWorkers, numPods);

			expect(podWorkers.podUpdates.size).toBe(numPods);

			const desiredPods = new Set(["2", "14"]);
			const desiredPodList = [
				newNamedPod("2", "ns", "name", false),
				newNamedPod("14", "ns", "name", false),
			];

			for (let i = 0; i < numPods; i++) {
				const pod = newNamedPod(String(i), "ns", "name", false);
				if (desiredPods.has(pod.metadata?.uid ?? "")) {
					continue;
				}
				if (i % 2 === 0) {
					pod.metadata ??= {};
					pod.metadata.deletionTimestamp = new Date();
				}
				await podWorkers.updatePod(
					tCtx,
					newUpdatePodOptions({
						pod,
						updateType: "kill",
					}),
				);
			}
			await drainWorkers(podWorkers, numPods);

			expect(await podWorkers.shouldPodContainersBeTerminating("0")).toBe(true);
			expect(await podWorkers.shouldPodContainersBeTerminating("1")).toBe(true);
			expect(await podWorkers.shouldPodContainersBeTerminating("2")).toBe(false);
			expect(await podWorkers.isPodTerminationRequested("0")).toBe(true);
			expect(await podWorkers.isPodTerminationRequested("2")).toBe(false);

			expect(await podWorkers.couldHaveRunningContainers("0")).toBe(false);
			expect(await podWorkers.couldHaveRunningContainers("1")).toBe(false);
			expect(await podWorkers.couldHaveRunningContainers("2")).toBe(true);

			expect(await podWorkers.shouldPodContentBeRemoved("0")).toBe(true);
			expect(await podWorkers.shouldPodContentBeRemoved("1")).toBe(false);
			expect(await podWorkers.shouldPodContentBeRemoved("2")).toBe(false);

			expect(await podWorkers.shouldPodContainersBeTerminating("abc")).toBe(false);
			expect(await podWorkers.couldHaveRunningContainers("abc")).toBe(true);
			expect(await podWorkers.shouldPodContentBeRemoved("abc")).toBe(false);

			await podWorkers.syncKnownPods(desiredPodList);
			expect(podWorkers.podUpdates.size).toBe(2);
			expect(podWorkers.podUpdates.has("2")).toBe(true);
			expect(podWorkers.podUpdates.has("14")).toBe(true);
			expect(await podWorkers.isPodTerminationRequested("2")).toBe(false);

			expect(await podWorkers.shouldPodContainersBeTerminating("abc")).toBe(true);
			expect(await podWorkers.couldHaveRunningContainers("abc")).toBe(false);
			expect(await podWorkers.shouldPodContentBeRemoved("abc")).toBe(true);

			await podWorkers.syncKnownPods([]);
			await drainAllWorkers(podWorkers);
			expect(podWorkers.podUpdates.size).toBe(0);
			expect(podWorkers.podSyncStatuses.size).toBe(2);

			for (const uid of desiredPods) {
				await podWorkers.updatePod(
					tCtx,
					newUpdatePodOptions({
						pod: newNamedPod(uid, "ns", "name", false),
						updateType: "kill",
					}),
				);
			}
			await drainWorkers(podWorkers, numPods);

			await podWorkers.syncKnownPods([]);
			expect(podWorkers.podUpdates.size).toBe(0);
			expect(podWorkers.podSyncStatuses.size).toBe(0);
		} finally {
			await podWorkers.close();
		}
	});
});
