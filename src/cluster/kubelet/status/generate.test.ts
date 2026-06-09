/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";
import type {
	V1ContainerStatus,
	V1Pod,
	V1PodCondition,
	V1PodSpec,
	V1PodStatus,
} from "../../../client";
import type { PodSandboxStatus } from "../../cri";
import {
	newContainerID,
	newPodStatus,
	type PodStatus as PodRuntimeStatus,
	type Status as ContainerRuntimeStatus,
} from "../container";
import {
	generateAllContainersRestartingCondition,
	generateContainersReadyCondition,
	generatePodReadyCondition,
	generatePodReadyToStartContainersCondition,
} from "./generate";
import { browser } from "../../../test/describe";

// Models kubernetes/pkg/kubelet/status/generate_test.go TestGenerateContainersReadyCondition.
browser.describe("generateContainersReadyCondition", () => {
	const tests: Array<{
		spec: Partial<V1PodSpec>;
		containerStatuses: V1ContainerStatus[] | undefined;
		podPhase: V1PodStatus["phase"];
		expectReady: V1PodCondition;
	}> = [
		{
			spec: {},
			containerStatuses: undefined,
			podPhase: "Running",
			expectReady: getPodCondition("ContainersReady", "False", "UnknownContainerStatuses", ""),
		},
		{
			spec: {},
			containerStatuses: [],
			podPhase: "Running",
			expectReady: getPodCondition("ContainersReady", "True", "", ""),
		},
		{
			spec: {
				containers: [{ name: "1234" }],
			},
			containerStatuses: [],
			podPhase: "Running",
			expectReady: getPodCondition(
				"ContainersReady",
				"False",
				"ContainersNotReady",
				"containers with unknown status: [1234]",
			),
		},
		{
			spec: {
				containers: [{ name: "1234" }, { name: "5678" }],
			},
			containerStatuses: [getReadyStatus("1234"), getReadyStatus("5678")],
			podPhase: "Running",
			expectReady: getPodCondition("ContainersReady", "True", "", ""),
		},
		{
			spec: {
				containers: [{ name: "1234" }, { name: "5678" }],
			},
			containerStatuses: [getReadyStatus("1234")],
			podPhase: "Running",
			expectReady: getPodCondition(
				"ContainersReady",
				"False",
				"ContainersNotReady",
				"containers with unknown status: [5678]",
			),
		},
		{
			spec: {
				containers: [{ name: "1234" }, { name: "5678" }],
			},
			containerStatuses: [getReadyStatus("1234"), getNotReadyStatus("5678")],
			podPhase: "Running",
			expectReady: getPodCondition(
				"ContainersReady",
				"False",
				"ContainersNotReady",
				"containers with unready status: [5678]",
			),
		},
		{
			spec: {
				containers: [{ name: "1234" }],
			},
			containerStatuses: [getNotReadyStatus("1234")],
			podPhase: "Succeeded",
			expectReady: getPodCondition("ContainersReady", "False", "PodCompleted", ""),
		},
		// Restartable init-container rows from upstream are intentionally not
		// ported because this simulator does not support init containers.
	];

	it("matches the upstream regular-container table", () => {
		for (const [_i, test] of tests.entries()) {
			const pod: V1Pod = { spec: podSpec(test.spec) };
			const ready = generateContainersReadyCondition(
				pod,
				{},
				test.containerStatuses,
				test.podPhase,
			);

			expect(ready).toEqual(test.expectReady);
		}
	});
});

// Models kubernetes/pkg/kubelet/status/generate_test.go TestGeneratePodReadyCondition.
browser.describe("generatePodReadyCondition", () => {
	const tests: Array<{
		spec: Partial<V1PodSpec>;
		conditions: V1PodCondition[] | undefined;
		containerStatuses: V1ContainerStatus[] | undefined;
		podPhase: V1PodStatus["phase"];
		expectReady: V1PodCondition;
	}> = [
		{
			spec: {},
			conditions: undefined,
			containerStatuses: undefined,
			podPhase: "Running",
			expectReady: getPodCondition("Ready", "False", "UnknownContainerStatuses", ""),
		},
		{
			spec: {},
			conditions: undefined,
			containerStatuses: [],
			podPhase: "Running",
			expectReady: getPodCondition("Ready", "True", "", ""),
		},
		{
			spec: {
				containers: [{ name: "1234" }],
			},
			conditions: undefined,
			containerStatuses: [],
			podPhase: "Running",
			expectReady: getPodCondition(
				"Ready",
				"False",
				"ContainersNotReady",
				"containers with unknown status: [1234]",
			),
		},
		{
			spec: {
				containers: [{ name: "1234" }, { name: "5678" }],
			},
			conditions: undefined,
			containerStatuses: [getReadyStatus("1234"), getReadyStatus("5678")],
			podPhase: "Running",
			expectReady: getPodCondition("Ready", "True", "", ""),
		},
		{
			spec: {
				containers: [{ name: "1234" }, { name: "5678" }],
			},
			conditions: undefined,
			containerStatuses: [getReadyStatus("1234")],
			podPhase: "Running",
			expectReady: getPodCondition(
				"Ready",
				"False",
				"ContainersNotReady",
				"containers with unknown status: [5678]",
			),
		},
		{
			spec: {
				containers: [{ name: "1234" }, { name: "5678" }],
			},
			conditions: undefined,
			containerStatuses: [getReadyStatus("1234"), getNotReadyStatus("5678")],
			podPhase: "Running",
			expectReady: getPodCondition(
				"Ready",
				"False",
				"ContainersNotReady",
				"containers with unready status: [5678]",
			),
		},
		{
			spec: {
				containers: [{ name: "1234" }],
			},
			conditions: undefined,
			containerStatuses: [getNotReadyStatus("1234")],
			podPhase: "Succeeded",
			expectReady: getPodCondition("Ready", "False", "PodCompleted", ""),
		},
		{
			spec: {
				readinessGates: [{ conditionType: "gate1" }],
			},
			conditions: undefined,
			containerStatuses: [],
			podPhase: "Running",
			expectReady: getPodCondition(
				"Ready",
				"False",
				"ReadinessGatesNotReady",
				'corresponding condition of pod readiness gate "gate1" does not exist.',
			),
		},
		{
			spec: {
				readinessGates: [{ conditionType: "gate1" }],
			},
			conditions: [getPodCondition("gate1", "False", "", "")],
			containerStatuses: [],
			podPhase: "Running",
			expectReady: getPodCondition(
				"Ready",
				"False",
				"ReadinessGatesNotReady",
				'the status of pod readiness gate "gate1" is not "True", but False',
			),
		},
		{
			spec: {
				readinessGates: [{ conditionType: "gate1" }],
			},
			conditions: [getPodCondition("gate1", "True", "", "")],
			containerStatuses: [],
			podPhase: "Running",
			expectReady: getPodCondition("Ready", "True", "", ""),
		},
		{
			spec: {
				readinessGates: [{ conditionType: "gate1" }, { conditionType: "gate2" }],
			},
			conditions: [getPodCondition("gate1", "True", "", "")],
			containerStatuses: [],
			podPhase: "Running",
			expectReady: getPodCondition(
				"Ready",
				"False",
				"ReadinessGatesNotReady",
				'corresponding condition of pod readiness gate "gate2" does not exist.',
			),
		},
		{
			spec: {
				readinessGates: [{ conditionType: "gate1" }, { conditionType: "gate2" }],
			},
			conditions: [
				getPodCondition("gate1", "True", "", ""),
				getPodCondition("gate2", "False", "", ""),
			],
			containerStatuses: [],
			podPhase: "Running",
			expectReady: getPodCondition(
				"Ready",
				"False",
				"ReadinessGatesNotReady",
				'the status of pod readiness gate "gate2" is not "True", but False',
			),
		},
		{
			spec: {
				readinessGates: [{ conditionType: "gate1" }, { conditionType: "gate2" }],
			},
			conditions: [
				getPodCondition("gate1", "True", "", ""),
				getPodCondition("gate2", "True", "", ""),
			],
			containerStatuses: [],
			podPhase: "Running",
			expectReady: getPodCondition("Ready", "True", "", ""),
		},
		{
			spec: {
				containers: [{ name: "1234" }],
				readinessGates: [{ conditionType: "gate1" }],
			},
			conditions: [getPodCondition("gate1", "True", "", "")],
			containerStatuses: [getNotReadyStatus("1234")],
			podPhase: "Running",
			expectReady: getPodCondition(
				"Ready",
				"False",
				"ContainersNotReady",
				"containers with unready status: [1234]",
			),
		},
	];

	it("matches the upstream regular-container table", () => {
		for (const [_i, test] of tests.entries()) {
			const pod: V1Pod = { spec: podSpec(test.spec) };
			const ready = generatePodReadyCondition(
				pod,
				{},
				test.conditions,
				test.containerStatuses,
				test.podPhase,
			);

			expect(ready).toEqual(test.expectReady);
		}
	});
});

// TestGeneratePodInitializedCondition is not ported here because the upstream
// table covers init-container semantics, which this simulator does not support.

// Models kubernetes/pkg/kubelet/status/generate_test.go TestGeneratePodReadyToStartContainersCondition.
browser.describe("generatePodReadyToStartContainersCondition", () => {
	const tests: Record<
		string,
		{
			pod: V1Pod;
			status: PodRuntimeStatus;
			expected: Pick<V1PodCondition, "status">;
		}
	> = {
		"Empty pod status": {
			pod: {},
			status: newPodStatus(),
			expected: {
				status: "False",
			},
		},
		"Pod sandbox status not ready": {
			pod: {},
			status: newPodStatus({
				sandboxStatuses: [
					podSandboxStatus({
						metadata: { attempt: 0 },
						state: "NotReady",
					}),
				],
			}),
			expected: {
				status: "False",
			},
		},
		"Pod sandbox status ready but no IP configured": {
			pod: {},
			status: newPodStatus({
				sandboxStatuses: [
					podSandboxStatus({
						network: { ip: "" },
						metadata: { attempt: 0 },
						state: "Ready",
					}),
				],
			}),
			expected: {
				status: "False",
			},
		},
		"Pod sandbox status ready and IP configured": {
			pod: {},
			status: newPodStatus({
				sandboxStatuses: [
					podSandboxStatus({
						network: { ip: "10.0.0.10" },
						metadata: { attempt: 0 },
						state: "Ready",
					}),
				],
			}),
			expected: {
				status: "True",
			},
		},
	};

	for (const [desc, test] of Object.entries(tests)) {
		it(desc, () => {
			const expected: V1PodCondition = {
				type: "PodReadyToStartContainers",
				observedGeneration: 0,
				...test.expected,
			};
			const condition = generatePodReadyToStartContainersCondition(test.pod, {}, test.status);

			expect(condition.type).toBe(expected.type);
			expect(condition.status).toBe(expected.status);
		});
	}
});

// Models kubernetes/pkg/kubelet/status/generate_test.go TestGenerateAllContainersRestartingCondition.
browser.describe("generateAllContainersRestartingCondition", () => {
	const restartPolicyNever = "Never";
	const defaultPod: V1Pod = {
		spec: {
			containers: [
				{
					name: "container1",
				},
				{
					name: "trigger",
					restartPolicy: restartPolicyNever,
					restartPolicyRules: [
						{
							action: "RestartAllContainers",
							exitCodes: {
								operator: "In",
								values: [42],
							},
						},
					],
				},
			],
		},
	};

	const tests: Record<
		string,
		{
			podStatus?: PodRuntimeStatus;
			oldAPIStatus?: V1PodStatus;
			phase: V1PodStatus["phase"];
			expected: Pick<V1PodCondition, "status" | "reason" | "message">;
		}
	> = {
		"pod pending": {
			phase: "Pending",
			expected: {
				status: "False",
			},
		},
		"pod failed": {
			phase: "Failed",
			expected: {
				status: "False",
				reason: "PodFailed",
			},
		},
		"pod succeeded": {
			phase: "Succeeded",
			expected: {
				status: "False",
				reason: "PodCompleted",
			},
		},
		"container triggers RestartAllContainers rule": {
			podStatus: newPodStatus({
				containerStatuses: [
					containerRuntimeStatus({
						name: "container",
						state: "Running",
					}),
					containerRuntimeStatus({
						name: "trigger",
						state: "Exited",
						exitCode: 42,
					}),
				],
			}),
			phase: "Running",
			expected: {
				status: "True",
				reason: "RestartAllContainersStarted",
				message: "container exited with restart policy rule",
			},
		},
		"container triggres RestartAllContainers rule, cleaning up": {
			podStatus: newPodStatus({
				containerStatuses: [
					containerRuntimeStatus({
						name: "container",
						state: "Exited",
					}),
					containerRuntimeStatus({
						name: "trigger",
						state: "Exited",
						exitCode: 42,
					}),
				],
			}),
			oldAPIStatus: {
				conditions: [
					{
						type: "AllContainersRestarting",
						status: "True",
					},
				],
			},
			phase: "Running",
			expected: {
				status: "True",
				reason: "RestartAllContainersStarted",
				message: "container exited with restart policy rule",
			},
		},
		"container triggres RestartAllContainers rule, cleaned up": {
			oldAPIStatus: {
				conditions: [
					{
						type: "AllContainersRestarting",
						status: "True",
					},
				],
			},
			phase: "Pending",
			expected: {
				status: "False",
			},
		},
	};

	for (const [desc, test] of Object.entries(tests)) {
		it(desc, () => {
			const expected: V1PodCondition = {
				type: "AllContainersRestarting",
				...test.expected,
			};
			const podStatus = test.podStatus ?? newPodStatus();
			const oldAPIStatus = test.oldAPIStatus ?? {};
			const condition = generateAllContainersRestartingCondition(
				defaultPod,
				podStatus,
				oldAPIStatus,
				test.phase,
			);

			expect(condition).toEqual(expected);
		});
	}
});

function getPodCondition(
	conditionType: string,
	status: string,
	reason: string,
	message: string,
): V1PodCondition {
	const condition: V1PodCondition = {
		type: conditionType,
		observedGeneration: 0,
		status,
	};
	if (reason !== "") {
		condition.reason = reason;
	}
	if (message !== "") {
		condition.message = message;
	}
	return condition;
}

function podSpec(spec: Partial<V1PodSpec>): V1PodSpec {
	return {
		containers: [],
		...spec,
	};
}

function getReadyStatus(cName: string): V1ContainerStatus {
	return {
		name: cName,
		image: "",
		imageID: "",
		ready: true,
		restartCount: 0,
	};
}

function getNotReadyStatus(cName: string): V1ContainerStatus {
	return {
		name: cName,
		image: "",
		imageID: "",
		ready: false,
		restartCount: 0,
	};
}

function podSandboxStatus(status: {
	metadata?: Partial<PodSandboxStatus["metadata"]>;
	state?: PodSandboxStatus["state"];
	network?: PodSandboxStatus["network"];
}): PodSandboxStatus {
	return {
		id: "",
		metadata: {
			uid: "",
			name: "",
			namespace: "",
			attempt: 0,
			...status.metadata,
		},
		state: status.state ?? "NotReady",
		createdAt: 0,
		network: status.network,
		labels: {},
		annotations: {},
	};
}

function containerRuntimeStatus(status: Partial<ContainerRuntimeStatus>): ContainerRuntimeStatus {
	return {
		id: newContainerID(),
		name: "",
		state: "Created",
		createdAt: 0,
		image: "",
		imageID: "",
		imageRef: "",
		imageRuntimeHandler: "",
		hash: 0,
		restartCount: 0,
		...status,
	};
}
