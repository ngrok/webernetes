/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";
import type { V1Pod } from "../../../client";
import { browser } from "../../../test/describe";
import {
	buildPodFullName,
	ContainerID,
	findContainerByID,
	findContainerByName,
	findContainerStatusByName,
	findPod,
	findSandboxByID,
	getPodFullName,
	getRunningContainerStatuses,
	newContainerID,
	newPod,
	newPodStatus,
	parseContainerID,
	parsePodFullName,
	podIsEmpty,
	networkReady,
	RuntimeCondition,
	RuntimeFeatures,
	RuntimeHandler,
	RuntimeStatus,
	runtimeReady,
	toAPIPod,
	type Pod,
	type Status,
} from "./runtime";

// Models kubernetes/pkg/kubelet/container/runtime_test.go TestParseContainerID.
browser.describe("parseContainerID", () => {
	const tests: {
		name: string;
		input: string;
		expected: ContainerID;
	}[] = [
		{
			name: "valid docker container id",
			input: `"docker://abc123"`,
			expected: new ContainerID("docker", "abc123"),
		},
		{
			name: "valid containerd container id",
			input: `"containerd://def456"`,
			expected: new ContainerID("containerd", "def456"),
		},
		{
			name: "valid format - no quotes",
			input: "docker://abc123",
			expected: new ContainerID("docker", "abc123"),
		},
		{
			name: "invalid format - missing separator",
			input: `"dockerabc123"`,
			expected: new ContainerID("", ""),
		},
		{
			name: "empty string",
			input: `""`,
			expected: new ContainerID("", ""),
		},
	];

	for (const tt of tests) {
		it(tt.name, () => {
			const result = parseContainerID(tt.input);
			expect(result).toEqual(tt.expected);
		});
	}
});

// Models kubernetes/pkg/kubelet/container/runtime_test.go TestContainerIDString.
browser.describe("ContainerID", () => {
	const tests: {
		name: string;
		cid: ContainerID;
		expected: string;
	}[] = [
		{
			name: "docker container",
			cid: new ContainerID("docker", "abc123"),
			expected: "docker://abc123",
		},
		{
			name: "containerd container",
			cid: new ContainerID("containerd", "def456"),
			expected: "containerd://def456",
		},
		{
			name: "empty container id",
			cid: new ContainerID("", ""),
			expected: "://",
		},
	];

	for (const tt of tests) {
		it(tt.name, () => {
			const result = tt.cid.toString();
			expect(result).toBe(tt.expected);
		});
	}
});

// Models kubernetes/pkg/kubelet/container/runtime_test.go TestPodStatusFindContainerStatusByName.
browser.describe("findContainerStatusByName", () => {
	const podStatus = newPodStatus({
		containerStatuses: [
			{ name: "container1", state: "Running" },
			{ name: "container2", state: "Exited" },
			{ name: "container1", state: "Created" },
		],
	});

	const tests: {
		name: string;
		containerName: string;
		expectedStatus: Status | undefined;
	}[] = [
		{
			name: "find existing container",
			containerName: "container1",
			expectedStatus: podStatus.containerStatuses[0],
		},
		{
			name: "find another existing container",
			containerName: "container2",
			expectedStatus: podStatus.containerStatuses[1],
		},
		{
			name: "find non-existing container",
			containerName: "nonexistent",
			expectedStatus: undefined,
		},
		{
			name: "empty container name",
			containerName: "",
			expectedStatus: undefined,
		},
	];

	for (const tt of tests) {
		it(tt.name, () => {
			const result = findContainerStatusByName(podStatus, tt.containerName);
			expect(result).toBe(tt.expectedStatus);
		});
	}
});

// Models kubernetes/pkg/kubelet/container/runtime_test.go TestPodStatusGetRunningContainerStatuses.
browser.describe("getRunningContainerStatuses", () => {
	it("returns running container statuses", () => {
		const podStatus = newPodStatus({
			containerStatuses: [
				{ name: "container1", state: "Running" },
				{ name: "container2", state: "Exited" },
				{ name: "container3", state: "Running" },
				{ name: "container4", state: "Created" },
			],
		});

		const expected = [podStatus.containerStatuses[0], podStatus.containerStatuses[2]];
		const result = getRunningContainerStatuses(podStatus);
		expect(result).toEqual(expected);
	});
});

// Models kubernetes/pkg/kubelet/container/runtime_test.go TestGetPodFullName.
browser.describe("getPodFullName", () => {
	const tests: {
		name: string;
		pod: V1Pod;
		expected: string;
	}[] = [
		{
			name: "normal pod",
			pod: {
				metadata: {
					name: "test-pod",
					namespace: "test-namespace",
				},
			},
			expected: "test-pod_test-namespace",
		},
		{
			name: "pod with empty name and namespace",
			pod: {
				metadata: {
					name: "",
					namespace: "",
				},
			},
			expected: "_",
		},
	];

	for (const tt of tests) {
		it(tt.name, () => {
			const result = getPodFullName(tt.pod);
			expect(result).toBe(tt.expected);
		});
	}
});

// Models kubernetes/pkg/kubelet/container/runtime_test.go TestBuildPodFullName.
browser.describe("buildPodFullName", () => {
	const tests: {
		name: string;
		podName: string;
		namespace: string;
		expected: string;
	}[] = [
		{
			name: "normal pod",
			podName: "test-pod",
			namespace: "test-namespace",
			expected: "test-pod_test-namespace",
		},
		{
			name: "empty name and namespace",
			podName: "",
			namespace: "",
			expected: "_",
		},
		{
			name: "empty name only",
			podName: "",
			namespace: "test-namespace",
			expected: "_test-namespace",
		},
		{
			name: "empty namespace only",
			podName: "test-pod",
			namespace: "",
			expected: "test-pod_",
		},
	];

	for (const tt of tests) {
		it(tt.name, () => {
			const result = buildPodFullName(tt.podName, tt.namespace);
			expect(result).toBe(tt.expected);
		});
	}
});

// Models kubernetes/pkg/kubelet/container/runtime_test.go TestParsePodFullName.
browser.describe("parsePodFullName", () => {
	const tests: {
		name: string;
		podFullName: string;
		expectedName: string;
		expectedNamespace: string;
		expectError: boolean;
	}[] = [
		{
			name: "valid pod full name",
			podFullName: "test-pod_test-namespace",
			expectedName: "test-pod",
			expectedNamespace: "test-namespace",
			expectError: false,
		},
		{
			name: "invalid format - no underscore",
			podFullName: "test-pod",
			expectedName: "",
			expectedNamespace: "",
			expectError: true,
		},
		{
			name: "invalid format - multiple underscores",
			podFullName: "test_pod_namespace",
			expectedName: "",
			expectedNamespace: "",
			expectError: true,
		},
		{
			name: "invalid format - empty parts",
			podFullName: "_",
			expectedName: "",
			expectedNamespace: "",
			expectError: true,
		},
		{
			name: "invalid format - empty name",
			podFullName: "_namespace",
			expectedName: "",
			expectedNamespace: "",
			expectError: true,
		},
		{
			name: "invalid format - empty namespace",
			podFullName: "pod_",
			expectedName: "",
			expectedNamespace: "",
			expectError: true,
		},
	];

	for (const tt of tests) {
		it(tt.name, () => {
			const [name, namespace, err] = parsePodFullName(tt.podFullName);
			expect(err !== undefined).toBe(tt.expectError);
			expect(name).toBe(tt.expectedName);
			expect(namespace).toBe(tt.expectedNamespace);
		});
	}
});

// Models kubernetes/pkg/kubelet/container/runtime_test.go TestPodFindContainerByName.
browser.describe("findContainerByName", () => {
	const pod = newPod({
		containers: [
			{ name: "container1", id: { type: "docker", id: "abc123" } },
			{ name: "container2", id: { type: "docker", id: "def456" } },
			{ name: "container1", id: { type: "docker", id: "ghi789" } },
		],
	});

	const tests = [
		{
			name: "find existing container",
			containerName: "container1",
			expectedContainer: pod.containers[0],
		},
		{
			name: "find another existing container",
			containerName: "container2",
			expectedContainer: pod.containers[1],
		},
		{
			name: "find non-existing container",
			containerName: "nonexistent",
			expectedContainer: undefined,
		},
		{
			name: "empty container name",
			containerName: "",
			expectedContainer: undefined,
		},
	];

	for (const tt of tests) {
		it(tt.name, () => {
			const result = findContainerByName(pod, tt.containerName);
			expect(result).toBe(tt.expectedContainer);
		});
	}
});

// Models kubernetes/pkg/kubelet/container/runtime_test.go TestPodFindContainerByID.
browser.describe("findContainerByID", () => {
	const pod = newPod({
		containers: [
			{ name: "container1", id: { type: "docker", id: "abc123" } },
			{ name: "container2", id: { type: "containerd", id: "def456" } },
		],
	});

	const tests = [
		{
			name: "find existing container",
			containerID: newContainerID({ type: "docker", id: "abc123" }),
			expectedContainer: pod.containers[0],
		},
		{
			name: "find another existing container",
			containerID: newContainerID({ type: "containerd", id: "def456" }),
			expectedContainer: pod.containers[1],
		},
		{
			name: "find non-existing container",
			containerID: newContainerID({ type: "docker", id: "nonexistent" }),
			expectedContainer: undefined,
		},
		{
			name: "empty container id",
			containerID: newContainerID(),
			expectedContainer: undefined,
		},
	];

	for (const tt of tests) {
		it(tt.name, () => {
			const result = findContainerByID(pod, tt.containerID);
			expect(result).toBe(tt.expectedContainer);
		});
	}
});

// Models kubernetes/pkg/kubelet/container/runtime_test.go TestPodFindSandboxByID.
browser.describe("findSandboxByID", () => {
	const pod = newPod({
		sandboxes: [
			{ name: "sandbox1", id: { type: "docker", id: "abc123" } },
			{ name: "sandbox2", id: { type: "containerd", id: "def456" } },
		],
	});

	const tests = [
		{
			name: "find existing sandbox",
			sandboxID: newContainerID({ type: "docker", id: "abc123" }),
			expectedSandbox: pod.sandboxes[0],
		},
		{
			name: "find another existing sandbox",
			sandboxID: newContainerID({ type: "containerd", id: "def456" }),
			expectedSandbox: pod.sandboxes[1],
		},
		{
			name: "find non-existing sandbox",
			sandboxID: newContainerID({ type: "docker", id: "nonexistent" }),
			expectedSandbox: undefined,
		},
		{
			name: "empty sandbox id",
			sandboxID: newContainerID(),
			expectedSandbox: undefined,
		},
	];

	for (const tt of tests) {
		it(tt.name, () => {
			const result = findSandboxByID(pod, tt.sandboxID);
			expect(result).toBe(tt.expectedSandbox);
		});
	}
});

// Models kubernetes/pkg/kubelet/container/runtime_test.go TestPodToAPIPod.
browser.describe("toAPIPod", () => {
	it("converts a runtime pod to an API pod", () => {
		const pod = newPod({
			id: "test-uid",
			name: "test-pod",
			namespace: "test-namespace",
			containers: [
				{ name: "container1", image: "nginx:latest" },
				{ name: "container2", image: "redis:latest" },
			],
		});

		const expected: V1Pod = {
			metadata: {
				uid: "test-uid",
				name: "test-pod",
				namespace: "test-namespace",
			},
			spec: {
				containers: [
					{ name: "container1", image: "nginx:latest" },
					{ name: "container2", image: "redis:latest" },
				],
			},
		};

		const result = toAPIPod(pod);
		expect(result).toEqual(expected);
	});
});

// Models kubernetes/pkg/kubelet/container/runtime_test.go TestPodIsEmpty.
browser.describe("podIsEmpty", () => {
	const tests: {
		name: string;
		pod: Pod;
		expected: boolean;
	}[] = [
		{
			name: "empty pod",
			pod: newPod(),
			expected: true,
		},
		{
			name: "non-empty pod",
			pod: newPod({
				id: "test-uid",
				name: "test-pod",
				namespace: "test-namespace",
			}),
			expected: false,
		},
		{
			name: "pod with containers",
			pod: newPod({
				containers: [{ name: "container1" }],
			}),
			expected: false,
		},
		{
			name: "pod with sandboxes",
			pod: newPod({
				sandboxes: [{ name: "sandbox1" }],
			}),
			expected: false,
		},
	];

	for (const tt of tests) {
		it(tt.name, () => {
			const result = podIsEmpty(tt.pod);
			expect(result).toBe(tt.expected);
		});
	}
});

// Models kubernetes/pkg/kubelet/container/runtime_test.go TestPodsFindPod.
browser.describe("findPod", () => {
	const pods = [
		newPod({ id: "uid1", name: "pod1", namespace: "ns1" }),
		newPod({ id: "uid2", name: "pod2", namespace: "ns2" }),
	];

	const tests: {
		name: string;
		podFullName: string;
		podUID: string;
		expected: Pod;
	}[] = [
		{
			name: "find by full name",
			podFullName: "pod1_ns1",
			podUID: "",
			expected: pods[0],
		},
		{
			name: "find by uid when full name is empty",
			podFullName: "",
			podUID: "uid2",
			expected: pods[1],
		},
		{
			name: "find by full name takes precedence",
			podFullName: "pod1_ns1",
			podUID: "uid2",
			expected: pods[0],
		},
		{
			name: "find non-existing pod",
			podFullName: "pod3_ns3",
			podUID: "uid3",
			expected: newPod(),
		},
	];

	for (const tt of tests) {
		it(tt.name, () => {
			const result = findPod(pods, tt.podFullName, tt.podUID);
			expect(result).toEqual(tt.expected);
		});
	}
});

// Models kubernetes/pkg/kubelet/container/runtime_test.go TestRuntimeStatusGetRuntimeCondition.
browser.describe("RuntimeStatus", () => {
	it("finds runtime conditions by type", () => {
		const status = new RuntimeStatus({
			conditions: [
				new RuntimeCondition({
					type: runtimeReady,
					status: true,
					reason: "ready",
					message: "runtime is ready",
				}),
				new RuntimeCondition({
					type: networkReady,
					status: false,
					reason: "not ready",
					message: "network is not ready",
				}),
			],
		});

		expect(status.getRuntimeCondition(runtimeReady)).toBe(status.conditions[0]);
		expect(status.getRuntimeCondition(networkReady)).toBe(status.conditions[1]);
		expect(status.getRuntimeCondition("NonExistent")).toBeUndefined();
	});

	// Models kubernetes/pkg/kubelet/container/runtime_test.go TestRuntimeStatusString.
	it("formats runtime status", () => {
		const status = new RuntimeStatus({
			conditions: [
				new RuntimeCondition({
					type: runtimeReady,
					status: true,
					reason: "ready",
					message: "runtime is ready",
				}),
				new RuntimeCondition({
					type: networkReady,
					status: false,
					reason: "not ready",
					message: "network is not ready",
				}),
			],
			handlers: [
				new RuntimeHandler({
					name: "handler1",
					supportsRecursiveReadOnlyMounts: true,
					supportsUserNamespaces: false,
				}),
				new RuntimeHandler({
					name: "handler2",
					supportsRecursiveReadOnlyMounts: false,
					supportsUserNamespaces: true,
				}),
			],
			features: new RuntimeFeatures({
				supplementalGroupsPolicy: true,
				userNamespacesHostNetwork: true,
			}),
		});

		expect(status.toString()).toBe(
			"Runtime Conditions: RuntimeReady=true reason:ready message:runtime is ready, NetworkReady=false reason:not ready message:network is not ready; Handlers: Name=handler1 SupportsRecursiveReadOnlyMounts: true SupportsUserNamespaces: false, Name=handler2 SupportsRecursiveReadOnlyMounts: false SupportsUserNamespaces: true, Features: SupplementalGroupsPolicy: true UserNamespacesHostNetwork: true",
		);
	});
});

// Models kubernetes/pkg/kubelet/container/runtime_test.go TestRuntimeHandlerString.
browser.describe("RuntimeHandler", () => {
	const tests = [
		{
			name: "handler with all features",
			handler: new RuntimeHandler({
				name: "test-handler",
				supportsRecursiveReadOnlyMounts: true,
				supportsUserNamespaces: true,
			}),
			expected:
				"Name=test-handler SupportsRecursiveReadOnlyMounts: true SupportsUserNamespaces: true",
		},
		{
			name: "handler with no features",
			handler: new RuntimeHandler({
				name: "test-handler",
				supportsRecursiveReadOnlyMounts: false,
				supportsUserNamespaces: false,
			}),
			expected:
				"Name=test-handler SupportsRecursiveReadOnlyMounts: false SupportsUserNamespaces: false",
		},
	];

	for (const tt of tests) {
		it(tt.name, () => {
			const result = tt.handler.toString();
			expect(result).toBe(tt.expected);
		});
	}
});

// Models kubernetes/pkg/kubelet/container/runtime_test.go TestRuntimeConditionString.
browser.describe("RuntimeCondition", () => {
	const tests = [
		{
			name: "true condition",
			condition: new RuntimeCondition({
				type: runtimeReady,
				status: true,
				reason: "ready",
				message: "runtime is ready",
			}),
			expected: "RuntimeReady=true reason:ready message:runtime is ready",
		},
		{
			name: "false condition",
			condition: new RuntimeCondition({
				type: networkReady,
				status: false,
				reason: "not ready",
				message: "network is not ready",
			}),
			expected: "NetworkReady=false reason:not ready message:network is not ready",
		},
	];

	for (const tt of tests) {
		it(tt.name, () => {
			const result = tt.condition.toString();
			expect(result).toBe(tt.expected);
		});
	}
});

// Models kubernetes/pkg/kubelet/container/runtime_test.go TestRuntimeFeaturesString.
browser.describe("RuntimeFeatures", () => {
	const tests = [
		{
			name: "features with both flags true",
			features: new RuntimeFeatures({
				supplementalGroupsPolicy: true,
				userNamespacesHostNetwork: true,
			}),
			expected: "SupplementalGroupsPolicy: true UserNamespacesHostNetwork: true",
		},
		{
			name: "features with both flags false",
			features: new RuntimeFeatures({
				supplementalGroupsPolicy: false,
				userNamespacesHostNetwork: false,
			}),
			expected: "SupplementalGroupsPolicy: false UserNamespacesHostNetwork: false",
		},
	];

	for (const tt of tests) {
		it(tt.name, () => {
			const result = tt.features.toString();
			expect(result).toBe(tt.expected);
		});
	}
});
