import { expect, it } from "vitest";
import { browser } from "../../test/describe";
import { buildContainerID, type PodStatus, type Status } from "./container";
import { getContainersToDeleteInPod } from "./pod-container-deletor";

// Models kubernetes/pkg/kubelet/pod_container_deletor_test.go TestGetContainersToDeleteInPodWithFilter.
browser.describe("getContainersToDeleteInPod with filter", () => {
	it.each([
		{
			containersToKeep: 0,
			expectedIndexes: [3, 2, 1],
		},
		{
			containersToKeep: 1,
			expectedIndexes: [2, 1],
		},
		{
			containersToKeep: 2,
			expectedIndexes: [1],
		},
	])("keeps $containersToKeep containers", (test) => {
		const pod = testPodStatus();

		const candidates = getContainersToDeleteInPod("4", pod, test.containersToKeep);

		expect(candidates).toEqual(test.expectedIndexes.map((index) => pod.containerStatuses[index]));
	});
});

// Models kubernetes/pkg/kubelet/pod_container_deletor_test.go TestGetContainersToDeleteInPod.
browser.describe("getContainersToDeleteInPod", () => {
	it.each([
		{
			containersToKeep: 0,
			expectedIndexes: [3, 2, 1, 0],
		},
		{
			containersToKeep: 1,
			expectedIndexes: [2, 1, 0],
		},
		{
			containersToKeep: 2,
			expectedIndexes: [1, 0],
		},
	])("keeps $containersToKeep containers", (test) => {
		const pod = testPodStatus();

		const candidates = getContainersToDeleteInPod("", pod, test.containersToKeep);

		expect(candidates).toEqual(test.expectedIndexes.map((index) => pod.containerStatuses[index]));
	});
});

// Models kubernetes/pkg/kubelet/pod_container_deletor_test.go TestGetContainersToDeleteInPodWithNoMatch.
browser.describe("getContainersToDeleteInPod with no match", () => {
	it("returns no candidates", () => {
		const pod = testPodStatus();

		const candidates = getContainersToDeleteInPod("abc", pod, pod.containerStatuses.length);

		expect(candidates).toEqual([]);
	});
});

function testPodStatus(): PodStatus {
	return {
		id: "",
		name: "",
		namespace: "",
		ips: [],
		containerStatuses: [
			containerStatus("1", "foo", 0, "Exited"),
			containerStatus("2", "bar", 1000, "Exited"),
			containerStatus("3", "bar", 2000, "Exited"),
			containerStatus("4", "bar", 3000, "Exited"),
			containerStatus("5", "bar", 4000, "Running"),
		],
		sandboxStatuses: [],
		timestamp: new Date(0),
	};
}

function containerStatus(
	id: string,
	name: string,
	createdAt: number,
	state: Status["state"],
): Status {
	return {
		id: buildContainerID("test", id),
		name,
		createdAt,
		state,
		image: "",
		imageID: "",
		imageRef: "",
		imageRuntimeHandler: "",
		hash: 0,
		restartCount: 0,
	};
}
