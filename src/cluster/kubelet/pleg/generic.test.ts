/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// oxlint-disable jest/expect-expect jest/no-conditional-expect
import { expect, it } from "vitest";
import { Clock } from "../../../clock";
import { Channel, select, type ReadOnlyChannel } from "../../../go/channel";
import * as context from "../../../go/context";
import { Timer } from "../../../go/time";
import type { Backoff } from "../../../client-go/util/flowcontrol/backoff";
import type { V1Pod } from "../../../client";
import { browser } from "../../../test/describe";
import type {
	ImageFsInfoResponse,
	MetricDescriptor,
	PodSandboxMetrics,
} from "../../cri/runtime/v1/api";
import {
	buildContainerID,
	newPod,
	newPodStatus,
	PodSyncResult,
	PodStatusCache,
	RuntimeStatus,
	type Container as RuntimeContainer,
	type ContainerID,
	type GCPolicy,
	type Image,
	type ImageSpec,
	type ImageStats,
	type Pod as RuntimePod,
	type PodStatus as PodRuntimeStatus,
	type Runtime,
	type Status,
	type Status as ContainerStatus,
	type SwapBehavior,
	type State as ContainerState,
	type Version,
} from "../container";
import {
	ContainerDied,
	ContainerRemoved,
	ContainerStarted,
	PodSync,
	type PodLifecycleEvent,
} from "./pleg";
import { GenericPLEG } from "./generic";

const testContainerRuntimeType = "fooRuntime";
const largeChannelCap = 100;

browser.describe("GenericPLEG", () => {
	// Models kubernetes/pkg/kubelet/pleg/generic_test.go TestRelisting.
	it("relisting", async () => {
		const testPleg = newTestGenericPLEG();
		const { pleg, runtime } = testPleg;
		const ch = pleg.watch();

		runtime.allPodList = [
			newPod({
				id: "1234",
				containers: [
					createTestContainer("c1", "Exited"),
					createTestContainer("c2", "Running"),
					createTestContainer("c3", "Unknown"),
				],
			}),
			newPod({ id: "4567", containers: [createTestContainer("c1", "Exited")] }),
		];
		await pleg.relist();
		let expected: PodLifecycleEvent[] = [
			{ id: "1234", type: ContainerStarted, data: "c2" },
			{ id: "4567", type: ContainerDied, data: "c1" },
			{ id: "1234", type: ContainerDied, data: "c1" },
		];
		let actual = await getEventsFromChannel(ch);
		verifyEvents(expected, actual);

		await pleg.relist();
		verifyEvents(expected, actual);

		runtime.allPodList = [
			newPod({
				id: "1234",
				containers: [createTestContainer("c2", "Exited"), createTestContainer("c3", "Running")],
			}),
			newPod({ id: "4567", containers: [createTestContainer("c4", "Running")] }),
		];
		await pleg.relist();
		expected = [
			{ id: "1234", type: ContainerRemoved, data: "c1" },
			{ id: "1234", type: ContainerDied, data: "c2" },
			{ id: "1234", type: ContainerStarted, data: "c3" },
			{ id: "4567", type: ContainerRemoved, data: "c1" },
			{ id: "4567", type: ContainerStarted, data: "c4" },
		];
		actual = await getEventsFromChannel(ch);
		verifyEvents(expected, actual);
	});

	// Models kubernetes/pkg/kubelet/pleg/generic_test.go TestEventChannelFull.
	it("event channel full", async () => {
		const testPleg = newTestGenericPLEGWithChannelSize(4);
		const { pleg, runtime } = testPleg;
		const ch = pleg.watch();

		runtime.allPodList = [
			newPod({
				id: "1234",
				containers: [
					createTestContainer("c1", "Exited"),
					createTestContainer("c2", "Running"),
					createTestContainer("c3", "Unknown"),
				],
			}),
			newPod({ id: "4567", containers: [createTestContainer("c1", "Exited")] }),
		];
		await pleg.relist();
		const expected: PodLifecycleEvent[] = [
			{ id: "1234", type: ContainerStarted, data: "c2" },
			{ id: "4567", type: ContainerDied, data: "c1" },
			{ id: "1234", type: ContainerDied, data: "c1" },
		];
		let actual = await getEventsFromChannel(ch);
		verifyEvents(expected, actual);

		runtime.allPodList = [
			newPod({
				id: "1234",
				containers: [createTestContainer("c2", "Exited"), createTestContainer("c3", "Running")],
			}),
			newPod({ id: "4567", containers: [createTestContainer("c4", "Running")] }),
		];
		await pleg.relist();
		const allEvents: PodLifecycleEvent[] = [
			{ id: "1234", type: ContainerRemoved, data: "c1" },
			{ id: "1234", type: ContainerDied, data: "c2" },
			{ id: "1234", type: ContainerStarted, data: "c3" },
			{ id: "4567", type: ContainerRemoved, data: "c1" },
			{ id: "4567", type: ContainerStarted, data: "c4" },
		];
		actual = await getEventsFromChannel(ch);
		expect(actual).toHaveLength(4);
		expect(allEvents).toEqual(expect.arrayContaining(actual));
	});

	// Models kubernetes/pkg/kubelet/pleg/generic_test.go TestDetectingContainerDeaths.
	it("detecting container deaths", async () => {
		await testReportMissingContainers(1);
		await testReportMissingPods(1);

		await testReportMissingContainers(3);
		await testReportMissingPods(3);
	});

	// Models kubernetes/pkg/kubelet/pleg/generic_test.go TestRelistWithCache.
	it("relist with cache", async () => {
		const runtimeMock = new FakeRuntime();
		const pleg = newTestGenericPLEGWithRuntimeMock(runtimeMock);
		const ch = pleg.watch();

		const { pods, statuses, events } = createTestPodsStatusesAndEvents(2);
		runtimeMock.allPodList = pods;
		runtimeMock.podStatuses.set(pods[0].id, statuses[0]);
		const statusErr = new Error("unable to get status");
		runtimeMock.podStatuses.set(pods[1].id, newPodStatus());
		runtimeMock.podStatusErrors.set(pods[1].id, statusErr);

		await pleg.relist();
		let actualEvents = await getEventsFromChannel(ch);
		let cases = [
			{ pod: pods[0], status: statuses[0], error: undefined },
			{ pod: pods[1], status: newPodStatus(), error: statusErr },
		];
		for (const c of cases) {
			const [actualStatus, actualErr] = await pleg.cache.get(c.pod.id);
			expect({ status: actualStatus, error: actualErr }).toEqual({
				status: c.status,
				error: c.error,
			});
		}
		expect(actualEvents).toEqual([events[0]]);

		runtimeMock.podStatuses.set(pods[1].id, statuses[1]);
		runtimeMock.podStatusErrors.delete(pods[1].id);
		await pleg.relist();
		actualEvents = await getEventsFromChannel(ch);
		cases = [
			{ pod: pods[0], status: statuses[0], error: undefined },
			{ pod: pods[1], status: statuses[1], error: undefined },
		];
		for (const c of cases) {
			const [actualStatus, actualErr] = await pleg.cache.get(c.pod.id);
			expect({ status: actualStatus, error: actualErr }).toEqual({
				status: c.status,
				error: c.error,
			});
		}
		expect(actualEvents).toEqual([events[1]]);
	});

	// Models kubernetes/pkg/kubelet/pleg/generic_test.go TestRemoveCacheEntry.
	it("remove cache entry", async () => {
		const runtimeMock = new FakeRuntime();
		const pleg = newTestGenericPLEGWithRuntimeMock(runtimeMock);

		const { pods, statuses } = createTestPodsStatusesAndEvents(1);
		runtimeMock.allPodList = pods;
		runtimeMock.podStatuses.set(pods[0].id, statuses[0]);
		await pleg.relist();

		runtimeMock.allPodList = [];
		await pleg.relist();
		const [actualStatus, actualErr] = await pleg.cache.get(pods[0].id);
		expect(actualStatus).toEqual(expect.objectContaining({ id: pods[0].id }));
		expect(actualErr).toBeUndefined();
	});

	// Models kubernetes/pkg/kubelet/pleg/generic_test.go TestHealthy.
	it("healthy", async () => {
		const testPleg = newTestGenericPLEG();
		const { clock, pleg } = testPleg;
		clock.pause();

		let health = pleg.healthy();
		expect(health.ok).toBe(false);

		clock.step(10 * 60 * 1000);
		health = pleg.healthy();
		expect(health.ok).toBe(false);

		await pleg.relist();
		clock.step(60 * 1000);
		health = pleg.healthy();
		expect(health.ok).toBe(true);

		clock.step(pleg.relistDuration.relistThresholdMs);
		health = pleg.healthy();
		expect(health.ok).toBe(false);
	});

	// Models kubernetes/pkg/kubelet/pleg/generic_test.go TestReinspect.
	it.each([
		{
			name: "RequestReinspect a pod not previously listed, success",
			requestReinspect: true,
			alreadyReinspect: false,
			updateCacheError: undefined,
			expectUpdateCache: true,
			expectReinspect: false,
			expectEvent: true,
			expectStatus: true,
		},
		{
			name: "RequestReinspect a pod not previously listed, failure",
			requestReinspect: true,
			alreadyReinspect: false,
			updateCacheError: new Error("fail"),
			expectUpdateCache: true,
			expectReinspect: true,
			expectEvent: false,
			expectStatus: true,
		},
		{
			name: "RequestReinspect of a pod already listed for reinspection, success",
			requestReinspect: true,
			alreadyReinspect: true,
			updateCacheError: undefined,
			expectUpdateCache: true,
			expectReinspect: false,
			expectEvent: true,
			expectStatus: true,
		},
		{
			name: "RequestReinspect of a pod already listed for reinspection, failure",
			requestReinspect: true,
			alreadyReinspect: true,
			updateCacheError: new Error("fail"),
			expectUpdateCache: true,
			expectReinspect: true,
			expectEvent: false,
			expectStatus: true,
		},
		{
			name: "Don't request reinspection",
			requestReinspect: false,
			alreadyReinspect: false,
			updateCacheError: undefined,
			expectUpdateCache: false,
			expectReinspect: false,
			expectEvent: false,
			expectStatus: false,
		},
		{
			name: "Don't request reinspection, but already listed for reinspection, success",
			requestReinspect: false,
			alreadyReinspect: true,
			updateCacheError: undefined,
			expectUpdateCache: true,
			expectReinspect: false,
			expectEvent: true,
			expectStatus: true,
		},
		{
			name: "Don't request reinspection, but already listed for reinspection, failure",
			requestReinspect: false,
			alreadyReinspect: true,
			updateCacheError: new Error("fail"),
			expectUpdateCache: true,
			expectReinspect: true,
			expectEvent: false,
			expectStatus: true,
		},
		{
			name: "Pod deleted, should clear reinspect",
			requestReinspect: false,
			alreadyReinspect: true,
			podDeleted: true,
			updateCacheError: undefined,
			expectUpdateCache: true,
			expectReinspect: false,
			expectEvent: true,
			expectStatus: false,
		},
	])("$name", async (tc) => {
		const runtimeMock = new FakeRuntime();
		const pleg = newTestGenericPLEGWithRuntimeMock(runtimeMock);
		const ch = pleg.watch();

		const podID = "test-pod";
		if (tc.alreadyReinspect || tc.requestReinspect) {
			pleg.requestReinspect(podID);
		}

		const pod = newPod({ id: podID, name: "name", namespace: "ns" });
		pleg.podRecords.records.set(podID, { old: pod, current: pod });

		if (tc.podDeleted) {
			runtimeMock.allPodList = [];
		} else {
			runtimeMock.allPodList = [pod];
		}

		let expectedStatus: PodRuntimeStatus | undefined;
		if (!tc.updateCacheError) {
			expectedStatus = podStatus(podID, new Date());
		}
		if (tc.expectUpdateCache) {
			if (tc.podDeleted) {
				// updateCache(undefined, podID) will be called, it doesn't call getPodStatus.
			} else {
				if (expectedStatus) {
					runtimeMock.podStatuses.set(podID, expectedStatus);
				}
				if (tc.updateCacheError) {
					runtimeMock.podStatusErrors.set(podID, tc.updateCacheError);
				}
			}
		}

		await pleg.relist();

		const actualReinspect = pleg.podsToReinspect.has(podID);
		expect(actualReinspect).toBe(tc.expectReinspect);

		const actualEvents = await getEventsFromChannel(ch);
		if (tc.expectEvent) {
			expect(actualEvents).not.toEqual([]);
			let hasPodSync = false;
			for (const event of actualEvents) {
				if (event.id === podID && event.type === PodSync) {
					hasPodSync = true;
					break;
				}
			}
			expect(hasPodSync).toBe(true);
		} else {
			expect(actualEvents).toEqual([]);
		}

		if (tc.expectStatus) {
			const [actualStatus, actualErr] = await pleg.cache.get(podID);
			expect(actualStatus).toEqual(expectedStatus);
			expect(actualErr).toBe(tc.updateCacheError);
		} else if (tc.podDeleted) {
			const [actualStatus] = await pleg.cache.get(podID);
			expect(actualStatus).toEqual(newPodStatus({ id: podID }));
		}
	});

	// Models kubernetes/pkg/kubelet/pleg/generic_test.go TestRelistingWithSandboxes.
	it("relisting with sandboxes", async () => {
		const testPleg = newTestGenericPLEG();
		const { pleg, runtime } = testPleg;
		const ch = pleg.watch();

		runtime.allPodList = [
			newPod({
				id: "1234",
				sandboxes: [
					createTestContainer("c1", "Exited"),
					createTestContainer("c2", "Running"),
					createTestContainer("c3", "Unknown"),
				],
			}),
			newPod({ id: "4567", sandboxes: [createTestContainer("c1", "Exited")] }),
		];
		await pleg.relist();
		let expected: PodLifecycleEvent[] = [
			{ id: "1234", type: ContainerStarted, data: "c2" },
			{ id: "4567", type: ContainerDied, data: "c1" },
			{ id: "1234", type: ContainerDied, data: "c1" },
		];
		let actual = await getEventsFromChannel(ch);
		verifyEvents(expected, actual);

		await pleg.relist();
		verifyEvents(expected, actual);

		runtime.allPodList = [
			newPod({
				id: "1234",
				sandboxes: [createTestContainer("c2", "Exited"), createTestContainer("c3", "Running")],
			}),
			newPod({ id: "4567", sandboxes: [createTestContainer("c4", "Running")] }),
		];
		await pleg.relist();
		expected = [
			{ id: "1234", type: ContainerRemoved, data: "c1" },
			{ id: "1234", type: ContainerDied, data: "c2" },
			{ id: "1234", type: ContainerStarted, data: "c3" },
			{ id: "4567", type: ContainerRemoved, data: "c1" },
			{ id: "4567", type: ContainerStarted, data: "c4" },
		];

		actual = await getEventsFromChannel(ch);
		verifyEvents(expected, actual);
	});

	// Models kubernetes/pkg/kubelet/pleg/generic_test.go TestRelistIPChange.
	it.each([
		{
			name: "test-0",
			podID: "test-pod-0",
			podIPs: ["192.168.1.5"],
		},
		{
			name: "tets-1",
			podID: "test-pod-1",
			podIPs: ["192.168.1.5/24", "2000::"],
		},
	])("relist IP change $name", async (tc) => {
		const runtimeMock = new FakeRuntime();
		const pleg = newTestGenericPLEGWithRuntimeMock(runtimeMock);
		const ch = pleg.watch();

		const id = tc.podID;
		let container = createTestContainer("c0", "Running");
		let pod = newPod({ id, containers: [container] });
		let status = podStatus(id, pod.timestamp, tc.podIPs, [containerStatus(container)]);
		let event: PodLifecycleEvent = { id: pod.id, type: ContainerStarted, data: container.id.id };

		runtimeMock.allPodList = [pod];
		runtimeMock.podStatuses.set(pod.id, status);

		await pleg.relist();
		let actualEvents = await getEventsFromChannel(ch);
		let [actualStatus, actualErr] = await pleg.cache.get(pod.id);
		expect(actualStatus).toEqual(status);
		expect(actualErr).toBeUndefined();
		expect(actualEvents).toEqual([event]);

		// Clear the IP address and mark the container terminated
		container = createTestContainer("c0", "Exited");
		pod = newPod({ id, containers: [container] });
		status = podStatus(id, pod.timestamp, [], [containerStatus(container)]);
		event = { id: pod.id, type: ContainerDied, data: container.id.id };
		runtimeMock.allPodList = [pod];
		runtimeMock.podStatuses.set(pod.id, status);

		await pleg.relist();
		actualEvents = await getEventsFromChannel(ch);
		[actualStatus, actualErr] = await pleg.cache.get(pod.id);
		const statusCopy = { ...status, ips: tc.podIPs };
		expect(actualStatus).toEqual(statusCopy);
		expect(actualErr).toBeUndefined();
		expect(actualEvents).toEqual([event]);
	});

	// Models kubernetes/pkg/kubelet/pleg/generic_test.go TestWorkerLoop.
	it("worker loop", async () => {
		const runtime = new FakeRuntime();
		const cache = new PodStatusCache();
		const clock = new Clock();
		const ctx = context.background();
		const eventChannel = new Channel<PodLifecycleEvent>(100);
		const pleg = new GenericPLEG(
			runtime,
			eventChannel,
			{ relistPeriodMs: 2000, relistThresholdMs: 4000 },
			cache,
			clock,
			ctx,
		);
		clock.pause();
		pleg.globalRelistTimer = new Timer(clock, 2000);

		const pod1 = newPod({
			id: "pod1",
			name: "pod1",
			containers: [createTestContainer("c1", "Running")],
		});
		const pod2 = newPod({
			id: "pod2",
			name: "pod2",
			containers: [createTestContainer("c2", "Running")],
		});
		const startTime = clock.now();
		try {
			const p1res = getNewerThanAsync(cache, ctx, pod1.id, startTime);
			await requireBlocked(p1res);
			const p2res = getNewerThanAsync(cache, ctx, pod2.id, startTime);
			await requireBlocked(p2res);

			pleg.requestRelist(pod1.id);

			runtime.allPodList = [pod1];
			runtime.getPodHook = (uid) => {
				expect(uid).toBe(pod1.id);
				pod1.timestamp = clock.now();
				runtime.podStatuses.set(pod1.id, newPodStatus({ id: pod1.id, timestamp: clock.now() }));
				return pod1;
			};

			await pleg.workerLoopIteration();

			const p1Status = await requireUnblocked(p1res);
			expect(p1Status.id).toBe(pod1.id);
			expect(p1Status.timestamp).toEqual(clock.now());
			await requireBlocked(p2res);

			const p1NewRes = getNewerThanAsync(cache, ctx, pod1.id, new Date(startTime.getTime() + 2000));
			await requireBlocked(p1NewRes);

			pleg.requestRelist(pod2.id);
			runtime.allPodList = [pod1, pod2];
			runtime.getPodsHook = async () => {
				pod1.timestamp = clock.now();
				pod2.timestamp = clock.now();
				runtime.podStatuses.set(pod2.id, newPodStatus({ id: pod2.id, timestamp: clock.now() }));
			};
			clock.step(2000);

			await pleg.workerLoopIteration();

			const p2Status = await requireUnblocked(p2res);
			expect(p2Status.id).toBe(pod2.id);
			const p1NewStatus = await requireUnblocked(p1NewRes);
			expect(p1NewStatus).toBe(p1Status);

			await pleg.workerLoopIteration();

			const p1ReinspectRes = getNewerThanAsync(cache, ctx, pod1.id, clock.now());
			await requireBlocked(p1ReinspectRes);

			pleg.requestReinspect(pod1.id);
			pleg.requestRelist(pod1.id);
			runtime.getPodsHook = async () => {
				pod1.timestamp = clock.now();
				pod2.timestamp = clock.now();
				runtime.podStatuses.set(pod1.id, newPodStatus({ id: pod1.id, timestamp: clock.now() }));
			};
			clock.step(2000);

			await pleg.workerLoopIteration();

			const p1ReinspectStatus = await requireUnblocked(p1ReinspectRes);
			expect(p1ReinspectStatus.id).toBe(pod1.id);
			expect(p1ReinspectStatus.timestamp).toEqual(clock.now());
			await pleg.workerLoopIteration();
		} finally {
			pleg.globalRelistTimer?.stop();
		}
	});

	// Simulator-only: relist() is async in the browser simulator, so verify
	// overlapping calls still serialize through the relist lock.
	it("serializes overlapping relists", async () => {
		const testPleg = newTestGenericPLEG();
		const { pleg, runtime } = testPleg;
		const enteredGetPods = new Channel<void>(2);
		const releaseGetPods = new Channel<void>(2);
		let activeGetPods = 0;
		let maxActiveGetPods = 0;
		runtime.getPodsHook = async () => {
			activeGetPods++;
			maxActiveGetPods = Math.max(maxActiveGetPods, activeGetPods);
			enteredGetPods.trySend();
			await releaseGetPods.receive();
			activeGetPods--;
		};

		const first = pleg.relist();
		await enteredGetPods.receive();
		const second = pleg.relist();
		await Promise.resolve();

		expect(maxActiveGetPods).toBe(1);

		releaseGetPods.trySend();
		await enteredGetPods.receive();
		releaseGetPods.trySend();
		await Promise.all([first, second]);
		expect(maxActiveGetPods).toBe(1);
	});
});

function newTestGenericPLEG(): {
	clock: Clock;
	pleg: GenericPLEG;
	runtime: FakeRuntime;
} {
	return newTestGenericPLEGWithChannelSize(largeChannelCap);
}

function newTestGenericPLEGWithChannelSize(channelSize: number): {
	clock: Clock;
	pleg: GenericPLEG;
	runtime: FakeRuntime;
} {
	const runtime = new FakeRuntime();
	const clock = new Clock();
	const eventChannel = new Channel<PodLifecycleEvent>(channelSize);
	const pleg = new GenericPLEG(
		runtime,
		eventChannel,
		{ relistPeriodMs: 3_600_000, relistThresholdMs: 3 * 60 * 1000 },
		new PodStatusCache(),
		clock,
		context.background(),
	);
	return { clock, pleg, runtime };
}

async function testReportMissingContainers(numRelists: number): Promise<void> {
	const testPleg = newTestGenericPLEG();
	const { pleg, runtime } = testPleg;
	const ch = pleg.watch();
	runtime.allPodList = [
		newPod({
			id: "1234",
			containers: [
				createTestContainer("c1", "Running"),
				createTestContainer("c2", "Running"),
				createTestContainer("c3", "Exited"),
			],
		}),
	];

	for (let i = 0; i < numRelists; i++) {
		await pleg.relist();
		await getEventsFromChannel(ch);
	}

	runtime.allPodList = [newPod({ id: "1234", containers: [createTestContainer("c1", "Running")] })];
	await pleg.relist();
	const expected: PodLifecycleEvent[] = [
		{ id: "1234", type: ContainerDied, data: "c2" },
		{ id: "1234", type: ContainerRemoved, data: "c2" },
		{ id: "1234", type: ContainerRemoved, data: "c3" },
	];
	const actual = await getEventsFromChannel(ch);
	verifyEvents(expected, actual);
}

async function testReportMissingPods(numRelists: number): Promise<void> {
	const testPleg = newTestGenericPLEG();
	const { pleg, runtime } = testPleg;
	const ch = pleg.watch();
	runtime.allPodList = [newPod({ id: "1234", containers: [createTestContainer("c2", "Running")] })];

	for (let i = 0; i < numRelists; i++) {
		await pleg.relist();
		await getEventsFromChannel(ch);
	}

	runtime.allPodList = [];
	await pleg.relist();
	const expected: PodLifecycleEvent[] = [
		{ id: "1234", type: ContainerDied, data: "c2" },
		{ id: "1234", type: ContainerRemoved, data: "c2" },
	];
	const actual = await getEventsFromChannel(ch);
	verifyEvents(expected, actual);
}

function newTestGenericPLEGWithRuntimeMock(runtimeMock: FakeRuntime): GenericPLEG {
	return new GenericPLEG(
		runtimeMock,
		new Channel<PodLifecycleEvent>(1000),
		{ relistPeriodMs: 3_600_000, relistThresholdMs: 7_200_000 },
		new PodStatusCache(),
		new Clock(),
		context.background(),
	);
}

class FakeRuntime implements Runtime {
	allPodList: RuntimePod[] = [];
	getPodsHook?: () => Promise<void>;
	getPodHook?: (podUid: string) => RuntimePod | undefined;
	getPodCalls = new Map<string, number>();
	podStatuses = new Map<string, PodRuntimeStatus>();
	podStatusErrors = new Map<string, Error>();

	type(): string {
		return "fakeRuntime";
	}

	async version(): Promise<[version: Version | undefined, err: Error | undefined]> {
		return [undefined, undefined];
	}

	async apiVersion(): Promise<[version: Version | undefined, err: Error | undefined]> {
		return [undefined, undefined];
	}

	async status(): Promise<[status: RuntimeStatus | undefined, err: Error | undefined]> {
		return [new RuntimeStatus(), undefined];
	}

	async getPods(
		_ctx: context.Context,
		_all: boolean,
	): Promise<[pods: RuntimePod[], err: Error | undefined]> {
		await this.getPodsHook?.();
		return [this.allPodList, undefined];
	}

	async getPod(
		_ctx: context.Context,
		podUid: string,
	): Promise<[pod: RuntimePod | undefined, err: Error | undefined]> {
		this.getPodCalls.set(podUid, (this.getPodCalls.get(podUid) ?? 0) + 1);
		if (this.getPodHook) {
			return [this.getPodHook(podUid), undefined];
		}
		return [this.allPodList.find((pod) => pod.id === podUid), undefined];
	}

	async getPodStatus(
		_ctx: context.Context,
		pod: RuntimePod,
	): Promise<[podStatus: PodRuntimeStatus | undefined, err: Error | undefined]> {
		const status = this.podStatuses.get(pod.id);
		const err = this.podStatusErrors.get(pod.id);
		if (this.podStatuses.has(pod.id) || this.podStatusErrors.has(pod.id)) {
			return [status, err];
		}
		return [
			{
				id: pod.id,
				name: pod.name,
				namespace: pod.namespace,
				ips: [],
				timestamp: pod.timestamp,
				containerStatuses: pod.containers.map(containerStatus),
				sandboxStatuses: [],
			},
			undefined,
		];
	}

	async garbageCollect(
		_ctx: context.Context,
		_gcPolicy: GCPolicy,
		_allSourcesReady: boolean,
		_evictNonDeletedPods: boolean,
	): Promise<Error | undefined> {
		return undefined;
	}

	async syncPod(
		_ctx: context.Context,
		_pod: V1Pod,
		_podStatus: PodRuntimeStatus,
		_pullSecrets: unknown[],
		_backOff: Backoff,
		_restartAllContainers: boolean,
	): Promise<PodSyncResult> {
		return new PodSyncResult();
	}

	async killPod(): Promise<Error | undefined> {
		return undefined;
	}

	async deleteContainer(
		_ctx: context.Context,
		_containerID: ContainerID,
	): Promise<Error | undefined> {
		return undefined;
	}

	async pullImage(
		_ctx: context.Context,
		image: ImageSpec,
	): Promise<[imageRef: string, credentialsUsed: unknown | undefined, err: Error | undefined]> {
		return [image.image, undefined, undefined];
	}

	async getImageRef(
		_ctx: context.Context,
		image: ImageSpec,
	): Promise<[imageRef: string, err: Error | undefined]> {
		return [image.image, undefined];
	}

	async listImages(): Promise<[images: Image[], err: Error | undefined]> {
		return [[], undefined];
	}

	async removeImage(): Promise<Error | undefined> {
		return undefined;
	}

	async imageStats(): Promise<[imageStats: ImageStats | undefined, err: Error | undefined]> {
		return [{ totalStorageBytes: 0 }, undefined];
	}

	async imageFsInfo(): Promise<
		[imageFsInfo: ImageFsInfoResponse | undefined, err: Error | undefined]
	> {
		return [{ imageFilesystems: [], containerFilesystems: [] }, undefined];
	}

	async getImageSize(): Promise<[imageSize: number, err: Error | undefined]> {
		return [0, undefined];
	}

	async updatePodCIDR(): Promise<Error | undefined> {
		return undefined;
	}

	async checkpointContainer(): Promise<Error | undefined> {
		return undefined;
	}

	generatePodStatus(): PodRuntimeStatus | undefined {
		return undefined;
	}

	async listMetricDescriptors(): Promise<
		[descriptors: MetricDescriptor[], err: Error | undefined]
	> {
		return [[], undefined];
	}

	async listPodSandboxMetrics(): Promise<[metrics: PodSandboxMetrics[], err: Error | undefined]> {
		return [[], undefined];
	}

	async getContainerStatus(
		_ctx: context.Context,
		_podUid: string,
		id: ContainerID,
	): Promise<[status: Status | undefined, err: Error | undefined]> {
		return [
			{
				id,
				name: id.id,
				image: "",
				imageID: "",
				imageRef: "",
				imageRuntimeHandler: "",
				hash: 0,
				state: "Running",
				restartCount: 0,
				createdAt: 0,
			},
			undefined,
		];
	}

	getContainerSwapBehavior(): SwapBehavior {
		return "NoSwap";
	}

	isPodResizeInProgress(): boolean {
		return false;
	}

	async updateActuatedPodLevelResources(): Promise<Error | undefined> {
		return undefined;
	}

	async runInContainer(): Promise<[output: string, err: Error | undefined]> {
		return ["", undefined];
	}
}

function createTestPodsStatusesAndEvents(num: number): {
	pods: RuntimePod[];
	statuses: PodRuntimeStatus[];
	events: PodLifecycleEvent[];
} {
	const pods: RuntimePod[] = [];
	const statuses: PodRuntimeStatus[] = [];
	const events: PodLifecycleEvent[] = [];
	for (let i = 0; i < num; i++) {
		const id = `test-pod-${i}`;
		const cState: ContainerState = "Running";
		const container = createTestContainer(`c${i}`, cState);
		const pod = newPod({ id, containers: [container] });
		const status = podStatus(id, pod.timestamp, [], [containerStatus(container)]);
		const event: PodLifecycleEvent = { id: pod.id, type: ContainerStarted, data: container.id.id };
		pods.push(pod);
		statuses.push(status);
		events.push(event);
	}
	return { pods, statuses, events };
}

function createTestContainer(id: string, state: ContainerState): RuntimeContainer {
	return {
		id: buildContainerID(testContainerRuntimeType, id),
		name: id,
		image: "busybox:1.36",
		imageID: "busybox:1.36",
		imageRef: "busybox:1.36",
		imageRuntimeHandler: "",
		hash: 0,
		state,
		podSandboxID: "sandbox-1",
		createdAt: 0,
	};
}

function containerStatus(container: RuntimeContainer): ContainerStatus {
	return {
		id: container.id,
		name: container.name,
		image: container.image,
		imageID: container.imageID,
		imageRef: container.imageRef,
		imageRuntimeHandler: container.imageRuntimeHandler,
		hash: container.hash,
		state: container.state,
		restartCount: 0,
		createdAt: container.createdAt,
	};
}

function podStatus(
	id: string,
	timestamp: Date,
	ips: string[] = [],
	containerStatuses: ContainerStatus[] = [],
): PodRuntimeStatus {
	return {
		id,
		name: "",
		namespace: "default",
		ips,
		timestamp,
		containerStatuses,
		sandboxStatuses: [],
	};
}

async function getEventsFromChannel(
	channel: ReadOnlyChannel<PodLifecycleEvent>,
): Promise<PodLifecycleEvent[]> {
	const events: PodLifecycleEvent[] = [];
	while (true) {
		const received = await select()
			.case(channel, (result) => result)
			.default(() => undefined);
		if (!received?.ok) {
			return events;
		}
		events.push(received.value);
	}
}

function verifyEvents(expected: PodLifecycleEvent[], actual: PodLifecycleEvent[]): void {
	expect(sortEvents(actual)).toEqual(sortEvents(expected));
}

async function getNewerThanAsync(
	cache: PodStatusCache,
	ctx: context.Context,
	podID: string,
	minTime: Date,
): Promise<PodRuntimeStatus> {
	const [status, err] = await cache.getNewerThan(ctx, podID, minTime);
	expect(err).toBeUndefined();
	if (!status) {
		throw new Error(`pod status cache returned no status for ${podID}`);
	}
	return status;
}

async function requireBlocked<T>(promise: Promise<T>): Promise<void> {
	const sentinel = Symbol("blocked");
	const result = await Promise.race([promise, Promise.resolve().then(() => sentinel)]);
	expect(result).toBe(sentinel);
}

async function requireUnblocked<T>(promise: Promise<T>): Promise<T> {
	const result = await Promise.race([
		promise.then((value) => ({ kind: "value" as const, value })),
		Promise.resolve().then(() => ({ kind: "blocked" as const })),
	]);
	if (result.kind === "blocked") {
		throw new Error("Receive should not have been blocked");
	}
	return result.value;
}

function sortEvents(events: PodLifecycleEvent[]): PodLifecycleEvent[] {
	return [...events].sort((left, right) => {
		const idCompare = left.id.localeCompare(right.id);
		if (idCompare !== 0) {
			return idCompare;
		}
		const dataCompare = String(left.data ?? "").localeCompare(String(right.data ?? ""));
		if (dataCompare !== 0) {
			return dataCompare;
		}
		return left.type.localeCompare(right.type);
	});
}
