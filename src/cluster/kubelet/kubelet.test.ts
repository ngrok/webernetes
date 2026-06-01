import { expect, it } from "vitest";
import type { V1Container, V1ContainerStatus, V1Pod } from "../../client";
import * as context from "../../go/context";
import { browser } from "../../test/describe";
import {
	ContainerID,
	PodSyncResult,
	type Pod as RuntimePod,
	type PodStatus as PodRuntimeStatus,
	type Status as ContainerRuntimeStatus,
	newSyncResult,
} from "./container";
import type { FakePod } from "./container/testing";
import {
	FakePodWorkers,
	newTestKubelet,
	podWithUIDNameNs,
	podWithUIDNameNsSpec,
} from "./kubelet-test-helpers";
import { newReasonCache } from "./reason-cache";
import { configSourceAnnotationKey } from "./types";

function containerStatusZero(cName: string): V1ContainerStatus {
	return {
		name: cName,
		image: "",
		imageID: "",
		ready: false,
		restartCount: 0,
	};
}

function runtimeStatus(
	name: string,
	options: Partial<ContainerRuntimeStatus> = {},
): ContainerRuntimeStatus {
	return {
		name,
		id: options.id ?? new ContainerID("", ""),
		image: options.image ?? "",
		imageID: options.imageID ?? "",
		imageRef: options.imageRef ?? "",
		imageRuntimeHandler: options.imageRuntimeHandler ?? "",
		state: options.state ?? "Running",
		createdAt: options.createdAt ?? 0,
		startedAt: options.startedAt,
		finishedAt: options.finishedAt,
		exitCode: options.exitCode,
		hash: options.hash ?? 0,
		restartCount: options.restartCount ?? 0,
		reason: options.reason,
		message: options.message,
	};
}

function verifyContainerStatuses(
	statuses: V1ContainerStatus[] | undefined,
	expectedState: Record<string, NonNullable<V1ContainerStatus["state"]>>,
	expectedLastTerminationState: Record<string, NonNullable<V1ContainerStatus["lastState"]>>,
): void {
	for (const status of statuses ?? []) {
		expect(status.state).toEqual(expectedState[status.name]);
		expect(status.lastState).toEqual(expectedLastTerminationState[status.name]);
	}
}

function runtimePodWithContainer(uid: string, name: string, namespace: string): RuntimePod {
	return {
		id: uid,
		name,
		namespace,
		createdAt: 0,
		timestamp: new Date(0),
		containers: [
			{
				id: new ContainerID("test", "bar"),
				name: "bar",
				image: "",
				imageID: "",
				imageRef: "",
				imageRuntimeHandler: "",
				hash: 0,
				state: "Running",
				podSandboxID: "sandbox",
				createdAt: 0,
			},
		],
		sandboxes: [],
	};
}

// Models kubernetes/pkg/kubelet/kubelet_test.go TestGenerateAPIPodStatusWithSortedContainers.
browser.describe("generateAPIPodStatusWithSortedContainers", () => {
	it("sorts container statuses by pod spec container order", async () => {
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);
		try {
			const kubelet = testKubelet.kubelet;
			const numContainers = 10;
			const expectedOrder: string[] = [];
			const cStatuses: ContainerRuntimeStatus[] = [];
			const specContainerList: V1Container[] = [];
			for (let i = 0; i < numContainers; i++) {
				const id = `${i}`;
				const containerName = `${id}container`;
				expectedOrder.push(containerName);
				const cStatus = runtimeStatus(containerName, {
					id: new ContainerID("test", id),
				});
				if (i % 2 === 0) {
					cStatuses.push(cStatus);
				} else {
					cStatuses.unshift(cStatus);
				}
				specContainerList.push({ name: containerName });
			}
			const pod = podWithUIDNameNsSpec("uid1", "foo", "test", {
				containers: specContainerList,
			});
			const status: PodRuntimeStatus = {
				id: pod.metadata?.uid ?? "",
				name: pod.metadata?.name ?? "",
				namespace: pod.metadata?.namespace ?? "",
				containerStatuses: cStatuses,
				sandboxStatuses: [],
				ips: [],
				timestamp: new Date(0),
			};

			for (let i = 0; i < 5; i++) {
				const apiStatus = kubelet.generateAPIPodStatus(tCtx, pod, status, false);
				expect(apiStatus.containerStatuses?.map((container) => container.name)).toEqual(
					expectedOrder,
				);
			}
		} finally {
			await testKubelet.cleanup();
		}
	});
});

// Models kubernetes/pkg/kubelet/kubelet_test.go TestHandlePodRemovesWhenSourcesAreReady.
browser.describe("handlePodRemovesWhenSourcesAreReady", () => {
	it("gates pod worker deletion on source readiness", async () => {
		expect.hasAssertions();
		const tCtx = context.background();
		let ready = false;
		const testKubelet = newTestKubelet(false);
		const kubelet = testKubelet.kubelet;
		try {
			const fakePod: FakePod = {
				pod: runtimePodWithContainer("1", "foo", "new"),
				netnsPath: "",
			};
			testKubelet.fakeRuntime.podList = [fakePod];
			const pods = [podWithUIDNameNs("1", "foo", "new")];
			kubelet.sourcesReady = { addSource: () => {}, allReady: () => ready };

			await kubelet.handlePodRemoves(tCtx, pods);
			await Promise.resolve();

			expect(testKubelet.fakePodWorkers.triggeredDeletion).toEqual([]);

			ready = true;
			await kubelet.handlePodRemoves(tCtx, pods);
			await Promise.resolve();

			expect(testKubelet.fakePodWorkers.triggeredDeletion).toEqual(["1"]);
		} finally {
			await testKubelet.cleanup();
		}
	});
});

// Models kubernetes/pkg/kubelet/kubelet_test.go TestNetworkErrorsWithoutHostNetwork.
browser.describe("networkErrorsWithoutHostNetwork", () => {
	it("blocks non-host-network pods when runtime network is not ready", async () => {
		expect.hasAssertions();
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);
		const kubelet = testKubelet.kubelet;
		try {
			kubelet.runtimeState.setNetworkState(new Error("simulated network error"));

			const pod = podWithUIDNameNsSpec("12345678", "hostnetwork", "new", {
				hostNetwork: false,
				containers: [{ name: "foo" }],
			});

			kubelet.podManager.setPods([pod]);
			const [isTerminal, , err] = await kubelet.syncPod(tCtx, "update", pod, undefined, {
				id: "",
				name: "",
				namespace: "",
				ips: [],
				containerStatuses: [],
				sandboxStatuses: [],
				timestamp: new Date(0),
			});
			expect(err).toBeInstanceOf(Error);
			expect(err?.message).toContain("network is not ready");
			expect(isTerminal).toBe(false);

			pod.metadata ??= {};
			pod.metadata.annotations ??= {};
			pod.metadata.annotations[configSourceAnnotationKey] = "file";
			pod.spec = { ...pod.spec, containers: pod.spec?.containers ?? [], hostNetwork: true };
			const [hostIsTerminal, , hostErr] = await kubelet.syncPod(tCtx, "update", pod, undefined, {
				id: "",
				name: "",
				namespace: "",
				ips: [],
				containerStatuses: [],
				sandboxStatuses: [],
				timestamp: new Date(0),
			});
			expect(hostErr).toBeUndefined();
			expect(hostIsTerminal).toBe(false);
		} finally {
			await testKubelet.cleanup();
		}
	});
});

// Models kubernetes/pkg/kubelet/kubelet_test.go TestSyncPodRestartAllContainersRequeue.
browser.describe("syncPodRestartAllContainersRequeue", () => {
	it("requeues immediately after successful restart-all container removal", async () => {
		expect.hasAssertions();
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);
		const kubelet = testKubelet.kubelet;
		try {
			const pod = podWithUIDNameNsSpec("12345678", "foo", "new", {
				containers: [
					{
						name: "bar",
						restartPolicyRules: [{ action: "RestartAllContainers" }],
					},
				],
			});
			kubelet.podManager.setPods([pod]);
			await kubelet.statusManager.setPodStatus(pod, {
				phase: "Running",
				conditions: [
					{
						type: "AllContainersRestarting",
						status: "True",
					},
				],
			});

			const syncResult = new PodSyncResult();
			syncResult.addSyncResult(newSyncResult("RemoveContainer", pod.metadata?.uid ?? ""));
			testKubelet.fakeRuntime.syncResults = syncResult;

			let callCount = 0;
			kubelet.podWorkers = new FakePodWorkers(
				kubelet.podCache,
				async (ctx, updateType, pod, mirrorPod, podStatus) => {
					callCount++;
					if (callCount > 1) {
						testKubelet.fakeRuntime.syncResults = new PodSyncResult();
					}
					return kubelet.syncPod(ctx, updateType, pod, mirrorPod, podStatus);
				},
			);

			const [isTerminal, , err] = await kubelet.syncPod(tCtx, "update", pod, undefined, {
				id: "",
				name: "",
				namespace: "",
				ips: [],
				containerStatuses: [
					{
						name: "bar",
						id: new ContainerID("", ""),
						image: "",
						imageID: "",
						imageRef: "",
						imageRuntimeHandler: "",
						hash: 0,
						restartCount: 0,
						state: "Exited",
						createdAt: 0,
					},
				],
				sandboxStatuses: [],
				timestamp: new Date(0),
			});

			expect(isTerminal).toBe(false);
			expect(err).toBeUndefined();
			expect(callCount).toBe(1);
		} finally {
			await testKubelet.cleanup();
		}
	});
});

// Models kubernetes/pkg/kubelet/kubelet_test.go TestGenerateAPIPodStatusWithReasonCache.
browser.describe("generateAPIPodStatusWithReasonCache", () => {
	const testTimestamp = new Date(123456789000 + 987);
	const testErrorReason = new Error("test-error");
	const emptyContainerID = new ContainerID("", "").toString();
	const pod = podWithUIDNameNs("12345678", "foo", "new");
	pod.spec = { restartPolicy: "OnFailure", containers: [] };
	const podStatus: PodRuntimeStatus = {
		id: pod.metadata?.uid ?? "",
		name: pod.metadata?.name ?? "",
		namespace: pod.metadata?.namespace ?? "",
		timestamp: new Date(0),
		containerStatuses: [],
		sandboxStatuses: [],
		ips: [],
	};

	const tests: Array<{
		containers: V1Container[];
		statuses: ContainerRuntimeStatus[];
		reasons: Record<string, Error>;
		oldStatuses: V1ContainerStatus[];
		expectedState: Record<string, NonNullable<V1ContainerStatus["state"]>>;
		expectedLastTerminationState: Record<string, NonNullable<V1ContainerStatus["lastState"]>>;
	}> = [
		{
			containers: [{ name: "without-old-record" }, { name: "with-old-record" }],
			statuses: [],
			reasons: {},
			oldStatuses: [
				{
					...containerStatusZero("with-old-record"),
					lastState: { terminated: { exitCode: 0 } },
				},
			],
			expectedState: {
				"without-old-record": { waiting: { reason: "ContainerCreating" } },
				"with-old-record": { waiting: { reason: "ContainerCreating" } },
			},
			expectedLastTerminationState: {
				"with-old-record": { terminated: { exitCode: 0 } },
			},
		},
		{
			containers: [{ name: "running" }],
			statuses: [
				runtimeStatus("running", {
					state: "Running",
					startedAt: testTimestamp.getTime(),
				}),
				runtimeStatus("running", {
					state: "Exited",
					exitCode: 1,
				}),
			],
			reasons: {},
			oldStatuses: [],
			expectedState: {
				running: { running: { startedAt: testTimestamp } },
			},
			expectedLastTerminationState: {
				running: { terminated: { exitCode: 1, containerID: emptyContainerID } },
			},
		},
		{
			containers: [{ name: "without-reason" }, { name: "with-reason" }, { name: "succeed" }],
			statuses: [
				runtimeStatus("without-reason", { state: "Exited", exitCode: 1 }),
				runtimeStatus("with-reason", { state: "Exited", exitCode: 2 }),
				runtimeStatus("without-reason", { state: "Exited", exitCode: 3 }),
				runtimeStatus("with-reason", { state: "Exited", exitCode: 4 }),
				runtimeStatus("succeed", { state: "Exited", exitCode: 0 }),
				runtimeStatus("succeed", { state: "Exited", exitCode: 5 }),
			],
			reasons: { "with-reason": testErrorReason, succeed: testErrorReason },
			oldStatuses: [],
			expectedState: {
				"without-reason": { terminated: { exitCode: 1, containerID: emptyContainerID } },
				"with-reason": { waiting: { reason: testErrorReason.message, message: "" } },
				succeed: { terminated: { exitCode: 0, containerID: emptyContainerID } },
			},
			expectedLastTerminationState: {
				"without-reason": { terminated: { exitCode: 3, containerID: emptyContainerID } },
				"with-reason": { terminated: { exitCode: 2, containerID: emptyContainerID } },
				succeed: { terminated: { exitCode: 5, containerID: emptyContainerID } },
			},
		},
		{
			containers: [{ name: "unknown" }],
			statuses: [
				runtimeStatus("unknown", { state: "Unknown" }),
				runtimeStatus("unknown", { state: "Running" }),
			],
			reasons: {},
			oldStatuses: [
				{
					...containerStatusZero("unknown"),
					state: { running: {} },
				},
			],
			expectedState: {
				unknown: {
					terminated: {
						exitCode: 137,
						message: "The container could not be located when the pod was terminated",
						reason: "ContainerStatusUnknown",
					},
				},
			},
			expectedLastTerminationState: {
				unknown: { running: {} },
			},
		},
	];

	it("generates api pod status with reason cache", async () => {
		expect.hasAssertions();
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);
		const kubelet = testKubelet.kubelet;
		try {
			for (const test of tests) {
				kubelet.reasonCache = newReasonCache();
				for (const [name, reason] of Object.entries(test.reasons)) {
					kubelet.reasonCache.add(pod.metadata?.uid ?? "", name, reason, "");
				}
				pod.spec = { ...pod.spec, containers: test.containers };
				pod.status = { containerStatuses: test.oldStatuses };
				podStatus.containerStatuses = test.statuses;
				const apiStatus = kubelet.generateAPIPodStatus(tCtx, pod, podStatus, false);

				verifyContainerStatuses(
					apiStatus.containerStatuses,
					test.expectedState,
					test.expectedLastTerminationState,
				);
			}

			// The upstream test repeats the same table for init containers. The
			// simulator does not currently support init containers, so that loop is
			// intentionally not copied here.
		} finally {
			await testKubelet.cleanup();
		}
	});
});

// Models kubernetes/pkg/kubelet/kubelet_test.go TestGenerateAPIPodStatusWithDifferentRestartPolicies.
browser.describe("generateAPIPodStatusWithDifferentRestartPolicies", () => {
	const testErrorReason = new Error("test-error");
	const emptyContainerID = new ContainerID("", "").toString();
	const containers: V1Container[] = [{ name: "succeed" }, { name: "failed" }];
	const pod = podWithUIDNameNs("12345678", "foo", "new");
	const podStatus: PodRuntimeStatus = {
		id: pod.metadata?.uid ?? "",
		name: pod.metadata?.name ?? "",
		namespace: pod.metadata?.namespace ?? "",
		timestamp: new Date(0),
		containerStatuses: [
			runtimeStatus("succeed", { state: "Exited", exitCode: 0 }),
			runtimeStatus("failed", { state: "Exited", exitCode: 1 }),
			runtimeStatus("succeed", { state: "Exited", exitCode: 2 }),
			runtimeStatus("failed", { state: "Exited", exitCode: 3 }),
		],
		sandboxStatuses: [],
		ips: [],
	};

	const tests: Array<{
		restartPolicy: NonNullable<V1Pod["spec"]>["restartPolicy"];
		expectedState: Record<string, NonNullable<V1ContainerStatus["state"]>>;
		expectedLastTerminationState: Record<string, NonNullable<V1ContainerStatus["lastState"]>>;
	}> = [
		{
			restartPolicy: "Never" as const,
			expectedState: {
				succeed: { terminated: { exitCode: 0, containerID: emptyContainerID } },
				failed: { terminated: { exitCode: 1, containerID: emptyContainerID } },
			},
			expectedLastTerminationState: {
				succeed: { terminated: { exitCode: 2, containerID: emptyContainerID } },
				failed: { terminated: { exitCode: 3, containerID: emptyContainerID } },
			},
		},
		{
			restartPolicy: "OnFailure" as const,
			expectedState: {
				succeed: { terminated: { exitCode: 0, containerID: emptyContainerID } },
				failed: { waiting: { reason: testErrorReason.message, message: "" } },
			},
			expectedLastTerminationState: {
				succeed: { terminated: { exitCode: 2, containerID: emptyContainerID } },
				failed: { terminated: { exitCode: 1, containerID: emptyContainerID } },
			},
		},
		{
			restartPolicy: "Always" as const,
			expectedState: {
				succeed: { waiting: { reason: testErrorReason.message, message: "" } },
				failed: { waiting: { reason: testErrorReason.message, message: "" } },
			},
			expectedLastTerminationState: {
				succeed: { terminated: { exitCode: 0, containerID: emptyContainerID } },
				failed: { terminated: { exitCode: 1, containerID: emptyContainerID } },
			},
		},
	];

	it("generates api pod status with different restart policies", async () => {
		expect.hasAssertions();
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);
		const kubelet = testKubelet.kubelet;
		try {
			kubelet.reasonCache.add(pod.metadata?.uid ?? "", "succeed", testErrorReason, "");
			kubelet.reasonCache.add(pod.metadata?.uid ?? "", "failed", testErrorReason, "");
			for (const test of tests) {
				pod.spec = { containers, restartPolicy: test.restartPolicy };
				const apiStatus = kubelet.generateAPIPodStatus(tCtx, pod, podStatus, false);

				verifyContainerStatuses(
					apiStatus.containerStatuses,
					test.expectedState,
					test.expectedLastTerminationState,
				);
				pod.spec = { containers: [] };

				// The upstream test repeats each case for init containers. The simulator
				// does not currently support init containers, so that half is
				// intentionally not copied here.
			}
		} finally {
			await testKubelet.cleanup();
		}
	});
});
