// oxlint-disable jest/no-standalone-expect
// oxlint-disable jest/no-conditional-expect
import { expect, it } from "vitest";
import type {
	V1Container,
	V1ContainerStatus,
	V1Pod,
	V1PodCondition,
	V1PodStatus,
} from "../../client";
import * as context from "../../go/context";
import { browser } from "../../test/describe";
import {
	buildContainerID,
	ContainerID,
	newContainer,
	newContainerID,
	newPod,
	type Pod as RuntimePod,
	type PodStatus as PodRuntimeStatus,
	type Status as ContainerRuntimeStatus,
} from "./container";
import { newFakePod, type FakePod } from "./container/testing";
import {
	createPodWorkers,
	drainAllWorkers,
	newTestKubelet,
	podWithUIDNameNs,
	type syncPodRecord,
} from "./kubelet-test-helpers";
import {
	isDeleted,
	isFinished,
	isTerminationRequested,
	isTerminationStarted,
	isWorking,
	newPodSyncerFuncs,
	newUpdatePodOptions,
	PodWorkersImpl,
} from "./pod-workers";
import * as kubetypes from "./types";

interface ConvertToAPIContainerStatusesUpstreamTestCase {
	name: string;
	pod: V1Pod;
	currentStatus: PodRuntimeStatus;
	previousStatus: V1ContainerStatus[];
	containers: V1Container[];
	hasInitContainers?: boolean;
	isInitContainer?: boolean;
	podRestarting?: boolean;
	expected: V1ContainerStatus[];
}

interface rejectedPod {
	uid: string;
	reason: string;
	message: string;
}

function containerStatusZero(cName: string): V1ContainerStatus {
	return {
		name: cName,
		image: "",
		imageID: "",
		ready: false,
		restartCount: 0,
	};
}

function waitingStateWithRestartingAllContainers(cName: string): V1ContainerStatus {
	return {
		...containerStatusZero(cName),
		state: {
			waiting: {
				reason: "RestartingAllContainers",
				message: "The container is removed because RestartAllContainers in place",
			},
		},
		lastState: {
			terminated: {
				reason: "RestartingAllContainers",
				message: "The container is removed because RestartAllContainers in place",
				exitCode: 137,
			},
		},
	};
}

function runningState(cName: string): V1ContainerStatus {
	return {
		...containerStatusZero(cName),
		state: { running: {} },
	};
}

function succeededState(cName: string): V1ContainerStatus {
	return {
		...containerStatusZero(cName),
		state: { terminated: { exitCode: 0 } },
	};
}

function failedState(cName: string): V1ContainerStatus {
	return {
		...containerStatusZero(cName),
		state: { terminated: { exitCode: -1 } },
	};
}

function failedStateWithExitCode(cName: string, exitCode: number): V1ContainerStatus {
	return {
		...containerStatusZero(cName),
		state: { terminated: { exitCode } },
	};
}

function waitingWithLastTerminationUnknown(cName: string, restartCount: number): V1ContainerStatus {
	return {
		...containerStatusZero(cName),
		state: { waiting: { reason: "ContainerCreating" } },
		lastState: {
			terminated: {
				reason: "ContainerStatusUnknown",
				message:
					"The container could not be located when the pod was deleted.  The container used to be Running",
				exitCode: 137,
			},
		},
		restartCount,
	};
}

function waitingState(cName: string): V1ContainerStatus {
	return waitingStateWithReason(cName, "");
}

function waitingStateWithReason(cName: string, reason: string): V1ContainerStatus {
	return {
		...containerStatusZero(cName),
		state: { waiting: { reason } },
	};
}

function runningStateWithStartedAt(cName: string, startedAt: Date): V1ContainerStatus {
	return {
		...containerStatusZero(cName),
		state: { running: { startedAt } },
	};
}

function ready(status: V1ContainerStatus): V1ContainerStatus {
	return {
		...status,
		ready: true,
	};
}

function withID(status: V1ContainerStatus, id: string): V1ContainerStatus {
	return {
		...status,
		containerID: id,
	};
}

function withResources(status: V1ContainerStatus): V1ContainerStatus {
	return {
		...status,
		resources: {},
	};
}

function withRestartCount(status: V1ContainerStatus, restartCount: number): V1ContainerStatus {
	return {
		...status,
		restartCount,
	};
}

function withLastTerminationState(
	status: V1ContainerStatus,
	lastState: NonNullable<V1ContainerStatus["lastState"]>,
): V1ContainerStatus {
	return {
		...status,
		lastState,
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

function stripUndefined<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map((item) => stripUndefined(item)) as T;
	}
	if (value instanceof Date || value === null || typeof value !== "object") {
		return value;
	}
	const result: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (child !== undefined) {
			result[key] = stripUndefined(child);
		}
	}
	return result as T;
}

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go findContainerStatusByName.
function findAPIContainerStatusByName(
	status: V1PodStatus,
	name: string,
): V1ContainerStatus | undefined {
	for (const containerStatus of status.initContainerStatuses ?? []) {
		if (containerStatus.name === name) {
			return containerStatus;
		}
	}
	for (const containerStatus of status.containerStatuses ?? []) {
		if (containerStatus.name === name) {
			return containerStatus;
		}
	}
	for (const containerStatus of status.ephemeralContainerStatuses ?? []) {
		if (containerStatus.name === name) {
			return containerStatus;
		}
	}
	return undefined;
}

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestGeneratePodHostNameAndDomain.
browser.describe("generatePodHostNameAndDomain", () => {
	it.each([
		{
			name: "Default behavior - pod name as hostname",
			podName: "test-pod",
			podHostname: undefined,
			podSubdomain: undefined,
			podHostnameOverride: undefined,
			expectedHostname: "test-pod",
			expectedDomain: "",
			errorContains: undefined,
		},
		{
			name: "Custom Hostname - uses pod.Spec.Hostname",
			podName: "test-pod",
			podHostname: "custom-hostname",
			podSubdomain: undefined,
			podHostnameOverride: undefined,
			expectedHostname: "custom-hostname",
			expectedDomain: "",
			errorContains: undefined,
		},
		{
			name: "Custom Subdomain - constructs FQDN",
			podName: "test-pod",
			podHostname: undefined,
			podSubdomain: "my-subdomain",
			podHostnameOverride: undefined,
			expectedHostname: "test-pod",
			expectedDomain: "my-subdomain.default.svc.cluster.local",
			errorContains: undefined,
		},
		{
			name: "Custom Hostname and Subdomain - uses both",
			podName: "test-pod",
			podHostname: "custom-hostname",
			podSubdomain: "my-subdomain",
			podHostnameOverride: undefined,
			expectedHostname: "custom-hostname",
			expectedDomain: "my-subdomain.default.svc.cluster.local",
			errorContains: undefined,
		},
		{
			name: "HostnameOverride - enabled - overrides all",
			podName: "test-pod",
			podHostname: "custom-hostname",
			podSubdomain: "my-subdomain",
			podHostnameOverride: "override-hostname",
			expectedHostname: "override-hostname",
			expectedDomain: "",
			errorContains: undefined,
		},
		{
			name: "HostnameOverride - enabled - overrides all - invalid hostname",
			podName: "test-pod",
			podHostname: "custom-hostname",
			podSubdomain: "my-subdomain",
			podHostnameOverride: "Invalid-Hostname-!",
			expectedHostname: "",
			expectedDomain: "",
			errorContains: 'pod HostnameOverride "Invalid-Hostname-!" is not a valid DNS subdomain',
		},
		{
			name: "HostnameOverride - enabled - overrides all - valid DNS hostname",
			podName: "test-pod",
			podHostname: undefined,
			podSubdomain: undefined,
			podHostnameOverride: "valid.hostname",
			expectedHostname: "valid.hostname",
			expectedDomain: "",
			errorContains: undefined,
		},
		{
			name: "Hostname Truncation - pod name is too long",
			podName: "a".repeat(65),
			podHostname: undefined,
			podSubdomain: undefined,
			podHostnameOverride: undefined,
			expectedHostname: "a".repeat(63),
			expectedDomain: "",
			errorContains: undefined,
		},
		{
			name: "Validation - invalid hostname",
			podName: "test-pod",
			podHostname: "Invalid-Hostname-!",
			podSubdomain: undefined,
			podHostnameOverride: undefined,
			expectedHostname: "",
			expectedDomain: "",
			errorContains: 'pod Hostname "Invalid-Hostname-!" is not a valid DNS label',
		},
		{
			name: "Validation - invalid subdomain",
			podName: "test-pod",
			podHostname: undefined,
			podSubdomain: "invalid_subdomain",
			podHostnameOverride: undefined,
			expectedHostname: "",
			expectedDomain: "",
			errorContains: 'pod Subdomain "invalid_subdomain" is not a valid DNS label',
		},
		{
			name: "Validation - too long hostname",
			podName: "test-pod",
			podHostname: "a".repeat(64),
			podSubdomain: undefined,
			podHostnameOverride: undefined,
			expectedHostname: "",
			expectedDomain: "",
			errorContains: "must be no more than 63 characters",
		},
	])(
		"$name",
		async ({
			podName,
			podHostname,
			podSubdomain,
			podHostnameOverride,
			expectedHostname,
			expectedDomain,
			errorContains,
		}) => {
			const testKubelet = newTestKubelet(false);
			const pod: V1Pod = {
				metadata: {
					name: podName,
					namespace: "default",
				},
				spec: {
					containers: [],
					hostname: podHostname,
					hostnameOverride: podHostnameOverride,
					subdomain: podSubdomain,
				},
			};

			try {
				const [hostname, domain, err] = testKubelet.kubelet.generatePodHostNameAndDomain(pod);

				expect(err?.message ?? "").toContain(errorContains ?? "");
				expect(err === undefined).toBe(errorContains === undefined);
				expect(hostname).toBe(expectedHostname);
				expect(domain).toBe(expectedDomain);
			} finally {
				await testKubelet.cleanup();
			}
		},
	);
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestKubelet_HandlePodCleanups.
browser.describe("kubeletHandlePodCleanups", () => {
	const one = 1;
	const two = 2;
	const deleted = new Date(2_000);
	const simplePod = (): V1Pod => ({
		metadata: { name: "pod1", namespace: "ns1", uid: "1" },
		spec: { containers: [{ name: "container-1" }] },
	});
	const withPhase = (pod: V1Pod, phase: string) => {
		pod.status = { phase };
		return pod;
	};
	const staticPod = (): V1Pod => ({
		metadata: {
			name: "pod1",
			namespace: "ns1",
			uid: "1",
			annotations: {
				[kubetypes.configSourceAnnotationKey]: kubetypes.fileSource,
			},
		},
		spec: { containers: [{ name: "container-1" }] },
	});
	// Models kubernetes/pkg/kubelet/kubelet_pods_test.go runtimePod.
	const runtimePod = (pod: V1Pod): RuntimePod => {
		const runningPod = newPod({
			id: pod.metadata?.uid ?? "",
			name: pod.metadata?.name ?? "",
			namespace: pod.metadata?.namespace ?? "default",
			containers: [
				newContainer({
					name: "container-1",
					id: newContainerID({ type: "test", id: "c1" }),
				}),
			],
		});
		for (const [i, container] of (pod.spec?.containers ?? []).entries()) {
			runningPod.containers.push(
				newContainer({
					name: container.name,
					id: newContainerID({ type: "test", id: `c${i}` }),
				}),
			);
		}
		return runningPod;
	};

	const tests: Array<{
		name: string;
		pods?: V1Pod[];
		runtimePods?: FakePod[];
		rejectedPods?: rejectedPod[];
		terminatingErr?: Error;
		prepareWorker?: (
			podWorkers: PodWorkersImpl,
			records: Map<string, syncPodRecord[]>,
		) => Promise<void>;
		wantWorker?: (
			podWorkers: PodWorkersImpl,
			records: Map<string, syncPodRecord[]>,
		) => void | Promise<void>;
		wantWorkerAfterRetry?: (
			podWorkers: PodWorkersImpl,
			records: Map<string, syncPodRecord[]>,
		) => void;
		wantErr?: boolean;
		expectMetrics?: Record<string, string>;
		expectMetricsAfterRetry?: Record<string, string>;
	}> = [
		{
			name: "missing pod is requested for termination with short grace period",
			runtimePods: [newFakePod({ pod: runtimePod(staticPod()) })],
			wantWorker: async (w, records) => {
				await drainAllWorkers(w);
				expect(records.get("1") ?? []).toEqual([
					{
						name: "pod1",
						updateType: "kill",
						runningPod: runtimePod(staticPod()),
					},
				]);
				expect(w.podSyncStatuses.has("1")).toBe(false);
			},
		},
		{
			name: "terminating pod that errored and is not in config is notified by the cleanup",
			runtimePods: [newFakePod({ pod: runtimePod(simplePod()) })],
			terminatingErr: new Error("unable to terminate"),
			prepareWorker: async (w, records) => {
				const pod: V1Pod = {
					metadata: { name: "pod1", namespace: "ns1", uid: "1" },
					spec: {
						containers: [{ name: "container-1" }],
					},
				};
				await w.updatePod(context.background(), {
					updateType: "create",
					startTime: new Date(1_000),
					pod,
				});
				await drainAllWorkers(w);
				const updatedPod: V1Pod = {
					metadata: {
						name: "pod1",
						namespace: "ns1",
						uid: "1",
						deletionGracePeriodSeconds: two,
						deletionTimestamp: deleted,
					},
					spec: {
						terminationGracePeriodSeconds: two,
						containers: [{ name: "container-1" }],
					},
				};
				await w.updatePod(context.background(), {
					updateType: "kill",
					startTime: new Date(3_000),
					pod: updatedPod,
				});
				await drainAllWorkers(w);
				const r = records.get(updatedPod.metadata?.uid ?? "");
				if (r === undefined || r.length !== 2 || r[1]?.gracePeriod !== 2) {
					throw new Error(`unexpected records: ${JSON.stringify(Object.fromEntries(records))}`);
				}
			},
			wantWorker: (podWorkers, records) => {
				const uid = "1";
				expect(podWorkers.podSyncStatuses.size).toBe(1);
				const s = podWorkers.podSyncStatuses.get(uid);
				if (
					!s ||
					!isTerminationRequested(s) ||
					!isTerminationStarted(s) ||
					isFinished(s) ||
					isWorking(s) ||
					!isDeleted(s)
				) {
					throw new Error(`unexpected requested pod termination: ${JSON.stringify(s)}`);
				}
				expect(records.get("1") ?? []).toEqual([
					{ name: "pod1", updateType: "create" },
					{ name: "pod1", updateType: "kill", gracePeriod: two },
					{ name: "pod1", updateType: "kill", gracePeriod: two },
				]);
			},
			wantWorkerAfterRetry: (podWorkers, records) => {
				const uid = "1";
				expect(podWorkers.podSyncStatuses.size).toBe(1);
				const s = podWorkers.podSyncStatuses.get(uid);
				if (
					!s ||
					!isTerminationRequested(s) ||
					!isTerminationStarted(s) ||
					!isFinished(s) ||
					isWorking(s) ||
					!isDeleted(s)
				) {
					throw new Error(`unexpected requested pod termination: ${JSON.stringify(s)}`);
				}
				expect(records.get("1") ?? []).toEqual([
					{ name: "pod1", updateType: "create" },
					{ name: "pod1", updateType: "kill", gracePeriod: two },
					{ name: "pod1", updateType: "kill", gracePeriod: two },
					{ name: "pod1", updateType: "kill", gracePeriod: two },
					{ name: "pod1", terminated: true },
				]);
			},
		},
		{
			name: "terminating pod that errored and is not in config or worker is force killed by the cleanup",
			runtimePods: [newFakePod({ pod: runtimePod(simplePod()) })],
			terminatingErr: new Error("unable to terminate"),
			wantWorker: (podWorkers, records) => {
				const uid = "1";
				expect(podWorkers.podSyncStatuses.size).toBe(1);
				const s = podWorkers.podSyncStatuses.get(uid);
				if (
					!s ||
					!isTerminationRequested(s) ||
					!isTerminationStarted(s) ||
					isFinished(s) ||
					isWorking(s) ||
					!isDeleted(s)
				) {
					throw new Error(`unexpected requested pod termination: ${JSON.stringify(s)}`);
				}
				const expectedRunningPod = runtimePod(simplePod());
				expect(s.activeUpdate?.runningPod).toEqual(expectedRunningPod);
				expect(s.activeUpdate?.killPodOptions?.podTerminationGracePeriodSecondsOverride).toBe(one);
				expect(records.get(uid) ?? []).toEqual([
					{
						name: "pod1",
						updateType: "kill",
						runningPod: expectedRunningPod,
					},
				]);
			},
			wantWorkerAfterRetry: (podWorkers, records) => {
				const uid = "1";
				expect(podWorkers.podSyncStatuses.size).toBe(0);
				const expectedRunningPod = runtimePod(simplePod());
				expect(records.get(uid) ?? []).toEqual([
					{
						name: "pod1",
						updateType: "kill",
						runningPod: expectedRunningPod,
					},
					{
						name: "pod1",
						updateType: "kill",
						runningPod: expectedRunningPod,
					},
				]);
			},
		},
		{
			name: "pod is added to worker by sync method",
			pods: [simplePod()],
			wantWorker: (podWorkers, records) => {
				const uid = "1";
				expect(podWorkers.podSyncStatuses.size).toBe(1);
				const s = podWorkers.podSyncStatuses.get(uid);
				if (
					!s ||
					isTerminationRequested(s) ||
					isTerminationStarted(s) ||
					isFinished(s) ||
					isWorking(s) ||
					isDeleted(s)
				) {
					throw new Error(`unexpected requested pod termination: ${JSON.stringify(s)}`);
				}
				expect(records.get(uid) ?? []).toEqual([{ name: "pod1", updateType: "create" }]);
			},
		},
		{
			name: "pod is not added to worker by sync method because it is in a terminal phase",
			pods: [withPhase(simplePod(), "Failed")],
			wantWorker: (w, records) => {
				expect(w.podSyncStatuses.size).toBe(0);
				expect(records.get("1")).toBeUndefined();
			},
		},
		{
			name: "pod is not added to worker by sync method because it has been rejected",
			pods: [simplePod()],
			rejectedPods: [{ uid: "1", reason: "Test", message: "rejected" }],
			wantWorker: (w, records) => {
				expect(w.podSyncStatuses.size).toBe(0);
				expect(records.get("1")).toBeUndefined();
			},
		},
		{
			name: "terminating pod that is known to the config gets no update during pod cleanup",
			pods: [
				{
					metadata: {
						name: "pod1",
						namespace: "ns1",
						uid: "1",
						deletionGracePeriodSeconds: two,
						deletionTimestamp: deleted,
					},
					spec: {
						terminationGracePeriodSeconds: two,
						containers: [{ name: "container-1" }],
					},
				},
			],
			runtimePods: [newFakePod({ pod: runtimePod(simplePod()) })],
			terminatingErr: new Error("unable to terminate"),
			prepareWorker: async (w, records) => {
				const pod: V1Pod = {
					metadata: { name: "pod1", namespace: "ns1", uid: "1" },
					spec: {
						containers: [{ name: "container-1" }],
					},
				};
				await w.updatePod(context.background(), {
					updateType: "create",
					startTime: new Date(1_000),
					pod,
				});
				await drainAllWorkers(w);
				const updatedPod: V1Pod = {
					metadata: {
						name: "pod1",
						namespace: "ns1",
						uid: "1",
						deletionGracePeriodSeconds: two,
						deletionTimestamp: deleted,
					},
					spec: {
						terminationGracePeriodSeconds: two,
						containers: [{ name: "container-1" }],
					},
				};
				await w.updatePod(context.background(), {
					updateType: "kill",
					startTime: new Date(3_000),
					pod: updatedPod,
				});
				await drainAllWorkers(w);
				expect(records.get(updatedPod.metadata?.uid ?? "") ?? []).toEqual([
					{ name: "pod1", updateType: "create" },
					{ name: "pod1", updateType: "kill", gracePeriod: two },
				]);
			},
			wantWorker: (podWorkers, records) => {
				const uid = "1";
				expect(podWorkers.podSyncStatuses.size).toBe(1);
				const s = podWorkers.podSyncStatuses.get(uid);
				if (
					!s ||
					!isTerminationRequested(s) ||
					!isTerminationStarted(s) ||
					isFinished(s) ||
					isWorking(s) ||
					!isDeleted(s)
				) {
					throw new Error(`unexpected requested pod termination: ${JSON.stringify(s)}`);
				}
				expect(records.get(uid) ?? []).toEqual([
					{ name: "pod1", updateType: "create" },
					{ name: "pod1", updateType: "kill", gracePeriod: two },
				]);
			},
		},
		{
			name: "started pod that is not in config is force terminated during pod cleanup",
			runtimePods: [newFakePod({ pod: runtimePod(simplePod()) })],
			terminatingErr: new Error("unable to terminate"),
			prepareWorker: async (podWorkers, records) => {
				const pod = staticPod();
				await podWorkers.updatePod(context.background(), {
					updateType: "create",
					startTime: new Date(1_000),
					pod,
				});
				await drainAllWorkers(podWorkers);
				expect(records.get(pod.metadata?.uid ?? "") ?? []).toEqual([
					{ name: "pod1", updateType: "create" },
				]);
			},
			wantWorker: (podWorkers, records) => {
				const uid = "1";
				expect(podWorkers.podSyncStatuses.size).toBe(1);
				const s = podWorkers.podSyncStatuses.get(uid);
				if (
					!s ||
					!isTerminationRequested(s) ||
					!isTerminationStarted(s) ||
					isFinished(s) ||
					isWorking(s) ||
					!isDeleted(s)
				) {
					throw new Error(`unexpected requested pod termination: ${JSON.stringify(s)}`);
				}
				expect(records.get(uid) ?? []).toEqual([
					{ name: "pod1", updateType: "create" },
					{ name: "pod1", updateType: "kill", gracePeriod: undefined },
				]);
			},
		},
		{
			name: "terminated pod is restarted in the same invocation that it is detected",
			pods: [
				(() => {
					const pod = staticPod();
					pod.metadata = { ...pod.metadata, annotations: { version: "2" } };
					return pod;
				})(),
			],
			prepareWorker: async (podWorkers) => {
				const pod = simplePod();
				await podWorkers.updatePod(context.background(), {
					updateType: "create",
					startTime: new Date(1_000),
					pod,
				});
				await drainAllWorkers(podWorkers);
				await podWorkers.updatePod(
					context.background(),
					newUpdatePodOptions({
						updateType: "kill",
						pod,
					}),
				);
				const pod2 = simplePod();
				pod2.metadata = { ...pod2.metadata, annotations: { version: "2" } };
				await podWorkers.updatePod(
					context.background(),
					newUpdatePodOptions({
						updateType: "create",
						pod: pod2,
					}),
				);
				await drainAllWorkers(podWorkers);
			},
			wantWorker: (podWorkers, records) => {
				const uid = "1";
				expect(podWorkers.podSyncStatuses.size).toBe(1);
				const s = podWorkers.podSyncStatuses.get(uid);
				if (
					!s ||
					isTerminationRequested(s) ||
					isTerminationStarted(s) ||
					isFinished(s) ||
					isWorking(s) ||
					isDeleted(s)
				) {
					throw new Error(`unexpected requested pod termination: ${JSON.stringify(s)}`);
				}
				if (
					s.pendingUpdate !== undefined ||
					s.activeUpdate?.pod === undefined ||
					s.activeUpdate.pod.metadata?.annotations?.version !== "2"
				) {
					throw new Error(`unexpected restarted pod: ${JSON.stringify(s.activeUpdate?.pod)}`);
				}
				expect(records.get(uid) ?? []).toEqual([
					{ name: "pod1", updateType: "create" },
					{ name: "pod1", updateType: "kill", gracePeriod: one },
					{ name: "pod1", terminated: true },
					{ name: "pod1", updateType: "create" },
				]);
			},
		},
	];

	it.each(tests)("$name", async (test) => {
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);
		const kl = testKubelet.kubelet;
		const [podWorkers, fakeRuntime, records] = createPodWorkers();
		kl.podWorkers = podWorkers;
		const originalPodSyncer = podWorkers.podSyncer;
		const syncFuncs = newPodSyncerFuncs(originalPodSyncer);
		podWorkers.podSyncer = syncFuncs;
		if (test.terminatingErr) {
			syncFuncs.syncTerminatingPod = async (ctx, pod, podStatus, gracePeriod, podStatusFunc) => {
				const err = await originalPodSyncer.syncTerminatingPod(
					ctx,
					pod,
					podStatus,
					gracePeriod,
					podStatusFunc,
				);
				if (err) {
					throw new Error(`unexpected error in syncTerminatingPodFn: ${err.message}`);
				}
				return test.terminatingErr;
			};
			syncFuncs.syncTerminatingRuntimePod = async (ctx, runningPod) => {
				const err = await originalPodSyncer.syncTerminatingRuntimePod(ctx, runningPod);
				if (err) {
					throw new Error(`unexpected error in syncTerminatingRuntimePodFn: ${err.message}`);
				}
				return test.terminatingErr;
			};
		}
		fakeRuntime.podList = test.runtimePods ?? [];
		testKubelet.fakeRuntime.podList = test.runtimePods ?? [];
		try {
			await test.prepareWorker?.(podWorkers, records);
			kl.podManager.setPods(test.pods ?? []);
			for (const reject of test.rejectedPods ?? []) {
				const pod = kl.podManager.getPodByUid(reject.uid);
				if (!pod) {
					throw new Error(`unable to reject pod by UID ${reject.uid}`);
				}
				await kl.rejectPod(tCtx, pod, reject.reason, reject.message);
			}

			const err = await kl.handlePodCleanups(tCtx);
			expect(err !== undefined).toBe(test.wantErr ?? false);
			await drainAllWorkers(podWorkers);
			await test.wantWorker?.(podWorkers, records);

			if (test.wantWorkerAfterRetry) {
				podWorkers.podSyncer = originalPodSyncer;
				const retryErr = await kl.handlePodCleanups(tCtx);
				expect(retryErr !== undefined).toBe(test.wantErr ?? false);
				await drainAllWorkers(podWorkers);
				test.wantWorkerAfterRetry(podWorkers, records);
			}
		} finally {
			await podWorkers.close();
			await testKubelet.cleanup();
		}
	});
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestConvertToAPIContainerStatuses.
browser.describe("convertToAPIContainerStatuses", () => {
	const desiredState = {
		nodeName: "machine",
		containers: [{ name: "containerA" }, { name: "containerB" }],
		restartPolicy: "Always" as const,
	};
	const now = new Date();

	const upstreamTestCases: ConvertToAPIContainerStatusesUpstreamTestCase[] = [
		{
			name: "no current status, with previous statuses and deletion",
			pod: {
				spec: desiredState,
				status: {
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
				metadata: { name: "my-pod", deletionTimestamp: now },
			},
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(),
				containerStatuses: [],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [runningState("containerA"), runningState("containerB")],
			containers: desiredState.containers,
			expected: [
				waitingWithLastTerminationUnknown("containerA", 0),
				waitingWithLastTerminationUnknown("containerB", 0),
			],
		},
		{
			name: "no current status, with previous statuses and no deletion",
			pod: {
				spec: desiredState,
				status: {
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
			},
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [runningState("containerA"), runningState("containerB")],
			containers: desiredState.containers,
			expected: [
				waitingWithLastTerminationUnknown("containerA", 1),
				waitingWithLastTerminationUnknown("containerB", 1),
			],
		},
		{
			name: "no current status, keeping previous restartCount",
			pod: { spec: desiredState },
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [
				withRestartCount(failedState("containerA"), 5),
				withRestartCount(failedState("containerB"), 5),
			],
			containers: desiredState.containers,
			expected: [
				withRestartCount(failedState("containerA"), 5),
				withRestartCount(failedState("containerB"), 5),
			],
		},
		{
			name: "currently running with lower restartCount; should keeping previous restartCount",
			pod: { spec: desiredState },
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [
					runtimeStatus("containerA", {
						id: new ContainerID("", "containerA"),
						state: "Running",
						restartCount: 0,
					}),
					runtimeStatus("containerB", {
						id: new ContainerID("", "containerB"),
						state: "Running",
						restartCount: 0,
					}),
				],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [
				withRestartCount(failedState("containerA"), 5),
				withRestartCount(failedState("containerB"), 5),
			],
			containers: desiredState.containers,
			expected: [
				withRestartCount(
					withLastTerminationState(runningState("containerA"), {
						terminated: { exitCode: -1 },
					}),
					6,
				),
				withRestartCount(
					withLastTerminationState(runningState("containerB"), {
						terminated: { exitCode: -1 },
					}),
					6,
				),
			],
		},
		{
			name: "containerB dies and triggers RestartAllContainers in place",
			pod: { spec: desiredState },
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [
					runtimeStatus("containerA", { state: "Running" }),
					runtimeStatus("containerB", { state: "Exited", exitCode: 42 }),
				],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [runningState("containerA"), runningState("containerB")],
			containers: desiredState.containers,
			podRestarting: true,
			expected: [runningState("containerA"), failedStateWithExitCode("containerB", 42)],
		},
		{
			name: "containerB dies and triggers RestartAllContainers in place, containerA killed",
			pod: { spec: desiredState },
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [runtimeStatus("containerA", { state: "Exited", exitCode: 137 })],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [runningState("containerA"), failedStateWithExitCode("containerB", 42)],
			containers: desiredState.containers,
			podRestarting: true,
			expected: [
				failedStateWithExitCode("containerA", 137),
				withRestartCount(waitingStateWithRestartingAllContainers("containerB"), 1),
			],
		},
		{
			name: "containerB dies and triggers RestartAllContainers in place, containerA killed then removed",
			pod: { spec: desiredState },
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [
				failedStateWithExitCode("containerA", 137),
				failedStateWithExitCode("containerB", 42),
			],
			containers: desiredState.containers,
			podRestarting: true,
			expected: [
				withRestartCount(waitingStateWithRestartingAllContainers("containerA"), 1),
				withRestartCount(waitingStateWithRestartingAllContainers("containerB"), 1),
			],
		},
		{
			name: "containerB dies and triggers RestartAllContainers in place, containerA killed and removed together",
			pod: { spec: desiredState },
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [runningState("containerA"), failedStateWithExitCode("containerB", 42)],
			containers: desiredState.containers,
			podRestarting: true,
			expected: [
				withRestartCount(waitingStateWithRestartingAllContainers("containerA"), 1),
				withRestartCount(waitingStateWithRestartingAllContainers("containerB"), 1),
			],
		},
		{
			name: "containerB dies and triggers RestartAllContainers in place, containerA rerun",
			pod: { spec: desiredState },
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [
					runtimeStatus("containerA", {
						id: new ContainerID("", "containerA-new"),
						state: "Running",
					}),
				],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [
				withRestartCount(waitingStateWithRestartingAllContainers("containerA"), 1),
				failedStateWithExitCode("containerB", 42),
			],
			containers: desiredState.containers,
			podRestarting: true,
			expected: [
				withRestartCount(
					withLastTerminationState(runningState("containerA"), {
						terminated: {
							reason: "RestartingAllContainers",
							message: "The container is removed because RestartAllContainers in place",
							exitCode: 137,
						},
					}),
					1,
				),
				withRestartCount(waitingStateWithRestartingAllContainers("containerB"), 1),
			],
		},
		{
			name: "containerB dies and triggers RestartAllContainers in place, containerA succeeded",
			pod: { spec: desiredState },
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [runtimeStatus("containerA", { state: "Exited", exitCode: 0 })],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [
				withRestartCount(runningState("containerA"), 1),
				failedStateWithExitCode("containerB", 42),
			],
			containers: desiredState.containers,
			podRestarting: true,
			expected: [
				withRestartCount(succeededState("containerA"), 1),
				withRestartCount(waitingStateWithRestartingAllContainers("containerB"), 1),
			],
		},
		{
			name: "containerB dies and triggers RestartAllContainers in place, containerA failed",
			pod: { spec: desiredState },
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [runtimeStatus("containerA", { state: "Exited", exitCode: 1 })],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [
				withRestartCount(runningState("containerA"), 1),
				failedStateWithExitCode("containerB", 42),
			],
			containers: desiredState.containers,
			podRestarting: true,
			expected: [
				withRestartCount(failedStateWithExitCode("containerA", 1), 1),
				withRestartCount(waitingStateWithRestartingAllContainers("containerB"), 1),
			],
		},
	];

	it.each(upstreamTestCases)("$name", async (tc) => {
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);
		try {
			const containerStatuses = testKubelet.kubelet.convertToAPIContainerStatuses(
				tCtx,
				tc.pod,
				tc.currentStatus,
				tc.previousStatus,
				tc.containers,
				undefined,
				tc.hasInitContainers ?? false,
				tc.isInitContainer ?? false,
				tc.podRestarting ?? false,
			);
			for (const status of containerStatuses) {
				delete status.containerID;
				delete status.resources;
				if (status.state?.terminated) {
					delete status.state.terminated.containerID;
				}
			}

			expect(containerStatuses).toEqual(tc.expected);
		} finally {
			await testKubelet.cleanup();
		}
	});

	it("throws when image volume status conversion is requested", async () => {
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);
		try {
			expect(() =>
				testKubelet.kubelet.convertToAPIContainerStatuses(
					tCtx,
					{ spec: desiredState },
					{
						id: "",
						name: "",
						namespace: "",
						timestamp: new Date(0),
						containerStatuses: [],
						sandboxStatuses: [],
						ips: [],
					},
					[],
					desiredState.containers,
					new Set(["image-volume"]),
					false,
					false,
					false,
				),
			).toThrow("image volume status conversion is not implemented");
		} finally {
			await testKubelet.cleanup();
		}
	});
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestConvertToAPIContainerStatusesForResources.
browser.describe("convertToAPIContainerStatusesForResources", () => {
	const nowTime = new Date();
	const testContainerName = "ctr0";
	const testContainerID = buildContainerID("test", testContainerName);
	const testContainer: V1Container = {
		name: testContainerName,
		image: "img",
	};
	const testContainerStatus: V1ContainerStatus = {
		name: testContainerName,
		image: "",
		imageID: "",
		ready: false,
		restartCount: 0,
	};
	const testPod: V1Pod = {
		metadata: {
			uid: "123456",
			name: "foo",
			namespace: "bar",
		},
		spec: {
			containers: [testContainer],
		},
		status: {
			containerStatuses: [testContainerStatus],
		},
	};
	const testPodStatus = (state: ContainerRuntimeStatus["state"]): PodRuntimeStatus => {
		const cStatus = runtimeStatus(testContainerName, {
			id: testContainerID,
			image: "img",
			imageID: "1234",
			imageRef: "img1234",
			state,
			startedAt: state === "Running" || state === "Exited" ? nowTime.getTime() : undefined,
			finishedAt: state === "Exited" ? nowTime.getTime() : undefined,
		});
		return {
			id: testPod.metadata?.uid ?? "",
			name: testPod.metadata?.name ?? "",
			namespace: testPod.metadata?.namespace ?? "",
			timestamp: new Date(0),
			containerStatuses: [cStatus],
			sandboxStatuses: [],
			ips: [],
		};
	};

	const testCases: Array<{
		tdesc: string;
		state?: ContainerRuntimeStatus["state"];
		oldStatus: V1ContainerStatus;
		expected: V1ContainerStatus;
	}> = [
		// Upstream also asserts AllocatedResources in this table. The simulator
		// does not model kubelet container resource allocation, so these cases
		// preserve the upstream status-transition, ImageID/ImageRef, and zero-value
		// Resources shape while omitting allocation expectations.
		{
			tdesc: "BestEffortQoSPod",
			oldStatus: {
				name: testContainerName,
				image: "img",
				imageID: "img1234",
				ready: false,
				restartCount: 0,
				state: { running: {} },
				resources: {},
			},
			expected: {
				name: testContainerName,
				containerID: testContainerID.toString(),
				image: "img",
				imageID: "img1234",
				ready: false,
				restartCount: 0,
				resources: {},
				state: { running: { startedAt: nowTime } },
			},
		},
		{
			tdesc: "newly created Pod",
			state: "Created",
			oldStatus: {
				name: "",
				image: "",
				imageID: "",
				ready: false,
				restartCount: 0,
			},
			expected: {
				name: testContainerName,
				containerID: testContainerID.toString(),
				image: "img",
				imageID: "img1234",
				ready: false,
				restartCount: 0,
				resources: {},
				state: { waiting: {} },
			},
		},
		{
			tdesc: "newly running Pod",
			oldStatus: {
				name: testContainerName,
				image: "img",
				imageID: "img1234",
				ready: false,
				restartCount: 0,
				state: { waiting: {} },
			},
			expected: {
				name: testContainerName,
				containerID: testContainerID.toString(),
				image: "img",
				imageID: "img1234",
				ready: false,
				restartCount: 0,
				resources: {},
				state: { running: { startedAt: nowTime } },
			},
		},
		{
			tdesc: "newly terminated Pod",
			state: "Exited",
			oldStatus: {
				name: testContainerName,
				image: "img",
				imageID: "img1234",
				ready: false,
				restartCount: 0,
				state: { running: {} },
				resources: {},
			},
			expected: {
				name: testContainerName,
				containerID: testContainerID.toString(),
				image: "img",
				imageID: "img1234",
				ready: false,
				restartCount: 0,
				resources: {},
				state: {
					terminated: {
						containerID: testContainerID.toString(),
						exitCode: 0,
						startedAt: nowTime,
						finishedAt: nowTime,
					},
				},
			},
		},
	];

	it.each(testCases)("$tdesc", async ({ state, oldStatus, expected }) => {
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);

		try {
			const cStatuses = testKubelet.kubelet.convertToAPIContainerStatuses(
				tCtx,
				testPod,
				testPodStatus(state ?? "Running"),
				[oldStatus],
				testPod.spec?.containers ?? [testContainer],
				undefined,
				false,
				false,
				false,
			);

			expect(cStatuses[0]).toEqual(expected);
		} finally {
			await testKubelet.cleanup();
		}
	});
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go Test_generateAPIPodStatus.
browser.describe("generateAPIPodStatus", () => {
	const now = new Date("2026-01-02T03:04:05.000Z");
	const desiredState = {
		nodeName: "machine",
		containers: [{ name: "containerA" }, { name: "containerB" }],
		restartPolicy: "Always" as const,
	};
	const sandboxReadyStatus: PodRuntimeStatus = {
		id: "",
		name: "",
		namespace: "",
		ips: [],
		containerStatuses: [],
		sandboxStatuses: [
			{
				network: { ip: "10.0.0.10" },
				metadata: {
					name: "",
					namespace: "",
					uid: "",
					attempt: 0,
				},
				state: "Ready",
				id: "",
				createdAt: 0,
				labels: {},
				annotations: {},
			},
		],
		timestamp: new Date(0),
	};
	const tests: Array<{
		name: string;
		pod: V1Pod;
		currentStatus: PodRuntimeStatus;
		unreadyContainer?: string[];
		previousStatus: V1PodStatus;
		isPodTerminal?: boolean;
		expected: V1PodStatus;
		expectedPodDisruptionCondition?: V1PodCondition;
		expectedPodReadyToStartContainersCondition: V1PodCondition;
	}> = [
		{
			name: "pod disruption condition is copied over and the phase is set to failed when deleted",
			pod: {
				metadata: { uid: "123456", name: "my-pod", deletionTimestamp: now },
				spec: desiredState,
				status: {
					containerStatuses: [runningState("containerA"), runningState("containerB")],
					conditions: [
						{
							type: "DisruptionTarget",
							status: "True",
							lastTransitionTime: now,
						},
					],
				},
			},
			currentStatus: sandboxReadyStatus,
			previousStatus: {
				containerStatuses: [runningState("containerA"), runningState("containerB")],
				conditions: [
					{
						type: "DisruptionTarget",
						status: "True",
						lastTransitionTime: now,
					},
				],
			},
			isPodTerminal: true,
			expected: {
				phase: "Failed",
				hostIP: "127.0.0.1",
				hostIPs: [{ ip: "127.0.0.1" }, { ip: "::1" }],
				qosClass: "BestEffort",
				conditions: [
					{ type: "Initialized", observedGeneration: 0, status: "True" },
					{ type: "Ready", observedGeneration: 0, status: "False", reason: "PodFailed" },
					{
						type: "ContainersReady",
						observedGeneration: 0,
						status: "False",
						reason: "PodFailed",
					},
					{ type: "PodScheduled", observedGeneration: 0, status: "True" },
				],
				containerStatuses: [
					ready(waitingWithLastTerminationUnknown("containerA", 0)),
					ready(waitingWithLastTerminationUnknown("containerB", 0)),
				],
			},
			expectedPodDisruptionCondition: {
				type: "DisruptionTarget",
				status: "True",
				lastTransitionTime: now,
			},
			expectedPodReadyToStartContainersCondition: {
				type: "PodReadyToStartContainers",
				observedGeneration: 0,
				status: "True",
			},
		},
		{
			name: "current status ready, with previous statuses and deletion",
			pod: {
				metadata: { uid: "123456", name: "my-pod", deletionTimestamp: now },
				spec: desiredState,
				status: {
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
			},
			currentStatus: sandboxReadyStatus,
			previousStatus: {
				containerStatuses: [runningState("containerA"), runningState("containerB")],
			},
			expected: {
				phase: "Running",
				hostIP: "127.0.0.1",
				hostIPs: [{ ip: "127.0.0.1" }, { ip: "::1" }],
				qosClass: "BestEffort",
				conditions: [
					{ type: "Initialized", observedGeneration: 0, status: "True" },
					{ type: "Ready", observedGeneration: 0, status: "True" },
					{ type: "ContainersReady", observedGeneration: 0, status: "True" },
					{ type: "PodScheduled", observedGeneration: 0, status: "True" },
				],
				containerStatuses: [
					ready(waitingWithLastTerminationUnknown("containerA", 0)),
					ready(waitingWithLastTerminationUnknown("containerB", 0)),
				],
			},
			expectedPodReadyToStartContainersCondition: {
				type: "PodReadyToStartContainers",
				observedGeneration: 0,
				status: "True",
			},
		},
		{
			name: "current status ready, with previous statuses and no deletion",
			pod: {
				metadata: { uid: "123456", name: "my-pod" },
				spec: desiredState,
				status: {
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
			},
			currentStatus: sandboxReadyStatus,
			previousStatus: {
				containerStatuses: [runningState("containerA"), runningState("containerB")],
			},
			expected: {
				phase: "Running",
				hostIP: "127.0.0.1",
				hostIPs: [{ ip: "127.0.0.1" }, { ip: "::1" }],
				qosClass: "BestEffort",
				conditions: [
					{ type: "Initialized", observedGeneration: 0, status: "True" },
					{ type: "Ready", observedGeneration: 0, status: "True" },
					{ type: "ContainersReady", observedGeneration: 0, status: "True" },
					{ type: "PodScheduled", observedGeneration: 0, status: "True" },
				],
				containerStatuses: [
					ready(waitingWithLastTerminationUnknown("containerA", 1)),
					ready(waitingWithLastTerminationUnknown("containerB", 1)),
				],
			},
			expectedPodReadyToStartContainersCondition: {
				type: "PodReadyToStartContainers",
				observedGeneration: 0,
				status: "True",
			},
		},
		{
			name: "terminal phase cannot be changed (apiserver previous is succeeded)",
			pod: {
				metadata: { uid: "123456", name: "my-pod" },
				spec: desiredState,
				status: {
					phase: "Succeeded",
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
			},
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				ips: [],
				containerStatuses: [],
				sandboxStatuses: [],
				timestamp: new Date(0),
			},
			previousStatus: {
				containerStatuses: [runningState("containerA"), runningState("containerB")],
			},
			expected: {
				phase: "Succeeded",
				hostIP: "127.0.0.1",
				hostIPs: [{ ip: "127.0.0.1" }, { ip: "::1" }],
				qosClass: "BestEffort",
				conditions: [
					{
						type: "Initialized",
						observedGeneration: 0,
						status: "True",
						reason: "PodCompleted",
					},
					{
						type: "Ready",
						observedGeneration: 0,
						status: "False",
						reason: "PodCompleted",
					},
					{
						type: "ContainersReady",
						observedGeneration: 0,
						status: "False",
						reason: "PodCompleted",
					},
					{ type: "PodScheduled", observedGeneration: 0, status: "True" },
				],
				containerStatuses: [
					ready(waitingWithLastTerminationUnknown("containerA", 1)),
					ready(waitingWithLastTerminationUnknown("containerB", 1)),
				],
			},
			expectedPodReadyToStartContainersCondition: {
				type: "PodReadyToStartContainers",
				observedGeneration: 0,
				status: "False",
			},
		},
		{
			name: "terminal phase from previous status must remain terminal, restartAlways",
			pod: {
				metadata: { uid: "123456", name: "my-pod" },
				spec: desiredState,
				status: {
					phase: "Running",
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
			},
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				ips: [],
				containerStatuses: [],
				sandboxStatuses: [],
				timestamp: new Date(0),
			},
			previousStatus: {
				phase: "Succeeded",
				containerStatuses: [runningState("containerA"), runningState("containerB")],
				// Reason and message should be preserved
				reason: "Test",
				message: "test",
			},
			expected: {
				phase: "Succeeded",
				reason: "Test",
				message: "test",
				hostIP: "127.0.0.1",
				hostIPs: [{ ip: "127.0.0.1" }, { ip: "::1" }],
				qosClass: "BestEffort",
				conditions: [
					{
						type: "Initialized",
						observedGeneration: 0,
						status: "True",
						reason: "PodCompleted",
					},
					{
						type: "Ready",
						observedGeneration: 0,
						status: "False",
						reason: "PodCompleted",
					},
					{
						type: "ContainersReady",
						observedGeneration: 0,
						status: "False",
						reason: "PodCompleted",
					},
					{ type: "PodScheduled", observedGeneration: 0, status: "True" },
				],
				containerStatuses: [
					ready(waitingWithLastTerminationUnknown("containerA", 1)),
					ready(waitingWithLastTerminationUnknown("containerB", 1)),
				],
			},
			expectedPodReadyToStartContainersCondition: {
				type: "PodReadyToStartContainers",
				observedGeneration: 0,
				status: "False",
			},
		},
		{
			name: "terminal phase from previous status must remain terminal, restartNever",
			pod: {
				metadata: { uid: "123456", name: "my-pod" },
				spec: {
					nodeName: "machine",
					containers: [{ name: "containerA" }, { name: "containerB" }],
					restartPolicy: "Never",
				},
				status: {
					phase: "Running",
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
			},
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				ips: [],
				containerStatuses: [],
				sandboxStatuses: [],
				timestamp: new Date(0),
			},
			previousStatus: {
				phase: "Succeeded",
				containerStatuses: [succeededState("containerA"), succeededState("containerB")],
				// Reason and message should be preserved
				reason: "Test",
				message: "test",
			},
			expected: {
				phase: "Succeeded",
				reason: "Test",
				message: "test",
				hostIP: "127.0.0.1",
				hostIPs: [{ ip: "127.0.0.1" }, { ip: "::1" }],
				qosClass: "BestEffort",
				conditions: [
					{
						type: "Initialized",
						observedGeneration: 0,
						status: "True",
						reason: "PodCompleted",
					},
					{
						type: "Ready",
						observedGeneration: 0,
						status: "False",
						reason: "PodCompleted",
					},
					{
						type: "ContainersReady",
						observedGeneration: 0,
						status: "False",
						reason: "PodCompleted",
					},
					{ type: "PodScheduled", observedGeneration: 0, status: "True" },
				],
				containerStatuses: [
					ready(succeededState("containerA")),
					ready(succeededState("containerB")),
				],
			},
			expectedPodReadyToStartContainersCondition: {
				type: "PodReadyToStartContainers",
				observedGeneration: 0,
				status: "False",
			},
		},
		{
			name: "running can revert to pending",
			pod: {
				metadata: { uid: "123456", name: "my-pod" },
				spec: desiredState,
				status: {
					phase: "Running",
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
			},
			currentStatus: sandboxReadyStatus,
			previousStatus: {
				containerStatuses: [waitingState("containerA"), waitingState("containerB")],
			},
			expected: {
				phase: "Pending",
				hostIP: "127.0.0.1",
				hostIPs: [{ ip: "127.0.0.1" }, { ip: "::1" }],
				qosClass: "BestEffort",
				conditions: [
					{ type: "Initialized", observedGeneration: 0, status: "True" },
					{ type: "Ready", observedGeneration: 0, status: "True" },
					{ type: "ContainersReady", observedGeneration: 0, status: "True" },
					{ type: "PodScheduled", observedGeneration: 0, status: "True" },
				],
				containerStatuses: [
					ready(waitingStateWithReason("containerA", "ContainerCreating")),
					ready(waitingStateWithReason("containerB", "ContainerCreating")),
				],
			},
			expectedPodReadyToStartContainersCondition: {
				type: "PodReadyToStartContainers",
				observedGeneration: 0,
				status: "True",
			},
		},
		{
			name: "reason and message are preserved when phase doesn't change",
			pod: {
				metadata: { uid: "123456", name: "my-pod" },
				spec: desiredState,
				status: {
					phase: "Running",
					containerStatuses: [waitingState("containerA"), waitingState("containerB")],
				},
			},
			currentStatus: {
				...sandboxReadyStatus,
				containerStatuses: [
					runtimeStatus("containerB", {
						id: new ContainerID("", "foo"),
						startedAt: 1000,
						state: "Running",
					}),
				],
			},
			previousStatus: {
				phase: "Pending",
				reason: "Test",
				message: "test",
				containerStatuses: [waitingState("containerA"), runningState("containerB")],
			},
			expected: {
				phase: "Pending",
				reason: "Test",
				message: "test",
				hostIP: "127.0.0.1",
				hostIPs: [{ ip: "127.0.0.1" }, { ip: "::1" }],
				qosClass: "BestEffort",
				conditions: [
					{ type: "Initialized", observedGeneration: 0, status: "True" },
					{ type: "Ready", observedGeneration: 0, status: "True" },
					{ type: "ContainersReady", observedGeneration: 0, status: "True" },
					{ type: "PodScheduled", observedGeneration: 0, status: "True" },
				],
				containerStatuses: [
					ready(waitingStateWithReason("containerA", "ContainerCreating")),
					withResources(
						ready(withID(runningStateWithStartedAt("containerB", new Date(1000)), "://foo")),
					),
				],
			},
			expectedPodReadyToStartContainersCondition: {
				type: "PodReadyToStartContainers",
				observedGeneration: 0,
				status: "True",
			},
		},
		{
			name: "reason and message are cleared when phase changes",
			pod: {
				metadata: { uid: "123456", name: "my-pod" },
				spec: desiredState,
				status: {
					phase: "Pending",
					containerStatuses: [waitingState("containerA"), waitingState("containerB")],
				},
			},
			currentStatus: {
				...sandboxReadyStatus,
				containerStatuses: [
					runtimeStatus("containerA", {
						id: new ContainerID("", "c1"),
						startedAt: 1000,
						state: "Running",
					}),
					runtimeStatus("containerB", {
						id: new ContainerID("", "c2"),
						startedAt: 2000,
						state: "Running",
					}),
				],
			},
			previousStatus: {
				phase: "Pending",
				reason: "Test",
				message: "test",
				containerStatuses: [runningState("containerA"), runningState("containerB")],
			},
			expected: {
				phase: "Running",
				hostIP: "127.0.0.1",
				hostIPs: [{ ip: "127.0.0.1" }, { ip: "::1" }],
				qosClass: "BestEffort",
				conditions: [
					{ type: "Initialized", observedGeneration: 0, status: "True" },
					{ type: "Ready", observedGeneration: 0, status: "True" },
					{ type: "ContainersReady", observedGeneration: 0, status: "True" },
					{ type: "PodScheduled", observedGeneration: 0, status: "True" },
				],
				containerStatuses: [
					withResources(
						ready(withID(runningStateWithStartedAt("containerA", new Date(1000)), "://c1")),
					),
					withResources(
						ready(withID(runningStateWithStartedAt("containerB", new Date(2000)), "://c2")),
					),
				],
			},
			expectedPodReadyToStartContainersCondition: {
				type: "PodReadyToStartContainers",
				observedGeneration: 0,
				status: "True",
			},
		},
	];

	it.each(tests)("$name", async (test) => {
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);
		try {
			const kl = testKubelet.kubelet;
			await kl.statusManager.setPodStatus(test.pod, test.previousStatus);
			for (const name of test.unreadyContainer ?? []) {
				const containerStatus = findAPIContainerStatusByName(test.expected, name);
				if (!containerStatus) {
					throw new Error(`container status ${name} not found`);
				}
				await kl.readinessManager.set(
					buildContainerID("", containerStatus.containerID ?? ""),
					"failure",
					test.pod,
				);
			}
			const actual = kl.generateAPIPodStatus(
				tCtx,
				test.pod,
				test.currentStatus,
				test.isPodTerminal ?? false,
			);
			const expected = structuredClone(test.expected);
			expected.conditions = [
				test.expectedPodReadyToStartContainersCondition,
				...(expected.conditions ?? []),
			];
			if (test.expectedPodDisruptionCondition) {
				expected.conditions = [test.expectedPodDisruptionCondition, ...expected.conditions];
			}

			expect(
				stripUndefined({
					phase: actual.phase,
					reason: actual.reason,
					message: actual.message,
					hostIP: actual.hostIP,
					hostIPs: actual.hostIPs,
					qosClass: actual.qosClass,
					conditions: actual.conditions,
					containerStatuses: actual.containerStatuses,
				}),
			).toEqual(expected);
		} finally {
			await testKubelet.cleanup();
		}
	});

	// Simulator only test
	it("does not copy unrelated fields from the old pod status", async () => {
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);
		try {
			const pod: V1Pod = {
				metadata: { uid: "123456", name: "my-pod" },
				spec: { containers: [{ name: "containerA" }] },
			};
			await testKubelet.kubelet.statusManager.setPodStatus(pod, {
				containerStatuses: [runningState("containerA")],
				startTime: now,
				nominatedNodeName: "old-node",
			});

			const actual = testKubelet.kubelet.generateAPIPodStatus(
				tCtx,
				pod,
				{
					...sandboxReadyStatus,
					ips: ["10.0.0.1"],
				},
				false,
			);

			expect(actual.podIP).toBe("10.0.0.1");
			expect(actual.podIPs).toEqual([{ ip: "10.0.0.1" }]);
			expect(actual.startTime).toBeUndefined();
			expect(actual.nominatedNodeName).toBeUndefined();
		} finally {
			await testKubelet.cleanup();
		}
	});
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestGenerateAPIPodStatusPodIPs.
browser.describe("generateAPIPodStatusPodIPs", () => {
	const tests: Array<{
		name: string;
		nodeIP: string;
		criPodIPs: string[];
		podIPs: Array<{ ip: string }>;
	}> = [
		{
			name: "Simple",
			nodeIP: "",
			criPodIPs: ["10.0.0.1"],
			podIPs: [{ ip: "10.0.0.1" }],
		},
		{
			name: "Dual-stack",
			nodeIP: "",
			criPodIPs: ["10.0.0.1", "fd01::1234"],
			podIPs: [{ ip: "10.0.0.1" }, { ip: "fd01::1234" }],
		},
		{
			name: "Dual-stack with explicit node IP",
			nodeIP: "192.168.1.1",
			criPodIPs: ["10.0.0.1", "fd01::1234"],
			podIPs: [{ ip: "10.0.0.1" }, { ip: "fd01::1234" }],
		},
		{
			name: "Dual-stack with CRI returning wrong family first",
			nodeIP: "",
			criPodIPs: ["fd01::1234", "10.0.0.1"],
			podIPs: [{ ip: "10.0.0.1" }, { ip: "fd01::1234" }],
		},
		{
			name: "Dual-stack with explicit node IP with CRI returning wrong family first",
			nodeIP: "192.168.1.1",
			criPodIPs: ["fd01::1234", "10.0.0.1"],
			podIPs: [{ ip: "10.0.0.1" }, { ip: "fd01::1234" }],
		},
		{
			name: "Dual-stack with IPv6 node IP",
			nodeIP: "fd00::5678",
			criPodIPs: ["10.0.0.1", "fd01::1234"],
			podIPs: [{ ip: "fd01::1234" }, { ip: "10.0.0.1" }],
		},
		{
			name: "Dual-stack with IPv6 node IP, other CRI order",
			nodeIP: "fd00::5678",
			criPodIPs: ["fd01::1234", "10.0.0.1"],
			podIPs: [{ ip: "fd01::1234" }, { ip: "10.0.0.1" }],
		},
		{
			name: "No Pod IP matching Node IP",
			nodeIP: "fd00::5678",
			criPodIPs: ["10.0.0.1"],
			podIPs: [{ ip: "10.0.0.1" }],
		},
		{
			name: "No Pod IP matching (unspecified) Node IP",
			nodeIP: "",
			criPodIPs: ["fd01::1234"],
			podIPs: [{ ip: "fd01::1234" }],
		},
		{
			name: "Multiple IPv4 IPs",
			nodeIP: "",
			criPodIPs: ["10.0.0.1", "10.0.0.2", "10.0.0.3"],
			podIPs: [{ ip: "10.0.0.1" }],
		},
		{
			name: "Multiple Dual-Stack IPs",
			nodeIP: "",
			criPodIPs: ["10.0.0.1", "10.0.0.2", "fd01::1234", "10.0.0.3", "fd01::5678"],
			podIPs: [{ ip: "10.0.0.1" }, { ip: "fd01::1234" }],
		},
	];

	it.each(tests)("$name", async (test) => {
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);
		try {
			const kl = testKubelet.kubelet;
			if (test.nodeIP !== "") {
				kl.nodeIPs = [test.nodeIP];
			}
			const pod = podWithUIDNameNs("12345", "test-pod", "test-namespace");
			const status = kl.generateAPIPodStatus(
				tCtx,
				pod,
				{
					id: pod.metadata?.uid ?? "",
					name: pod.metadata?.name ?? "",
					namespace: pod.metadata?.namespace ?? "",
					ips: test.criPodIPs,
					containerStatuses: [],
					sandboxStatuses: [],
					timestamp: new Date(0),
				},
				false,
			);

			expect(status.podIPs).toEqual(test.podIPs);
			expect(status.podIP).toBe(status.podIPs?.[0]?.ip);
		} finally {
			await testKubelet.cleanup();
		}
	});
});
