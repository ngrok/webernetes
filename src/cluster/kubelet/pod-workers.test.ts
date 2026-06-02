import { expect, it } from "vitest";
import type { V1Pod } from "../../client";
import { deepEqual } from "../../deep-equal";
import { Channel, type ReadOnlyChannel } from "../../go/channel";
import * as context from "../../go/context";
import { wait } from "../../promise";
import { browser } from "../../test/describe";
import type { FakePassiveClock } from "../../utils/clock/testing/fake-clock";
import { newPod, newPodStatus, type PodStatus as PodRuntimeStatus } from "./container";
import { FakeRuntime } from "./container/testing";
import { createPodWorkers, drainAllWorkers, type syncPodRecord } from "./kubelet-test-helpers";
import {
	newPodSyncStatus,
	newUpdatePodOptions,
	PodWorkersImpl,
	type PodSyncStatus,
	type PodWorkerSync,
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
		return this.w.syncKnownPods(desiredPods);
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

			expect(podWorkers.w.isPodKnownTerminated(uid)).toBe(tc.expectKnownTerminated ?? false);
			expectPodSyncStatus(tc.expect, podWorkers.w.podSyncStatuses.get(uid));
		} finally {
			await podWorkers.w.close();
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
