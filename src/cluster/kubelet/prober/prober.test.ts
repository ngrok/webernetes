/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
/* eslint-disable jest/no-conditional-expect, jest/valid-expect */
import { expect, it } from "vitest";

import type {
	V1Container,
	V1HTTPGetAction,
	V1Pod,
	V1PodStatus,
	V1Probe,
	V1TCPSocketAction,
} from "../../../client";
import { FakeRecorder, newFakeRecorder } from "../../../client-go/tools/record/fake";
import { browser } from "../../../test/describe";
import type { ProbeResult } from "../../probe";
import { resolveContainerPort } from "../../probe/util";
import { ClusterNetwork } from "../../cni";
import { buildContainerID } from "../container";
import { FakeContainerCommandRunner } from "../container/testing";
import { FakeExecProber } from "./common.test";
import { Prober } from "./prober";
import { probeTypeString } from "./prober-manager";
import type { ProbeType, ProberResult } from "./results";

// Models kubernetes/pkg/kubelet/prober/prober_test.go TestGetURLParts.
browser.describe("TestGetURLParts", () => {
	it("resolves HTTP probe URL parts", () => {
		const testCases: Array<{
			probe: V1HTTPGetAction;
			ok: boolean;
			host: string;
			port: number;
			path: string;
		}> = [
			{ probe: { host: "", port: -1, path: "" }, ok: false, host: "", port: -1, path: "" },
			{ probe: { host: "", port: "", path: "" }, ok: false, host: "", port: -1, path: "" },
			{ probe: { host: "", port: "-1", path: "" }, ok: false, host: "", port: -1, path: "" },
			{ probe: { host: "", port: "not-found", path: "" }, ok: false, host: "", port: -1, path: "" },
			{
				probe: { host: "", port: "found", path: "" },
				ok: true,
				host: "127.0.0.1",
				port: 93,
				path: "",
			},
			{ probe: { host: "", port: 76, path: "" }, ok: true, host: "127.0.0.1", port: 76, path: "" },
			{
				probe: { host: "", port: "118", path: "" },
				ok: true,
				host: "127.0.0.1",
				port: 118,
				path: "",
			},
			{
				probe: { host: "hostname", port: 76, path: "path" },
				ok: true,
				host: "hostname",
				port: 76,
				path: "path",
			},
		];

		for (const test of testCases) {
			const state: V1PodStatus = { podIP: "127.0.0.1" };
			const container: V1Container = {
				name: "",
				ports: [{ name: "found", containerPort: 93 }],
				livenessProbe: {
					httpGet: test.probe,
				},
			};

			const scheme = test.probe.scheme || "HTTP";
			const host = test.probe.host || state.podIP || "";
			const [port, err] = resolveContainerPort(test.probe.port, container);
			const path = test.probe.path ?? "";

			if (!test.ok) {
				expect(
					err,
					`Expected error for ${JSON.stringify(test)}, got ${scheme}${host}:${port}/${path}`,
				).toBeDefined();
			}
			if (test.ok) {
				expect(err, JSON.stringify(test)).toBeUndefined();
				expect({ host, port, path }).toEqual({
					host: test.host,
					port: test.port,
					path: test.path,
				});
			}
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/prober_test.go TestGetTCPAddrParts.
browser.describe("TestGetTCPAddrParts", () => {
	it("resolves TCP probe address parts", () => {
		const testCases: Array<{
			probe: V1TCPSocketAction;
			ok: boolean;
			host: string;
			port: number;
		}> = [
			{ probe: { port: -1 }, ok: false, host: "", port: -1 },
			{ probe: { port: "" }, ok: false, host: "", port: -1 },
			{ probe: { port: "-1" }, ok: false, host: "", port: -1 },
			{ probe: { port: "not-found" }, ok: false, host: "", port: -1 },
			{ probe: { port: "found" }, ok: true, host: "1.2.3.4", port: 93 },
			{ probe: { port: 76 }, ok: true, host: "1.2.3.4", port: 76 },
			{ probe: { port: "118" }, ok: true, host: "1.2.3.4", port: 118 },
		];

		for (const test of testCases) {
			const host = "1.2.3.4";
			const container: V1Container = {
				name: "",
				ports: [{ name: "found", containerPort: 93 }],
				livenessProbe: {
					tcpSocket: test.probe,
				},
			};
			const [port, err] = resolveContainerPort(test.probe.port, container);

			if (!test.ok) {
				expect(
					err,
					`Expected error for ${JSON.stringify(test)}, got ${host}:${port}`,
				).toBeDefined();
			}
			if (test.ok) {
				expect(err, JSON.stringify(test)).toBeUndefined();
				expect({ host, port }).toEqual({ host: test.host, port: test.port });
			}
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/prober_test.go TestProbe.
browser.describe("TestProbe", ({ ctx }) => {
	it("handles probe results and exec arguments", async () => {
		const containerID = buildContainerID("test", "foobar");
		const execProbe: V1Probe = {
			exec: {},
		};

		const tests: Array<{
			probe?: V1Probe;
			env?: NonNullable<V1Container["env"]>;
			execError?: boolean;
			expectError?: boolean;
			execResult?: ProbeResult;
			expectedResult: ProberResult;
			expectCommand?: string[];
			unsupported?: boolean;
		}> = [
			{
				// No probe
				probe: undefined,
				expectedResult: "success",
			},
			{
				// No handler
				probe: {},
				expectError: true,
				expectedResult: "failure",
			},
			{
				// Probe fails
				probe: execProbe,
				execResult: "failure",
				expectedResult: "failure",
			},
			{
				// Probe succeeds
				probe: execProbe,
				execResult: "success",
				expectedResult: "success",
			},
			{
				// Probe result is warning
				probe: execProbe,
				execResult: "warning",
				expectedResult: "success",
			},
			{
				// Probe result is unknown with no error
				probe: execProbe,
				execResult: "unknown",
				expectError: false,
				expectedResult: "failure",
			},
			{
				// Probe result is unknown with an error
				probe: execProbe,
				execError: true,
				expectError: true,
				execResult: "unknown",
				expectedResult: "failure",
			},
			{
				// Unsupported probe type
				probe: undefined,
				expectedResult: "failure",
				expectError: true,
				unsupported: true,
			},
			{
				// Probe arguments are passed through
				probe: {
					exec: {
						command: ["/bin/bash", "-c", "some script"],
					},
				},
				expectCommand: ["/bin/bash", "-c", "some script"],
				execResult: "success",
				expectedResult: "success",
			},
			{
				// Probe arguments are passed through
				probe: {
					exec: {
						command: ["/bin/bash", "-c", "some $(A) $(B)"],
					},
				},
				env: [{ name: "A", value: "script" }],
				expectCommand: ["/bin/bash", "-c", "some script $(B)"],
				execResult: "success",
				expectedResult: "success",
			},
		];

		for (const [i, test] of tests.entries()) {
			for (const originalProbeType of ["liveness", "readiness", "startup"] as const) {
				const probeType = test.unsupported ? (666 as unknown as ProbeType) : originalProbeType;
				const prober = new Prober(
					ctx,
					new FakeContainerCommandRunner(),
					new ClusterNetwork(),
					new FakeRecorder(),
				);
				const testId = `${i}-${String(probeType)}`;
				const testContainer: V1Container = { name: "", env: test.env };
				switch (probeType) {
					case "liveness":
						testContainer.livenessProbe = test.probe;
						break;
					case "readiness":
						testContainer.readinessProbe = test.probe;
						break;
					case "startup":
						testContainer.startupProbe = test.probe;
						break;
				}
				prober.exec = new FakeExecProber(
					test.execResult ?? "success",
					test.execError ? new Error("exec error") : undefined,
				);

				const [result, err] = await prober.probe(
					ctx,
					probeType,
					{},
					{},
					testContainer,
					containerID,
				);

				if (test.expectError) {
					expect(err, testId).toBeDefined();
				} else {
					expect(err, testId).toBeUndefined();
				}
				expect(result, testId).toBe(test.expectedResult);

				if ((test.expectCommand?.length ?? 0) > 0) {
					const runner = new FakeContainerCommandRunner();
					const commandProber = new Prober(ctx, runner, new ClusterNetwork(), new FakeRecorder());
					const [, commandErr] = await commandProber.probe(
						ctx,
						probeType,
						{},
						{},
						testContainer,
						containerID,
					);
					expect(commandErr, testId).toBeUndefined();
					expect(runner.cmd, testId).toEqual(test.expectCommand);
				}
			}
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/prober_test.go TestNewExecInContainer.
// Intentionally not ported: the simulator routes exec probes through ExecProber and CommandRunner.

// Models kubernetes/pkg/kubelet/prober/prober_test.go TestNewProber.
browser.describe("TestNewProber", ({ ctx }) => {
	it("initializes prober dependencies", () => {
		const runner = new FakeContainerCommandRunner();
		const recorder = new FakeRecorder();
		const prober = new Prober(ctx, runner, new ClusterNetwork(), recorder);

		expect(prober).toBeDefined();
		expect(prober.runner).toBe(runner);
		expect(prober.recorder).toBe(recorder);
		expect(prober.exec).toBeDefined();
		expect(prober.http).toBeDefined();
		expect(prober.tcp).toBeDefined();
	});
});

// Models kubernetes/pkg/kubelet/prober/prober_test.go TestRecordContainerEventUnknownStatus.
browser.describe("TestRecordContainerEventUnknownStatus", ({ ctx }) => {
	it("records warning events for unknown probe statuses", async () => {
		const pod: V1Pod = {
			apiVersion: "v1",
			kind: "Pod",
			metadata: {
				uid: "test-probe-pod",
			},
			spec: {
				containers: [
					{
						name: "test-probe-container",
					},
				],
			},
		};
		const container = pod.spec?.containers?.[0] as V1Container;
		const output = "probe output";

		const testCases: Array<{
			name: string;
			probeType: ProbeType;
			result: ProbeResult;
			expected: string[];
		}> = [
			{
				name: "Readiness Probe Unknown",
				probeType: "readiness",
				result: "unknown",
				expected: [
					"Warning ContainerProbeWarning Readiness probe warning: probe output",
					"Warning ContainerProbeWarning Unknown Readiness probe status: unknown",
				],
			},
			{
				name: "Liveness Probe Unknown",
				probeType: "liveness",
				result: "unknown",
				expected: [
					"Warning ContainerProbeWarning Liveness probe warning: probe output",
					"Warning ContainerProbeWarning Unknown Liveness probe status: unknown",
				],
			},
			{
				name: "Startup Probe Unknown",
				probeType: "startup",
				result: "unknown",
				expected: [
					"Warning ContainerProbeWarning Startup probe warning: probe output",
					"Warning ContainerProbeWarning Unknown Startup probe status: unknown",
				],
			},
		];

		for (const tc of testCases) {
			const bufferSize = tc.expected.length + 1;
			const fakeRecorder = newFakeRecorder(bufferSize);
			const prober = new Prober(
				ctx,
				new FakeContainerCommandRunner(),
				new ClusterNetwork(),
				fakeRecorder,
			);

			await prober.recordContainerEvent(
				pod,
				container,
				"Warning",
				"ContainerProbeWarning",
				"%s probe warning: %s",
				probeTypeString(tc.probeType),
				output,
			);
			await prober.recordContainerEvent(
				pod,
				container,
				"Warning",
				"ContainerProbeWarning",
				"Unknown %s probe status: %s",
				probeTypeString(tc.probeType),
				tc.result,
			);

			for (const expected of tc.expected) {
				await expect(fakeRecorder.events?.receive(), tc.name).resolves.toMatchObject({
					ok: true,
					value: expected,
				});
			}
			expect(fakeRecorder.events?.tryReceive(), tc.name).toBeUndefined();
		}
	});
});
