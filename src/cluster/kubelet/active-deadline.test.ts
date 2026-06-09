/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";
import type { V1Pod, V1PodSpec, V1PodStatus } from "../../client";
import { newFakeRecorder } from "../../client-go/tools/record/fake";
import { Clock } from "../../clock";
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

function newTestClock(): Clock {
	const clock = new Clock();
	clock.pause();
	return clock;
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
browser.describe("newActiveDeadlineHandler", () => {
	it("requires all handler dependencies", () => {
		expect.hasAssertions();
		const pods = newTestPods(1);
		const podStatusProvider = new mockPodStatusProvider(pods);
		const fakeRecorder = newFakeRecorder(20);
		const fakeClock = newTestClock();

		const testCases: Array<{
			podStatusProvider: mockPodStatusProvider | undefined;
			recorder: ReturnType<typeof newFakeRecorder> | undefined;
			clock: Clock | undefined;
			expectedHandler: boolean;
			expectedError: boolean;
		}> = [
			{
				podStatusProvider,
				recorder: fakeRecorder,
				clock: fakeClock,
				expectedHandler: true,
				expectedError: false,
			},
			{
				podStatusProvider,
				recorder: fakeRecorder,
				clock: undefined,
				expectedHandler: false,
				expectedError: true,
			},
			{
				podStatusProvider,
				recorder: undefined,
				clock: fakeClock,
				expectedHandler: false,
				expectedError: true,
			},
			{
				podStatusProvider,
				recorder: undefined,
				clock: undefined,
				expectedHandler: false,
				expectedError: true,
			},
			{
				podStatusProvider: undefined,
				recorder: fakeRecorder,
				clock: fakeClock,
				expectedHandler: false,
				expectedError: true,
			},
			{
				podStatusProvider: undefined,
				recorder: fakeRecorder,
				clock: undefined,
				expectedHandler: false,
				expectedError: true,
			},
			{
				podStatusProvider: undefined,
				recorder: undefined,
				clock: fakeClock,
				expectedHandler: false,
				expectedError: true,
			},
			{
				podStatusProvider: undefined,
				recorder: undefined,
				clock: undefined,
				expectedHandler: false,
				expectedError: true,
			},
		];

		for (const testCase of testCases) {
			const [actual, err] = newActiveDeadlineHandler(
				testCase.podStatusProvider,
				testCase.recorder,
				testCase.clock,
			);

			expect(actual instanceof ActiveDeadlineHandler).toBe(testCase.expectedHandler);
			expect(err instanceof Error).toBe(testCase.expectedError);
		}
	});
});

// Models kubernetes/pkg/kubelet/active_deadline_test.go TestActiveDeadlineHandler.
browser.describe("activeDeadlineHandler", () => {
	it("syncs and evicts pods that have exceeded their active deadline", () => {
		expect.hasAssertions();
		const pods = newTestPods(5);
		const fakeClock = newTestClock();
		const podStatusProvider = new mockPodStatusProvider(pods);
		const fakeRecorder = newFakeRecorder(20);
		const [handler, err] = newActiveDeadlineHandler(podStatusProvider, fakeRecorder, fakeClock);
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
		const fakeClock = newTestClock();
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
			new mockPodStatusProvider(pods),
			fakeRecorder,
			fakeClock,
		);

		expect(err).toBeUndefined();
		expect(handler?.shouldSync(pod)).toBe(true);
	});
});
