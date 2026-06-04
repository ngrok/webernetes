import { expect, it } from "vitest";
import type { V1Pod } from "../../../../client";
import { browser } from "../../../../test/describe";
import { pod, podDesc } from "./pod";

function fakeCreatePod(name: string, namespace: string, uid: string): V1Pod {
	return {
		metadata: {
			name,
			namespace,
			uid,
		},
	};
}

// Models kubernetes/pkg/kubelet/util/format/pod_test.go TestPod.
browser.describe("TestPod", () => {
	const testCases: {
		caseName: string;
		pod: V1Pod | undefined;
		expectedValue: string;
	}[] = [
		{ caseName: "field_empty_case", pod: fakeCreatePod("", "", ""), expectedValue: "_()" },
		{
			caseName: "field_normal_case",
			pod: fakeCreatePod("test-pod", "default", "551f5a43-9f2f-11e7-a589-fa163e148d75"),
			expectedValue: "test-pod_default(551f5a43-9f2f-11e7-a589-fa163e148d75)",
		},
		{ caseName: "nil_pod_case", pod: undefined, expectedValue: "<nil>" },
	];

	for (const testCase of testCases) {
		it(testCase.caseName, () => {
			const realPod = pod(testCase.pod);
			expect(realPod).toEqual(testCase.expectedValue);
		});
	}
});

// Models kubernetes/pkg/kubelet/util/format/pod_test.go TestPodAndPodDesc.
browser.describe("TestPodAndPodDesc", () => {
	const testCases: {
		caseName: string;
		podName: string;
		podNamespace: string;
		podUID: string;
		expectedValue: string;
	}[] = [
		{
			caseName: "field_empty_case",
			podName: "",
			podNamespace: "",
			podUID: "",
			expectedValue: "_()",
		},
		{
			caseName: "field_normal_case",
			podName: "test-pod",
			podNamespace: "default",
			podUID: "551f5a43-9f2f-11e7-a589-fa163e148d75",
			expectedValue: "test-pod_default(551f5a43-9f2f-11e7-a589-fa163e148d75)",
		},
	];

	for (const testCase of testCases) {
		it(testCase.caseName, () => {
			const realPodDesc = podDesc(testCase.podName, testCase.podNamespace, testCase.podUID);
			expect(realPodDesc).toEqual(testCase.expectedValue);
		});
	}
});
