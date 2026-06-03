import { expect, it } from "vitest";
import { browser } from "../../../test/describe";
import { podConditionByKubelet, podConditionSharedByKubelet } from "./pod-status";

// Models kubernetes/pkg/kubelet/types/pod_status_test.go TestPodConditionByKubelet.
browser.describe("podConditionByKubelet", () => {
	const trueCases = [
		"PodScheduled",
		"Ready",
		"Initialized",
		"ContainersReady",
		"PodReadyToStartContainers",
	];

	for (const tc of trueCases) {
		it(`treats ${tc} as owned by kubelet`, () => {
			expect(podConditionByKubelet(tc)).toBe(true);
		});
	}

	const falseCases = ["abcd", "Unschedulable"];

	for (const tc of falseCases) {
		it(`does not treat ${tc} as owned by kubelet`, () => {
			expect(podConditionByKubelet(tc)).toBe(false);
		});
	}
});

// Upstream pod_status_test.go does not include this 1.36-default feature-gated
// case. The simulator has no feature gates, so it follows the default-enabled
// behavior.
browser.describe("podConditionByKubelet local extra coverage", () => {
	it("treats AllContainersRestarting as owned by kubelet", () => {
		expect(podConditionByKubelet("AllContainersRestarting")).toBe(true);
	});
});

// Models kubernetes/pkg/kubelet/types/pod_status_test.go TestPodConditionSharedByKubelet.
browser.describe("podConditionSharedByKubelet", () => {
	const trueCases = ["DisruptionTarget"];

	for (const tc of trueCases) {
		it(`treats ${tc} as shared by kubelet`, () => {
			expect(podConditionSharedByKubelet(tc)).toBe(true);
		});
	}

	const falseCases = ["abcd", "Unschedulable"];

	for (const tc of falseCases) {
		it(`does not treat ${tc} as shared by kubelet`, () => {
			expect(podConditionSharedByKubelet(tc)).toBe(false);
		});
	}
});
