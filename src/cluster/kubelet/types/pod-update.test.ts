import { expect, it } from "vitest";
import type { V1Pod } from "../../../client";
import { browser } from "../../../test/describe";
import {
	allSource,
	apiserverSource,
	configMirrorAnnotationKey,
	configSourceAnnotationKey,
	fileSource,
	getPodSource,
	getValidatedSources,
	hasRestartableInitContainer,
	highestUserDefinablePriority,
	httpSource,
	isCriticalPod,
	isCriticalPodBasedOnPriority,
	isMirrorPod,
	isNodeCriticalPod,
	isStaticPod,
	preemptable,
	syncPodCreate,
	syncPodKill,
	syncPodString,
	syncPodSync,
	syncPodUpdate,
	systemCriticalPriority,
	systemNodeCritical,
} from "./pod-update";

const systemPriority = systemCriticalPriority;
const systemPriorityUpper = systemPriority + 1000;

function getTestPod(
	annotations?: Record<string, string>,
	podPriority?: number,
	priorityClassName = "",
): V1Pod {
	return {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			name: "foo",
			namespace: "default",
			annotations,
		},
		spec: {
			containers: [],
			...(podPriority !== undefined ? { priority: podPriority } : {}),
			priorityClassName,
		},
	};
}

function configSourceAnnotation(source: string): Record<string, string> {
	return { [configSourceAnnotationKey]: source };
}

function configMirrorAnnotation(): Record<string, string> {
	return { [configMirrorAnnotationKey]: "true" };
}

// Models kubernetes/pkg/kubelet/types/pod_update_test.go TestGetValidatedSources.
browser.describe("getValidatedSources", () => {
	const tests: Array<{
		name: string;
		sources: string[];
		errExpected: boolean;
		sourcesLen: number;
	}> = [
		{
			name: "empty source",
			sources: [""],
			errExpected: false,
			sourcesLen: 0,
		},
		{
			name: "file and apiserver source",
			sources: [fileSource, apiserverSource],
			errExpected: false,
			sourcesLen: 2,
		},
		{
			name: "all source",
			sources: [allSource],
			errExpected: false,
			sourcesLen: 3,
		},
		{
			name: "unknown source",
			sources: ["unknown"],
			errExpected: true,
			sourcesLen: 0,
		},
	];

	for (const test of tests) {
		it(test.name, () => {
			const [sources, err] = getValidatedSources(test.sources);
			expect(err !== undefined).toBe(test.errExpected);
			expect(sources).toHaveLength(test.sourcesLen);
		});
	}
});

// Models kubernetes/pkg/kubelet/types/pod_update_test.go TestGetPodSource.
browser.describe("getPodSource", () => {
	const tests: Array<{
		name: string;
		pod: V1Pod;
		expected: string;
		errExpected: boolean;
	}> = [
		{
			name: "cannot get pod source",
			pod: getTestPod(),
			expected: "",
			errExpected: true,
		},
		{
			name: "valid annotation returns the source",
			pod: getTestPod(configSourceAnnotation("host-ipc-sources")),
			expected: "host-ipc-sources",
			errExpected: false,
		},
	];

	for (const test of tests) {
		it(test.name, () => {
			const [source, err] = getPodSource(test.pod);
			expect(err !== undefined).toBe(test.errExpected);
			expect(source).toBe(test.expected);
		});
	}
});

// Models kubernetes/pkg/kubelet/types/pod_update_test.go TestString.
browser.describe("syncPodString", () => {
	const tests: Array<{
		sp: string | number;
		expected: string;
	}> = [
		{
			sp: syncPodCreate,
			expected: "create",
		},
		{
			sp: syncPodUpdate,
			expected: "update",
		},
		{
			sp: syncPodSync,
			expected: "sync",
		},
		{
			sp: syncPodKill,
			expected: "kill",
		},
		{
			sp: 50,
			expected: "unknown",
		},
	];

	for (const test of tests) {
		it(test.expected, () => {
			expect(syncPodString(test.sp)).toBe(test.expected);
		});
	}
});

// Models kubernetes/pkg/kubelet/types/pod_update_test.go TestIsMirrorPod.
browser.describe("isMirrorPod", () => {
	const tests: Array<{
		name: string;
		pod: V1Pod;
		expected: boolean;
	}> = [
		{
			name: "mirror pod",
			pod: getTestPod(configMirrorAnnotation()),
			expected: true,
		},
		{
			name: "not a mirror pod",
			pod: getTestPod(),
			expected: false,
		},
	];

	for (const test of tests) {
		it(test.name, () => {
			expect(isMirrorPod(test.pod)).toBe(test.expected);
		});
	}
});

// Models kubernetes/pkg/kubelet/types/pod_update_test.go TestIsStaticPod.
browser.describe("isStaticPod", () => {
	const tests: Array<{
		name: string;
		pod: V1Pod;
		expected: boolean;
	}> = [
		{
			name: "static pod with file source",
			pod: getTestPod(configSourceAnnotation(fileSource)),
			expected: true,
		},
		{
			name: "static pod with http source",
			pod: getTestPod(configSourceAnnotation(httpSource)),
			expected: true,
		},
		{
			name: "static pod with api server source",
			pod: getTestPod(configSourceAnnotation(apiserverSource)),
			expected: false,
		},
	];

	for (const test of tests) {
		it(test.name, () => {
			expect(isStaticPod(test.pod)).toBe(test.expected);
		});
	}
});

// Models kubernetes/pkg/kubelet/types/pod_update_test.go TestIsCriticalPod.
browser.describe("isCriticalPod", () => {
	const tests: Array<{
		name: string;
		pod: V1Pod;
		expected: boolean;
	}> = [
		{
			name: "critical pod with file source",
			pod: getTestPod(configSourceAnnotation(fileSource)),
			expected: true,
		},
		{
			name: "critical pod with mirror annotation",
			pod: getTestPod(configMirrorAnnotation()),
			expected: true,
		},
		{
			name: "critical pod using system priority",
			pod: getTestPod(undefined, systemPriority),
			expected: true,
		},
		{
			name: "critical pod using greater than system priority",
			pod: getTestPod(undefined, systemPriorityUpper),
			expected: true,
		},
		{
			name: "not a critical pod with api server annotation",
			pod: getTestPod(configSourceAnnotation(apiserverSource)),
			expected: false,
		},
		{
			name: "not critical if not static, mirror or without a priority",
			pod: getTestPod(),
			expected: false,
		},
	];

	for (const test of tests) {
		it(test.name, () => {
			expect(isCriticalPod(test.pod)).toBe(test.expected);
		});
	}
});

// Models kubernetes/pkg/kubelet/types/pod_update_test.go TestPreemptable.
browser.describe("preemptable", () => {
	const tests: Array<{
		name: string;
		preemptor: V1Pod;
		preemptee: V1Pod;
		expected: boolean;
	}> = [
		{
			name: "a critical preemptor pod preempts a non critical pod",
			preemptor: getTestPod(configSourceAnnotation(fileSource)),
			preemptee: getTestPod(),
			expected: true,
		},
		{
			name: "a preemptor pod with higher priority preempts a critical pod",
			preemptor: getTestPod(configSourceAnnotation(fileSource), systemPriorityUpper),
			preemptee: getTestPod(configSourceAnnotation(fileSource), systemPriority),
			expected: true,
		},
		{
			name: "a not critical pod with higher priority preempts a critical pod",
			preemptor: getTestPod(configSourceAnnotation(apiserverSource), systemPriorityUpper),
			preemptee: getTestPod(configSourceAnnotation(fileSource), systemPriority),
			expected: true,
		},
		{
			name: "a critical pod with less priority do not preempts a critical pod",
			preemptor: getTestPod(configSourceAnnotation(fileSource), systemPriority),
			preemptee: getTestPod(configSourceAnnotation(fileSource), systemPriorityUpper),
			expected: false,
		},
		{
			name: "a critical pod without priority do not preempts a critical pod without priority",
			preemptor: getTestPod(configSourceAnnotation(fileSource)),
			preemptee: getTestPod(configSourceAnnotation(fileSource)),
			expected: false,
		},
		{
			name: "a critical pod with priority do not preempts a critical pod with the same priority",
			preemptor: getTestPod(configSourceAnnotation(fileSource), systemPriority),
			preemptee: getTestPod(configSourceAnnotation(fileSource), systemPriority),
			expected: false,
		},
	];

	for (const test of tests) {
		it(test.name, () => {
			expect(preemptable(test.preemptor, test.preemptee)).toBe(test.expected);
		});
	}
});

// Models kubernetes/pkg/kubelet/types/pod_update_test.go TestIsCriticalPodBasedOnPriority.
browser.describe("isCriticalPodBasedOnPriority", () => {
	const tests: Array<{
		priority: number;
		name: string;
		expected: boolean;
	}> = [
		{
			name: "a system critical pod",
			priority: systemPriority,
			expected: true,
		},
		{
			name: "a non system critical pod",
			priority: highestUserDefinablePriority,
			expected: false,
		},
	];

	for (const test of tests) {
		it(test.name, () => {
			expect(isCriticalPodBasedOnPriority(test.priority)).toBe(test.expected);
		});
	}
});

// Models kubernetes/pkg/kubelet/types/pod_update_test.go TestIsNodeCriticalPod.
browser.describe("isNodeCriticalPod", () => {
	const tests: Array<{
		name: string;
		pod: V1Pod;
		expected: boolean;
	}> = [
		{
			name: "critical pod with file source and systemNodeCritical",
			pod: getTestPod(configSourceAnnotation(fileSource), undefined, systemNodeCritical),
			expected: true,
		},
		{
			name: "critical pod with mirror annotation and systemNodeCritical",
			pod: getTestPod(configMirrorAnnotation(), undefined, systemNodeCritical),
			expected: true,
		},
		{
			name: "critical pod using system priority and systemNodeCritical",
			pod: getTestPod(undefined, systemPriority, systemNodeCritical),
			expected: true,
		},
		{
			name: "critical pod using greater than system priority and systemNodeCritical",
			pod: getTestPod(undefined, systemPriorityUpper, systemNodeCritical),
			expected: true,
		},
		{
			name: "not a critical pod with api server annotation and systemNodeCritical",
			pod: getTestPod(configSourceAnnotation(apiserverSource), undefined, systemNodeCritical),
			expected: false,
		},
		{
			name: "not critical if not static, mirror or without a priority and systemNodeCritical",
			pod: getTestPod(undefined, undefined, systemNodeCritical),
			expected: false,
		},
		{
			name: "not critical if not static, mirror or without a priority",
			pod: getTestPod(),
			expected: false,
		},
	];

	for (const test of tests) {
		it(test.name, () => {
			expect(isNodeCriticalPod(test.pod)).toBe(test.expected);
		});
	}
});

// Models kubernetes/pkg/kubelet/types/pod_update_test.go TestHasRestartableInitContainer.
browser.describe("hasRestartableInitContainer", () => {
	const containerRestartPolicyAlways = "Always";
	const tests: Array<{
		name: string;
		pod: V1Pod;
		expected: boolean;
	}> = [
		{
			name: "pod without init containers",
			pod: {
				spec: {
					containers: [{ name: "container1" }],
				},
			},
			expected: false,
		},
		{
			name: "pod with regular init containers only",
			pod: {
				spec: {
					initContainers: [{ name: "init1" }, { name: "init2" }],
					containers: [{ name: "container1" }],
				},
			},
			expected: false,
		},
		{
			name: "pod with one restartable init container",
			pod: {
				spec: {
					initContainers: [
						{ name: "restartable-init", restartPolicy: containerRestartPolicyAlways },
					],
					containers: [{ name: "container1" }],
				},
			},
			expected: true,
		},
		{
			name: "pod with mixed init containers (regular and restartable)",
			pod: {
				spec: {
					initContainers: [
						{ name: "init1" },
						{ name: "restartable-init", restartPolicy: containerRestartPolicyAlways },
						{ name: "init2" },
					],
					containers: [{ name: "container1" }],
				},
			},
			expected: true,
		},
		{
			name: "pod with multiple restartable init containers",
			pod: {
				spec: {
					initContainers: [
						{ name: "restartable-init1", restartPolicy: containerRestartPolicyAlways },
						{ name: "restartable-init2", restartPolicy: containerRestartPolicyAlways },
					],
					containers: [{ name: "container1" }],
				},
			},
			expected: true,
		},
		{
			name: "pod with init container having nil restart policy",
			pod: {
				spec: {
					initContainers: [{ name: "init1" }],
					containers: [{ name: "container1" }],
				},
			},
			expected: false,
		},
	];

	for (const test of tests) {
		it(test.name, () => {
			expect(hasRestartableInitContainer(test.pod)).toBe(test.expected);
		});
	}
});
