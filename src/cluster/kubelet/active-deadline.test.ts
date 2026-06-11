/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";
import type { V1Pod, V1PodSpec, V1PodStatus } from "../../client";
import { newFakeRecorder } from "../../client-go/tools/record/fake";
import { getClock } from "../../clock-context";
import { browser } from "../../test/describe";
import { ActiveDeadlineHandler, newActiveDeadlineHandler } from "./active-deadline";
import { newTestPods } from "./kubelet-test-helpers";

// Models kubernetes/pkg/kubelet/active_deadline_test.go mockPodStatusProvider.
class mockPodStatusProvider {
	constructor(private readonly pods: V1Pod[]) {}

	getPodStatus(podUid: string): V1PodStatus | undefined {
		for (const pod of this.pods) {
			if (pod.metadata?.uid === podUid) {
				return pod.status;
			}
		}
		return undefined;
	}
}

function fetchEvent(recorder: ReturnType<typeof newFakeRecorder>): string {
	const event = recorder.events?.tryReceive();
	if (!event?.ok) {
		return "";
	}
	return event.value;
}

function podSpec(pod: V1Pod): V1PodSpec {
	if (!pod.spec) {
		throw new Error("test pod must have a spec");
	}
	return pod.spec;
}

// Models kubernetes/pkg/kubelet/active_deadline_test.go TestNewActiveDeadlineHandler.
browser.describe("newActiveDeadlineHandler", ({ ctx }) => {
	it("requires all handler dependencies", () => {
		expect.hasAssertions();
		const pods = newTestPods(1);
		const podStatusProvider = new mockPodStatusProvider(pods);
		const fakeRecorder = newFakeRecorder(20);

		const testCases: Array<{
			podStatusProvider: mockPodStatusProvider | undefined;
			recorder: ReturnType<typeof newFakeRecorder> | undefined;
			expectedHandler: boolean;
			expectedError: boolean;
		}> = [
			{
				podStatusProvider,
				recorder: fakeRecorder,
				expectedHandler: true,
				expectedError: false,
			},
			{
				podStatusProvider,
				recorder: undefined,
				expectedHandler: false,
				expectedError: true,
			},
			{
				podStatusProvider: undefined,
				recorder: fakeRecorder,
				expectedHandler: false,
				expectedError: true,
			},
			{
				podStatusProvider: undefined,
				recorder: undefined,
				expectedHandler: false,
				expectedError: true,
			},
		];

		for (const testCase of testCases) {
			const [actual, err] = newActiveDeadlineHandler(
				ctx,
				testCase.podStatusProvider,
				testCase.recorder,
			);

			expect(actual instanceof ActiveDeadlineHandler).toBe(testCase.expectedHandler);
			expect(err instanceof Error).toBe(testCase.expectedError);
		}
	});
});

// Models kubernetes/pkg/kubelet/active_deadline_test.go TestActiveDeadlineHandler.
browser.describe("activeDeadlineHandler", ({ ctx }) => {
	it("syncs and evicts pods that have exceeded their active deadline", () => {
		expect.hasAssertions();
		const pods = newTestPods(5);
		const fakeClock = getClock(ctx);
		fakeClock.pause();
		const podStatusProvider = new mockPodStatusProvider(pods);
		const fakeRecorder = newFakeRecorder(20);
		const [handler, err] = newActiveDeadlineHandler(ctx, podStatusProvider, fakeRecorder);
		expect(err).toBeUndefined();
		expect(handler).toBeDefined();
		if (!handler) {
			return;
		}

		const startTime = new Date(fakeClock.now().getTime() - 60_000);

		pods[0].status = { startTime };
		podSpec(pods[0]).activeDeadlineSeconds = 30;

		pods[1].status = { startTime };
		podSpec(pods[1]).activeDeadlineSeconds = 120;

		pods[2].status = { startTime };
		podSpec(pods[2]).activeDeadlineSeconds = undefined;

		pods[3].status = { startTime: undefined };
		podSpec(pods[3]).activeDeadlineSeconds = 120;

		const testCases: Array<{
			pod: V1Pod;
			expected: boolean;
			reason: string;
			message: string;
			event: string;
		}> = [
			{
				pod: pods[0],
				expected: true,
				reason: "DeadlineExceeded",
				message: "Pod was active on the node longer than the specified deadline",
				event:
					"Normal DeadlineExceeded Pod was active on the node longer than the specified deadline",
			},
			{ pod: pods[1], expected: false, reason: "", message: "", event: "" },
			{ pod: pods[2], expected: false, reason: "", message: "", event: "" },
			{ pod: pods[3], expected: false, reason: "", message: "", event: "" },
			{ pod: pods[4], expected: false, reason: "", message: "", event: "" },
		];

		for (const testCase of testCases) {
			expect(handler.shouldSync(testCase.pod)).toBe(testCase.expected);
			const actual = handler.shouldEvict(testCase.pod);
			expect(actual.evict).toBe(testCase.expected);
			expect(actual.reason).toBe(testCase.reason);
			expect(actual.message).toBe(testCase.message);
			expect(fetchEvent(fakeRecorder)).toBe(testCase.event);
		}
	});

	it("falls back to pod status when the provider has no matching status", () => {
		const pods = newTestPods(1);
		const fakeClock = getClock(ctx);
		fakeClock.pause();
		const pod = {
			...newTestPods(1)[0],
			status: {
				startTime: new Date(fakeClock.now().getTime() - 60_000),
			},
			spec: {
				containers: [],
				hostNetwork: true,
				activeDeadlineSeconds: 30,
			},
		};
		const fakeRecorder = newFakeRecorder(20);
		const [handler, err] = newActiveDeadlineHandler(
			ctx,
			new mockPodStatusProvider(pods),
			fakeRecorder,
		);

		expect(err).toBeUndefined();
		expect(handler?.shouldSync(pod)).toBe(true);
	});
});
