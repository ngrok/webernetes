/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import {
	type V1ContainerStatus,
	type V1Pod,
	type V1PodStatus,
	type V1Probe,
} from "../../../client";
import { getClock } from "../../../clock-context";
import { Channel, select } from "../../../go/channel";
import * as context from "../../../go/context";
import { browser } from "../../../test/describe";
import { newContainerID, parseContainerID } from "../container";
import { ProbeManagerImpl } from "./prober-manager";
import { type ProbeKey, type ProbeUpdate } from "./results";
import {
	getTestPod,
	getTestRunningStatus,
	newTestManager,
	newTestWorker,
	setTestProbe,
	SyncExecProber,
	testContainerID,
	testContainerName,
	testPodUID,
} from "./common.test";

// Models kubernetes/pkg/kubelet/prober/prober_manager_test.go defaultProbe.
const defaultProbe: V1Probe = {
	exec: {},
	timeoutSeconds: 1,
	periodSeconds: 1,
	successThreshold: 1,
	failureThreshold: 3,
};

const interval = 1000;
const foreverTestTimeout = 30_000;

// Models kubernetes/pkg/kubelet/prober/prober_manager_test.go TestAddRemovePods.
browser.describe("TestAddRemovePods", ({ ctx }) => {
	it("adds and removes regular-container probes", async () => {
		const m = newTestManager(ctx);
		try {
			const noProbePod: V1Pod = {
				metadata: {
					uid: "no_probe_pod",
				},
				spec: {
					containers: [{ name: "no_probe1" }, { name: "no_probe2" }, { name: "no_probe3" }],
				},
			};

			const probePod: V1Pod = {
				metadata: {
					uid: "probe_pod",
				},
				spec: {
					containers: [
						{ name: "probe1" },
						{ name: "readiness", readinessProbe: defaultProbe },
						{ name: "probe2" },
						{ name: "liveness", livenessProbe: defaultProbe },
						{ name: "probe3" },
						{ name: "startup", startupProbe: defaultProbe },
					],
				},
			};

			expectProbes(m, []);

			m.addPod(ctx, noProbePod);
			expectProbes(m, []);

			m.addPod(ctx, probePod);
			const probePaths: ProbeKey[] = [
				{ podUid: "probe_pod", containerName: "readiness", probeType: "readiness" },
				{ podUid: "probe_pod", containerName: "liveness", probeType: "liveness" },
				{ podUid: "probe_pod", containerName: "startup", probeType: "startup" },
			];
			expectProbes(m, probePaths);

			m.removePod(noProbePod);
			expectProbes(m, probePaths);

			m.removePod(probePod);
			await waitForWorkerExit(ctx, m, probePaths);
			expectProbes(m, []);

			m.removePod(probePod);
			expectProbes(m, []);
		} finally {
			await cleanup(ctx, m);
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/prober_manager_test.go TestCleanupPods.
browser.describe("TestCleanupPods", ({ ctx }) => {
	it("cleans up probes whose pod UID is not desired", async () => {
		const m = newTestManager(ctx);
		try {
			const podToCleanup: V1Pod = {
				metadata: { uid: "pod_cleanup" },
				spec: {
					containers: [
						{ name: "prober1", readinessProbe: defaultProbe },
						{ name: "prober2", livenessProbe: defaultProbe },
						{ name: "prober3", startupProbe: defaultProbe },
					],
				},
			};
			const podToKeep: V1Pod = {
				metadata: { uid: "pod_keep" },
				spec: {
					containers: [
						{ name: "prober1", readinessProbe: defaultProbe },
						{ name: "prober2", livenessProbe: defaultProbe },
						{ name: "prober3", startupProbe: defaultProbe },
					],
				},
			};
			m.addPod(ctx, podToCleanup);
			m.addPod(ctx, podToKeep);

			const desiredPods = new Set<string>();
			desiredPods.add(podToKeep.metadata?.uid ?? "");
			m.cleanupPods(desiredPods);

			const removedProbes: ProbeKey[] = [
				{ podUid: "pod_cleanup", containerName: "prober1", probeType: "readiness" },
				{ podUid: "pod_cleanup", containerName: "prober2", probeType: "liveness" },
				{ podUid: "pod_cleanup", containerName: "prober3", probeType: "startup" },
			];
			const expectedProbes: ProbeKey[] = [
				{ podUid: "pod_keep", containerName: "prober1", probeType: "readiness" },
				{ podUid: "pod_keep", containerName: "prober2", probeType: "liveness" },
				{ podUid: "pod_keep", containerName: "prober3", probeType: "startup" },
			];
			await waitForWorkerExit(ctx, m, removedProbes);
			expectProbes(m, expectedProbes);
		} finally {
			await cleanup(ctx, m);
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/prober_manager_test.go TestCleanupRepeated.
browser.describe("TestCleanupRepeated", ({ ctx }) => {
	it("repeatedly cleans up workers", async () => {
		const m = newTestManager(ctx);
		try {
			const podTemplate: V1Pod = {
				spec: {
					containers: [
						{
							name: "prober1",
							readinessProbe: defaultProbe,
							livenessProbe: defaultProbe,
							startupProbe: defaultProbe,
						},
					],
				},
			};

			const numTestPods = 100;
			for (let i = 0; i < numTestPods; i++) {
				const pod = structuredClone(podTemplate);
				pod.metadata = { uid: String(i) };
				m.addPod(ctx, pod);
			}

			for (let i = 0; i < 10; i++) {
				m.cleanupPods(new Set());
			}
		} finally {
			await cleanup(ctx, m);
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/prober_manager_test.go TestUpdatePodStatus.
browser.describe("TestUpdatePodStatus", ({ ctx }) => {
	it("updates readiness from cached regular-container probe results", async () => {
		const m = newTestManager(ctx);

		const unprobed = runningContainerStatus("unprobed_container");
		const probedReady = runningContainerStatus("probed_container_ready");
		const probedPending = runningContainerStatus("probed_container_pending");
		const probedUnready = runningContainerStatus("probed_container_unready");
		const notStartedNoReadiness = runningContainerStatus("not_started_container_no_readiness");
		const startedNoReadiness = runningContainerStatus("started_container_no_readiness");
		const terminated = runningContainerStatus("terminated_container", {
			state: { terminated: { exitCode: 0 } },
		});
		const podStatus: V1PodStatus = {
			phase: "Running",
			containerStatuses: [
				unprobed,
				probedReady,
				probedPending,
				probedUnready,
				notStartedNoReadiness,
				startedNoReadiness,
				terminated,
			],
		};

		m.workers.set(
			{ podUid: testPodUID, containerName: unprobed.name, probeType: "liveness" },
			newTestWorker(m, "liveness", {}),
		);
		m.workers.set(
			{ podUid: testPodUID, containerName: probedReady.name, probeType: "readiness" },
			newTestWorker(m, "readiness", {}),
		);
		m.workers.set(
			{ podUid: testPodUID, containerName: probedPending.name, probeType: "readiness" },
			newTestWorker(m, "readiness", {}),
		);
		m.workers.set(
			{ podUid: testPodUID, containerName: probedUnready.name, probeType: "readiness" },
			newTestWorker(m, "readiness", {}),
		);
		m.workers.set(
			{ podUid: testPodUID, containerName: notStartedNoReadiness.name, probeType: "startup" },
			newTestWorker(m, "startup", {}),
		);
		m.workers.set(
			{ podUid: testPodUID, containerName: startedNoReadiness.name, probeType: "startup" },
			newTestWorker(m, "startup", {}),
		);
		m.workers.set(
			{ podUid: testPodUID, containerName: terminated.name, probeType: "readiness" },
			newTestWorker(m, "readiness", {}),
		);
		await m.readinessManager.set(parseContainerID(probedReady.containerID), "success", {});
		await m.readinessManager.set(parseContainerID(probedUnready.containerID), "failure", {});
		await m.startupManager.set(parseContainerID(startedNoReadiness.containerID), "success", {});
		await m.readinessManager.set(parseContainerID(terminated.containerID), "success", {});

		m.updatePodStatus(
			ctx,
			{
				metadata: { uid: testPodUID },
				spec: {
					containers: [
						{ name: unprobed.name },
						{ name: probedReady.name },
						{ name: probedPending.name },
						{ name: probedUnready.name },
						{ name: notStartedNoReadiness.name },
						{ name: startedNoReadiness.name },
						{ name: terminated.name },
					],
				},
			},
			podStatus,
		);

		const expectedReadiness = new Map<string, boolean>([
			[unprobed.name, true],
			[probedReady.name, true],
			[probedPending.name, false],
			[probedUnready.name, false],
			[notStartedNoReadiness.name, false],
			[startedNoReadiness.name, true],
			[terminated.name, false],
		]);
		for (const c of podStatus.containerStatuses ?? []) {
			expect(c.ready).toBe(expectedReadiness.get(c.name));
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/prober_manager_test.go TestUpdateReadiness.
browser.describe("TestUpdateReadiness", ({ ctx }) => {
	it("updates container readiness from worker readiness updates", async () => {
		const testPod = getTestPod();
		setTestProbe(testPod, "readiness", {});
		const m = newTestManager(ctx);
		const readinessHandling = startReadinessHandling(m);
		try {
			const exec = new SyncExecProber("success", undefined);
			m.prober.exec = exec;

			await m.statusManager.setPodStatus(testPod, getTestRunningStatus());

			m.addPod(ctx, testPod);
			const probePaths: ProbeKey[] = [
				{ podUid: testPodUID, containerName: testContainerName, probeType: "readiness" },
			];
			expectProbes(m, probePaths);

			await waitForReadyStatus(ctx, m, true);

			exec.set("failure", undefined);
			await waitForReadyStatus(ctx, m, false);
		} finally {
			await readinessHandling.stop();
			await cleanup(ctx, m);
		}
	});
});

function runningContainerStatus(
	name: string,
	overrides: Partial<V1ContainerStatus> = {},
): V1ContainerStatus {
	return {
		name,
		containerID: `test://${name}_id`,
		image: "",
		imageID: "",
		ready: false,
		restartCount: 0,
		state: {
			running: {},
		},
		...overrides,
	};
}

// Models kubernetes/pkg/kubelet/prober/prober_manager_test.go expectProbes.
function expectProbes(m: ProbeManagerImpl, expectedProbes: ProbeKey[]): void {
	const unexpected: ProbeKey[] = [];
	const missing = [...expectedProbes];

	outer: for (const [probePath] of m.workers) {
		for (let i = 0; i < missing.length; i++) {
			const expectedPath = missing[i];
			if (expectedPath && probeKeyEqual(probePath, expectedPath)) {
				missing.splice(i, 1);
				continue outer;
			}
		}
		unexpected.push(probePath);
	}

	expect({ unexpected, missing }).toEqual({ unexpected: [], missing: [] });
}

// Models kubernetes/pkg/kubelet/prober/prober_manager_test.go waitForWorkerExit.
async function waitForWorkerExit(
	ctx: context.Context,
	m: ProbeManagerImpl,
	workerPaths: ProbeKey[],
): Promise<void> {
	for (const w of workerPaths) {
		const condition = () => m.getWorker(w.podUid, w.containerName, w.probeType) === undefined;
		if (condition()) {
			continue;
		}
		await poll(ctx, interval, foreverTestTimeout, condition);
	}
}

// Models kubernetes/pkg/kubelet/prober/prober_manager_test.go cleanup.
async function cleanup(ctx: context.Context, m: ProbeManagerImpl): Promise<void> {
	m.cleanupPods(new Set());
	const condition = () => m.workerCount() === 0;
	if (!condition()) {
		await poll(ctx, interval, foreverTestTimeout, condition);
	}
	await m.close();
	expect(m.workerCount()).toBe(0);
}

function probeKeyEqual(left: ProbeKey, right: ProbeKey): boolean {
	return (
		left.podUid === right.podUid &&
		left.containerName === right.containerName &&
		left.probeType === right.probeType
	);
}

// Models kubernetes/pkg/kubelet/prober/prober_manager_test.go waitForReadyStatus.
async function waitForReadyStatus(
	ctx: context.Context,
	m: ProbeManagerImpl,
	ready: boolean,
): Promise<void> {
	const condition = async () => {
		const status = m.statusManager.getPodStatus(testPodUID);
		const containerStatus = status?.containerStatuses?.[0];
		if (!status) {
			throw new Error(`status not found: ${testPodUID}`);
		}
		if ((status.containerStatuses ?? []).length !== 1) {
			throw new Error(
				`expected single container, found ${(status.containerStatuses ?? []).length}`,
			);
		}
		if (containerStatus?.containerID !== testContainerID.toString()) {
			throw new Error(
				`expected container ${testContainerID}, found ${containerStatus?.containerID}`,
			);
		}
		return containerStatus.ready === ready;
	};
	await poll(ctx, interval, foreverTestTimeout, condition);
}

function startReadinessHandling(m: ProbeManagerImpl): { stop(): Promise<void> } {
	const stopCh = new Channel<void>(1);
	const done = (async () => {
		for (;;) {
			const selected = await select()
				.case(stopCh, () => ({ type: "stop" }) as const)
				.case(m.readinessManager.updates(), (update) => ({ type: "update", update }) as const);
			if (selected.type === "stop") {
				return;
			}
			if (selected.update.ok) {
				await extractedReadinessHandling(m, selected.update.value);
			}
		}
	})();
	return {
		async stop(): Promise<void> {
			stopCh.trySend(undefined);
			await m.readinessManager.set(newContainerID(), "success", {});
			await done;
		},
	};
}

// Models kubernetes/pkg/kubelet/prober/prober_manager_test.go extractedReadinessHandling.
async function extractedReadinessHandling(m: ProbeManagerImpl, update: ProbeUpdate): Promise<void> {
	const ready = update.result === "success";
	await m.statusManager.setContainerReadiness(update.podUid, update.containerId, ready);
}

async function poll(
	ctx: context.Context,
	intervalMs: number,
	timeoutMs: number,
	condition: () => boolean | Promise<boolean>,
): Promise<void> {
	const clock = getClock(ctx);
	const deadline = clock.nowMs() + timeoutMs;
	for (;;) {
		if (await condition()) {
			return;
		}
		if (clock.nowMs() >= deadline) {
			expect(await condition()).toBe(true);
			return;
		}
		await Promise.resolve();
		clock.step(Math.min(intervalMs, deadline - clock.nowMs()));
		await Promise.resolve();
	}
}
