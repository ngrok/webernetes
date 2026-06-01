import { expect, it } from "vitest";
import type { V1Pod } from "../../client";
import { Clock } from "../../clock";
import { deepEqual } from "../../deep-equal";
import * as context from "../../go/context";
import { browser } from "../../test/describe";
import { ContainerID, type Pod as RuntimePod } from "./container";
import { FakeRuntime, newFakeCache } from "./container/testing";
import { PodWorkers, type UpdatePodOptions } from "./pod-workers";
import { BasicWorkQueue } from "./util/queue/work-queue";
import { wait } from "../../promise";

interface SyncPodRecord {
	name: string;
	updateType?: UpdatePodOptions["updateType"];
	gracePeriod?: number;
	runningPod?: RuntimePod;
	terminated?: boolean;
}

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

function newRuntimePod(uid: string, namespace: string, name: string): RuntimePod {
	return {
		id: uid,
		namespace,
		name,
		createdAt: 0,
		timestamp: new Date(0),
		containers: [
			{
				id: new ContainerID("test", "container"),
				name: "container",
				image: "",
				imageID: "",
				imageRef: "",
				imageRuntimeHandler: "",
				hash: 0,
				state: "Running",
				podSandboxID: "sandbox",
				createdAt: 0,
			},
		],
		sandboxes: [],
	};
}

function createPodWorkers(): [
	podWorkers: PodWorkers,
	fakeRuntime: FakeRuntime,
	processed: Map<string, SyncPodRecord[]>,
] {
	const clock = new Clock();
	const fakeRuntime = new FakeRuntime();
	const fakeCache = newFakeCache(fakeRuntime);
	const processed = new Map<string, SyncPodRecord[]>();
	const record = (uid: string, update: SyncPodRecord) => {
		processed.set(uid, [...(processed.get(uid) ?? []), update]);
	};
	const podWorkers = new PodWorkers(
		clock,
		new BasicWorkQueue(clock),
		60 * 1000,
		1000,
		{
			async syncPod(_ctx, updateType, pod) {
				const uid = pod.metadata?.uid ?? "";
				record(uid, { name: pod.metadata?.name ?? "", updateType });
				return [false, undefined, undefined];
			},
			async syncTerminatingPod(_ctx, pod, _podStatus, gracePeriod) {
				const uid = pod.metadata?.uid ?? "";
				record(uid, {
					name: pod.metadata?.name ?? "",
					updateType: "kill",
					gracePeriod,
				});
			},
			async syncTerminatingRuntimePod(_ctx, runningPod) {
				record(runningPod.id, {
					name: runningPod.name,
					updateType: "kill",
					runningPod,
				});
			},
			async syncTerminatedPod(_ctx, pod) {
				const uid = pod.metadata?.uid ?? "";
				record(uid, { name: pod.metadata?.name ?? "", terminated: true });
			},
		},
		fakeCache,
	);
	return [podWorkers, fakeRuntime, processed];
}

// Models kubernetes/pkg/kubelet/pod_workers_test.go drainWorkers.
async function drainWorkers(podWorkers: PodWorkers, numPods: number): Promise<void> {
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

// Models kubernetes/pkg/kubelet/pod_workers_test.go drainAllWorkers.
async function drainAllWorkers(podWorkers: PodWorkers): Promise<void> {
	for (;;) {
		let stillWorking = false;
		for (const status of podWorkers.podSyncStatuses.values()) {
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

// Models kubernetes/pkg/kubelet/pod_workers_test.go TestUpdatePodForRuntimePod.
browser.describe("updatePodForRuntimePod", () => {
	it("creates synthetic pod only for runtime kill updates", async () => {
		const tCtx = context.background();
		const [podWorkers, , processed] = createPodWorkers();
		try {
			await podWorkers.updatePod(tCtx, {
				updateType: "create",
				runningPod: newRuntimePod("1", "test", "1"),
				startTime: new Date(0),
			});
			await drainAllWorkers(podWorkers);
			expect(processed.size).toBe(0);

			await podWorkers.updatePod(tCtx, {
				updateType: "kill",
				runningPod: newRuntimePod("1", "test", "1"),
				startTime: new Date(0),
			});
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

			await podWorkers.updatePod(tCtx, {
				updateType: "kill",
				runningPod: newRuntimePod("1", "test", "1"),
				startTime: new Date(),
			});
			await drainAllWorkers(podWorkers);

			expect(processed.get("1") ?? []).toHaveLength(0);
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
				await podWorkers.updatePod(tCtx, {
					pod,
					updateType: "create",
					startTime: new Date(),
				});
				await podWorkers.updatePod(tCtx, {
					pod,
					updateType: "kill",
					startTime: new Date(),
				});
				await podWorkers.updatePod(tCtx, {
					pod,
					updateType: "update",
					startTime: new Date(),
				});
			}
			await drainWorkers(podWorkers, numPods);
			expect(processed.size).toBe(numPods);
			for (let i = 0; i < numPods; i++) {
				const uid = String(i);
				// each pod should be processed two or three times (kill,terminate or create,kill,terminate) because
				// we buffer pending updates and the pod worker may compress the create and kill
				const syncPodRecords = processed.get(uid);
				let match = false;
				const possible: SyncPodRecord[][] = [
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
