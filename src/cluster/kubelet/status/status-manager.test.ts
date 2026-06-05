// oxlint-disable jest/no-conditional-expect
import { expect, it } from "vitest";

import {
	KubeConfig,
	newContainerStatus,
	type V1ContainerStatus,
	type V1Pod,
	type V1PodCondition,
	type V1PodStatus,
} from "../../../client";
import { NotFound } from "../../../client/errors";
import { clientAction, TestKubeClient, type ClientAction } from "../../../client/test";
import { Clock } from "../../../clock";
import { deepEqual, dropUndefinedFields } from "../../../deep-equal";
import * as context from "../../../go/context";
import { browser } from "../../../test/describe";
import * as podutil from "../../api/v1/pod/util";
import { Etcd } from "../../etcd";
import {
	buildContainerID,
	containerReasonStatusUnknown,
	maxPodTerminationMessageLogLength,
} from "../container";
import { PodManager } from "../pod";
import {
	apiserverSource,
	configMirrorAnnotationKey,
	configSourceAnnotationKey,
	fileSource,
	isMirrorPod,
	isStaticPod,
} from "../types";
import {
	isPodStatusByKubeletEqual,
	mergePodStatus,
	normalizeStatus,
	type StatusManager,
	StatusManagerImpl,
	updateLastTransitionTime,
} from "./status-manager";

type TestStatusManager = StatusManagerImpl & { kubeClient: TestKubeClient };

// Models kubernetes/pkg/kubelet/status/status_manager_test.go getTestPod.
function getTestPod(): V1Pod {
	return {
		kind: "Pod",
		apiVersion: "v1",
		metadata: {
			uid: "12345678",
			name: "foo",
			namespace: "new",
		},
	};
}

// Models kubernetes/pkg/kubelet/status/status_manager_test.go manager.testSyncBatch.
async function testSyncBatch(m: StatusManagerImpl, ctx: context.Context): Promise<void> {
	for (const [uid, status] of m.podStatuses) {
		const pod = m.podManager.getPodByUid(uid);
		if (pod) {
			pod.status = structuredClone(status.status);
		}
		const mirrorPod = pod ? m.podManager.getMirrorPodByPod(pod) : undefined;
		if (mirrorPod) {
			mirrorPod.status = structuredClone(status.status);
		}
	}
	await m.syncBatch(ctx, true);
}

// Models kubernetes/pkg/kubelet/status/status_manager_test.go newTestManager.
function newTestManager(kubeClient: TestKubeClient): TestStatusManager {
	const clock = kubeClient.kubeConfig.options.clock;
	const podManager = new PodManager();
	podManager.addPod(getTestPod());
	const podStartupLatencyTracker = {
		recordStatusUpdated(_pod: V1Pod): void {},
		deletePodStartupState(_podUid: string): void {},
	};
	const manager = new StatusManagerImpl({
		clock,
		kubeClient,
		podManager,
		podDeletionSafety: {
			podCouldHaveRunningContainers: async () => false,
		},
		podStartupLatencyHelper: podStartupLatencyTracker,
	});
	return manager as TestStatusManager;
}

// TypeScript harness setup for constructing the kubeClient argument that upstream
// receives from client-go fake.Clientset{}.
function newTestKubeClient() {
	const clock = new Clock();
	const kubeConfig = new KubeConfig({
		clock,
		etcd: new Etcd(clock),
		nodePortRange: { from: 30000, to: 32767 },
	});
	return new TestKubeClient(kubeConfig);
}

// TypeScript harness setup for constructing the kubeClient argument that upstream
// receives from client-go fake.NewSimpleClientset(...objects).
async function newSimpleTestKubeClient(...pods: V1Pod[]): Promise<TestKubeClient> {
	const kubeClient = newTestKubeClient();
	const namespaces = new Set<string>();
	for (const pod of pods) {
		namespaces.add(pod.metadata?.namespace ?? "new");
	}
	for (const namespace of namespaces) {
		await kubeClient.corev1.createNamespace({
			body: { metadata: { name: namespace } },
		});
	}
	for (const pod of pods) {
		const namespace = pod.metadata?.namespace ?? "new";
		const body = structuredClone(pod);
		body.metadata = { ...body.metadata, namespace };
		body.spec = {
			...body.spec,
			containers: body.spec?.containers ?? [
				{ name: "container", image: "registry.k8s.io/pause:3.10" },
			],
		};
		await kubeClient.corev1.createNamespacedPod({ namespace, body });
	}
	kubeClient.clearActions();
	return kubeClient;
}

// Models kubernetes/pkg/kubelet/status/status_manager_test.go generateRandomMessage.
function generateRandomMessage(): string {
	return Math.random().toString();
}

// Models kubernetes/pkg/kubelet/status/status_manager_test.go getRandomPodStatus.
function getRandomPodStatus(): V1PodStatus {
	return {
		message: generateRandomMessage(),
	};
}

// Models kubernetes/pkg/kubelet/status/status_manager_test.go verifyActions.
async function verifyActions(
	manager: TestStatusManager,
	expectedActions: ClientAction[],
): Promise<void> {
	const ctx = context.background();
	await consumeUpdates(manager, ctx);
	const actions = manager.kubeClient.actions();
	try {
		expect(actions.length).toBe(expectedActions.length);
		for (let i = 0; i < actions.length; i++) {
			const e = expectedActions[i];
			const a = actions[i];
			expect(a.verb).toBe(e.verb);
			expect(a.resource).toBe(e.resource);
			expect(a.subresource).toBe(e.subresource);
		}
	} finally {
		manager.kubeClient.clearActions();
	}
}

// Models kubernetes/pkg/kubelet/status/status_manager_test.go verifyUpdates.
async function verifyUpdates(manager: StatusManagerImpl, expectedUpdates: number): Promise<void> {
	const ctx = context.background();
	const numUpdates = await consumeUpdates(manager, ctx);
	expect(numUpdates).toBe(expectedUpdates);
}

// Models kubernetes/pkg/kubelet/status/status_manager_test.go manager.consumeUpdates.
async function consumeUpdates(m: StatusManagerImpl, ctx: context.Context): Promise<number> {
	let updates = 0;
	for (;;) {
		const result = m.podStatusChannel.tryReceive();
		if (!result) {
			return updates;
		}
		updates += await m.syncBatch(ctx, false);
	}
}

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestNewStatus.
browser.describe("TestNewStatus", () => {
	it("sets a new status", async () => {
		const syncer = newTestManager(newTestKubeClient());
		const testPod = getTestPod();
		await syncer.setPodStatus(testPod, getRandomPodStatus());
		await verifyUpdates(syncer, 1);

		const status = expectPodStatus(syncer, testPod);
		expect(status.startTime).toBeDefined();
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestNewStatusPreservesPodStartTime.
browser.describe("TestNewStatusPreservesPodStartTime", () => {
	it("preserves pod start time", async () => {
		const syncer = newTestManager(newTestKubeClient());
		const pod: V1Pod = {
			metadata: {
				uid: "12345678",
				name: "foo",
				namespace: "new",
			},
			status: {},
		};
		const startTime = new Date(Date.now() - 60 * 1000);
		pod.status = { startTime };
		await syncer.setPodStatus(pod, getRandomPodStatus());

		const status = expectPodStatus(syncer, pod);
		expect(status.startTime?.getTime()).toBe(startTime.getTime());
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go getReadyPodStatus.
function getReadyPodStatus(): V1PodStatus {
	return {
		conditions: [
			{
				type: "Ready",
				status: "True",
			},
		],
	};
}

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestNewStatusSetsReadyTransitionTime.
browser.describe("TestNewStatusSetsReadyTransitionTime", () => {
	it("sets ready transition time", async () => {
		const syncer = newTestManager(newTestKubeClient());
		const podStatus = getReadyPodStatus();
		const pod: V1Pod = {
			metadata: {
				uid: "12345678",
				name: "foo",
				namespace: "new",
			},
			status: {},
		};
		await syncer.setPodStatus(pod, podStatus);
		await verifyUpdates(syncer, 1);
		const status = expectPodStatus(syncer, pod);
		const readyCondition = podutil.getPodReadyCondition(status);
		expect(readyCondition?.lastTransitionTime).toBeDefined();
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestChangedStatus.
browser.describe("TestChangedStatus", () => {
	it("generates updates for changed status", async () => {
		expect.hasAssertions();
		const syncer = newTestManager(newTestKubeClient());
		const testPod = getTestPod();
		await syncer.setPodStatus(testPod, getRandomPodStatus());
		await verifyUpdates(syncer, 1);
		await syncer.setPodStatus(testPod, getRandomPodStatus());
		await verifyUpdates(syncer, 1);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestChangedStatusKeepsStartTime.
browser.describe("TestChangedStatusKeepsStartTime", () => {
	it("keeps start time", async () => {
		const syncer = newTestManager(newTestKubeClient());
		const testPod = getTestPod();
		const now = new Date();
		const firstStatus = getRandomPodStatus();
		firstStatus.startTime = now;
		await syncer.setPodStatus(testPod, firstStatus);
		await verifyUpdates(syncer, 1);
		await syncer.setPodStatus(testPod, getRandomPodStatus());
		await verifyUpdates(syncer, 1);
		const finalStatus = expectPodStatus(syncer, testPod);
		expect(finalStatus.startTime).toBeDefined();
		expect(finalStatus.startTime?.getTime()).toBe(now.getTime());
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestChangedStatusUpdatesLastTransitionTime.
browser.describe("TestChangedStatusUpdatesLastTransitionTime", () => {
	it("updates last transition time", async () => {
		const syncer = newTestManager(newTestKubeClient());
		const podStatus = getReadyPodStatus();
		const pod: V1Pod = {
			metadata: {
				uid: "12345678",
				name: "foo",
				namespace: "new",
			},
			status: {},
		};
		await syncer.setPodStatus(pod, podStatus);
		await verifyUpdates(syncer, 1);
		const oldStatus = expectPodStatus(syncer, pod);
		const anotherStatus = getReadyPodStatus();
		if (anotherStatus.conditions) {
			anotherStatus.conditions[0].status = "False";
		}
		await syncer.setPodStatus(pod, anotherStatus);
		await verifyUpdates(syncer, 1);
		const newStatus = expectPodStatus(syncer, pod);

		const oldReadyCondition = podutil.getPodReadyCondition(oldStatus);
		const newReadyCondition = podutil.getPodReadyCondition(newStatus);
		expect(newReadyCondition?.lastTransitionTime).toBeDefined();
		expect(
			(newReadyCondition?.lastTransitionTime?.getTime() ?? 0) >=
				(oldReadyCondition?.lastTransitionTime?.getTime() ?? 0),
		).toBe(true);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestUnchangedStatus.
browser.describe("TestUnchangedStatus", () => {
	it("does not generate a second update", async () => {
		expect.hasAssertions();
		const syncer = newTestManager(newTestKubeClient());
		const testPod = getTestPod();
		const podStatus = getRandomPodStatus();
		await syncer.setPodStatus(testPod, podStatus);
		await syncer.setPodStatus(testPod, podStatus);
		await verifyUpdates(syncer, 1);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestUnchangedStatusPreservesLastTransitionTime.
browser.describe("TestUnchangedStatusPreservesLastTransitionTime", () => {
	it("preserves last transition time", async () => {
		const syncer = newTestManager(newTestKubeClient());
		const podStatus = getReadyPodStatus();
		const pod: V1Pod = {
			metadata: {
				uid: "12345678",
				name: "foo",
				namespace: "new",
			},
			status: {},
		};
		await syncer.setPodStatus(pod, podStatus);
		await verifyUpdates(syncer, 1);
		const oldStatus = expectPodStatus(syncer, pod);
		const anotherStatus = getReadyPodStatus();
		await syncer.setPodStatus(pod, anotherStatus);
		await verifyUpdates(syncer, 0);
		const newStatus = expectPodStatus(syncer, pod);

		const oldReadyCondition = podutil.getPodReadyCondition(oldStatus);
		const newReadyCondition = podutil.getPodReadyCondition(newStatus);
		expect(newReadyCondition?.lastTransitionTime).toBeDefined();
		expect(newReadyCondition?.lastTransitionTime?.getTime()).toBe(
			oldReadyCondition?.lastTransitionTime?.getTime(),
		);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestSyncPodIgnoresNotFound.
browser.describe("TestSyncPodIgnoresNotFound", () => {
	it("ignores not found pods", async () => {
		expect.hasAssertions();
		const kubeClient = newTestKubeClient();
		const syncer = newTestManager(kubeClient);
		kubeClient.addReactor("get", "pods", () => {
			return [true, undefined, new NotFound(`pods "test-pod" not found`)];
		});
		await syncer.setPodStatus(getTestPod(), getRandomPodStatus());
		await verifyActions(syncer, [getAction()]);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestSyncPod.
browser.describe("TestSyncPod", () => {
	it("syncs pod status", async () => {
		expect.hasAssertions();
		const testPod = getTestPod();
		const kubeClient = await newSimpleTestKubeClient(testPod);
		const syncer = newTestManager(kubeClient);
		const status = getRandomPodStatus();
		await syncer.setPodStatus(testPod, status);
		await verifyActions(syncer, [getAction(), patchAction()]);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestSyncPodChecksMismatchedUID.
browser.describe("TestSyncPodChecksMismatchedUID", () => {
	it("checks mismatched UID", async () => {
		expect.hasAssertions();
		const pod = getTestPod();
		pod.metadata = { ...pod.metadata, uid: "first" };
		const differentPod = getTestPod();
		differentPod.metadata = { ...differentPod.metadata, uid: "second" };
		const kubeClient = await newSimpleTestKubeClient(pod);
		const syncer = newTestManager(kubeClient);
		const podManager = syncer.podManager;
		podManager.addPod(pod);
		podManager.addPod(differentPod);
		await syncer.setPodStatus(differentPod, getRandomPodStatus());
		await verifyActions(syncer, [getAction()]);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestSyncPodNoDeadlock.
browser.describe("TestSyncPodNoDeadlock", () => {
	it("does not deadlock while syncing pods", async () => {
		expect.hasAssertions();
		const kubeClient = newTestKubeClient();
		const m = newTestManager(kubeClient);
		const pod = getTestPod();

		let ret: V1Pod | undefined;
		let err: Error | undefined;
		kubeClient.addReactor("*", "pods", (action) => {
			switch (action.verb) {
				case "get":
					expect(action.request).toMatchObject({ name: pod.metadata?.name });
					break;
				case "patch":
					expect(action.request).toMatchObject({ name: pod.metadata?.name });
					break;
				default:
					expect.fail(`Unexpected Action: ${JSON.stringify(action)}`);
			}
			return [true, ret, err];
		});

		pod.status = { containerStatuses: [newContainerStatus({ state: { running: {} } })] };

		ret = undefined;
		err = new NotFound(`pods "${pod.metadata?.name}" not found`);
		await m.setPodStatus(pod, getRandomPodStatus());
		await verifyActions(m, [getAction()]);

		ret = getTestPod();
		ret.metadata = { ...ret.metadata, uid: "other_pod" };
		err = undefined;
		await m.setPodStatus(pod, getRandomPodStatus());
		await verifyActions(m, [getAction()]);

		ret = getTestPod();
		await m.setPodStatus(pod, getRandomPodStatus());
		await verifyActions(m, [getAction(), patchAction()]);

		pod.metadata = { ...pod.metadata, deletionTimestamp: new Date() };
		await m.setPodStatus(pod, getRandomPodStatus());
		await verifyActions(m, [getAction(), patchAction()]);

		const containerStatus = pod.status.containerStatuses?.[0];
		if (containerStatus?.state) {
			containerStatus.state.running = undefined;
			containerStatus.state.terminated = { exitCode: 0 };
		}
		await m.setPodStatus(pod, getRandomPodStatus());
		await verifyActions(m, [getAction(), patchAction()]);

		ret = undefined;
		err = new Error("intentional test error");
		await m.setPodStatus(pod, getRandomPodStatus());
		await verifyActions(m, [getAction()]);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestStaleUpdates.
browser.describe("TestStaleUpdates", () => {
	it("only pushes latest status", async () => {
		expect.hasAssertions();
		const ctx = context.background();
		const pod = getTestPod();
		const kubeClient = await newSimpleTestKubeClient(pod);
		const m = newTestManager(kubeClient);

		const status: V1PodStatus = { message: "initial status" };
		await m.setPodStatus(pod, status);
		status.message = "first version bump";
		await m.setPodStatus(pod, status);
		status.message = "second version bump";
		await m.setPodStatus(pod, status);

		await m.syncBatch(ctx, true);
		await verifyUpdates(m, 0);
		await verifyActions(m, [getAction(), patchAction()]);
		await verifyActions(m, []);

		await m.setPodStatus(pod, status);
		await verifyUpdates(m, 0);

		const mirrorPodUid = pod.metadata?.uid ?? "";
		m.apiStatusVersions.set(mirrorPodUid, (m.apiStatusVersions.get(mirrorPodUid) ?? 0) - 1);
		await m.setPodStatus(pod, status);
		await m.syncBatch(ctx, true);
		await verifyActions(m, [getAction()]);
		await verifyUpdates(m, 0);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go shuffle.
function shuffle(statuses: V1ContainerStatus[]): V1ContainerStatus[] {
	const shuffled = [...statuses];
	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
	}
	return shuffled;
}

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestStatusEquality.
browser.describe("TestStatusEquality", () => {
	it("matches upstream normalized status equality", () => {
		// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestStatusEquality getContainersAndStatuses.
		const getContainersAndStatuses = (): [Array<{ name: string }>, V1ContainerStatus[]] => {
			const containers: Array<{ name: string }> = [];
			const containerStatuses: V1ContainerStatus[] = [];
			for (let i = 0; i < 10; i++) {
				const containerName = `container${i}`;
				containers.push({ name: containerName });
				containerStatuses.push(newContainerStatus({ name: containerName }));
			}
			return [containers, containerStatuses];
		};
		const [containers, containerStatuses] = getContainersAndStatuses();
		const pod: V1Pod = {
			spec: {
				initContainers: containers,
				containers: [],
			},
		};
		const podStatus: V1PodStatus = {
			containerStatuses,
			initContainerStatuses: containerStatuses,
			ephemeralContainerStatuses: containerStatuses,
		};
		for (let i = 0; i < 10; i++) {
			const oldPodStatus: V1PodStatus = {
				containerStatuses: shuffle(podStatus.containerStatuses ?? []),
				initContainerStatuses: shuffle(podStatus.initContainerStatuses ?? []),
				ephemeralContainerStatuses: shuffle(podStatus.ephemeralContainerStatuses ?? []),
			};
			normalizeStatus(pod, oldPodStatus);
			normalizeStatus(pod, podStatus);
			expect(isPodStatusByKubeletEqual(oldPodStatus, podStatus)).toBe(true);
		}

		const oldPodStatus = structuredClone(podStatus);
		podStatus.conditions = [
			...(podStatus.conditions ?? []),
			{
				type: "www.example.com/feature",
				status: "True",
			},
		];

		oldPodStatus.conditions = [
			...(podStatus.conditions ?? []),
			{
				type: "www.example.com/feature",
				status: "False",
			},
		];

		normalizeStatus(pod, oldPodStatus);
		normalizeStatus(pod, podStatus);
		expect(isPodStatusByKubeletEqual(oldPodStatus, podStatus)).toBe(true);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestStatusNormalizationEnforcesMaxBytes.
browser.describe("TestStatusNormalizationEnforcesMaxBytes", () => {
	it("truncates container messages", () => {
		const pod: V1Pod = {
			spec: { containers: [] },
		};
		const containerStatus: V1ContainerStatus[] = [];
		for (let i = 0; i < 48; i++) {
			containerStatus.push(
				newContainerStatus({
					name: `container${i}`,
					lastState: {
						terminated: {
							message: "abcdefgh".repeat(24 + (i % 3)),
						},
					},
				}),
			);
		}
		const podStatus: V1PodStatus = {
			initContainerStatuses: containerStatus.slice(0, 16),
			containerStatuses: containerStatus.slice(16, 32),
			ephemeralContainerStatuses: containerStatus.slice(32),
		};
		const result = normalizeStatus(pod, podStatus);
		let count = 0;
		for (const s of result.initContainerStatuses ?? []) {
			const length = s.lastState?.terminated?.message?.length ?? 0;
			expect(length).toBeGreaterThanOrEqual(192);
			expect(length).toBeLessThanOrEqual(256);
			count += length;
		}
		expect(count).toBeLessThanOrEqual(maxPodTerminationMessageLogLength);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestStatusNormalizeTimeStamp.
browser.describe("TestStatusNormalizeTimeStamp", () => {
	it("normalizes timestamps", () => {
		const pod: V1Pod = {
			spec: { containers: [] },
		};
		const now = new Date();
		const podStatus: V1PodStatus = {
			containerStatuses: [
				newContainerStatus({ state: { running: { startedAt: now } } }),
				newContainerStatus({
					state: { terminated: { startedAt: now, finishedAt: now } },
				}),
			],
			initContainerStatuses: [
				newContainerStatus({ state: { running: { startedAt: now } } }),
				newContainerStatus({
					state: { terminated: { startedAt: now, finishedAt: now } },
				}),
			],
			ephemeralContainerStatuses: [
				newContainerStatus({ state: { running: { startedAt: now } } }),
				newContainerStatus({
					state: { terminated: { startedAt: now, finishedAt: now } },
				}),
			],
		};

		const expectedTime = new Date(now.toISOString());
		const expectedPodStatus: V1PodStatus = {
			containerStatuses: [
				newContainerStatus({ state: { running: { startedAt: expectedTime } } }),
				newContainerStatus({
					state: { terminated: { startedAt: expectedTime, finishedAt: expectedTime } },
				}),
			],
			initContainerStatuses: [
				newContainerStatus({ state: { running: { startedAt: expectedTime } } }),
				newContainerStatus({
					state: { terminated: { startedAt: expectedTime, finishedAt: expectedTime } },
				}),
			],
			ephemeralContainerStatuses: [
				newContainerStatus({ state: { running: { startedAt: expectedTime } } }),
				newContainerStatus({
					state: { terminated: { startedAt: expectedTime, finishedAt: expectedTime } },
				}),
			],
		};

		const normalizedStatus = normalizeStatus(pod, podStatus);
		expect(isPodStatusByKubeletEqual(expectedPodStatus, normalizedStatus)).toBe(true);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestStaticPod.
browser.describe("TestStaticPod", () => {
	it("syncs static pod status through mirror pod", async () => {
		const ctx = context.background();
		const staticPod = getTestPod();
		staticPod.metadata = {
			...staticPod.metadata,
			annotations: { [configSourceAnnotationKey]: fileSource },
		};
		const mirrorPod = getTestPod();
		mirrorPod.metadata = {
			...mirrorPod.metadata,
			uid: "mirror-12345678",
			annotations: {
				[configSourceAnnotationKey]: apiserverSource,
				[configMirrorAnnotationKey]: "mirror",
			},
		};
		const kubeClient = await newSimpleTestKubeClient(mirrorPod);
		const m = newTestManager(kubeClient);
		const podManager = m.podManager;

		podManager.addPod(staticPod);
		const status = getRandomPodStatus();
		const now = new Date();
		status.startTime = now;
		await m.setPodStatus(staticPod, status);

		const retrievedStatus = expectPodStatus(m, staticPod);
		normalizeStatus(staticPod, status);
		expect(isPodStatusByKubeletEqual(status, retrievedStatus)).toBe(true);

		expect(await m.syncBatch(ctx, true)).toBe(0);
		await verifyActions(m, []);

		podManager.addPod(mirrorPod);
		const retrievedMirrorStatus = m.getPodStatus(mirrorPod.metadata?.uid ?? "");
		expect(retrievedMirrorStatus).toBeDefined();
		expect(isPodStatusByKubeletEqual(status, retrievedMirrorStatus ?? {})).toBe(true);

		expect(await m.syncBatch(ctx, true)).toBe(1);
		await verifyActions(m, [getAction(), patchAction()]);

		await testSyncBatch(m, ctx);
		await verifyActions(m, []);

		podManager.removePod(mirrorPod);
		mirrorPod.metadata = {
			...mirrorPod.metadata,
			uid: "new-mirror-pod",
		};
		mirrorPod.status = {};
		podManager.addPod(mirrorPod);

		expect(await m.syncBatch(ctx, true)).toBe(1);
		await verifyActions(m, [getAction()]);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestTerminatePod.
browser.describe("TestTerminatePod", () => {
	it("preserves previous terminal status update", async () => {
		const syncer = newTestManager(newTestKubeClient());
		const testPod = getTestPod();
		testPod.spec = {
			initContainers: [{ name: "init-test-1" }, { name: "init-test-2" }, { name: "init-test-3" }],
			containers: [{ name: "test-1" }, { name: "test-2" }, { name: "test-3" }],
		};
		const firstStatus = getRandomPodStatus();
		firstStatus.phase = "Failed";
		firstStatus.initContainerStatuses = [
			newContainerStatus({ name: "init-test-1" }),
			newContainerStatus({
				name: "init-test-2",
				state: { terminated: { reason: "InitTest", exitCode: 0 } },
			}),
			newContainerStatus({
				name: "init-test-3",
				state: { terminated: { reason: "InitTest", exitCode: 3 } },
			}),
		];
		firstStatus.containerStatuses = [
			newContainerStatus({ name: "test-1" }),
			newContainerStatus({
				name: "test-2",
				state: { terminated: { reason: "Test", exitCode: 2 } },
			}),
			newContainerStatus({
				name: "test-3",
				state: { terminated: { reason: "Test", exitCode: 0 } },
			}),
		];
		await syncer.setPodStatus(testPod, firstStatus);

		testPod.status = getRandomPodStatus();
		testPod.status.phase = "Running";
		testPod.status.initContainerStatuses = [
			newContainerStatus({ name: "test-1" }),
			newContainerStatus({
				name: "init-test-2",
				state: { terminated: { reason: "InitTest", exitCode: 0 } },
			}),
			newContainerStatus({
				name: "init-test-3",
				state: { terminated: { reason: "InitTest", exitCode: 0 } },
			}),
		];
		testPod.status.containerStatuses = [
			newContainerStatus({ name: "test-1", state: { running: {} } }),
			newContainerStatus({ name: "test-2", state: { running: {} } }),
			newContainerStatus({ name: "test-3", state: { running: {} } }),
		];

		syncer.terminatePod(testPod);

		const newStatus = expectPodStatus(syncer, testPod);
		for (const container of newStatus.containerStatuses ?? []) {
			expect(container.state?.terminated).toBeDefined();
		}
		for (const container of newStatus.initContainerStatuses ?? []) {
			expect(container.state?.terminated).toBeDefined();
		}

		const expectUnknownState: V1ContainerStatus["state"] = {
			terminated: {
				reason: containerReasonStatusUnknown,
				message: "The container could not be located when the pod was terminated",
				exitCode: 137,
			},
		};
		expect(deepEqual(newStatus.initContainerStatuses?.[0].state, expectUnknownState)).toBe(true);
		expect(
			deepEqual(
				newStatus.initContainerStatuses?.[1].state,
				firstStatus.initContainerStatuses?.[1].state,
			),
		).toBe(true);
		expect(
			deepEqual(
				newStatus.initContainerStatuses?.[2].state,
				firstStatus.initContainerStatuses?.[2].state,
			),
		).toBe(true);
		expect(deepEqual(newStatus.containerStatuses?.[0].state, expectUnknownState)).toBe(true);
		expect(
			deepEqual(newStatus.containerStatuses?.[1].state, firstStatus.containerStatuses?.[1].state),
		).toBe(true);
		expect(
			deepEqual(newStatus.containerStatuses?.[2].state, firstStatus.containerStatuses?.[2].state),
		).toBe(true);

		expect(newStatus.phase).toBe(firstStatus.phase);
		expect(newStatus.message).toBe(firstStatus.message);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestTerminatePodWaiting.
browser.describe("TestTerminatePodWaiting", () => {
	it("preserves waiting init container status", async () => {
		const syncer = newTestManager(newTestKubeClient());
		const testPod = getTestPod();
		testPod.spec = {
			initContainers: [{ name: "init-test-1" }, { name: "init-test-2" }, { name: "init-test-3" }],
			containers: [{ name: "test-1" }, { name: "test-2" }, { name: "test-3" }],
		};
		const firstStatus = getRandomPodStatus();
		firstStatus.phase = "Failed";
		firstStatus.initContainerStatuses = [
			newContainerStatus({ name: "init-test-1" }),
			newContainerStatus({
				name: "init-test-2",
				state: { terminated: { reason: "InitTest", exitCode: 0 } },
			}),
			newContainerStatus({
				name: "init-test-3",
				state: { waiting: { reason: "InitTest" } },
			}),
		];
		firstStatus.containerStatuses = [
			newContainerStatus({ name: "test-1" }),
			newContainerStatus({
				name: "test-2",
				state: { terminated: { reason: "Test", exitCode: 2 } },
			}),
			newContainerStatus({
				name: "test-3",
				state: { waiting: { reason: "Test" } },
			}),
		];
		await syncer.setPodStatus(testPod, firstStatus);

		testPod.status = getRandomPodStatus();
		testPod.status.phase = "Running";
		testPod.status.initContainerStatuses = [
			newContainerStatus({ name: "test-1" }),
			newContainerStatus({
				name: "init-test-2",
				state: { terminated: { reason: "InitTest", exitCode: 0 } },
			}),
			newContainerStatus({
				name: "init-test-3",
				state: { terminated: { reason: "InitTest", exitCode: 0 } },
			}),
		];
		testPod.status.containerStatuses = [
			newContainerStatus({ name: "test-1", state: { running: {} } }),
			newContainerStatus({ name: "test-2", state: { running: {} } }),
			newContainerStatus({ name: "test-3", state: { running: {} } }),
		];

		syncer.terminatePod(testPod);

		const newStatus = expectPodStatus(syncer, testPod);
		for (const container of newStatus.containerStatuses ?? []) {
			expect(container.state?.terminated).toBeDefined();
		}
		for (const container of newStatus.initContainerStatuses?.slice(0, 2) ?? []) {
			expect(container.state?.terminated).toBeDefined();
		}
		for (const container of newStatus.initContainerStatuses?.slice(2) ?? []) {
			expect(container.state?.waiting).toBeDefined();
		}

		const expectUnknownState: V1ContainerStatus["state"] = {
			terminated: {
				reason: containerReasonStatusUnknown,
				message: "The container could not be located when the pod was terminated",
				exitCode: 137,
			},
		};
		expect(deepEqual(newStatus.initContainerStatuses?.[0].state, expectUnknownState)).toBe(true);
		expect(
			deepEqual(
				newStatus.initContainerStatuses?.[1].state,
				firstStatus.initContainerStatuses?.[1].state,
			),
		).toBe(true);
		expect(
			deepEqual(
				newStatus.initContainerStatuses?.[2].state,
				firstStatus.initContainerStatuses?.[2].state,
			),
		).toBe(true);
		expect(deepEqual(newStatus.containerStatuses?.[0].state, expectUnknownState)).toBe(true);
		expect(
			deepEqual(newStatus.containerStatuses?.[1].state, firstStatus.containerStatuses?.[1].state),
		).toBe(true);
		expect(deepEqual(newStatus.containerStatuses?.[2].state, expectUnknownState)).toBe(true);

		expect(newStatus.phase).toBe(firstStatus.phase);
		expect(newStatus.message).toBe(firstStatus.message);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestTerminatePod_DefaultUnknownStatus.
browser.describe("TestTerminatePod_DefaultUnknownStatus", () => {
	// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestTerminatePod_DefaultUnknownStatus newPod.
	const newPod = (
		initContainers: number,
		containers: number,
		...fns: Array<(pod: V1Pod) => void>
	): V1Pod => {
		const pod = getTestPod();
		pod.spec = { initContainers: [], containers: [] };
		for (let i = 0; i < initContainers; i++) {
			pod.spec.initContainers?.push({
				name: `init-${i}`,
			});
		}
		for (let i = 0; i < containers; i++) {
			pod.spec.containers?.push({
				name: `${i}`,
			});
		}
		pod.status = { startTime: new Date(1000), observedGeneration: 0 };
		for (const fn of fns) {
			fn(pod);
		}
		return pod;
	};

	// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestTerminatePod_DefaultUnknownStatus expectTerminatedUnknown.
	const expectTerminatedUnknown = (state: V1ContainerStatus["state"]) => {
		if (
			state?.terminated === undefined ||
			state.running !== undefined ||
			state.waiting !== undefined
		) {
			throw new Error(`unexpected state: ${JSON.stringify(state)}`);
		}
		if (
			state.terminated.exitCode !== 137 ||
			state.terminated.reason !== "ContainerStatusUnknown" ||
			(state.terminated.message?.length ?? 0) === 0
		) {
			throw new Error(`unexpected terminated state: ${JSON.stringify(state.terminated)}`);
		}
	};

	// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestTerminatePod_DefaultUnknownStatus expectTerminated.
	const expectTerminated = (state: V1ContainerStatus["state"], exitCode: number) => {
		if (
			state?.terminated === undefined ||
			state.running !== undefined ||
			state.waiting !== undefined
		) {
			throw new Error(`unexpected state: ${JSON.stringify(state)}`);
		}
		if (state.terminated.exitCode !== exitCode) {
			throw new Error(`unexpected terminated state: ${JSON.stringify(state.terminated)}`);
		}
	};

	// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestTerminatePod_DefaultUnknownStatus expectWaiting.
	const expectWaiting = (state: V1ContainerStatus["state"]) => {
		if (
			state?.terminated !== undefined ||
			state?.running !== undefined ||
			state?.waiting === undefined
		) {
			throw new Error(`unexpected state: ${JSON.stringify(state)}`);
		}
	};

	// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestTerminatePod_DefaultUnknownStatus testCases.
	const testCases: Array<{
		name: string;
		pod: V1Pod;
		updateFn?: (pod: V1Pod) => void;
		expectFn?: (status: V1PodStatus) => void;
	}> = [
		{
			name: "",
			pod: newPod(0, 1, (pod) => {
				pod.status = { ...pod.status, phase: "Failed" };
			}),
		},
		{
			name: "",
			pod: newPod(0, 1, (pod) => {
				pod.status = { ...pod.status, phase: "Running" };
			}),
			expectFn: (status) => {
				status.phase = "Failed";
			},
		},
		{
			name: "",
			pod: newPod(0, 1, (pod) => {
				pod.status = {
					...pod.status,
					phase: "Running",
					containerStatuses: [
						newContainerStatus({
							name: "0",
							state: { terminated: { reason: "Test", exitCode: 2 } },
						}),
					],
				};
			}),
			expectFn: (status) => {
				status.phase = "Failed";
			},
		},
		{
			name: "last termination state set",
			pod: newPod(0, 1, (pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
				pod.status = {
					...pod.status,
					phase: "Running",
					containerStatuses: [
						newContainerStatus({
							name: "0",
							lastState: { terminated: { reason: "Test", exitCode: 2 } },
							state: { waiting: {} },
						}),
					],
				};
			}),
			expectFn: (status) => {
				const container = status.containerStatuses?.[0];
				if (container?.lastState?.terminated?.exitCode !== 2) {
					throw new Error(`unexpected last state: ${JSON.stringify(container?.lastState)}`);
				}
				expectTerminatedUnknown(container?.state);
			},
		},
		{
			name: "no previous state",
			pod: newPod(0, 1, (pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
				pod.status = {
					...pod.status,
					phase: "Running",
					containerStatuses: [
						newContainerStatus({
							name: "0",
							state: { waiting: {} },
						}),
					],
				};
			}),
			expectFn: (status) => {
				expectTerminatedUnknown(status.containerStatuses?.[0].state);
			},
		},
		{
			name: "uninitialized pod defaults the first init container",
			pod: newPod(1, 1, (pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
				pod.status = {
					...pod.status,
					phase: "Pending",
					initContainerStatuses: [
						newContainerStatus({
							name: "init-0",
							state: { waiting: {} },
						}),
					],
					containerStatuses: [
						newContainerStatus({
							name: "0",
							state: { waiting: {} },
						}),
					],
				};
			}),
			expectFn: (status) => {
				expectTerminatedUnknown(status.initContainerStatuses?.[0].state);
				expectWaiting(status.containerStatuses?.[0].state);
			},
		},
		{
			name: "uninitialized pod defaults only the first init container",
			pod: newPod(2, 1, (pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
				pod.status = {
					...pod.status,
					phase: "Pending",
					initContainerStatuses: [
						newContainerStatus({
							name: "init-0",
							state: { waiting: {} },
						}),
						newContainerStatus({
							name: "init-1",
							state: { waiting: {} },
						}),
					],
					containerStatuses: [
						newContainerStatus({
							name: "0",
							state: { waiting: {} },
						}),
					],
				};
			}),
			expectFn: (status) => {
				expectTerminatedUnknown(status.initContainerStatuses?.[0].state);
				expectWaiting(status.initContainerStatuses?.[1].state);
				expectWaiting(status.containerStatuses?.[0].state);
			},
		},
		{
			name: "uninitialized pod defaults gaps",
			pod: newPod(4, 1, (pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
				pod.status = {
					...pod.status,
					phase: "Pending",
					initContainerStatuses: [
						newContainerStatus({
							name: "init-0",
							state: { waiting: {} },
						}),
						newContainerStatus({
							name: "init-1",
							state: { waiting: {} },
						}),
						newContainerStatus({
							name: "init-2",
							state: { terminated: { exitCode: 1 } },
						}),
						newContainerStatus({
							name: "init-3",
							state: { waiting: {} },
						}),
					],
					containerStatuses: [
						newContainerStatus({
							name: "0",
							state: { waiting: {} },
						}),
					],
				};
			}),
			expectFn: (status) => {
				expectTerminatedUnknown(status.initContainerStatuses?.[0].state);
				expectTerminatedUnknown(status.initContainerStatuses?.[1].state);
				expectTerminated(status.initContainerStatuses?.[2].state, 1);
				expectWaiting(status.initContainerStatuses?.[3].state);
				expectWaiting(status.containerStatuses?.[0].state);
			},
		},
		{
			name: "failed last container is uninitialized",
			pod: newPod(3, 1, (pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
				pod.status = {
					...pod.status,
					phase: "Pending",
					initContainerStatuses: [
						newContainerStatus({
							name: "init-0",
							state: { waiting: {} },
						}),
						newContainerStatus({
							name: "init-1",
							state: { waiting: {} },
						}),
						newContainerStatus({
							name: "init-2",
							state: { terminated: { exitCode: 1 } },
						}),
					],
					containerStatuses: [
						newContainerStatus({
							name: "0",
							state: { waiting: {} },
						}),
					],
				};
			}),
			expectFn: (status) => {
				expectTerminatedUnknown(status.initContainerStatuses?.[0].state);
				expectTerminatedUnknown(status.initContainerStatuses?.[1].state);
				expectTerminated(status.initContainerStatuses?.[2].state, 1);
				expectWaiting(status.containerStatuses?.[0].state);
			},
		},
		{
			name: "successful last container is initialized",
			pod: newPod(3, 1, (pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
				pod.status = {
					...pod.status,
					phase: "Running",
					initContainerStatuses: [
						newContainerStatus({
							name: "init-0",
							state: { waiting: {} },
						}),
						newContainerStatus({
							name: "init-1",
							state: { waiting: {} },
						}),
						newContainerStatus({
							name: "init-2",
							state: { terminated: { exitCode: 0 } },
						}),
					],
					containerStatuses: [
						newContainerStatus({
							name: "0",
							state: { waiting: {} },
						}),
					],
				};
			}),
			expectFn: (status) => {
				expectTerminatedUnknown(status.initContainerStatuses?.[0].state);
				expectTerminatedUnknown(status.initContainerStatuses?.[1].state);
				expectTerminated(status.initContainerStatuses?.[2].state, 0);
				expectTerminatedUnknown(status.containerStatuses?.[0].state);
			},
		},
		{
			name: "successful last previous container is initialized, and container state is overwritten",
			pod: newPod(3, 1, (pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
				pod.status = {
					...pod.status,
					phase: "Running",
					initContainerStatuses: [
						newContainerStatus({
							name: "init-0",
							state: { waiting: {} },
						}),
						newContainerStatus({
							name: "init-1",
							state: { waiting: {} },
						}),
						newContainerStatus({
							name: "init-2",
							lastState: { terminated: { exitCode: 0 } },
							state: { waiting: {} },
						}),
					],
					containerStatuses: [
						newContainerStatus({
							name: "0",
							state: { waiting: {} },
						}),
					],
				};
			}),
			expectFn: (status) => {
				expectTerminatedUnknown(status.initContainerStatuses?.[0].state);
				expectTerminatedUnknown(status.initContainerStatuses?.[1].state);
				expectTerminatedUnknown(status.initContainerStatuses?.[2].state);
				expectTerminatedUnknown(status.containerStatuses?.[0].state);
			},
		},
		{
			name: "running container proves initialization",
			pod: newPod(1, 1, (pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
				pod.status = {
					...pod.status,
					phase: "Running",
					initContainerStatuses: [
						newContainerStatus({
							name: "init-0",
							state: { waiting: {} },
						}),
					],
					containerStatuses: [
						newContainerStatus({
							name: "0",
							state: { running: {} },
						}),
					],
				};
			}),
			expectFn: (status) => {
				expectTerminatedUnknown(status.initContainerStatuses?.[0].state);
				expectTerminatedUnknown(status.containerStatuses?.[0].state);
			},
		},
		{
			name: "evidence of terminated container proves initialization",
			pod: newPod(1, 1, (pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
				pod.status = {
					...pod.status,
					phase: "Running",
					initContainerStatuses: [
						newContainerStatus({
							name: "init-0",
							state: { waiting: {} },
						}),
					],
					containerStatuses: [
						newContainerStatus({
							name: "0",
							state: { terminated: { exitCode: 0 } },
						}),
					],
				};
			}),
			expectFn: (status) => {
				expectTerminatedUnknown(status.initContainerStatuses?.[0].state);
				expectTerminated(status.containerStatuses?.[0].state, 0);
			},
		},
		{
			name: "evidence of previously terminated container proves initialization",
			pod: newPod(1, 1, (pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
				pod.status = {
					...pod.status,
					phase: "Running",
					initContainerStatuses: [
						newContainerStatus({
							name: "init-0",
							state: { waiting: {} },
						}),
					],
					containerStatuses: [
						newContainerStatus({
							name: "0",
							lastState: { terminated: { exitCode: 0 } },
						}),
					],
				};
			}),
			expectFn: (status) => {
				expectTerminatedUnknown(status.initContainerStatuses?.[0].state);
				expectTerminatedUnknown(status.containerStatuses?.[0].state);
			},
		},
	];

	for (const tc of testCases) {
		it(tc.name, async () => {
			const kubeClient = newTestKubeClient();
			const podManager = new PodManager();
			const podStartupLatencyTracker = {
				recordStatusUpdated(_pod: V1Pod): void {},
				deletePodStartupState(_podUid: string): void {},
			};
			const syncer = new StatusManagerImpl({
				clock: kubeClient.kubeConfig.options.clock,
				kubeClient,
				podManager,
				podDeletionSafety: {
					podCouldHaveRunningContainers: async () => false,
				},
				podStartupLatencyHelper: podStartupLatencyTracker,
			});

			const original = structuredClone(tc.pod);
			await syncer.setPodStatus(original, original.status ?? {});

			const copied = structuredClone(tc.pod);
			if (tc.updateFn) {
				tc.updateFn(copied);
			}
			const expected = structuredClone(copied);

			syncer.terminatePod(copied);
			const status = expectPodStatus(syncer, structuredClone(tc.pod));
			if (tc.expectFn) {
				tc.expectFn(status);
				return;
			}
			expect(statusEqual(expected.status ?? {}, status)).toBe(true);
		});
	}
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestTerminatePod_EnsurePodPhaseIsTerminal.
browser.describe("TestTerminatePod_EnsurePodPhaseIsTerminal", () => {
	// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestTerminatePod_EnsurePodPhaseIsTerminal testCases.
	const testCases: Record<
		string,
		{
			status: V1PodStatus;
			wantStatus: V1PodStatus;
		}
	> = {
		"Pending pod": {
			status: {
				phase: "Pending",
			},
			wantStatus: {
				phase: "Failed",
			},
		},
		"Running pod": {
			status: {
				phase: "Running",
			},
			wantStatus: {
				phase: "Failed",
			},
		},
		"Succeeded pod": {
			status: {
				phase: "Succeeded",
			},
			wantStatus: {
				phase: "Succeeded",
			},
		},
		"Failed pod": {
			status: {
				phase: "Failed",
			},
			wantStatus: {
				phase: "Failed",
			},
		},
		"Unknown pod": {
			status: {
				phase: "Unknown",
			},
			wantStatus: {
				phase: "Failed",
			},
		},
		"Unknown phase pod": {
			status: {
				phase: "SomeUnknownPhase",
			},
			wantStatus: {
				phase: "Failed",
			},
		},
	};

	for (const [name, tc] of Object.entries(testCases)) {
		it(name, () => {
			const kubeClient = newTestKubeClient();
			const podManager = new PodManager();
			const podStartupLatencyTracker = {
				recordStatusUpdated(_pod: V1Pod): void {},
				deletePodStartupState(_podUid: string): void {},
			};
			const syncer = new StatusManagerImpl({
				clock: kubeClient.kubeConfig.options.clock,
				kubeClient,
				podManager,
				podDeletionSafety: {
					podCouldHaveRunningContainers: async () => false,
				},
				podStartupLatencyHelper: podStartupLatencyTracker,
			});

			const pod = getTestPod();
			pod.status = tc.status;
			syncer.terminatePod(pod);
			const gotStatus = expectPodStatus(syncer, structuredClone(pod));
			const gotStatusWithoutStartTime = structuredClone(gotStatus);
			gotStatusWithoutStartTime.startTime = undefined;
			expect(statusEqual(tc.wantStatus, gotStatusWithoutStartTime)).toBe(true);
		});
	}
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestSetContainerReadiness.
browser.describe("TestSetContainerReadiness", () => {
	it("sets container readiness", async () => {
		const cID1 = buildContainerID("test", "1");
		const cID2 = buildContainerID("test", "2");
		const containerStatuses = [
			newContainerStatus({
				name: "c1",
				containerID: cID1.toString(),
				ready: false,
			}),
			newContainerStatus({
				name: "c2",
				containerID: cID2.toString(),
				ready: false,
			}),
		];
		const status: V1PodStatus = {
			containerStatuses,
			conditions: [
				{
					type: "Ready",
					status: "False",
				},
			],
		};
		const pod = getTestPod();
		pod.spec = { containers: [{ name: "c1" }, { name: "c2" }] };

		// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestSetContainerReadiness verifyReadiness.
		const verifyReadiness = (
			step: string,
			gotStatus: V1PodStatus,
			c1Ready: boolean,
			c2Ready: boolean,
			podReady: boolean,
		) => {
			for (const c of gotStatus.containerStatuses ?? []) {
				switch (c.containerID) {
					case cID1.toString():
						expect(c.ready).toBe(c1Ready);
						break;
					case cID2.toString():
						expect(c.ready).toBe(c2Ready);
						break;
					default:
						throw new Error(`[${step}] Unexpected container: ${JSON.stringify(c)}`);
				}
			}
			const condition = gotStatus.conditions?.[0];
			if (condition?.type !== "Ready") {
				throw new Error(`[${step}] Unexpected condition: ${JSON.stringify(condition)}`);
			} else {
				const ready = condition.status === "True";
				expect(ready).toBe(podReady);
			}
		};

		const m = newTestManager(newTestKubeClient());
		const podManager = m.podManager;
		podManager.addPod(pod);

		m.setContainerReadiness(pod.metadata?.uid ?? "", cID1, true);
		await verifyUpdates(m, 0);
		expect(m.getPodStatus(pod.metadata?.uid ?? "")).toBeUndefined();

		await m.setPodStatus(pod, status);
		await verifyUpdates(m, 1);
		let gotStatus = expectPodStatus(m, pod);
		verifyReadiness("initial", gotStatus, false, false, false);

		m.setContainerReadiness(pod.metadata?.uid ?? "", cID1, false);
		await verifyUpdates(m, 0);
		gotStatus = expectPodStatus(m, pod);
		verifyReadiness("unchanged", gotStatus, false, false, false);

		m.setContainerReadiness(pod.metadata?.uid ?? "", cID1, true);
		await verifyUpdates(m, 1);
		gotStatus = expectPodStatus(m, pod);
		verifyReadiness("c1 ready", gotStatus, true, false, false);

		m.setContainerReadiness(pod.metadata?.uid ?? "", cID2, true);
		await verifyUpdates(m, 1);
		gotStatus = expectPodStatus(m, pod);
		verifyReadiness("all ready", gotStatus, true, true, true);

		m.setContainerReadiness(pod.metadata?.uid ?? "", buildContainerID("test", "foo"), true);
		await verifyUpdates(m, 0);
		gotStatus = expectPodStatus(m, pod);
		verifyReadiness("ignore non-existent", gotStatus, true, true, true);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestSetContainerStartup.
browser.describe("TestSetContainerStartup", () => {
	it("sets container startup", async () => {
		const cID1 = buildContainerID("test", "1");
		const cID2 = buildContainerID("test", "2");
		const containerStatuses = [
			newContainerStatus({
				name: "c1",
				containerID: cID1.toString(),
				ready: false,
			}),
			newContainerStatus({
				name: "c2",
				containerID: cID2.toString(),
				ready: false,
			}),
		];
		const status: V1PodStatus = {
			containerStatuses,
			conditions: [
				{
					type: "Ready",
					status: "False",
				},
			],
		};
		const pod = getTestPod();
		pod.spec = { containers: [{ name: "c1" }, { name: "c2" }] };

		// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestSetContainerStartup verifyStartup.
		const verifyStartup = (
			step: string,
			gotStatus: V1PodStatus,
			c1Started: boolean,
			c2Started: boolean,
			_podStarted: boolean,
		) => {
			for (const c of gotStatus.containerStatuses ?? []) {
				switch (c.containerID) {
					case cID1.toString():
						if ((c.started !== undefined && c.started) !== c1Started) {
							throw new Error(
								`Error in startup of c1: expected ${c1Started}, current ${c.started}`,
							);
						}
						break;
					case cID2.toString():
						if ((c.started !== undefined && c.started) !== c2Started) {
							throw new Error(
								`Error in startup of c2: step ${step}, expected ${c2Started}, current ${c.started}`,
							);
						}
						break;
					default:
						throw new Error(`Unexpected container: step ${step}, container ${JSON.stringify(c)}`);
				}
			}
		};

		const m = newTestManager(newTestKubeClient());
		const podManager = m.podManager;
		podManager.addPod(pod);

		m.setContainerStartup(pod.metadata?.uid ?? "", cID1, true);
		await verifyUpdates(m, 0);
		expect(m.getPodStatus(pod.metadata?.uid ?? "")).toBeUndefined();

		await m.setPodStatus(pod, status);
		await verifyUpdates(m, 1);
		let gotStatus = expectPodStatus(m, pod);
		verifyStartup("initial", gotStatus, false, false, false);

		m.setContainerStartup(pod.metadata?.uid ?? "", cID1, false);
		await verifyUpdates(m, 1);
		gotStatus = expectPodStatus(m, pod);
		verifyStartup("unchanged", gotStatus, false, false, false);

		m.setContainerStartup(pod.metadata?.uid ?? "", cID1, true);
		await verifyUpdates(m, 1);
		gotStatus = expectPodStatus(m, pod);
		verifyStartup("c1 ready", gotStatus, true, false, false);

		m.setContainerStartup(pod.metadata?.uid ?? "", cID2, true);
		await verifyUpdates(m, 1);
		gotStatus = expectPodStatus(m, pod);
		verifyStartup("all ready", gotStatus, true, true, true);

		m.setContainerStartup(pod.metadata?.uid ?? "", buildContainerID("test", "foo"), true);
		await verifyUpdates(m, 0);
		gotStatus = expectPodStatus(m, pod);
		verifyStartup("ignore non-existent", gotStatus, true, true, true);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestSyncBatchCleanupVersions.
browser.describe("TestSyncBatchCleanupVersions", () => {
	it("cleans up versions", async () => {
		const ctx = context.background();
		const m = newTestManager(newTestKubeClient());
		const podManager = m.podManager;
		const testPod = getTestPod();
		const mirrorPod = getTestPod();
		mirrorPod.metadata = {
			...mirrorPod.metadata,
			uid: "mirror-uid",
			name: "mirror_pod",
			annotations: {
				[configSourceAnnotationKey]: apiserverSource,
				[configMirrorAnnotationKey]: "mirror",
			},
		};

		m.apiStatusVersions.set(testPod.metadata?.uid ?? "", 100);
		m.apiStatusVersions.set(mirrorPod.metadata?.uid ?? "", 200);
		await m.syncBatch(ctx, true);
		expect(m.apiStatusVersions.has(testPod.metadata?.uid ?? "")).toBe(false);
		expect(m.apiStatusVersions.has(mirrorPod.metadata?.uid ?? "")).toBe(false);

		await m.setPodStatus(testPod, getRandomPodStatus());
		podManager.addPod(mirrorPod);
		const staticPod = structuredClone(mirrorPod);
		staticPod.metadata = {
			...staticPod.metadata,
			uid: "static-uid",
			annotations: { [configSourceAnnotationKey]: fileSource },
		};
		podManager.addPod(staticPod);
		m.apiStatusVersions.set(testPod.metadata?.uid ?? "", 100);
		m.apiStatusVersions.set(mirrorPod.metadata?.uid ?? "", 200);
		await testSyncBatch(m, ctx);
		expect(m.apiStatusVersions.has(testPod.metadata?.uid ?? "")).toBe(true);
		expect(m.apiStatusVersions.has(mirrorPod.metadata?.uid ?? "")).toBe(true);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestReconcilePodStatus.
browser.describe("TestReconcilePodStatus", () => {
	it("reconciles pod status", async () => {
		const ctx = context.background();
		const testPod = getTestPod();
		const kubeClient = await newSimpleTestKubeClient(testPod);
		const syncer = newTestManager(kubeClient);
		const podManager = syncer.podManager;
		await syncer.setPodStatus(testPod, getRandomPodStatus());
		await syncer.syncBatch(ctx, true);
		kubeClient.clearActions();

		const podStatus = syncer.getPodStatus(testPod.metadata?.uid ?? "");
		expect(podStatus).toBeDefined();
		testPod.status = podStatus;

		podManager.updatePod(testPod);
		expect(syncer.needsReconcile(testPod.metadata?.uid ?? "", podStatus ?? {})).toBe(false);
		await syncer.setPodStatus(testPod, podStatus ?? {});
		await syncer.syncBatch(ctx, true);
		await verifyActions(syncer, []);

		const normalizedStartTime = new Date(testPod.status?.startTime?.toISOString() ?? "");
		testPod.status = { ...testPod.status, startTime: normalizedStartTime };
		podManager.updatePod(testPod);
		expect(syncer.needsReconcile(testPod.metadata?.uid ?? "", podStatus ?? {})).toBe(false);
		await syncer.setPodStatus(testPod, podStatus ?? {});
		await syncer.syncBatch(ctx, true);
		await verifyActions(syncer, []);

		const changedPodStatus = getRandomPodStatus();
		podManager.updatePod(testPod);
		expect(syncer.needsReconcile(testPod.metadata?.uid ?? "", changedPodStatus)).toBe(true);
		await syncer.setPodStatus(testPod, changedPodStatus);
		await syncer.syncBatch(ctx, true);
		await verifyActions(syncer, [getAction(), patchAction()]);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go expectPodStatus.
function expectPodStatus(m: StatusManager, pod: V1Pod): V1PodStatus {
	const status = m.getPodStatus(pod.metadata?.uid ?? "");
	if (!status) {
		throw new Error(`Expected PodStatus for "${pod.metadata?.uid ?? ""}" not found`);
	}
	return status;
}

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestDeletePodBeforeFinished.
browser.describe("TestDeletePodBeforeFinished", () => {
	it("does not delete pod before finished", async () => {
		expect.hasAssertions();
		const pod = getTestPod();
		pod.metadata = { ...pod.metadata, deletionTimestamp: new Date() };
		const kubeClient = await newSimpleTestKubeClient(pod);
		const m = newTestManager(kubeClient);
		const podManager = m.podManager;
		podManager.addPod(pod);
		const status = getRandomPodStatus();
		status.phase = "Failed";
		await m.setPodStatus(pod, status);
		await verifyActions(m, [getAction(), patchAction()]);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestDeletePodFinished.
browser.describe("TestDeletePodFinished", () => {
	it("deletes pod once finished", async () => {
		expect.hasAssertions();
		const pod = getTestPod();
		pod.metadata = { ...pod.metadata, deletionTimestamp: new Date() };
		pod.status = { phase: "Failed" };
		const kubeClient = await newSimpleTestKubeClient(pod);
		const m = newTestManager(kubeClient);
		const podManager = m.podManager;
		podManager.addPod(pod);
		m.terminatePod(pod);
		await verifyActions(m, [getAction(), patchAction(), deleteAction()]);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestDoNotDeleteMirrorPods.
browser.describe("TestDoNotDeleteMirrorPods", () => {
	it("does not delete mirror pods", async () => {
		expect.hasAssertions();
		const staticPod = getTestPod();
		staticPod.metadata = {
			...staticPod.metadata,
			annotations: { [configSourceAnnotationKey]: fileSource },
		};
		const mirrorPod = getTestPod();
		mirrorPod.metadata = {
			...mirrorPod.metadata,
			uid: "mirror-12345678",
			deletionTimestamp: new Date(),
			annotations: {
				[configSourceAnnotationKey]: apiserverSource,
				[configMirrorAnnotationKey]: "mirror",
			},
		};
		const kubeClient = await newSimpleTestKubeClient(mirrorPod);
		const m = newTestManager(kubeClient);
		const podManager = m.podManager;
		podManager.addPod(staticPod);
		podManager.addPod(mirrorPod);
		expect(isStaticPod(staticPod)).toBe(true);
		expect(isMirrorPod(mirrorPod)).toBe(true);
		expect(podManager.translatePodUid(mirrorPod.metadata?.uid ?? "")).toBe(
			staticPod.metadata?.uid ?? "",
		);

		const status = getRandomPodStatus();
		const now = new Date();
		status.startTime = now;
		await m.setPodStatus(staticPod, status);
		await verifyActions(m, [getAction(), patchAction()]);
	});
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestUpdateLastTransitionTime.
browser.describe("TestUpdateLastTransitionTime", () => {
	const old = new Date(Date.now() - 1000);
	const tests: Record<
		string,
		{
			condition?: V1PodCondition;
			oldCondition?: V1PodCondition;
			expectUpdate: boolean;
		}
	> = {
		"should do nothing if no corresponding condition": {
			expectUpdate: false,
		},
		"should update last transition time if no old condition": {
			condition: {
				type: "test-type",
				status: "True",
			},
			expectUpdate: true,
		},
		"should update last transition time if condition is changed": {
			condition: {
				type: "test-type",
				status: "True",
			},
			oldCondition: {
				type: "test-type",
				status: "False",
				lastTransitionTime: old,
			},
			expectUpdate: true,
		},
		"should keep last transition time if condition is not changed": {
			condition: {
				type: "test-type",
				status: "False",
			},
			oldCondition: {
				type: "test-type",
				status: "False",
				lastTransitionTime: old,
			},
			expectUpdate: false,
		},
	};

	for (const [desc, test] of Object.entries(tests)) {
		it(desc, () => {
			const clock = new Clock();
			const status: V1PodStatus = {};
			const oldStatus: V1PodStatus = {};
			if (test.condition) {
				status.conditions = [structuredClone(test.condition)];
			}
			if (test.oldCondition) {
				oldStatus.conditions = [structuredClone(test.oldCondition)];
			}
			updateLastTransitionTime(clock, status, oldStatus, "test-type");
			const actual = test.expectUpdate
				? (status.conditions?.[0].lastTransitionTime?.getTime() ?? 0) > old.getTime()
				: status.conditions?.[0].lastTransitionTime?.getTime();
			const expected = test.expectUpdate ? true : test.condition ? old.getTime() : undefined;
			expect(actual).toBe(expected);
		});
	}
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go getAction.
function getAction(): ClientAction {
	return clientAction("get", "pods");
}

// Models kubernetes/pkg/kubelet/status/status_manager_test.go patchAction.
function patchAction(): ClientAction {
	return clientAction("patch", "pods", "status");
}

// Models kubernetes/pkg/kubelet/status/status_manager_test.go deleteAction.
function deleteAction(): ClientAction {
	return clientAction("delete", "pods");
}

// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestMergePodStatus.
browser.describe("TestMergePodStatus", () => {
	// Models kubernetes/pkg/kubelet/status/status_manager_test.go TestMergePodStatus useCases.
	const useCases: Array<{
		desc: string;
		hasRunningContainers: boolean;
		oldPodStatus(input: V1PodStatus): V1PodStatus;
		newPodStatus(input: V1PodStatus): V1PodStatus;
		expectPodStatus: V1PodStatus;
	}> = [
		{
			desc: "no change",
			hasRunningContainers: false,
			oldPodStatus: (input) => input,
			newPodStatus: (input) => input,
			expectPodStatus: getPodStatus(),
		},
		{
			desc: "add DisruptionTarget condition when transitioning into failed phase",
			hasRunningContainers: false,
			oldPodStatus: (input) => input,
			newPodStatus: (input) => {
				input.phase = "Failed";
				input.conditions = [
					...(input.conditions ?? []),
					{ type: "DisruptionTarget", status: "True", reason: "TerminationByKubelet" },
				];
				return input;
			},
			expectPodStatus: {
				phase: "Failed",
				conditions: [
					{ type: "DisruptionTarget", status: "True", reason: "TerminationByKubelet" },
					{ type: "Ready", status: "False", reason: "PodFailed" },
					{ type: "PodScheduled", status: "True" },
					{ type: "ContainersReady", status: "False", reason: "PodFailed" },
				],
				message: "Message",
			},
		},
		{
			desc: "don't add DisruptionTarget condition when transitioning into failed phase, but there might still be running containers",
			hasRunningContainers: true,
			oldPodStatus: (input) => input,
			newPodStatus: (input) => {
				input.phase = "Failed";
				input.conditions = [
					...(input.conditions ?? []),
					{ type: "DisruptionTarget", status: "True", reason: "TerminationByKubelet" },
				];
				return input;
			},
			expectPodStatus: {
				phase: "Running",
				conditions: [
					{ type: "Ready", status: "True" },
					{ type: "PodScheduled", status: "True" },
				],
				message: "Message",
			},
		},
		{
			desc: "preserve DisruptionTarget condition",
			hasRunningContainers: false,
			oldPodStatus: (input) => {
				input.conditions = [
					...(input.conditions ?? []),
					{ type: "DisruptionTarget", status: "True", reason: "TerminationByKubelet" },
				];
				return input;
			},
			newPodStatus: (input) => input,
			expectPodStatus: {
				phase: "Running",
				conditions: [
					{ type: "Ready", status: "True" },
					{ type: "PodScheduled", status: "True" },
					{ type: "DisruptionTarget", status: "True", reason: "TerminationByKubelet" },
				],
				message: "Message",
			},
		},
		{
			desc: "override DisruptionTarget condition",
			hasRunningContainers: false,
			oldPodStatus: (input) => {
				input.conditions = [
					...(input.conditions ?? []),
					{ type: "DisruptionTarget", status: "True", reason: "EvictedByEvictionAPI" },
				];
				return input;
			},
			newPodStatus: (input) => {
				input.phase = "Failed";
				input.conditions = [
					...(input.conditions ?? []),
					{ type: "DisruptionTarget", status: "True", reason: "TerminationByKubelet" },
				];
				return input;
			},
			expectPodStatus: {
				phase: "Failed",
				conditions: [
					{ type: "Ready", status: "False", reason: "PodFailed" },
					{ type: "ContainersReady", status: "False", reason: "PodFailed" },
					{ type: "PodScheduled", status: "True" },
					{ type: "DisruptionTarget", status: "True", reason: "TerminationByKubelet" },
				],
				message: "Message",
			},
		},
		{
			desc: "don't override DisruptionTarget condition when remaining in running phase",
			hasRunningContainers: false,
			oldPodStatus: (input) => {
				input.conditions = [
					...(input.conditions ?? []),
					{ type: "DisruptionTarget", status: "True", reason: "EvictedByEvictionAPI" },
				];
				return input;
			},
			newPodStatus: (input) => {
				input.conditions = [
					...(input.conditions ?? []),
					{ type: "DisruptionTarget", status: "True", reason: "TerminationByKubelet" },
				];
				return input;
			},
			expectPodStatus: {
				phase: "Running",
				conditions: [
					{ type: "DisruptionTarget", status: "True", reason: "EvictedByEvictionAPI" },
					{ type: "Ready", status: "True" },
					{ type: "PodScheduled", status: "True" },
				],
				message: "Message",
			},
		},
		{
			desc: "don't override DisruptionTarget condition when transitioning to failed phase but there might still be running containers",
			hasRunningContainers: true,
			oldPodStatus: (input) => {
				input.conditions = [
					...(input.conditions ?? []),
					{ type: "DisruptionTarget", status: "True", reason: "EvictedByEvictionAPI" },
				];
				return input;
			},
			newPodStatus: (input) => {
				input.phase = "Failed";
				input.conditions = [
					...(input.conditions ?? []),
					{ type: "DisruptionTarget", status: "True", reason: "TerminationByKubelet" },
				];
				return input;
			},
			expectPodStatus: {
				phase: "Running",
				conditions: [
					{ type: "DisruptionTarget", status: "True", reason: "EvictedByEvictionAPI" },
					{ type: "Ready", status: "True" },
					{ type: "PodScheduled", status: "True" },
				],
				message: "Message",
			},
		},
		{
			desc: "readiness changes",
			hasRunningContainers: false,
			oldPodStatus: (input) => input,
			newPodStatus: (input) => {
				if (input.conditions) {
					input.conditions[0].status = "False";
				}
				return input;
			},
			expectPodStatus: {
				phase: "Running",
				conditions: [
					{ type: "Ready", status: "False" },
					{ type: "PodScheduled", status: "True" },
				],
				message: "Message",
			},
		},
		{
			desc: "additional pod condition",
			hasRunningContainers: false,
			oldPodStatus: (input) => {
				input.conditions = [
					...(input.conditions ?? []),
					{ type: "example.com/feature", status: "True" },
				];
				return input;
			},
			newPodStatus: (input) => input,
			expectPodStatus: {
				phase: "Running",
				conditions: [
					{ type: "Ready", status: "True" },
					{ type: "PodScheduled", status: "True" },
					{ type: "example.com/feature", status: "True" },
				],
				message: "Message",
			},
		},
		{
			desc: "additional pod condition and readiness changes",
			hasRunningContainers: false,
			oldPodStatus: (input) => {
				input.conditions = [
					...(input.conditions ?? []),
					{ type: "example.com/feature", status: "True" },
				];
				return input;
			},
			newPodStatus: (input) => {
				if (input.conditions) {
					input.conditions[0].status = "False";
				}
				return input;
			},
			expectPodStatus: {
				phase: "Running",
				conditions: [
					{ type: "Ready", status: "False" },
					{ type: "PodScheduled", status: "True" },
					{ type: "example.com/feature", status: "True" },
				],
				message: "Message",
			},
		},
		{
			desc: "additional pod condition changes",
			hasRunningContainers: false,
			oldPodStatus: (input) => {
				input.conditions = [
					...(input.conditions ?? []),
					{ type: "example.com/feature", status: "True" },
				];
				return input;
			},
			newPodStatus: (input) => {
				input.conditions = [
					...(input.conditions ?? []),
					{ type: "example.com/feature", status: "False" },
				];
				return input;
			},
			expectPodStatus: {
				phase: "Running",
				conditions: [
					{ type: "Ready", status: "True" },
					{ type: "PodScheduled", status: "True" },
					{ type: "example.com/feature", status: "True" },
				],
				message: "Message",
			},
		},
		{
			desc: "phase is transitioning to failed and no containers running",
			hasRunningContainers: false,
			oldPodStatus: (input) => {
				input.phase = "Running";
				input.reason = "Unknown";
				input.message = "Message";
				return input;
			},
			newPodStatus: (input) => {
				input.phase = "Failed";
				input.reason = "Evicted";
				input.message = "Was Evicted";
				return input;
			},
			expectPodStatus: {
				phase: "Failed",
				conditions: [
					{ type: "Ready", status: "False", reason: "PodFailed" },
					{ type: "ContainersReady", status: "False", reason: "PodFailed" },
					{ type: "PodScheduled", status: "True" },
				],
				reason: "Evicted",
				message: "Was Evicted",
			},
		},
		{
			desc: "phase is transitioning to failed and containers running",
			hasRunningContainers: true,
			oldPodStatus: (input) => {
				input.phase = "Running";
				input.reason = "Unknown";
				input.message = "Message";
				return input;
			},
			newPodStatus: (input) => {
				input.phase = "Failed";
				input.reason = "Evicted";
				input.message = "Was Evicted";
				return input;
			},
			expectPodStatus: {
				phase: "Running",
				conditions: [
					{ type: "Ready", status: "True" },
					{ type: "PodScheduled", status: "True" },
				],
				reason: "Unknown",
				message: "Message",
			},
		},
	];

	for (const tc of useCases) {
		it(tc.desc, () => {
			const clock = new Clock();
			const oldPodStatus = tc.oldPodStatus(getPodStatus());
			const pod: V1Pod = { status: oldPodStatus };
			const output = mergePodStatus(
				clock,
				pod,
				oldPodStatus,
				tc.newPodStatus(getPodStatus()),
				tc.hasRunningContainers,
			);
			expect(conditionsEqual(output.conditions ?? [], tc.expectPodStatus.conditions ?? [])).toBe(
				true,
			);
			expect(statusEqual(output, tc.expectPodStatus)).toBe(true);
		});
	}
});

// Models kubernetes/pkg/kubelet/status/status_manager_test.go statusEqual.
function statusEqual(left: V1PodStatus, right: V1PodStatus): boolean {
	const leftCopy = structuredClone(left);
	const rightCopy = structuredClone(right);
	leftCopy.conditions = undefined;
	rightCopy.conditions = undefined;
	return deepEqual(dropUndefinedFields(leftCopy), dropUndefinedFields(rightCopy));
}

// Models kubernetes/pkg/kubelet/status/status_manager_test.go conditionsEqual.
function conditionsEqual(left: V1PodCondition[], right: V1PodCondition[]): boolean {
	if (left.length !== right.length) {
		return false;
	}

	for (const l of left) {
		const r = right.find((condition) => condition.type === l.type);
		if (!r) {
			return false;
		}
		if (l.status !== r.status || l.reason !== r.reason) {
			return false;
		}
	}
	return true;
}

// Models kubernetes/pkg/kubelet/status/status_manager_test.go getPodStatus.
function getPodStatus(): V1PodStatus {
	return {
		phase: "Running",
		conditions: [
			{
				type: "Ready",
				status: "True",
			},
			{
				type: "PodScheduled",
				status: "True",
			},
		],
		message: "Message",
	};
}
