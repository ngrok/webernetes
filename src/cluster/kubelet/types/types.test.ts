/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";
import type { V1Container, V1ContainerStatus, V1Pod } from "../../../client";
import { browser } from "../../../test/describe";
import {
	sortedContainerStatuses,
	sortInitContainerStatuses,
	sortStatusesOfInitContainers,
} from "./types";

// Models kubernetes/pkg/kubelet/types/types_test.go TestLess.
browser.describe("sortedContainerStatuses", () => {
	it("sorts statuses by container name", () => {
		const statuses: V1ContainerStatus[] = [{ name: "second" }, { name: "first" }].map((status) => ({
			image: "",
			imageID: "",
			ready: false,
			restartCount: 0,
			...status,
		}));

		expect(sortedContainerStatuses(statuses).map((status) => status.name)).toEqual([
			"first",
			"second",
		]);
		expect(statuses.map((status) => status.name)).toEqual(["second", "first"]);
	});
});

// Models kubernetes/pkg/kubelet/types/types_test.go TestSortInitContainerStatuses.
browser.describe("sortInitContainerStatuses", () => {
	const tests: Array<{
		containers: V1Container[];
		statuses: V1ContainerStatus[];
		sortedStatuses: V1ContainerStatus[];
	}> = [
		{
			containers: [{ name: "first" }, { name: "second" }, { name: "third" }, { name: "fourth" }],
			statuses: [
				containerStatus("first"),
				containerStatus("second"),
				containerStatus("third"),
				containerStatus("fourth"),
			],
			sortedStatuses: [
				containerStatus("first"),
				containerStatus("second"),
				containerStatus("third"),
				containerStatus("fourth"),
			],
		},
		{
			containers: [{ name: "first" }, { name: "second" }, { name: "third" }, { name: "fourth" }],
			statuses: [
				containerStatus("second"),
				containerStatus("first"),
				containerStatus("fourth"),
				containerStatus("third"),
			],
			sortedStatuses: [
				containerStatus("first"),
				containerStatus("second"),
				containerStatus("third"),
				containerStatus("fourth"),
			],
		},
		{
			containers: [{ name: "first" }, { name: "second" }, { name: "third" }, { name: "fourth" }],
			statuses: [containerStatus("fourth"), containerStatus("first")],
			sortedStatuses: [containerStatus("first"), containerStatus("fourth")],
		},
		{
			containers: [{ name: "first" }, { name: "second" }, { name: "third" }, { name: "fourth" }],
			statuses: [containerStatus("first"), containerStatus("third")],
			sortedStatuses: [containerStatus("first"), containerStatus("third")],
		},
	];

	it.each(tests)("sorts init statuses in pod init container order", (test) => {
		const pod: V1Pod = { spec: { initContainers: test.containers, containers: [] } };

		sortInitContainerStatuses(pod, test.statuses);

		expect(test.statuses).toEqual(test.sortedStatuses);
	});
});

// Models kubernetes/pkg/kubelet/types/types_test.go TestSortStatusesOfInitContainers.
browser.describe("sortStatusesOfInitContainers", () => {
	const tests: Array<{
		containers: V1Container[];
		statusMap: Map<string, V1ContainerStatus>;
		expectStatuses: V1ContainerStatus[];
	}> = [
		{
			containers: [{ name: "first" }, { name: "second" }, { name: "third" }, { name: "fourth" }],
			expectStatuses: [
				containerStatus("first"),
				containerStatus("second"),
				containerStatus("third"),
				containerStatus("fourth"),
			],
			statusMap: statusMap("first", "second", "third", "fourth"),
		},
		{
			containers: [{ name: "first" }, { name: "second" }, { name: "third" }, { name: "fourth" }],
			expectStatuses: [
				containerStatus("first"),
				containerStatus("second"),
				containerStatus("third"),
				containerStatus("fourth"),
			],
			statusMap: statusMap("second", "third", "first", "fourth"),
		},
		{
			containers: [{ name: "first" }, { name: "second" }, { name: "third" }, { name: "fourth" }],
			expectStatuses: [
				containerStatus("first"),
				containerStatus("third"),
				containerStatus("fourth"),
			],
			statusMap: statusMap("third", "first", "fourth"),
		},
		{
			containers: [{ name: "first" }, { name: "second" }, { name: "third" }, { name: "fourth" }],
			expectStatuses: [
				containerStatus("first"),
				containerStatus("third"),
				containerStatus("fourth"),
			],
			statusMap: statusMap("first", "third", "fourth"),
		},
	];

	it.each(tests)("returns init statuses in pod init container order", (test) => {
		const pod: V1Pod = { spec: { initContainers: test.containers, containers: [] } };

		const result = sortStatusesOfInitContainers(pod, test.statusMap);

		expect(result).toEqual(test.expectStatuses);
	});
});

function containerStatus(name: string): V1ContainerStatus {
	return {
		name,
		image: "",
		imageID: "",
		ready: false,
		restartCount: 0,
	};
}

function statusMap(...names: string[]): Map<string, V1ContainerStatus> {
	return new Map(names.map((name) => [name, containerStatus(name)]));
}
