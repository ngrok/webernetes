import { expect, it } from "vitest";
import type {
	V1Container,
	V1ContainerStatus,
	V1Pod,
	V1PodCondition,
	V1PodStatus,
} from "../../client";
import * as context from "../../go/context";
import { browser } from "../../test/describe";
import {
	buildContainerID,
	ContainerID,
	type PodStatus as PodRuntimeStatus,
	type Status as ContainerRuntimeStatus,
} from "./container";
import { newTestKubelet } from "./kubelet-test-helpers";

interface ConvertToAPIContainerStatusesUpstreamTestCase {
	name: string;
	pod: V1Pod;
	currentStatus: PodRuntimeStatus;
	previousStatus: V1ContainerStatus[];
	containers: V1Container[];
	hasInitContainers?: boolean;
	isInitContainer?: boolean;
	podRestarting?: boolean;
	expected: V1ContainerStatus[];
}

function containerStatusZero(cName: string): V1ContainerStatus {
	return {
		name: cName,
		image: "",
		imageID: "",
		ready: false,
		restartCount: 0,
	};
}

function waitingStateWithRestartingAllContainers(cName: string): V1ContainerStatus {
	return {
		...containerStatusZero(cName),
		state: {
			waiting: {
				reason: "RestartingAllContainers",
				message: "The container is removed because RestartAllContainers in place",
			},
		},
		lastState: {
			terminated: {
				reason: "RestartingAllContainers",
				message: "The container is removed because RestartAllContainers in place",
				exitCode: 137,
			},
		},
	};
}

function runningState(cName: string): V1ContainerStatus {
	return {
		...containerStatusZero(cName),
		state: { running: {} },
	};
}

function succeededState(cName: string): V1ContainerStatus {
	return {
		...containerStatusZero(cName),
		state: { terminated: { exitCode: 0 } },
	};
}

function failedState(cName: string): V1ContainerStatus {
	return {
		...containerStatusZero(cName),
		state: { terminated: { exitCode: -1 } },
	};
}

function failedStateWithExitCode(cName: string, exitCode: number): V1ContainerStatus {
	return {
		...containerStatusZero(cName),
		state: { terminated: { exitCode } },
	};
}

function waitingWithLastTerminationUnknown(cName: string, restartCount: number): V1ContainerStatus {
	return {
		...containerStatusZero(cName),
		state: { waiting: { reason: "ContainerCreating" } },
		lastState: {
			terminated: {
				reason: "ContainerStatusUnknown",
				message:
					"The container could not be located when the pod was deleted.  The container used to be Running",
				exitCode: 137,
			},
		},
		restartCount,
	};
}

function ready(status: V1ContainerStatus): V1ContainerStatus {
	return {
		...status,
		ready: true,
	};
}

function withRestartCount(status: V1ContainerStatus, restartCount: number): V1ContainerStatus {
	return {
		...status,
		restartCount,
	};
}

function withLastTerminationState(
	status: V1ContainerStatus,
	lastState: NonNullable<V1ContainerStatus["lastState"]>,
): V1ContainerStatus {
	return {
		...status,
		lastState,
	};
}

function runtimeStatus(
	name: string,
	options: Partial<ContainerRuntimeStatus> = {},
): ContainerRuntimeStatus {
	return {
		name,
		id: options.id ?? new ContainerID("", ""),
		image: options.image ?? "",
		imageID: options.imageID ?? "",
		imageRef: options.imageRef ?? "",
		imageRuntimeHandler: options.imageRuntimeHandler ?? "",
		state: options.state ?? "Running",
		createdAt: options.createdAt ?? 0,
		startedAt: options.startedAt,
		finishedAt: options.finishedAt,
		exitCode: options.exitCode,
		hash: options.hash ?? 0,
		restartCount: options.restartCount ?? 0,
		reason: options.reason,
		message: options.message,
	};
}

function stripUndefined<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map((item) => stripUndefined(item)) as T;
	}
	if (value instanceof Date || value === null || typeof value !== "object") {
		return value;
	}
	const result: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (child !== undefined) {
			result[key] = stripUndefined(child);
		}
	}
	return result as T;
}

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go findContainerStatusByName.
function findAPIContainerStatusByName(
	status: V1PodStatus,
	name: string,
): V1ContainerStatus | undefined {
	for (const containerStatus of status.initContainerStatuses ?? []) {
		if (containerStatus.name === name) {
			return containerStatus;
		}
	}
	for (const containerStatus of status.containerStatuses ?? []) {
		if (containerStatus.name === name) {
			return containerStatus;
		}
	}
	for (const containerStatus of status.ephemeralContainerStatuses ?? []) {
		if (containerStatus.name === name) {
			return containerStatus;
		}
	}
	return undefined;
}

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestGeneratePodHostNameAndDomain.
browser.describe("generatePodHostNameAndDomain", () => {
	it.each([
		{
			name: "Default behavior - pod name as hostname",
			podName: "test-pod",
			podHostname: undefined,
			podSubdomain: undefined,
			podHostnameOverride: undefined,
			expectedHostname: "test-pod",
			expectedDomain: "",
			errorContains: undefined,
		},
		{
			name: "Custom Hostname - uses pod.Spec.Hostname",
			podName: "test-pod",
			podHostname: "custom-hostname",
			podSubdomain: undefined,
			podHostnameOverride: undefined,
			expectedHostname: "custom-hostname",
			expectedDomain: "",
			errorContains: undefined,
		},
		{
			name: "Custom Subdomain - constructs FQDN",
			podName: "test-pod",
			podHostname: undefined,
			podSubdomain: "my-subdomain",
			podHostnameOverride: undefined,
			expectedHostname: "test-pod",
			expectedDomain: "my-subdomain.default.svc.cluster.local",
			errorContains: undefined,
		},
		{
			name: "Custom Hostname and Subdomain - uses both",
			podName: "test-pod",
			podHostname: "custom-hostname",
			podSubdomain: "my-subdomain",
			podHostnameOverride: undefined,
			expectedHostname: "custom-hostname",
			expectedDomain: "my-subdomain.default.svc.cluster.local",
			errorContains: undefined,
		},
		{
			name: "HostnameOverride - enabled - overrides all",
			podName: "test-pod",
			podHostname: "custom-hostname",
			podSubdomain: "my-subdomain",
			podHostnameOverride: "override-hostname",
			expectedHostname: "override-hostname",
			expectedDomain: "",
			errorContains: undefined,
		},
		{
			name: "HostnameOverride - enabled - overrides all - invalid hostname",
			podName: "test-pod",
			podHostname: "custom-hostname",
			podSubdomain: "my-subdomain",
			podHostnameOverride: "Invalid-Hostname-!",
			expectedHostname: "",
			expectedDomain: "",
			errorContains: 'pod HostnameOverride "Invalid-Hostname-!" is not a valid DNS subdomain',
		},
		{
			name: "HostnameOverride - enabled - overrides all - valid DNS hostname",
			podName: "test-pod",
			podHostname: undefined,
			podSubdomain: undefined,
			podHostnameOverride: "valid.hostname",
			expectedHostname: "valid.hostname",
			expectedDomain: "",
			errorContains: undefined,
		},
		{
			name: "Hostname Truncation - pod name is too long",
			podName: "a".repeat(65),
			podHostname: undefined,
			podSubdomain: undefined,
			podHostnameOverride: undefined,
			expectedHostname: "a".repeat(63),
			expectedDomain: "",
			errorContains: undefined,
		},
		{
			name: "Validation - invalid hostname",
			podName: "test-pod",
			podHostname: "Invalid-Hostname-!",
			podSubdomain: undefined,
			podHostnameOverride: undefined,
			expectedHostname: "",
			expectedDomain: "",
			errorContains: 'pod Hostname "Invalid-Hostname-!" is not a valid DNS label',
		},
		{
			name: "Validation - invalid subdomain",
			podName: "test-pod",
			podHostname: undefined,
			podSubdomain: "invalid_subdomain",
			podHostnameOverride: undefined,
			expectedHostname: "",
			expectedDomain: "",
			errorContains: 'pod Subdomain "invalid_subdomain" is not a valid DNS label',
		},
		{
			name: "Validation - too long hostname",
			podName: "test-pod",
			podHostname: "a".repeat(64),
			podSubdomain: undefined,
			podHostnameOverride: undefined,
			expectedHostname: "",
			expectedDomain: "",
			errorContains: "must be no more than 63 characters",
		},
	])(
		"$name",
		async ({
			podName,
			podHostname,
			podSubdomain,
			podHostnameOverride,
			expectedHostname,
			expectedDomain,
			errorContains,
		}) => {
			const testKubelet = newTestKubelet(false);
			const pod: V1Pod = {
				metadata: {
					name: podName,
					namespace: "default",
				},
				spec: {
					containers: [],
					hostname: podHostname,
					hostnameOverride: podHostnameOverride,
					subdomain: podSubdomain,
				},
			};

			try {
				const [hostname, domain, err] = testKubelet.kubelet.generatePodHostNameAndDomain(pod);

				expect(err?.message ?? "").toContain(errorContains ?? "");
				expect(err === undefined).toBe(errorContains === undefined);
				expect(hostname).toBe(expectedHostname);
				expect(domain).toBe(expectedDomain);
			} finally {
				await testKubelet.cleanup();
			}
		},
	);
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestConvertToAPIContainerStatuses.
browser.describe("convertToAPIContainerStatuses", () => {
	const desiredState = {
		nodeName: "machine",
		containers: [{ name: "containerA" }, { name: "containerB" }],
		restartPolicy: "Always" as const,
	};
	const now = new Date();

	const upstreamTestCases: ConvertToAPIContainerStatusesUpstreamTestCase[] = [
		{
			name: "no current status, with previous statuses and deletion",
			pod: {
				spec: desiredState,
				status: {
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
				metadata: { name: "my-pod", deletionTimestamp: now },
			},
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(),
				containerStatuses: [],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [runningState("containerA"), runningState("containerB")],
			containers: desiredState.containers,
			expected: [
				waitingWithLastTerminationUnknown("containerA", 0),
				waitingWithLastTerminationUnknown("containerB", 0),
			],
		},
		{
			name: "no current status, with previous statuses and no deletion",
			pod: {
				spec: desiredState,
				status: {
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
			},
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [runningState("containerA"), runningState("containerB")],
			containers: desiredState.containers,
			expected: [
				waitingWithLastTerminationUnknown("containerA", 1),
				waitingWithLastTerminationUnknown("containerB", 1),
			],
		},
		{
			name: "no current status, keeping previous restartCount",
			pod: { spec: desiredState },
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [
				withRestartCount(failedState("containerA"), 5),
				withRestartCount(failedState("containerB"), 5),
			],
			containers: desiredState.containers,
			expected: [
				withRestartCount(failedState("containerA"), 5),
				withRestartCount(failedState("containerB"), 5),
			],
		},
		{
			name: "currently running with lower restartCount; should keeping previous restartCount",
			pod: { spec: desiredState },
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [
					runtimeStatus("containerA", {
						id: new ContainerID("", "containerA"),
						state: "Running",
						restartCount: 0,
					}),
					runtimeStatus("containerB", {
						id: new ContainerID("", "containerB"),
						state: "Running",
						restartCount: 0,
					}),
				],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [
				withRestartCount(failedState("containerA"), 5),
				withRestartCount(failedState("containerB"), 5),
			],
			containers: desiredState.containers,
			expected: [
				withRestartCount(
					withLastTerminationState(runningState("containerA"), {
						terminated: { exitCode: -1 },
					}),
					6,
				),
				withRestartCount(
					withLastTerminationState(runningState("containerB"), {
						terminated: { exitCode: -1 },
					}),
					6,
				),
			],
		},
		{
			name: "containerB dies and triggers RestartAllContainers in place",
			pod: { spec: desiredState },
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [
					runtimeStatus("containerA", { state: "Running" }),
					runtimeStatus("containerB", { state: "Exited", exitCode: 42 }),
				],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [runningState("containerA"), runningState("containerB")],
			containers: desiredState.containers,
			podRestarting: true,
			expected: [runningState("containerA"), failedStateWithExitCode("containerB", 42)],
		},
		{
			name: "containerB dies and triggers RestartAllContainers in place, containerA killed",
			pod: { spec: desiredState },
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [runtimeStatus("containerA", { state: "Exited", exitCode: 137 })],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [runningState("containerA"), failedStateWithExitCode("containerB", 42)],
			containers: desiredState.containers,
			podRestarting: true,
			expected: [
				failedStateWithExitCode("containerA", 137),
				withRestartCount(waitingStateWithRestartingAllContainers("containerB"), 1),
			],
		},
		{
			name: "containerB dies and triggers RestartAllContainers in place, containerA killed then removed",
			pod: { spec: desiredState },
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [
				failedStateWithExitCode("containerA", 137),
				failedStateWithExitCode("containerB", 42),
			],
			containers: desiredState.containers,
			podRestarting: true,
			expected: [
				withRestartCount(waitingStateWithRestartingAllContainers("containerA"), 1),
				withRestartCount(waitingStateWithRestartingAllContainers("containerB"), 1),
			],
		},
		{
			name: "containerB dies and triggers RestartAllContainers in place, containerA killed and removed together",
			pod: { spec: desiredState },
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [runningState("containerA"), failedStateWithExitCode("containerB", 42)],
			containers: desiredState.containers,
			podRestarting: true,
			expected: [
				withRestartCount(waitingStateWithRestartingAllContainers("containerA"), 1),
				withRestartCount(waitingStateWithRestartingAllContainers("containerB"), 1),
			],
		},
		{
			name: "containerB dies and triggers RestartAllContainers in place, containerA rerun",
			pod: { spec: desiredState },
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [
					runtimeStatus("containerA", {
						id: new ContainerID("", "containerA-new"),
						state: "Running",
					}),
				],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [
				withRestartCount(waitingStateWithRestartingAllContainers("containerA"), 1),
				failedStateWithExitCode("containerB", 42),
			],
			containers: desiredState.containers,
			podRestarting: true,
			expected: [
				withRestartCount(
					withLastTerminationState(runningState("containerA"), {
						terminated: {
							reason: "RestartingAllContainers",
							message: "The container is removed because RestartAllContainers in place",
							exitCode: 137,
						},
					}),
					1,
				),
				withRestartCount(waitingStateWithRestartingAllContainers("containerB"), 1),
			],
		},
		{
			name: "containerB dies and triggers RestartAllContainers in place, containerA succeeded",
			pod: { spec: desiredState },
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [runtimeStatus("containerA", { state: "Exited", exitCode: 0 })],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [
				withRestartCount(runningState("containerA"), 1),
				failedStateWithExitCode("containerB", 42),
			],
			containers: desiredState.containers,
			podRestarting: true,
			expected: [
				withRestartCount(succeededState("containerA"), 1),
				withRestartCount(waitingStateWithRestartingAllContainers("containerB"), 1),
			],
		},
		{
			name: "containerB dies and triggers RestartAllContainers in place, containerA failed",
			pod: { spec: desiredState },
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [runtimeStatus("containerA", { state: "Exited", exitCode: 1 })],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [
				withRestartCount(runningState("containerA"), 1),
				failedStateWithExitCode("containerB", 42),
			],
			containers: desiredState.containers,
			podRestarting: true,
			expected: [
				withRestartCount(failedStateWithExitCode("containerA", 1), 1),
				withRestartCount(waitingStateWithRestartingAllContainers("containerB"), 1),
			],
		},
	];

	it.each(upstreamTestCases)("$name", async (tc) => {
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);
		try {
			const containerStatuses = testKubelet.kubelet.convertToAPIContainerStatuses(
				tCtx,
				tc.pod,
				tc.currentStatus,
				tc.previousStatus,
				tc.containers,
				undefined,
				tc.hasInitContainers ?? false,
				tc.isInitContainer ?? false,
				tc.podRestarting ?? false,
			);
			for (const status of containerStatuses) {
				delete status.containerID;
				delete status.resources;
				if (status.state?.terminated) {
					delete status.state.terminated.containerID;
				}
			}

			expect(containerStatuses).toEqual(tc.expected);
		} finally {
			await testKubelet.cleanup();
		}
	});

	it("throws when image volume status conversion is requested", async () => {
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);
		try {
			expect(() =>
				testKubelet.kubelet.convertToAPIContainerStatuses(
					tCtx,
					{ spec: desiredState },
					{
						id: "",
						name: "",
						namespace: "",
						timestamp: new Date(0),
						containerStatuses: [],
						sandboxStatuses: [],
						ips: [],
					},
					[],
					desiredState.containers,
					new Set(["image-volume"]),
					false,
					false,
					false,
				),
			).toThrow("image volume status conversion is not implemented");
		} finally {
			await testKubelet.cleanup();
		}
	});
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestConvertToAPIContainerStatusesForResources.
browser.describe("convertToAPIContainerStatusesForResources", () => {
	const nowTime = new Date();
	const testContainerName = "ctr0";
	const testContainerID = buildContainerID("test", testContainerName);
	const testContainer: V1Container = {
		name: testContainerName,
		image: "img",
	};
	const testContainerStatus: V1ContainerStatus = {
		name: testContainerName,
		image: "",
		imageID: "",
		ready: false,
		restartCount: 0,
	};
	const testPod: V1Pod = {
		metadata: {
			uid: "123456",
			name: "foo",
			namespace: "bar",
		},
		spec: {
			containers: [testContainer],
		},
		status: {
			containerStatuses: [testContainerStatus],
		},
	};
	const testPodStatus = (state: ContainerRuntimeStatus["state"]): PodRuntimeStatus => {
		const cStatus = runtimeStatus(testContainerName, {
			id: testContainerID,
			image: "img",
			imageID: "1234",
			imageRef: "img1234",
			state,
			startedAt: state === "Running" || state === "Exited" ? nowTime.getTime() : undefined,
			finishedAt: state === "Exited" ? nowTime.getTime() : undefined,
		});
		return {
			id: testPod.metadata?.uid ?? "",
			name: testPod.metadata?.name ?? "",
			namespace: testPod.metadata?.namespace ?? "",
			timestamp: new Date(0),
			containerStatuses: [cStatus],
			sandboxStatuses: [],
			ips: [],
		};
	};

	const testCases: Array<{
		tdesc: string;
		state?: ContainerRuntimeStatus["state"];
		oldStatus: V1ContainerStatus;
		expected: V1ContainerStatus;
	}> = [
		// Upstream also asserts AllocatedResources and Resources in this table. The
		// simulator does not model kubelet container resource allocation, so these
		// cases preserve the upstream status-transition and ImageID/ImageRef shape
		// while omitting resource/allocation expectations.
		{
			tdesc: "BestEffortQoSPod",
			oldStatus: {
				name: testContainerName,
				image: "img",
				imageID: "img1234",
				ready: false,
				restartCount: 0,
				state: { running: {} },
				resources: {},
			},
			expected: {
				name: testContainerName,
				containerID: testContainerID.toString(),
				image: "img",
				imageID: "img1234",
				ready: false,
				restartCount: 0,
				state: { running: { startedAt: nowTime } },
			},
		},
		{
			tdesc: "newly created Pod",
			state: "Created",
			oldStatus: {
				name: "",
				image: "",
				imageID: "",
				ready: false,
				restartCount: 0,
			},
			expected: {
				name: testContainerName,
				containerID: testContainerID.toString(),
				image: "img",
				imageID: "img1234",
				ready: false,
				restartCount: 0,
				state: { waiting: {} },
			},
		},
		{
			tdesc: "newly running Pod",
			oldStatus: {
				name: testContainerName,
				image: "img",
				imageID: "img1234",
				ready: false,
				restartCount: 0,
				state: { waiting: {} },
			},
			expected: {
				name: testContainerName,
				containerID: testContainerID.toString(),
				image: "img",
				imageID: "img1234",
				ready: false,
				restartCount: 0,
				state: { running: { startedAt: nowTime } },
			},
		},
		{
			tdesc: "newly terminated Pod",
			state: "Exited",
			oldStatus: {
				name: testContainerName,
				image: "img",
				imageID: "img1234",
				ready: false,
				restartCount: 0,
				state: { running: {} },
				resources: {},
			},
			expected: {
				name: testContainerName,
				containerID: testContainerID.toString(),
				image: "img",
				imageID: "img1234",
				ready: false,
				restartCount: 0,
				state: {
					terminated: {
						containerID: testContainerID.toString(),
						exitCode: 0,
						startedAt: nowTime,
						finishedAt: nowTime,
					},
				},
			},
		},
	];

	it.each(testCases)("$tdesc", async ({ state, oldStatus, expected }) => {
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);

		try {
			const cStatuses = testKubelet.kubelet.convertToAPIContainerStatuses(
				tCtx,
				testPod,
				testPodStatus(state ?? "Running"),
				[oldStatus],
				testPod.spec?.containers ?? [testContainer],
				undefined,
				false,
				false,
				false,
			);

			expect(cStatuses[0]).toEqual(expected);
		} finally {
			await testKubelet.cleanup();
		}
	});
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go Test_generateAPIPodStatus.
browser.describe("generateAPIPodStatus", () => {
	const now = new Date("2026-01-02T03:04:05.000Z");
	const desiredState = {
		nodeName: "machine",
		containers: [{ name: "containerA" }, { name: "containerB" }],
		restartPolicy: "Always" as const,
	};
	const sandboxReadyStatus: PodRuntimeStatus = {
		id: "",
		name: "",
		namespace: "",
		ips: [],
		containerStatuses: [],
		sandboxStatuses: [
			{
				network: { ip: "10.0.0.10" },
				metadata: {
					name: "",
					namespace: "",
					uid: "",
					attempt: 0,
				},
				state: "Ready",
				id: "",
				createdAt: 0,
				labels: {},
				annotations: {},
			},
		],
		timestamp: new Date(0),
	};
	const tests: Array<{
		name: string;
		pod: V1Pod;
		currentStatus: PodRuntimeStatus;
		unreadyContainer?: string[];
		previousStatus: V1PodStatus;
		isPodTerminal?: boolean;
		expected: V1PodStatus;
		expectedPodDisruptionCondition?: V1PodCondition;
		expectedPodReadyToStartContainersCondition: V1PodCondition;
	}> = [
		{
			name: "pod disruption condition is copied over and the phase is set to failed when deleted",
			pod: {
				metadata: { uid: "123456", name: "my-pod", deletionTimestamp: now },
				spec: desiredState,
				status: {
					containerStatuses: [runningState("containerA"), runningState("containerB")],
					conditions: [
						{
							type: "DisruptionTarget",
							status: "True",
							lastTransitionTime: now,
						},
					],
				},
			},
			currentStatus: sandboxReadyStatus,
			previousStatus: {
				containerStatuses: [runningState("containerA"), runningState("containerB")],
				conditions: [
					{
						type: "DisruptionTarget",
						status: "True",
						lastTransitionTime: now,
					},
				],
			},
			isPodTerminal: true,
			expected: {
				phase: "Failed",
				hostIP: "127.0.0.1",
				hostIPs: [{ ip: "127.0.0.1" }, { ip: "::1" }],
				qosClass: "BestEffort",
				conditions: [
					{ type: "Initialized", observedGeneration: 0, status: "True" },
					{ type: "Ready", observedGeneration: 0, status: "False", reason: "PodFailed" },
					{
						type: "ContainersReady",
						observedGeneration: 0,
						status: "False",
						reason: "PodFailed",
					},
					{ type: "PodScheduled", observedGeneration: 0, status: "True" },
				],
				containerStatuses: [
					ready(waitingWithLastTerminationUnknown("containerA", 0)),
					ready(waitingWithLastTerminationUnknown("containerB", 0)),
				],
			},
			expectedPodDisruptionCondition: {
				type: "DisruptionTarget",
				status: "True",
				lastTransitionTime: now,
			},
			expectedPodReadyToStartContainersCondition: {
				type: "PodReadyToStartContainers",
				observedGeneration: 0,
				status: "True",
			},
		},
		{
			name: "current status ready, with previous statuses and deletion",
			pod: {
				metadata: { uid: "123456", name: "my-pod", deletionTimestamp: now },
				spec: desiredState,
				status: {
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
			},
			currentStatus: sandboxReadyStatus,
			previousStatus: {
				containerStatuses: [runningState("containerA"), runningState("containerB")],
			},
			expected: {
				phase: "Running",
				hostIP: "127.0.0.1",
				hostIPs: [{ ip: "127.0.0.1" }, { ip: "::1" }],
				qosClass: "BestEffort",
				conditions: [
					{ type: "Initialized", observedGeneration: 0, status: "True" },
					{ type: "Ready", observedGeneration: 0, status: "True" },
					{ type: "ContainersReady", observedGeneration: 0, status: "True" },
					{ type: "PodScheduled", observedGeneration: 0, status: "True" },
				],
				containerStatuses: [
					ready(waitingWithLastTerminationUnknown("containerA", 0)),
					ready(waitingWithLastTerminationUnknown("containerB", 0)),
				],
			},
			expectedPodReadyToStartContainersCondition: {
				type: "PodReadyToStartContainers",
				observedGeneration: 0,
				status: "True",
			},
		},
		{
			name: "current status ready, with previous statuses and no deletion",
			pod: {
				metadata: { uid: "123456", name: "my-pod" },
				spec: desiredState,
				status: {
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
			},
			currentStatus: sandboxReadyStatus,
			previousStatus: {
				containerStatuses: [runningState("containerA"), runningState("containerB")],
			},
			expected: {
				phase: "Running",
				hostIP: "127.0.0.1",
				hostIPs: [{ ip: "127.0.0.1" }, { ip: "::1" }],
				qosClass: "BestEffort",
				conditions: [
					{ type: "Initialized", observedGeneration: 0, status: "True" },
					{ type: "Ready", observedGeneration: 0, status: "True" },
					{ type: "ContainersReady", observedGeneration: 0, status: "True" },
					{ type: "PodScheduled", observedGeneration: 0, status: "True" },
				],
				containerStatuses: [
					ready(waitingWithLastTerminationUnknown("containerA", 1)),
					ready(waitingWithLastTerminationUnknown("containerB", 1)),
				],
			},
			expectedPodReadyToStartContainersCondition: {
				type: "PodReadyToStartContainers",
				observedGeneration: 0,
				status: "True",
			},
		},
		{
			name: "terminal phase cannot be changed (apiserver previous is succeeded)",
			pod: {
				metadata: { uid: "123456", name: "my-pod" },
				spec: desiredState,
				status: {
					phase: "Succeeded",
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
			},
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				ips: [],
				containerStatuses: [],
				sandboxStatuses: [],
				timestamp: new Date(0),
			},
			previousStatus: {
				containerStatuses: [runningState("containerA"), runningState("containerB")],
			},
			expected: {
				phase: "Succeeded",
				hostIP: "127.0.0.1",
				hostIPs: [{ ip: "127.0.0.1" }, { ip: "::1" }],
				qosClass: "BestEffort",
				conditions: [
					{
						type: "Initialized",
						observedGeneration: 0,
						status: "True",
						reason: "PodCompleted",
					},
					{
						type: "Ready",
						observedGeneration: 0,
						status: "False",
						reason: "PodCompleted",
					},
					{
						type: "ContainersReady",
						observedGeneration: 0,
						status: "False",
						reason: "PodCompleted",
					},
					{ type: "PodScheduled", observedGeneration: 0, status: "True" },
				],
				containerStatuses: [
					ready(waitingWithLastTerminationUnknown("containerA", 1)),
					ready(waitingWithLastTerminationUnknown("containerB", 1)),
				],
			},
			expectedPodReadyToStartContainersCondition: {
				type: "PodReadyToStartContainers",
				observedGeneration: 0,
				status: "False",
			},
		},
		{
			name: "terminal phase from previous status must remain terminal, restartAlways",
			pod: {
				metadata: { uid: "123456", name: "my-pod" },
				spec: desiredState,
				status: {
					phase: "Running",
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
			},
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				ips: [],
				containerStatuses: [],
				sandboxStatuses: [],
				timestamp: new Date(0),
			},
			previousStatus: {
				phase: "Succeeded",
				containerStatuses: [runningState("containerA"), runningState("containerB")],
				// Reason and message should be preserved
				reason: "Test",
				message: "test",
			},
			expected: {
				phase: "Succeeded",
				reason: "Test",
				message: "test",
				hostIP: "127.0.0.1",
				hostIPs: [{ ip: "127.0.0.1" }, { ip: "::1" }],
				qosClass: "BestEffort",
				conditions: [
					{
						type: "Initialized",
						observedGeneration: 0,
						status: "True",
						reason: "PodCompleted",
					},
					{
						type: "Ready",
						observedGeneration: 0,
						status: "False",
						reason: "PodCompleted",
					},
					{
						type: "ContainersReady",
						observedGeneration: 0,
						status: "False",
						reason: "PodCompleted",
					},
					{ type: "PodScheduled", observedGeneration: 0, status: "True" },
				],
				containerStatuses: [
					ready(waitingWithLastTerminationUnknown("containerA", 1)),
					ready(waitingWithLastTerminationUnknown("containerB", 1)),
				],
			},
			expectedPodReadyToStartContainersCondition: {
				type: "PodReadyToStartContainers",
				observedGeneration: 0,
				status: "False",
			},
		},
		{
			name: "terminal phase from previous status must remain terminal, restartNever",
			pod: {
				metadata: { uid: "123456", name: "my-pod" },
				spec: {
					nodeName: "machine",
					containers: [{ name: "containerA" }, { name: "containerB" }],
					restartPolicy: "Never",
				},
				status: {
					phase: "Running",
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
			},
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				ips: [],
				containerStatuses: [],
				sandboxStatuses: [],
				timestamp: new Date(0),
			},
			previousStatus: {
				phase: "Succeeded",
				containerStatuses: [succeededState("containerA"), succeededState("containerB")],
				// Reason and message should be preserved
				reason: "Test",
				message: "test",
			},
			expected: {
				phase: "Succeeded",
				reason: "Test",
				message: "test",
				hostIP: "127.0.0.1",
				hostIPs: [{ ip: "127.0.0.1" }, { ip: "::1" }],
				qosClass: "BestEffort",
				conditions: [
					{
						type: "Initialized",
						observedGeneration: 0,
						status: "True",
						reason: "PodCompleted",
					},
					{
						type: "Ready",
						observedGeneration: 0,
						status: "False",
						reason: "PodCompleted",
					},
					{
						type: "ContainersReady",
						observedGeneration: 0,
						status: "False",
						reason: "PodCompleted",
					},
					{ type: "PodScheduled", observedGeneration: 0, status: "True" },
				],
				containerStatuses: [
					ready(succeededState("containerA")),
					ready(succeededState("containerB")),
				],
			},
			expectedPodReadyToStartContainersCondition: {
				type: "PodReadyToStartContainers",
				observedGeneration: 0,
				status: "False",
			},
		},
	];

	it.each(tests)("$name", async (test) => {
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);
		try {
			const kl = testKubelet.kubelet;
			await kl.statusManager.setPodStatus(test.pod, test.previousStatus);
			for (const name of test.unreadyContainer ?? []) {
				const containerStatus = findAPIContainerStatusByName(test.expected, name);
				if (!containerStatus) {
					throw new Error(`container status ${name} not found`);
				}
				await kl.readinessManager.set(
					buildContainerID("", containerStatus.containerID ?? ""),
					"failure",
					test.pod,
				);
			}
			const actual = kl.generateAPIPodStatus(
				tCtx,
				test.pod,
				test.currentStatus,
				test.isPodTerminal ?? false,
			);
			const expected = structuredClone(test.expected);
			expected.conditions = [
				test.expectedPodReadyToStartContainersCondition,
				...(expected.conditions ?? []),
			];
			if (test.expectedPodDisruptionCondition) {
				expected.conditions = [test.expectedPodDisruptionCondition, ...expected.conditions];
			}

			expect(
				stripUndefined({
					phase: actual.phase,
					reason: actual.reason,
					message: actual.message,
					hostIP: actual.hostIP,
					hostIPs: actual.hostIPs,
					qosClass: actual.qosClass,
					conditions: actual.conditions,
					containerStatuses: actual.containerStatuses,
				}),
			).toEqual(expected);
		} finally {
			await testKubelet.cleanup();
		}
	});
});
