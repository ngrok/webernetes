// oxlint-disable jest/expect-expect
import { expect, it } from "vitest";

import {
	KubeConfig,
	type V1Container,
	type V1ContainerStatus,
	type V1Pod,
	type V1PodStatus,
	type V1Probe,
} from "../../../client";
import { FakeRecorder } from "../../../client-go/tools/record/fake";
import { Clock } from "../../../clock";
import { Channel, select } from "../../../go/channel";
import * as context from "../../../go/context";
import { browser } from "../../../test/describe";
import type { ExecProbe, ProbeResult } from "../../probe";
import { ClusterNetwork } from "../../cni";
import { Etcd } from "../../etcd";
import { KubeClient } from "../../cluster";
import { buildContainerID, type ContainerID, newContainerID, parseContainerID } from "../container";
import { PodManager } from "../pod";
import { StatusManager } from "../status";
import { ProbeWorker } from "./worker";
import { ProbeManagerImpl } from "./prober-manager";
import { ResultsManager, type ProbeKey, type ProbeType, type ProbeUpdate } from "./results";

// Models kubernetes/pkg/kubelet/prober/prober_manager_test.go defaultProbe.
const defaultProbe: V1Probe = {
	exec: {},
	timeoutSeconds: 1,
	periodSeconds: 1,
	successThreshold: 1,
	failureThreshold: 3,
};

const testPodUID = "test_pod";
const testContainerName = "test_container";
const testContainerID = buildContainerID("test", "test_container_id");
const interval = 1000;
const foreverTestTimeout = 30_000;

// Models kubernetes/pkg/kubelet/prober/common_test.go newTestManager.
function newTestManager(): ProbeManagerImpl {
	const clock = new Clock();
	clock.pause();
	const kubeConfig = new KubeConfig({
		clock,
		etcd: new Etcd(clock),
		nodePortRange: { from: 30000, to: 32767 },
	});
	const podManager = new PodManager();
	podManager.addPod(getTestPod());
	const statusManager = new StatusManager({
		clock,
		kubeClient: new KubeClient(kubeConfig),
		podManager,
	});
	return new ProbeManagerImpl(
		statusManager,
		new ResultsManager(),
		new ResultsManager(),
		new ResultsManager(),
		undefined,
		new FakeRecorder(),
		clock,
		new ClusterNetwork(),
	);
}

// Models kubernetes/pkg/kubelet/prober/common_test.go syncExecProber.
class SyncExecProber implements ExecProbe {
	constructor(
		private result: ProbeResult,
		private err: Error | undefined,
	) {}

	set(result: ProbeResult, err: Error | undefined): void {
		this.result = result;
		this.err = err;
	}

	async probe(
		_ctx: context.Context,
		_containerId: ContainerID,
		_container: V1Container,
		_action: NonNullable<V1Probe["exec"]>,
		_timeoutMs: number,
	): Promise<[ProbeResult, string, Error | undefined]> {
		return [this.result, "", this.err];
	}
}

// Models kubernetes/pkg/kubelet/prober/common_test.go getTestPod.
function getTestPod(): V1Pod {
	return {
		metadata: {
			uid: testPodUID,
			name: "testPod",
			namespace: "testNamespace",
		},
		spec: {
			restartPolicy: "Always",
			containers: [
				{
					name: testContainerName,
				},
			],
		},
	};
}

// Models kubernetes/pkg/kubelet/prober/common_test.go getTestRunningStatusWithStarted.
function containerStatus(status: Partial<V1ContainerStatus> = {}): V1ContainerStatus {
	return {
		name: testContainerName,
		image: "",
		imageID: "",
		containerID: testContainerID.toString(),
		ready: false,
		restartCount: 0,
		started: true,
		state: {
			running: {
				startedAt: new Date(0),
			},
		},
		...status,
	};
}

// Models kubernetes/pkg/kubelet/prober/common_test.go getTestRunningStatus.
function getTestRunningStatus(): V1PodStatus {
	return {
		phase: "Running",
		containerStatuses: [containerStatus()],
	};
}

// Models kubernetes/pkg/kubelet/prober/common_test.go newTestWorker.
function newTestWorker(m: ProbeManagerImpl, probeType: ProbeType, probe: V1Probe): ProbeWorker {
	const pod = getTestPod();
	setTestProbe(pod, probeType, probe);
	return new ProbeWorker(m, probeType, pod, pod.spec?.containers?.[0] as V1Container);
}

// Models kubernetes/pkg/kubelet/prober/common_test.go setTestProbe.
function setTestProbe(pod: V1Pod, probeType: ProbeType, probe: V1Probe): void {
	const container = pod.spec?.containers?.[0];
	if (!container) {
		throw new Error("test pod missing container");
	}
	const mergedProbe = { ...defaultProbe, ...probe };
	switch (probeType) {
		case "readiness":
			container.readinessProbe = mergedProbe;
			break;
		case "liveness":
			container.livenessProbe = mergedProbe;
			break;
		case "startup":
			container.startupProbe = mergedProbe;
			break;
	}
}

// Models kubernetes/pkg/kubelet/prober/prober_manager_test.go TestAddRemovePods.
browser.describe("TestAddRemovePods", () => {
	it("adds and removes regular-container probes", async () => {
		const ctx = context.background();
		const m = newTestManager();
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
			await waitForWorkerExit(m, probePaths);
			expectProbes(m, []);

			m.removePod(probePod);
			expectProbes(m, []);
		} finally {
			await cleanup(m);
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/prober_manager_test.go TestCleanupPods.
browser.describe("TestCleanupPods", () => {
	it("cleans up probes whose pod UID is not desired", async () => {
		const ctx = context.background();
		const m = newTestManager();
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
			await waitForWorkerExit(m, removedProbes);
			expectProbes(m, expectedProbes);
		} finally {
			await cleanup(m);
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/prober_manager_test.go TestCleanupRepeated.
browser.describe("TestCleanupRepeated", () => {
	it("repeatedly cleans up workers", async () => {
		const ctx = context.background();
		const m = newTestManager();
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
			await cleanup(m);
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/prober_manager_test.go TestUpdatePodStatus.
browser.describe("TestUpdatePodStatus", () => {
	it("updates readiness from cached regular-container probe results", async () => {
		const ctx = context.background();
		const m = newTestManager();

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
browser.describe("TestUpdateReadiness", () => {
	it("updates container readiness from worker readiness updates", async () => {
		const ctx = context.background();
		const testPod = getTestPod();
		setTestProbe(testPod, "readiness", {});
		const m = newTestManager();
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

			await waitForReadyStatus(m, true);

			exec.set("failure", undefined);
			await waitForReadyStatus(m, false);
		} finally {
			await readinessHandling.stop();
			await cleanup(m);
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
async function waitForWorkerExit(m: ProbeManagerImpl, workerPaths: ProbeKey[]): Promise<void> {
	for (const w of workerPaths) {
		const condition = () => m.getWorker(w.podUid, w.containerName, w.probeType) === undefined;
		if (condition()) {
			continue;
		}
		await poll(m, interval, foreverTestTimeout, condition);
	}
}

// Models kubernetes/pkg/kubelet/prober/prober_manager_test.go cleanup.
async function cleanup(m: ProbeManagerImpl): Promise<void> {
	m.cleanupPods(new Set());
	const condition = () => m.workerCount() === 0;
	if (!condition()) {
		await poll(m, interval, foreverTestTimeout, condition);
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
async function waitForReadyStatus(m: ProbeManagerImpl, ready: boolean): Promise<void> {
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
	await poll(m, interval, foreverTestTimeout, condition);
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
				extractedReadinessHandling(m, selected.update.value);
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
function extractedReadinessHandling(m: ProbeManagerImpl, update: ProbeUpdate): void {
	const ready = update.result === "success";
	m.statusManager.setContainerReadiness(update.podUid, update.containerId, ready);
}

async function poll(
	m: ProbeManagerImpl,
	intervalMs: number,
	timeoutMs: number,
	condition: () => boolean | Promise<boolean>,
): Promise<void> {
	const deadline = m.clock.nowMs() + timeoutMs;
	for (;;) {
		if (await condition()) {
			return;
		}
		if (m.clock.nowMs() >= deadline) {
			expect(await condition()).toBe(true);
			return;
		}
		await Promise.resolve();
		m.clock.step(Math.min(intervalMs, deadline - m.clock.nowMs()));
		await Promise.resolve();
	}
}
