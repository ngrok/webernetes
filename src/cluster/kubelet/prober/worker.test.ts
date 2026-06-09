/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
/* eslint-disable jest/no-conditional-expect, jest/valid-expect */
import { expect, it } from "vitest";

import {
	type V1Container,
	type V1ContainerStatus,
	type V1Pod,
	type V1PodStatus,
	type V1Probe,
} from "../../../client";
import type { Clock } from "../../../clock";
import * as context from "../../../go/context";
import { browser } from "../../../test/describe";
import { buildContainerID } from "../container";
import {
	FakeExecProber,
	getTestNotRunningStatus,
	getTestPendingStatus,
	getTestPod,
	getTestRunningStatus,
	getTestRunningStatusWithFailedContainer,
	getTestRunningStatusWithStarted,
	getTestRunningStatusWithSucceededContainer,
	newTestManager,
	newTestWorker,
	setTestProbe,
	testContainerID,
	testContainerName,
	testPodUID,
} from "./common.test";
import type { ProbeManagerImpl } from "./prober-manager";
import { ResultsManager, type ProbeType, type ProberResult } from "./results";
import { ProbeWorker } from "./worker";

const liveness: ProbeType = "liveness";
const readiness: ProbeType = "readiness";
const startup: ProbeType = "startup";

function getOnlyContainerStatus(status: V1PodStatus): V1ContainerStatus {
	const containerStatus = status.containerStatuses?.[0];
	if (!containerStatus) {
		throw new Error("test status missing container status");
	}
	return containerStatus;
}

function setOnlyRunningStartedAt(status: V1PodStatus, startedAt: Date): void {
	const containerStatus = getOnlyContainerStatus(status);
	const running = containerStatus.state?.running;
	if (!running) {
		throw new Error("test status missing running container");
	}
	running.startedAt = startedAt;
}

// Models kubernetes/pkg/kubelet/prober/worker_test.go TestDoProbe.
browser.describe("TestDoProbe", () => {
	it("handles regular-container probe states", async () => {
		const ctx = context.background();

		for (const probeType of [liveness, readiness, startup]) {
			const runningStatus = getTestRunningStatusWithStarted(probeType !== startup);
			const pendingStatus = getTestRunningStatusWithStarted(probeType !== startup);
			if (pendingStatus.containerStatuses?.[0]) {
				pendingStatus.containerStatuses[0].state = {};
			}
			const terminatedStatus = getTestRunningStatusWithStarted(probeType !== startup);
			if (terminatedStatus.containerStatuses?.[0]) {
				terminatedStatus.containerStatuses[0].state = {
					terminated: { exitCode: 0, startedAt: new Date() },
				};
			}
			const otherStatus = getTestRunningStatusWithStarted(probeType !== startup);
			if (otherStatus.containerStatuses?.[0]) {
				otherStatus.containerStatuses[0].name = "otherContainer";
			}
			const failedStatus = getTestRunningStatusWithStarted(probeType !== startup);
			failedStatus.phase = "Failed";

			const tests: Array<{
				probe?: V1Probe;
				podStatus?: V1PodStatus;
				expectContinue?: Partial<Record<ProbeType, boolean>>;
				expectSet?: boolean;
				expectedResult?: ProberResult;
				setDeletionTimestamp?: boolean;
			}> = [
				{
					expectContinue: {
						[liveness]: true,
						[readiness]: true,
						[startup]: true,
					},
				},
				{
					podStatus: failedStatus,
				},
				{
					podStatus: runningStatus,
					setDeletionTimestamp: true,
					expectSet: true,
					expectContinue: {
						[readiness]: true,
					},
					expectedResult: "success",
				},
				{
					podStatus: otherStatus,
					expectContinue: {
						[liveness]: true,
						[readiness]: true,
						[startup]: true,
					},
				},
				{
					podStatus: pendingStatus,
					expectContinue: {
						[liveness]: true,
						[readiness]: true,
						[startup]: true,
					},
					expectSet: true,
					expectedResult: "failure",
				},
				{
					podStatus: terminatedStatus,
					expectSet: true,
					expectedResult: "failure",
				},
				{
					podStatus: runningStatus,
					expectContinue: {
						[liveness]: true,
						[readiness]: true,
						[startup]: true,
					},
					expectSet: true,
					expectedResult: "success",
				},
				{
					podStatus: runningStatus,
					probe: { initialDelaySeconds: -100 },
					expectContinue: {
						[liveness]: true,
						[readiness]: true,
						[startup]: true,
					},
					expectSet: true,
					expectedResult: "success",
				},
			];

			for (let i = 0; i < tests.length; i++) {
				const test = tests[i];
				const m = newTestManager();
				const w = newTestWorker(m, probeType, test?.probe ?? {});
				if (test?.podStatus) {
					await m.statusManager.setPodStatus(w.pod, test.podStatus);
				}
				if (test?.setDeletionTimestamp) {
					w.pod.metadata ??= {};
					w.pod.metadata.deletionTimestamp = new Date();
				}
				await expect(w.doProbe(ctx), `${probeType}-${i}`).resolves.toBe(
					test?.expectContinue?.[probeType] ?? false,
				);
				const result = resultsManager(m, probeType).get(testContainerID);
				expect(result !== undefined, `${probeType}-${i}`).toBe(test?.expectSet ?? false);
				expect(result, `${probeType}-${i}`).toBe(test?.expectedResult);

				resultsManager(m, probeType).remove(testContainerID);
			}
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/worker_test.go TestDoProbeWithContainerRestartRules.
browser.describe("TestDoProbeWithContainerRestartRules", () => {
	it("handles regular-container restart policy rules", async () => {
		const ctx = context.background();
		const m = newTestManager();
		for (const probeType of [liveness, readiness, startup]) {
			const restartPolicyAlways = "Always";
			const restartPolicyNever = "Never";
			const restartPolicyOnFailure = "OnFailure";
			const testcases: Array<{
				name: string;
				container: V1Container;
				podStatus: V1PodStatus;
				expectContinue: boolean;
			}> = [
				{
					name: "container failed with container restartPolicy=OnFailure",
					container: { name: testContainerName, restartPolicy: restartPolicyOnFailure },
					podStatus: getTestRunningStatusWithFailedContainer(),
					expectContinue: true,
				},
				{
					name: "container succeeded with containerRestartPolicy=OnFailure",
					container: { name: testContainerName, restartPolicy: restartPolicyOnFailure },
					podStatus: getTestRunningStatusWithSucceededContainer(),
					expectContinue: false,
				},
				{
					name: "container failed with containerRestartPolicy=Always",
					container: { name: testContainerName, restartPolicy: restartPolicyAlways },
					podStatus: getTestRunningStatusWithFailedContainer(),
					expectContinue: true,
				},
				{
					name: "container succeeded with containerRestartPolicy=Always",
					container: { name: testContainerName, restartPolicy: restartPolicyAlways },
					podStatus: getTestRunningStatusWithSucceededContainer(),
					expectContinue: true,
				},
				{
					name: "container failed with containerRestartPolicy=Never",
					container: { name: testContainerName, restartPolicy: restartPolicyNever },
					podStatus: getTestRunningStatusWithFailedContainer(),
					expectContinue: false,
				},
				{
					name: "container succeeded with containerRestartPolicy=Never",
					container: { name: testContainerName, restartPolicy: restartPolicyNever },
					podStatus: getTestRunningStatusWithSucceededContainer(),
					expectContinue: false,
				},
				{
					name: "container terminated with matching restartPolicyRules",
					container: {
						name: testContainerName,
						restartPolicy: restartPolicyNever,
						restartPolicyRules: [{ action: "Restart", exitCodes: { operator: "In", values: [1] } }],
					},
					podStatus: getTestRunningStatusWithFailedContainer(),
					expectContinue: true,
				},
				{
					name: "container terminated with non-matching restartPolicyRules",
					container: {
						name: testContainerName,
						restartPolicy: restartPolicyNever,
						restartPolicyRules: [
							{ action: "Restart", exitCodes: { operator: "In", values: [99] } },
						],
					},
					podStatus: getTestRunningStatusWithFailedContainer(),
					expectContinue: false,
				},
			];

			for (const tc of testcases) {
				const pod = getTestPod();
				setTestProbe(pod, probeType, {});
				pod.spec?.containers?.splice(0, 1, {
					...(pod.spec.containers[0] as V1Container),
					restartPolicy: tc.container.restartPolicy,
					restartPolicyRules: tc.container.restartPolicyRules,
				});
				const w = new ProbeWorker(m, probeType, pod, pod.spec?.containers?.[0] as V1Container);
				await m.statusManager.setPodStatus(w.pod, tc.podStatus);

				await expect(w.doProbe(ctx), `${probeType}-${tc.name}`).resolves.toBe(tc.expectContinue);
				resultsManager(m, probeType).remove(testContainerID);
			}
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/worker_test.go TestDoProbeWithContainerRestartAllContainers.
browser.describe("TestDoProbeWithContainerRestartAllContainers", () => {
	it("handles regular-container restart-all rules", async () => {
		const ctx = context.background();
		const m = newTestManager();
		for (const probeType of [liveness, readiness, startup]) {
			const restartPolicyNever = "Never";
			const testcases: Array<{
				name: string;
				pod: () => V1Pod;
				podStatus: () => V1PodStatus;
				expectContinue: boolean;
			}> = [
				{
					name: "container terminated with matching restartAllContainers",
					pod: () => {
						const pod = getTestPod();
						setTestProbe(pod, probeType, {});
						const c = pod.spec?.containers?.[0] as V1Container;
						c.restartPolicy = restartPolicyNever;
						c.restartPolicyRules = [
							{ action: "RestartAllContainers", exitCodes: { operator: "In", values: [1] } },
						];
						return pod;
					},
					podStatus: getTestRunningStatusWithFailedContainer,
					expectContinue: true,
				},
				{
					name: "container terminated by restartAllContainers",
					pod: () => {
						const pod = getTestPod();
						setTestProbe(pod, probeType, {});
						pod.spec?.containers?.push({
							name: "trigger",
							restartPolicy: restartPolicyNever,
							restartPolicyRules: [
								{ action: "RestartAllContainers", exitCodes: { operator: "In", values: [1] } },
							],
						});
						return pod;
					},
					podStatus: () => {
						const status = getTestRunningStatusWithFailedContainer();
						status.containerStatuses?.push({
							name: "trigger",
							image: "",
							imageID: "",
							ready: false,
							restartCount: 0,
							state: { terminated: { exitCode: 1 } },
						});
						return status;
					},
					expectContinue: true,
				},
				{
					name: "container cleaned up by restartAllContainers",
					pod: () => {
						const pod = getTestPod();
						setTestProbe(pod, probeType, {});
						pod.spec?.containers?.push({
							name: "trigger",
							restartPolicy: restartPolicyNever,
							restartPolicyRules: [
								{ action: "RestartAllContainers", exitCodes: { operator: "In", values: [1] } },
							],
						});
						return pod;
					},
					podStatus: getTestPendingStatus,
					expectContinue: true,
				},
			];

			for (const tc of testcases) {
				const pod = tc.pod();
				const podStatus = tc.podStatus();
				const w = new ProbeWorker(m, probeType, pod, pod.spec?.containers?.[0] as V1Container);
				await m.statusManager.setPodStatus(w.pod, podStatus);

				await expect(w.doProbe(ctx), `${probeType}-${tc.name}`).resolves.toBe(tc.expectContinue);
				resultsManager(m, probeType).remove(testContainerID);
			}
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/worker_test.go TestInitialDelay.
browser.describe("TestInitialDelay", () => {
	it("honors initial delay for regular-container probes", async () => {
		const ctx = context.background();
		const m = newTestManager();

		for (const probeType of [liveness, readiness, startup]) {
			const w = newTestWorker(m, probeType, { initialDelaySeconds: 10 });
			const status = getTestRunningStatusWithStarted(probeType !== startup);
			setOnlyRunningStartedAt(status, m.clock.now());
			await m.statusManager.setPodStatus(w.pod, status);

			expectContinue(w, await w.doProbe(ctx), "during initial delay");
			switch (probeType) {
				case liveness:
					expectResult(w, "success", "during initial delay");
					break;
				case readiness:
					expectResult(w, "failure", "during initial delay");
					break;
				case startup:
					expectResult(w, "unknown", "during initial delay");
					break;
			}

			const laterStatus = getTestRunningStatusWithStarted(probeType !== startup);
			setOnlyRunningStartedAt(laterStatus, new Date(m.clock.nowMs() - 100_000));
			await m.statusManager.setPodStatus(w.pod, laterStatus);

			expectContinue(w, await w.doProbe(ctx), "after initial delay");
			expectResult(w, "success", "after initial delay");
			resultsManager(m, probeType).remove(testContainerID);
		}
	});

	it("truncates subsecond start-time skew for zero initial delay", async () => {
		const ctx = context.background();
		const m = newTestManager();
		const w = newTestWorker(m, readiness, {});
		const status = getTestRunningStatus();
		setOnlyRunningStartedAt(status, new Date(m.clock.nowMs() + 1));
		await m.statusManager.setPodStatus(w.pod, status);

		expectContinue(w, await w.doProbe(ctx), "subsecond future start time");
		expectResult(w, "success", "subsecond future start time");
	});
});

// Models kubernetes/pkg/kubelet/prober/worker_test.go TestFailureThreshold.
browser.describe("TestFailureThreshold", () => {
	it("applies failure threshold", async () => {
		const ctx = context.background();
		const m = newTestManager();
		const w = newTestWorker(m, readiness, { successThreshold: 1, failureThreshold: 3 });
		await m.statusManager.setPodStatus(w.pod, getTestRunningStatus());

		for (let i = 0; i < 2; i++) {
			m.prober.exec = new FakeExecProber("success");
			for (let j = 0; j < 3; j++) {
				const msg = `${j + 1} success (${i})`;
				expectContinue(w, await w.doProbe(ctx), msg);
				expectResult(w, "success", msg);
			}

			m.prober.exec = new FakeExecProber("failure");
			for (let j = 0; j < 2; j++) {
				const msg = `${j + 1} failing (${i})`;
				expectContinue(w, await w.doProbe(ctx), msg);
				expectResult(w, "success", msg);
			}

			for (let j = 0; j < 3; j++) {
				const msg = `${j + 3} failure (${i})`;
				expectContinue(w, await w.doProbe(ctx), msg);
				expectResult(w, "failure", msg);
			}
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/worker_test.go TestSuccessThreshold.
browser.describe("TestSuccessThreshold", () => {
	it("applies success threshold", async () => {
		const ctx = context.background();
		const m = newTestManager();
		const w = newTestWorker(m, readiness, { successThreshold: 3, failureThreshold: 1 });
		await m.statusManager.setPodStatus(w.pod, getTestRunningStatus());
		await w.resultsManager.set(testContainerID, "failure", {});

		for (let i = 0; i < 2; i++) {
			for (let j = 0; j < 2; j++) {
				const msg = `${j + 1} success (${i})`;
				expectContinue(w, await w.doProbe(ctx), msg);
				expectResult(w, "failure", msg);
			}

			for (let j = 0; j < 3; j++) {
				const msg = `${j + 3} success (${i})`;
				expectContinue(w, await w.doProbe(ctx), msg);
				expectResult(w, "success", msg);
			}

			m.prober.exec = new FakeExecProber("failure");
			const msg = `1 failure (${i})`;
			expectContinue(w, await w.doProbe(ctx), msg);
			expectResult(w, "failure", msg);

			m.prober.exec = new FakeExecProber("success");
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/worker_test.go TestStartupProbeSuccessThreshold.
browser.describe("TestStartupProbeSuccessThreshold", () => {
	it("puts startup probe on hold after success threshold", async () => {
		const ctx = context.background();
		const m = newTestManager();
		const successThreshold = 1;
		const failureThreshold = 3;
		const w = newTestWorker(m, startup, {
			successThreshold,
			failureThreshold,
		});
		await m.statusManager.setPodStatus(w.pod, getTestNotRunningStatus());
		m.prober.exec = new FakeExecProber("success");

		for (let i = 0; i < successThreshold + 1; i++) {
			if (i < successThreshold) {
				expect(w.onHold).toBe(false);
				const msg = `${i + 1} success`;
				expectContinue(w, await w.doProbe(ctx), msg);
				expectResult(w, "success", msg);
			} else {
				expect(w.onHold).toBe(true);
				expect(w.resultRun).toBe(0);
			}
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/worker_test.go TestStartupProbeFailureThreshold.
browser.describe("TestStartupProbeFailureThreshold", () => {
	it("puts startup probe on hold after failure threshold", async () => {
		const ctx = context.background();
		const m = newTestManager();
		const successThreshold = 1;
		const failureThreshold = 3;
		const w = newTestWorker(m, startup, {
			successThreshold,
			failureThreshold,
		});
		await m.statusManager.setPodStatus(w.pod, getTestNotRunningStatus());
		m.prober.exec = new FakeExecProber("failure");

		for (let i = 0; i < failureThreshold + 1; i++) {
			if (i < failureThreshold) {
				expect(w.onHold).toBe(false);
				const msg = `${i + 1} failure`;
				expectContinue(w, await w.doProbe(ctx), msg);
				switch (i) {
					case 0:
					case 1:
						expectResult(w, "unknown", msg);
						expect(w.resultRun).toBe(i + 1);
						break;
					case 2:
						expectResult(w, "failure", msg);
						expect(w.resultRun).toBe(0);
						break;
				}
			} else {
				expect(w.onHold).toBe(true);
				expect(w.resultRun).toBe(0);
			}
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/worker_test.go TestCleanUp.
browser.describe("TestCleanUp", () => {
	it("clears results and workers when stopped", async () => {
		const ctx = context.background();
		const m = newTestManager();

		for (const probeType of [liveness, readiness, startup]) {
			const key = { podUid: testPodUID, containerName: testContainerName, probeType };
			const w = newTestWorker(m, probeType, {});
			await m.statusManager.setPodStatus(
				w.pod,
				getTestRunningStatusWithStarted(probeType !== startup),
			);
			const run = w.run(ctx);
			m.workers.set(key, w);

			for (
				let i = 0;
				i < 5 && resultsManager(m, probeType).get(testContainerID) !== "success";
				i++
			) {
				await Promise.resolve();
				m.clock.step(1000);
				await Promise.resolve();
			}
			expect(resultsManager(m, probeType).get(testContainerID), probeType).toBe("success");

			for (let i = 0; i < 10; i++) {
				w.stop();
			}
			await waitForWorkerExit(m.clock, m, key);
			await run;

			expect(resultsManager(m, probeType).get(testContainerID), probeType).toBeUndefined();
			expect(m.workers.get(key), probeType).toBeUndefined();
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/worker_test.go expectResult.
function expectResult(w: ProbeWorker, expectedResult: ProberResult, msg: string): void {
	const result = resultsManager(w.probeManager, w.probeType).get(w.containerId ?? testContainerID);
	expect(result, `${w.probeType} - ${msg}`).toBe(expectedResult);
}

// Models kubernetes/pkg/kubelet/prober/worker_test.go expectContinue.
function expectContinue(w: ProbeWorker, c: boolean, msg: string): void {
	expect(c, `${w.probeType} - ${msg}`).toBe(true);
}

// Models kubernetes/pkg/kubelet/prober/worker_test.go resultsManager.
function resultsManager(m: ProbeManagerImpl, probeType: ProbeType): ResultsManager {
	switch (probeType) {
		case readiness:
			return m.readinessManager;
		case liveness:
			return m.livenessManager;
		case startup:
			return m.startupManager;
	}
	throw new Error(`unhandled probe type: ${probeType}`);
}

// Models kubernetes/pkg/kubelet/prober/worker_test.go TestOnHoldOnLivenessOrStartupCheckFailure.
browser.describe("TestOnHoldOnLivenessOrStartupCheckFailure", () => {
	it("holds liveness and startup probes after failure", async () => {
		const ctx = context.background();

		for (const probeType of [liveness, startup]) {
			const m = newTestManager();
			const w = newTestWorker(m, probeType, { successThreshold: 1, failureThreshold: 1 });
			const status = getTestRunningStatusWithStarted(probeType !== startup);
			await m.statusManager.setPodStatus(w.pod, status);

			m.prober.exec = new FakeExecProber("failure");
			let msg = "first probe";
			expectContinue(w, await w.doProbe(ctx), msg);
			expectResult(w, "failure", msg);
			expect(w.onHold).toBe(true);

			m.prober.exec = new FakeExecProber("success");
			msg = "while on hold";
			expectContinue(w, await w.doProbe(ctx), msg);
			expectResult(w, "failure", msg);
			expect(w.onHold).toBe(true);

			getOnlyContainerStatus(status).containerID = "test://newCont_ID";
			await m.statusManager.setPodStatus(w.pod, status);
			msg = "hold lifted";
			expectContinue(w, await w.doProbe(ctx), msg);
			expectResult(w, "success", msg);
			if (probeType === liveness) {
				expect(w.onHold).toBe(false);
			} else {
				expect(w.onHold).toBe(true);
			}
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/worker_test.go TestResultRunOnLivenessCheckFailure.
browser.describe("TestResultRunOnLivenessCheckFailure", () => {
	it("resets result run after liveness failure threshold", async () => {
		const ctx = context.background();
		const m = newTestManager();
		const w = newTestWorker(m, liveness, { successThreshold: 1, failureThreshold: 3 });
		await m.statusManager.setPodStatus(w.pod, getTestRunningStatus());

		m.prober.exec = new FakeExecProber("success");
		expectContinue(w, await w.doProbe(ctx), "initial probe success");
		expectResult(w, "success", "initial probe success");
		expect(w.resultRun).toBe(1);

		m.prober.exec = new FakeExecProber("failure");
		let msg = "probe failure, result success";
		expectContinue(w, await w.doProbe(ctx), msg);
		expectResult(w, "success", msg);
		expect(w.resultRun).toBe(1);

		m.prober.exec = new FakeExecProber("failure");
		msg = "2nd probe failure, result success";
		expectContinue(w, await w.doProbe(ctx), msg);
		expectResult(w, "success", msg);
		expect(w.resultRun).toBe(2);

		m.prober.exec = new FakeExecProber("failure");
		msg = "3rd probe failure, result failure";
		expectContinue(w, await w.doProbe(ctx), msg);
		expectResult(w, "failure", msg);
		expect(w.resultRun).toBe(0);
	});
});

// Models kubernetes/pkg/kubelet/prober/worker_test.go TestResultRunOnStartupCheckFailure.
browser.describe("TestResultRunOnStartupCheckFailure", () => {
	it("resets result run after startup failure threshold", async () => {
		const ctx = context.background();
		const m = newTestManager();
		const w = newTestWorker(m, startup, { successThreshold: 1, failureThreshold: 3 });
		await m.statusManager.setPodStatus(w.pod, getTestRunningStatusWithStarted(false));

		m.prober.exec = new FakeExecProber("failure");
		let msg = "probe failure, result unknown";
		expectContinue(w, await w.doProbe(ctx), msg);
		expectResult(w, "unknown", msg);
		expect(w.resultRun).toBe(1);

		m.prober.exec = new FakeExecProber("failure");
		msg = "2nd probe failure, result unknown";
		expectContinue(w, await w.doProbe(ctx), msg);
		expectResult(w, "unknown", msg);
		expect(w.resultRun).toBe(2);

		m.prober.exec = new FakeExecProber("failure");
		msg = "3rd probe failure, result failure";
		expectContinue(w, await w.doProbe(ctx), msg);
		expectResult(w, "failure", msg);
		expect(w.resultRun).toBe(0);
	});
});

// Models kubernetes/pkg/kubelet/prober/worker_test.go TestDoProbe_TerminatedContainerWithRestartPolicyNever.
browser.describe("TestDoProbe_TerminatedContainerWithRestartPolicyNever", () => {
	it("stops probing regular terminated container when pod restart policy is Never", async () => {
		const ctx = context.background();
		const m = newTestManager();
		const w = newTestWorker(m, startup, {});
		w.container.restartPolicy = undefined;
		if (!w.pod.spec) {
			throw new Error("test pod missing spec");
		}
		w.pod.spec.restartPolicy = "Never";
		const terminatedStatus = getTestRunningStatus();
		getOnlyContainerStatus(terminatedStatus).state = {
			terminated: { exitCode: 0, startedAt: new Date() },
		};
		await m.statusManager.setPodStatus(w.pod, terminatedStatus);

		await expect(w.doProbe(ctx)).resolves.toBe(false);
		expectResult(w, "failure", "regular container with pod restart policy Never");
	});
});

// Models kubernetes/pkg/kubelet/prober/worker_test.go TestLivenessProbeDisabledByStarted.
browser.describe("TestLivenessProbeDisabledByStarted", () => {
	it("disables liveness probe until container has started", async () => {
		const ctx = context.background();
		const m = newTestManager();
		const w = newTestWorker(m, liveness, { successThreshold: 1, failureThreshold: 1 });
		await m.statusManager.setPodStatus(w.pod, getTestRunningStatusWithStarted(false));
		m.prober.exec = new FakeExecProber("failure");
		let msg = "Not started, probe failure, result success";
		expectContinue(w, await w.doProbe(ctx), msg);
		expectResult(w, "success", msg);

		await m.statusManager.setContainerStartup(testPodUID, testContainerID, true);
		msg = "Started, probe failure, result failure";
		expectContinue(w, await w.doProbe(ctx), msg);
		expectResult(w, "failure", msg);
	});
});

// Models kubernetes/pkg/kubelet/prober/worker_test.go TestStartupProbeDisabledByStarted.
browser.describe("TestStartupProbeDisabledByStarted", () => {
	it("disables startup probe after container has started", async () => {
		const ctx = context.background();
		const m = newTestManager();
		const w = newTestWorker(m, startup, { successThreshold: 1, failureThreshold: 2 });
		await m.statusManager.setPodStatus(w.pod, getTestRunningStatusWithStarted(false));
		m.prober.exec = new FakeExecProber("failure");
		let msg = "Not started, probe failure, result unknown";
		expectContinue(w, await w.doProbe(ctx), msg);
		expectResult(w, "unknown", msg);

		m.prober.exec = new FakeExecProber("success");
		msg = "Started, probe success, result success";
		expectContinue(w, await w.doProbe(ctx), msg);
		expectResult(w, "success", msg);

		await m.statusManager.setContainerStartup(testPodUID, testContainerID, true);
		m.prober.exec = new FakeExecProber("failure");
		msg = "Started, probe failure, result success";
		expectContinue(w, await w.doProbe(ctx), msg);
		expectResult(w, "success", msg);
	});
});

// Models kubernetes/pkg/kubelet/prober/worker_test.go TestChangeContainerStatusOnKubeletRestart.
browser.describe("TestChangeContainerStatusOnKubeletRestart", () => {
	// Upstream rows for disabled feature gates and restartable init containers are outside the
	// simulator's current feature-gate and init-container scope.
	it.each([
		{
			name: "feature enabled, is restart, readiness",
			featureEnabled: true,
			isRestart: true,
			probeType: readiness,
			initialValue: "failure" as const,
			expectSet: true,
			isSidecar: false,
			expectedResult: "failure" as const,
		},
		{
			name: "feature enabled, is restart, liveness",
			featureEnabled: true,
			isRestart: true,
			probeType: liveness,
			initialValue: "success" as const,
			expectSet: true,
			isSidecar: false,
			expectedResult: "success" as const,
		},
		{
			name: "feature enabled, is restart, startup",
			featureEnabled: true,
			isRestart: true,
			probeType: startup,
			initialValue: "unknown" as const,
			expectSet: true,
			isSidecar: false,
			expectedResult: "unknown" as const,
		},
		{
			name: "feature enabled, not restart, readiness",
			featureEnabled: true,
			isRestart: false,
			probeType: readiness,
			initialValue: "failure" as const,
			expectSet: true,
			isSidecar: false,
			expectedResult: "failure" as const,
		},
		{
			name: "feature enabled, not restart, liveness",
			featureEnabled: true,
			isRestart: false,
			probeType: liveness,
			initialValue: "success" as const,
			expectSet: true,
			isSidecar: false,
			expectedResult: "success" as const,
		},
		{
			name: "feature enabled, not restart, startup",
			featureEnabled: true,
			isRestart: false,
			probeType: startup,
			initialValue: "unknown" as const,
			expectSet: true,
			isSidecar: false,
			expectedResult: "unknown" as const,
		},
	])("$name", async (tc) => {
		const ctx = context.background();
		const m = newTestManager();
		const podStatus = getTestRunningStatus();
		const containerStatus = podStatus.containerStatuses?.[0];
		if (!containerStatus?.state?.running) {
			throw new Error("test running status missing running container");
		}
		containerStatus.containerID = "test://container-id";
		containerStatus.state.running.startedAt = new Date(
			m.startedAt.getTime() + (tc.isRestart ? -5 * 60_000 : 5 * 60_000),
		);
		const w = newTestWorker(m, tc.probeType, { initialDelaySeconds: 1000 });
		expect(w.initialValue).toBe(tc.initialValue);
		await m.statusManager.setPodStatus(w.pod, podStatus);
		const containerID = buildContainerID("test", "container-id");

		await w.doProbe(ctx);

		const result = resultsManager(m, tc.probeType).get(containerID);
		expect(result !== undefined).toBe(tc.expectSet);
		if (tc.expectSet) {
			expect(result).toBe(tc.expectedResult);
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/prober_manager_test.go waitForWorkerExit.
async function waitForWorkerExit(
	_clock: Clock,
	m: ProbeManagerImpl,
	key: { podUid: string; containerName: string; probeType: ProbeType },
): Promise<void> {
	for (let i = 0; i < 50 && m.getWorker(key.podUid, key.containerName, key.probeType); i++) {
		await Promise.resolve();
		await Promise.resolve();
	}
	expect(
		m.getWorker(key.podUid, key.containerName, key.probeType),
		JSON.stringify(key),
	).toBeUndefined();
}
