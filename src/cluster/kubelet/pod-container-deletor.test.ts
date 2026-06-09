/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";
import { browser } from "../../test/describe";
import { newPodStatus, newStatus, type Status } from "./container";
import { getContainersToDeleteInPod } from "./pod-container-deletor";

// Models kubernetes/pkg/kubelet/pod_container_deletor_test.go TestGetContainersToDeleteInPodWithFilter.
browser.describe("TestGetContainersToDeleteInPodWithFilter", () => {
	it("returns containers matching the filtered container name", () => {
		const now = Date.now();
		const pod = newPodStatus({
			containerStatuses: [
				newStatus({
					id: { type: "test", id: "1" },
					name: "foo",
					createdAt: now,
					state: "Exited",
				}),
				newStatus({
					id: { type: "test", id: "2" },
					name: "bar",
					createdAt: now + 1000,
					state: "Exited",
				}),
				newStatus({
					id: { type: "test", id: "3" },
					name: "bar",
					createdAt: now + 2 * 1000,
					state: "Exited",
				}),
				newStatus({
					id: { type: "test", id: "4" },
					name: "bar",
					createdAt: now + 3 * 1000,
					state: "Exited",
				}),
				newStatus({
					id: { type: "test", id: "5" },
					name: "bar",
					createdAt: now + 4 * 1000,
					state: "Running",
				}),
			],
		});

		const testCases: Array<{
			containersToKeep: number;
			expectedContainersToDelete: Array<Status | undefined>;
		}> = [
			{
				containersToKeep: 0,
				expectedContainersToDelete: [
					pod.containerStatuses[3],
					pod.containerStatuses[2],
					pod.containerStatuses[1],
				],
			},
			{
				containersToKeep: 1,
				expectedContainersToDelete: [pod.containerStatuses[2], pod.containerStatuses[1]],
			},
			{
				containersToKeep: 2,
				expectedContainersToDelete: [pod.containerStatuses[1]],
			},
		];

		for (const test of testCases) {
			const candidates = getContainersToDeleteInPod("4", pod, test.containersToKeep);
			expect(candidates).toEqual(test.expectedContainersToDelete);
		}
	});
});

// Models kubernetes/pkg/kubelet/pod_container_deletor_test.go TestGetContainersToDeleteInPod.
browser.describe("TestGetContainersToDeleteInPod", () => {
	it("returns containers across the pod", () => {
		const now = Date.now();
		const pod = newPodStatus({
			containerStatuses: [
				newStatus({
					id: { type: "test", id: "1" },
					name: "foo",
					createdAt: now,
					state: "Exited",
				}),
				newStatus({
					id: { type: "test", id: "2" },
					name: "bar",
					createdAt: now + 1000,
					state: "Exited",
				}),
				newStatus({
					id: { type: "test", id: "3" },
					name: "bar",
					createdAt: now + 2 * 1000,
					state: "Exited",
				}),
				newStatus({
					id: { type: "test", id: "4" },
					name: "bar",
					createdAt: now + 3 * 1000,
					state: "Exited",
				}),
				newStatus({
					id: { type: "test", id: "5" },
					name: "bar",
					createdAt: now + 4 * 1000,
					state: "Running",
				}),
			],
		});

		const testCases: Array<{
			containersToKeep: number;
			expectedContainersToDelete: Array<Status | undefined>;
		}> = [
			{
				containersToKeep: 0,
				expectedContainersToDelete: [
					pod.containerStatuses[3],
					pod.containerStatuses[2],
					pod.containerStatuses[1],
					pod.containerStatuses[0],
				],
			},
			{
				containersToKeep: 1,
				expectedContainersToDelete: [
					pod.containerStatuses[2],
					pod.containerStatuses[1],
					pod.containerStatuses[0],
				],
			},
			{
				containersToKeep: 2,
				expectedContainersToDelete: [pod.containerStatuses[1], pod.containerStatuses[0]],
			},
		];

		for (const test of testCases) {
			const candidates = getContainersToDeleteInPod("", pod, test.containersToKeep);
			expect(candidates).toEqual(test.expectedContainersToDelete);
		}
	});
});

// Models kubernetes/pkg/kubelet/pod_container_deletor_test.go TestGetContainersToDeleteInPodWithNoMatch.
browser.describe("TestGetContainersToDeleteInPodWithNoMatch", () => {
	it("returns no candidates when the filter does not match", () => {
		const now = Date.now();
		const pod = newPodStatus({
			containerStatuses: [
				newStatus({
					id: { type: "test", id: "1" },
					name: "foo",
					createdAt: now,
					state: "Exited",
				}),
				newStatus({
					id: { type: "test", id: "2" },
					name: "bar",
					createdAt: now + 1000,
					state: "Exited",
				}),
				newStatus({
					id: { type: "test", id: "3" },
					name: "bar",
					createdAt: now + 2 * 1000,
					state: "Exited",
				}),
				newStatus({
					id: { type: "test", id: "4" },
					name: "bar",
					createdAt: now + 3 * 1000,
					state: "Exited",
				}),
				newStatus({
					id: { type: "test", id: "5" },
					name: "bar",
					createdAt: now + 4 * 1000,
					state: "Running",
				}),
			],
		});

		const testCases: Array<{
			filterID: string;
			expectedContainersToDelete: Status[];
		}> = [
			{
				filterID: "abc",
				expectedContainersToDelete: [],
			},
		];

		for (const test of testCases) {
			const candidates = getContainersToDeleteInPod(
				test.filterID,
				pod,
				pod.containerStatuses.length,
			);
			expect(candidates).toEqual(test.expectedContainersToDelete);
		}
	});
});
