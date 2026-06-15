/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import type { V1Pod, V1PodTemplateSpec } from "../client";
import { browser } from "../test/describe";
import { ActivePodsWithRanks, computeHash } from "./controller-utils";

browser.describe("controller utils", () => {
	// Models kubernetes/pkg/controller/controller_utils_test.go TestSortingActivePodsWithRanks.
	it("SortingActivePodsWithRanks", () => {
		const now = new Date("2026-01-01T00:00:00.000Z");
		const then1Month = new Date("2025-12-01T00:00:00.000Z");
		const then2Hours = new Date(now.getTime() - 2 * 60 * 60 * 1000);
		const then5Hours = new Date(now.getTime() - 5 * 60 * 60 * 1000);
		const then8Hours = new Date(now.getTime() - 8 * 60 * 60 * 1000);
		const zeroTime = undefined;
		const pod = (
			podName: string,
			nodeName: string,
			phase: string,
			ready: boolean,
			restarts: number,
			sideRestarts: number,
			readySince: Date | undefined,
			created: Date | undefined,
			annotations?: Record<string, string>,
		): V1Pod => ({
			metadata: {
				creationTimestamp: created,
				name: podName,
				annotations,
			},
			spec: {
				containers: [],
				nodeName,
				initContainers: [{ name: "sidecar", restartPolicy: "Always" }],
			},
			status: {
				conditions: ready
					? [{ type: "Ready", status: "True", lastTransitionTime: readySince }]
					: undefined,
				containerStatuses: ready
					? [
							{
								image: "image",
								imageID: "image",
								name: "container",
								ready: true,
								restartCount: restarts,
							},
						]
					: undefined,
				initContainerStatuses: ready
					? [
							{
								image: "image",
								imageID: "image",
								name: "sidecar",
								ready: true,
								restartCount: sideRestarts,
							},
						]
					: undefined,
				phase,
			},
		});
		const unscheduledPod = pod("unscheduled", "", "Pending", false, 0, 0, zeroTime, zeroTime);
		const scheduledPendingPod = pod("pending", "node", "Pending", false, 0, 0, zeroTime, zeroTime);
		const unknownPhasePod = pod(
			"unknown-phase",
			"node",
			"Unknown",
			false,
			0,
			0,
			zeroTime,
			zeroTime,
		);
		const runningNotReadyPod = pod("not-ready", "node", "Running", false, 0, 0, zeroTime, zeroTime);
		const runningReadyNoLastTransitionTimePod = pod(
			"ready-no-last-transition-time",
			"node",
			"Running",
			true,
			0,
			0,
			zeroTime,
			zeroTime,
		);
		const runningReadyNow = pod("ready-now", "node", "Running", true, 0, 0, now, now);
		const runningReadyThen = pod(
			"ready-then",
			"node",
			"Running",
			true,
			0,
			0,
			then1Month,
			then1Month,
		);
		const runningReadyNowHighRestarts = pod(
			"ready-high-restarts",
			"node",
			"Running",
			true,
			9001,
			0,
			now,
			now,
		);
		const runningReadyNowHighSideRestarts = pod(
			"ready-high-side-restarts",
			"node",
			"Running",
			true,
			9001,
			9001,
			now,
			now,
		);
		const runningReadyNowCreatedThen = pod(
			"ready-now-created-then",
			"node",
			"Running",
			true,
			0,
			0,
			now,
			then1Month,
		);
		const lowPodDeletionCost = pod(
			"low-deletion-cost",
			"node",
			"Running",
			true,
			0,
			0,
			now,
			then1Month,
			{ "controller.kubernetes.io/pod-deletion-cost": "10" },
		);
		const highPodDeletionCost = pod(
			"high-deletion-cost",
			"node",
			"Running",
			true,
			0,
			0,
			now,
			then1Month,
			{ "controller.kubernetes.io/pod-deletion-cost": "100" },
		);
		const ready2Hours = pod("ready-2-hours", "", "Running", true, 0, 0, then2Hours, then1Month);
		const ready5Hours = pod("ready-5-hours", "", "Running", true, 0, 0, then5Hours, then1Month);
		const ready10Hours = pod("ready-10-hours", "", "Running", true, 0, 0, then8Hours, then1Month);
		const equalityTests: Array<{ p1: V1Pod; p2?: V1Pod }> = [
			{ p1: unscheduledPod },
			{ p1: scheduledPendingPod },
			{ p1: unknownPhasePod },
			{ p1: runningNotReadyPod },
			{ p1: runningReadyNowCreatedThen },
			{ p1: runningReadyNow },
			{ p1: runningReadyThen },
			{ p1: runningReadyNowHighRestarts },
			{ p1: runningReadyNowCreatedThen },
			{ p1: ready5Hours, p2: ready10Hours },
		];
		for (const [index, test] of equalityTests.entries()) {
			const podsWithRanks = new ActivePodsWithRanks([test.p1, test.p2 ?? test.p1], [1, 1], now);
			expect({
				leftLess: podsWithRanks.less(0, 1),
				rightLess: podsWithRanks.less(1, 0),
				name: `Equality tests ${index}`,
			}).toEqual({ leftLess: false, rightLess: false, name: `Equality tests ${index}` });
		}

		const inequalityTests: Array<{
			lesser: [V1Pod, number];
			greater: [V1Pod, number];
		}> = [
			{ lesser: [unscheduledPod, 1], greater: [scheduledPendingPod, 2] },
			{ lesser: [unscheduledPod, 2], greater: [scheduledPendingPod, 1] },
			{ lesser: [scheduledPendingPod, 1], greater: [unknownPhasePod, 2] },
			{ lesser: [unknownPhasePod, 1], greater: [runningNotReadyPod, 2] },
			{ lesser: [runningNotReadyPod, 1], greater: [runningReadyNoLastTransitionTimePod, 1] },
			{ lesser: [runningReadyNoLastTransitionTimePod, 1], greater: [runningReadyNow, 1] },
			{ lesser: [runningReadyNow, 2], greater: [runningReadyNoLastTransitionTimePod, 1] },
			{ lesser: [runningReadyNow, 1], greater: [runningReadyThen, 1] },
			{ lesser: [runningReadyNow, 2], greater: [runningReadyThen, 1] },
			{ lesser: [runningReadyNowHighRestarts, 1], greater: [runningReadyNow, 1] },
			{ lesser: [runningReadyNowHighSideRestarts, 1], greater: [runningReadyNowHighRestarts, 1] },
			{ lesser: [runningReadyNow, 2], greater: [runningReadyNowHighRestarts, 1] },
			{ lesser: [runningReadyNow, 1], greater: [runningReadyNowCreatedThen, 1] },
			{ lesser: [runningReadyNowCreatedThen, 2], greater: [runningReadyNow, 1] },
			{ lesser: [lowPodDeletionCost, 2], greater: [highPodDeletionCost, 1] },
			{ lesser: [ready2Hours, 1], greater: [ready5Hours, 1] },
		];
		for (const [index, test] of inequalityTests.entries()) {
			const podsWithRanks = new ActivePodsWithRanks(
				[test.lesser[0], test.greater[0]],
				[test.lesser[1], test.greater[1]],
				now,
			);
			expect({
				leftLess: podsWithRanks.less(0, 1),
				rightLess: podsWithRanks.less(1, 0),
				name: `Inequality tests ${index}`,
			}).toEqual({ leftLess: true, rightLess: false, name: `Inequality tests ${index}` });
		}
	});

	// Models kubernetes/pkg/controller/controller_utils_test.go TestComputeHash.
	it("ComputeHash", () => {
		const collisionCount = 1;
		const otherCollisionCount = 2;
		const maxCollisionCount = 2147483647;
		const tests: Array<{
			name: string;
			template: V1PodTemplateSpec;
			collisionCount?: number;
			otherCollisionCount?: number;
		}> = [
			{
				name: "simple",
				template: {},
				collisionCount,
				otherCollisionCount,
			},
			{
				name: "using math.MaxInt64",
				template: {},
				collisionCount: undefined,
				otherCollisionCount: maxCollisionCount,
			},
		];

		for (const test of tests) {
			const hash = computeHash(test.template, test.collisionCount);
			const otherHash = computeHash(test.template, test.otherCollisionCount);
			expect({ name: test.name, sameHash: hash === otherHash }).toEqual({
				name: test.name,
				sameHash: false,
			});
		}
	});
});
