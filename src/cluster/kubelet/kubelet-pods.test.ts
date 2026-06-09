/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// oxlint-disable jest/no-standalone-expect
// oxlint-disable jest/no-conditional-expect
// oxlint-disable typescript-eslint/no-non-null-assertion
import { expect, it } from "vitest";
import { newFakeRecorder } from "../../client-go/tools/record/fake";
import { newContainerStatus } from "../../client";
import { Set as LabelSet } from "../../apimachinery/pkg/labels/labels";
import type { Selector } from "../../apimachinery/pkg/labels/selector";
import type {
	V1Container,
	V1ContainerStatus,
	V1NodeAddress,
	V1Pod,
	V1PodCondition,
	V1PodStatus,
	V1Service,
} from "../../client";
import * as context from "../../go/context";
import { browser } from "../../test/describe";
import { ClusterNetwork } from "../cni";
import {
	buildContainerID,
	ContainerID,
	type EnvVar,
	newContainer,
	newContainerID,
	newPod,
	type Pod as RuntimePod,
	type PodStatus as PodRuntimeStatus,
	type Status as ContainerRuntimeStatus,
} from "./container";
import { FakeContainerCommandRunner, newFakePod, type FakePod } from "./container/testing";
import {
	createPodWorkers,
	drainAllWorkers,
	newTestKubelet,
	podWithUIDNameNs,
	type syncPodRecord,
} from "./kubelet-test-helpers";
import { getPhase, truncatePodHostnameIfNeeded } from "./kubelet-pods";
import type { ServiceLister } from "./kubelet";
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
import { ProbeManagerImpl, ResultsManager } from "./prober";
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

function waitingStateWithRestartingAllContainers(cName: string): V1ContainerStatus {
	return newContainerStatus({
		name: cName,
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
	});
}

function runningState(cName: string): V1ContainerStatus {
	return newContainerStatus({
		name: cName,
		state: { running: {} },
	});
}

function succeededState(cName: string): V1ContainerStatus {
	return newContainerStatus({
		name: cName,
		state: { terminated: { exitCode: 0 } },
	});
}

function failedState(cName: string): V1ContainerStatus {
	return newContainerStatus({
		name: cName,
		state: { terminated: { exitCode: -1 } },
	});
}

function failedStateWithExitCode(cName: string, exitCode: number): V1ContainerStatus {
	return newContainerStatus({
		name: cName,
		state: { terminated: { exitCode } },
	});
}

function waitingWithLastTerminationUnknown(cName: string, restartCount: number): V1ContainerStatus {
	return newContainerStatus({
		name: cName,
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
	});
}

function waitingState(cName: string): V1ContainerStatus {
	return waitingStateWithReason(cName, "");
}

function waitingStateWithReason(cName: string, reason: string): V1ContainerStatus {
	return newContainerStatus({
		name: cName,
		state: { waiting: { reason } },
	});
}

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go waitingStateWithLastTermination.
function waitingStateWithLastTermination(cName: string): V1ContainerStatus {
	return newContainerStatus({
		name: cName,
		state: { waiting: {} },
		lastState: {
			terminated: {
				exitCode: 0,
			},
		},
	});
}

function waitingStateWithNonZeroTermination(cName: string): V1ContainerStatus {
	return newContainerStatus({
		name: cName,
		state: { waiting: {} },
		lastState: {
			terminated: {
				exitCode: 1,
			},
		},
	});
}

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go stoppedState.
function stoppedState(cName: string): V1ContainerStatus {
	return newContainerStatus({
		name: cName,
		state: { terminated: { exitCode: 0 } },
	});
}

function startedState(cName: string): V1ContainerStatus {
	return newContainerStatus({
		name: cName,
		started: true,
		state: { running: {} },
	});
}

function runningStateWithStartedAt(cName: string, startedAt: Date): V1ContainerStatus {
	return newContainerStatus({
		name: cName,
		state: { running: { startedAt } },
	});
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

function withStarted(status: V1ContainerStatus, started: boolean): V1ContainerStatus {
	return {
		...status,
		started,
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
		user: options.user,
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

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go buildService.
function buildService(
	name: string,
	namespace: string,
	clusterIP: string,
	protocol: string,
	port: number,
): V1Service {
	return {
		metadata: { name, namespace },
		spec: {
			ports: [
				{
					protocol,
					port,
				},
			],
			clusterIP,
		},
	};
}

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go testServiceLister.
class testServiceLister implements ServiceLister {
	constructor(private readonly services: V1Service[] = []) {}

	async list(selector: Selector): Promise<[services: V1Service[], err: Error | undefined]> {
		return [
			this.services.filter((service) => selector.matches(new LabelSet(service.metadata?.labels))),
			undefined,
		];
	}
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

interface PodPhaseTestCase {
	pod: V1Pod;
	podIsTerminal?: boolean;
	status: NonNullable<V1PodStatus["phase"]>;
	test: string;
}

function podPhaseStatus(
	containerStatuses: V1ContainerStatus[] = [],
): Pick<V1PodStatus, "containerStatuses"> {
	return { containerStatuses };
}

function podPhaseInfo(pod: V1Pod): V1ContainerStatus[] {
	return [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
}

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestPodPhaseWithRestartAlways.
browser.describe("podPhaseWithRestartAlways", () => {
	const desiredState = {
		nodeName: "machine",
		containers: [{ name: "containerA" }, { name: "containerB" }],
		restartPolicy: "Always" as const,
	};

	const tests: PodPhaseTestCase[] = [
		{
			pod: { spec: desiredState, status: {} },
			podIsTerminal: false,
			status: "Pending",
			test: "waiting",
		},
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([runningState("containerA"), runningState("containerB")]),
			},
			podIsTerminal: false,
			status: "Running",
			test: "all running",
		},
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([stoppedState("containerA"), stoppedState("containerB")]),
			},
			podIsTerminal: false,
			status: "Running",
			test: "all stopped with restart always",
		},
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([succeededState("containerA"), succeededState("containerB")]),
			},
			podIsTerminal: true,
			status: "Succeeded",
			test: "all succeeded with restart always, but the pod is terminal",
		},
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([succeededState("containerA"), failedState("containerB")]),
			},
			podIsTerminal: true,
			status: "Failed",
			test: "all stopped with restart always, but the pod is terminal",
		},
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([runningState("containerA"), stoppedState("containerB")]),
			},
			podIsTerminal: false,
			status: "Running",
			test: "mixed state #1 with restart always",
		},
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([runningState("containerA")]),
			},
			podIsTerminal: false,
			status: "Pending",
			test: "mixed state #2 with restart always",
		},
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([runningState("containerA"), waitingState("containerB")]),
			},
			podIsTerminal: false,
			status: "Pending",
			test: "mixed state #3 with restart always",
		},
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([
					runningState("containerA"),
					waitingStateWithLastTermination("containerB"),
				]),
			},
			podIsTerminal: false,
			status: "Running",
			test: "backoff crashloop container with restart always",
		},
	];

	it.each(tests)("$test", (test) => {
		const status = getPhase(
			test.pod,
			test.pod.status?.containerStatuses ?? [],
			test.podIsTerminal ?? false,
			false,
		);
		expect(status).toBe(test.status);
	});
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestPodPhaseWithRestartAlwaysInitContainers.
browser.describe("podPhaseWithRestartAlwaysInitContainers", () => {
	const desiredState = {
		nodeName: "machine",
		initContainers: [{ name: "containerX" }],
		containers: [{ name: "containerA" }, { name: "containerB" }],
		restartPolicy: "Always" as const,
	};

	const tests: PodPhaseTestCase[] = [
		{ pod: { spec: desiredState, status: {} }, status: "Pending", test: "empty, waiting" },
		{
			pod: {
				spec: desiredState,
				status: { initContainerStatuses: [runningState("containerX")] },
			},
			status: "Pending",
			test: "init container running",
		},
		{
			pod: {
				spec: desiredState,
				status: { initContainerStatuses: [failedState("containerX")] },
			},
			status: "Pending",
			test: "init container terminated non-zero",
		},
		{
			pod: {
				spec: desiredState,
				status: { initContainerStatuses: [waitingStateWithLastTermination("containerX")] },
			},
			status: "Pending",
			test: "init container waiting, terminated zero",
		},
		{
			pod: {
				spec: desiredState,
				status: { initContainerStatuses: [waitingStateWithNonZeroTermination("containerX")] },
			},
			status: "Pending",
			test: "init container waiting, terminated non-zero",
		},
		{
			pod: {
				spec: desiredState,
				status: { initContainerStatuses: [waitingState("containerX")] },
			},
			status: "Pending",
			test: "init container waiting, not terminated",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [succeededState("containerX")],
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
			},
			status: "Running",
			test: "init container succeeded",
		},
	];

	it.each(tests)("$test", (test) => {
		const status = getPhase(test.pod, podPhaseInfo(test.pod), false, false);
		expect(status).toBe(test.status);
	});
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestPodPhaseWithRestartAlwaysRestartableInitContainers.
browser.describe("podPhaseWithRestartAlwaysRestartableInitContainers", () => {
	const desiredState = {
		nodeName: "machine",
		initContainers: [{ name: "containerX", restartPolicy: "Always" as const }],
		containers: [{ name: "containerA" }, { name: "containerB" }],
		restartPolicy: "Always" as const,
	};

	const tests: Array<PodPhaseTestCase & { podHasInitialized: boolean }> = [
		{
			pod: { spec: desiredState, status: {} },
			podIsTerminal: false,
			podHasInitialized: false,
			status: "Pending",
			test: "empty, waiting",
		},
		{
			pod: {
				spec: desiredState,
				status: { initContainerStatuses: [runningState("containerX")] },
			},
			podIsTerminal: false,
			podHasInitialized: false,
			status: "Pending",
			test: "restartable init container running",
		},
		{
			pod: {
				spec: desiredState,
				status: { initContainerStatuses: [stoppedState("containerX")] },
			},
			podIsTerminal: false,
			podHasInitialized: false,
			status: "Pending",
			test: "restartable init container stopped",
		},
		{
			pod: {
				spec: desiredState,
				status: { initContainerStatuses: [waitingStateWithLastTermination("containerX")] },
			},
			podIsTerminal: false,
			podHasInitialized: false,
			status: "Pending",
			test: "restartable init container waiting, terminated zero",
		},
		{
			pod: {
				spec: desiredState,
				status: { initContainerStatuses: [waitingStateWithNonZeroTermination("containerX")] },
			},
			podIsTerminal: false,
			podHasInitialized: false,
			status: "Pending",
			test: "restartable init container waiting, terminated non-zero",
		},
		{
			pod: {
				spec: desiredState,
				status: { initContainerStatuses: [waitingState("containerX")] },
			},
			podIsTerminal: false,
			podHasInitialized: false,
			status: "Pending",
			test: "restartable init container waiting, not terminated",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [startedState("containerX")],
					containerStatuses: [runningState("containerA")],
				},
			},
			podIsTerminal: false,
			podHasInitialized: true,
			status: "Pending",
			test: "restartable init container started, 1/2 regular container running",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [startedState("containerX")],
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
			},
			podIsTerminal: false,
			podHasInitialized: true,
			status: "Running",
			test: "restartable init container started, all regular containers running",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [runningState("containerX")],
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
			},
			podIsTerminal: false,
			podHasInitialized: true,
			status: "Running",
			test: "restartable init container running, all regular containers running",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [stoppedState("containerX")],
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
			},
			podIsTerminal: false,
			podHasInitialized: true,
			status: "Running",
			test: "restartable init container stopped, all regular containers running",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [waitingStateWithLastTermination("containerX")],
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
			},
			podIsTerminal: false,
			podHasInitialized: true,
			status: "Running",
			test: "backoff crashloop restartable init container, all regular containers running",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [failedState("containerX")],
					containerStatuses: [succeededState("containerA"), succeededState("containerB")],
				},
			},
			podIsTerminal: true,
			podHasInitialized: true,
			status: "Succeeded",
			test: "all regular containers succeeded and restartable init container failed with restart always, but the pod is terminal",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [succeededState("containerX")],
					containerStatuses: [succeededState("containerA"), succeededState("containerB")],
				},
			},
			podIsTerminal: true,
			podHasInitialized: true,
			status: "Succeeded",
			test: "all regular containers succeeded and restartable init container succeeded with restart always, but the pod is terminal",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [runningState("containerX")],
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
			},
			podIsTerminal: false,
			podHasInitialized: false,
			status: "Pending",
			test: "re-initializing the pod after the sandbox is recreated",
		},
	];

	it.each(tests)("$test", (test) => {
		const status = getPhase(
			test.pod,
			podPhaseInfo(test.pod),
			test.podIsTerminal ?? false,
			test.podHasInitialized,
		);
		expect(status).toBe(test.status);
	});
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestPodPhaseWithRestartAlwaysAndPodHasRun.
browser.describe("podPhaseWithRestartAlwaysAndPodHasRun", () => {
	const desiredState = {
		nodeName: "machine",
		initContainers: [
			{ name: "containerX" },
			{ name: "containerY", restartPolicy: "Always" as const },
		],
		containers: [{ name: "containerA" }],
		restartPolicy: "Always" as const,
	};

	const tests: Array<PodPhaseTestCase & { podHasInitialized: boolean }> = [
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [runningState("containerX"), runningState("containerY")],
					containerStatuses: [runningState("containerA")],
				},
			},
			podHasInitialized: false,
			status: "Pending",
			test: "regular init containers, restartable init container and regular container are all running",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [runningState("containerX"), runningState("containerY")],
					containerStatuses: [stoppedState("containerA")],
				},
			},
			podHasInitialized: false,
			status: "Pending",
			test: "regular containers is stopped, restartable init container and regular int container are both running",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [succeededState("containerX"), runningState("containerY")],
					containerStatuses: [stoppedState("containerA")],
				},
			},
			podHasInitialized: false,
			status: "Pending",
			test: "re-created sandbox: regular init container is succeeded, restartable init container is running, old regular containers is stopped",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [succeededState("containerX"), runningState("containerY")],
					containerStatuses: [stoppedState("containerA")],
				},
			},
			podHasInitialized: true,
			status: "Running",
			test: "regular init container is succeeded, restartable init container is running, regular containers is stopped",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [succeededState("containerX"), runningState("containerY")],
					containerStatuses: [runningState("containerA")],
				},
			},
			podHasInitialized: true,
			status: "Running",
			test: "regular init container is succeeded, restartable init container and regular containers are both running",
		},
	];

	it.each(tests)("$test", (test) => {
		const status = getPhase(test.pod, podPhaseInfo(test.pod), false, test.podHasInitialized);
		expect(status).toBe(test.status);
	});
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestPodPhaseWithRestartNever.
browser.describe("podPhaseWithRestartNever", () => {
	const desiredState = {
		nodeName: "machine",
		containers: [{ name: "containerA" }, { name: "containerB" }],
		restartPolicy: "Never" as const,
	};

	const tests: PodPhaseTestCase[] = [
		{ pod: { spec: desiredState, status: {} }, status: "Pending", test: "waiting" },
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([runningState("containerA"), runningState("containerB")]),
			},
			status: "Running",
			test: "all running with restart never",
		},
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([succeededState("containerA"), succeededState("containerB")]),
			},
			status: "Succeeded",
			test: "all succeeded with restart never",
		},
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([failedState("containerA"), failedState("containerB")]),
			},
			status: "Failed",
			test: "all failed with restart never",
		},
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([runningState("containerA"), succeededState("containerB")]),
			},
			status: "Running",
			test: "mixed state #1 with restart never",
		},
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([runningState("containerA")]),
			},
			status: "Pending",
			test: "mixed state #2 with restart never",
		},
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([runningState("containerA"), waitingState("containerB")]),
			},
			status: "Pending",
			test: "mixed state #3 with restart never",
		},
	];

	it.each(tests)("$test", (test) => {
		const status = getPhase(
			test.pod,
			test.pod.status?.containerStatuses ?? [],
			test.podIsTerminal ?? false,
			false,
		);
		expect(status).toBe(test.status);
	});
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestPodPhaseWithRestartNeverInitContainers.
browser.describe("podPhaseWithRestartNeverInitContainers", () => {
	const desiredState = {
		nodeName: "machine",
		initContainers: [{ name: "containerX" }],
		containers: [{ name: "containerA" }, { name: "containerB" }],
		restartPolicy: "Never" as const,
	};

	const tests: PodPhaseTestCase[] = [
		{ pod: { spec: desiredState, status: {} }, status: "Pending", test: "empty, waiting" },
		{
			pod: {
				spec: desiredState,
				status: { initContainerStatuses: [runningState("containerX")] },
			},
			status: "Pending",
			test: "init container running",
		},
		{
			pod: {
				spec: desiredState,
				status: { initContainerStatuses: [failedState("containerX")] },
			},
			status: "Failed",
			test: "init container terminated non-zero",
		},
		{
			pod: {
				spec: desiredState,
				status: { initContainerStatuses: [waitingStateWithLastTermination("containerX")] },
			},
			status: "Pending",
			test: "init container waiting, terminated zero",
		},
		{
			pod: {
				spec: desiredState,
				status: { initContainerStatuses: [waitingStateWithNonZeroTermination("containerX")] },
			},
			status: "Failed",
			test: "init container waiting, terminated non-zero",
		},
		{
			pod: {
				spec: desiredState,
				status: { initContainerStatuses: [waitingState("containerX")] },
			},
			status: "Pending",
			test: "init container waiting, not terminated",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [succeededState("containerX")],
					containerStatuses: [runningState("containerA"), runningState("containerB")],
				},
			},
			status: "Running",
			test: "init container succeeded",
		},
	];

	it.each(tests)("$test", (test) => {
		const status = getPhase(test.pod, podPhaseInfo(test.pod), false, false);
		expect(status).toBe(test.status);
	});
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestPodPhaseWithRestartNeverRestartableInitContainers.
browser.describe("podPhaseWithRestartNeverRestartableInitContainers", () => {
	const desiredState = {
		nodeName: "machine",
		initContainers: [{ name: "containerX", restartPolicy: "Always" as const }],
		containers: [{ name: "containerA" }, { name: "containerB" }],
		restartPolicy: "Never" as const,
	};

	const tests: Array<PodPhaseTestCase & { podHasInitialized: boolean }> = [
		{
			pod: { spec: desiredState, status: {} },
			podHasInitialized: false,
			status: "Pending",
			test: "empty, waiting",
		},
		{
			pod: {
				spec: desiredState,
				status: { initContainerStatuses: [runningState("containerX")] },
			},
			podHasInitialized: false,
			status: "Pending",
			test: "restartable init container running",
		},
		{
			pod: {
				spec: desiredState,
				status: { initContainerStatuses: [stoppedState("containerX")] },
			},
			podHasInitialized: false,
			status: "Pending",
			test: "restartable init container stopped",
		},
		{
			pod: {
				spec: desiredState,
				status: { initContainerStatuses: [waitingStateWithLastTermination("containerX")] },
			},
			podHasInitialized: false,
			status: "Pending",
			test: "restartable init container waiting, terminated zero",
		},
		{
			pod: {
				spec: desiredState,
				status: { initContainerStatuses: [waitingStateWithNonZeroTermination("containerX")] },
			},
			podHasInitialized: false,
			status: "Pending",
			test: "restartable init container waiting, terminated non-zero",
		},
		{
			pod: {
				spec: desiredState,
				status: { initContainerStatuses: [waitingState("containerX")] },
			},
			podHasInitialized: false,
			status: "Pending",
			test: "restartable init container waiting, not terminated",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [startedState("containerX")],
					containerStatuses: [runningState("containerA")],
				},
			},
			podHasInitialized: true,
			status: "Pending",
			test: "restartable init container started, one main container running",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [startedState("containerX")],
					containerStatuses: [succeededState("containerA"), succeededState("containerB")],
				},
			},
			podHasInitialized: true,
			status: "Running",
			test: "restartable init container started, main containers succeeded",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [runningState("containerX")],
					containerStatuses: [succeededState("containerA"), succeededState("containerB")],
				},
			},
			podHasInitialized: true,
			status: "Running",
			test: "restartable init container re-running, main containers succeeded",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [succeededState("containerX")],
					containerStatuses: [succeededState("containerA"), succeededState("containerB")],
				},
			},
			podHasInitialized: true,
			status: "Succeeded",
			test: "all containers succeeded",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [failedState("containerX")],
					containerStatuses: [succeededState("containerA"), succeededState("containerB")],
				},
			},
			podHasInitialized: true,
			status: "Succeeded",
			test: "restartable init container terminated non-zero, main containers succeeded",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [waitingStateWithLastTermination("containerX")],
					containerStatuses: [succeededState("containerA"), succeededState("containerB")],
				},
			},
			podHasInitialized: true,
			status: "Succeeded",
			test: "backoff crashloop restartable init container, main containers succeeded",
		},
		{
			pod: {
				spec: desiredState,
				status: {
					initContainerStatuses: [waitingStateWithNonZeroTermination("containerX")],
					containerStatuses: [succeededState("containerA"), succeededState("containerB")],
				},
			},
			podHasInitialized: true,
			status: "Succeeded",
			test: "backoff crashloop with non-zero restartable init container, main containers succeeded",
		},
	];

	it.each(tests)("$test", (test) => {
		const status = getPhase(test.pod, podPhaseInfo(test.pod), false, test.podHasInitialized);
		expect(status).toBe(test.status);
	});
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestPodPhaseWithRestartOnFailure.
browser.describe("podPhaseWithRestartOnFailure", () => {
	const desiredState = {
		nodeName: "machine",
		containers: [{ name: "containerA" }, { name: "containerB" }],
		restartPolicy: "OnFailure" as const,
	};

	const tests: PodPhaseTestCase[] = [
		{ pod: { spec: desiredState, status: {} }, status: "Pending", test: "waiting" },
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([runningState("containerA"), runningState("containerB")]),
			},
			status: "Running",
			test: "all running with restart onfailure",
		},
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([succeededState("containerA"), succeededState("containerB")]),
			},
			status: "Succeeded",
			test: "all succeeded with restart onfailure",
		},
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([failedState("containerA"), failedState("containerB")]),
			},
			status: "Running",
			test: "all failed with restart never",
		},
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([runningState("containerA"), succeededState("containerB")]),
			},
			status: "Running",
			test: "mixed state #1 with restart onfailure",
		},
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([runningState("containerA")]),
			},
			status: "Pending",
			test: "mixed state #2 with restart onfailure",
		},
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([runningState("containerA"), waitingState("containerB")]),
			},
			status: "Pending",
			test: "mixed state #3 with restart onfailure",
		},
		{
			pod: {
				spec: desiredState,
				status: podPhaseStatus([
					runningState("containerA"),
					waitingStateWithLastTermination("containerB"),
				]),
			},
			status: "Running",
			test: "backoff crashloop container with restart onfailure",
		},
	];

	it.each(tests)("$test", (test) => {
		const status = getPhase(
			test.pod,
			test.pod.status?.containerStatuses ?? [],
			test.podIsTerminal ?? false,
			false,
		);
		expect(status).toBe(test.status);
	});
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestPodPhaseWithContainerRestartPolicy.
browser.describe("podPhaseWithContainerRestartPolicy", () => {
	interface ContainerRestartPolicyTestCase {
		name: string;
		spec: NonNullable<V1Pod["spec"]>;
		statuses: V1ContainerStatus[];
		podIsTerminal?: boolean;
		expectedPhase: NonNullable<V1PodStatus["phase"]>;
	}

	const containerRestartPolicyAlways = "Always" as const;
	const containerRestartPolicyOnFailure = "OnFailure" as const;
	const containerRestartPolicyNever = "Never" as const;

	const tests: ContainerRestartPolicyTestCase[] = [
		{
			name: "container with restart policy Never failed",
			spec: {
				containers: [
					{
						name: "failed-container",
						restartPolicy: containerRestartPolicyNever,
					},
				],
				restartPolicy: "Always",
			},
			statuses: [failedState("failed-container")],
			expectedPhase: "Failed",
		},
		{
			name: "container with restart policy OnFailure failed",
			spec: {
				containers: [
					{
						name: "failed-container",
						restartPolicy: containerRestartPolicyOnFailure,
					},
				],
				restartPolicy: "Always",
			},
			statuses: [failedState("failed-container")],
			expectedPhase: "Running",
		},
		{
			name: "container with restart policy Always failed",
			spec: {
				containers: [
					{
						name: "failed-container",
						restartPolicy: containerRestartPolicyAlways,
					},
				],
				restartPolicy: "Always",
			},
			statuses: [failedState("failed-container")],
			expectedPhase: "Running",
		},
		{
			name: "At least one container with restartable container-level restart policy failed",
			spec: {
				containers: [
					{
						name: "containerA",
						restartPolicy: containerRestartPolicyAlways,
					},
					{ name: "containerB" },
				],
				restartPolicy: "Never",
			},
			statuses: [succeededState("containerA"), failedState("containerB")],
			expectedPhase: "Running",
		},
		{
			name: "All containers without restartable container-level restart policy failed",
			spec: {
				containers: [
					{
						name: "containerA",
						restartPolicy: containerRestartPolicyNever,
					},
					{
						name: "containerB",
						restartPolicy: containerRestartPolicyOnFailure,
					},
				],
				restartPolicy: "Always",
			},
			statuses: [failedState("containerA"), succeededState("containerB")],
			expectedPhase: "Failed",
		},
		{
			name: "All containers succeeded",
			spec: {
				containers: [
					{
						name: "containerA",
						restartPolicy: containerRestartPolicyNever,
					},
					{
						name: "containerB",
						restartPolicy: containerRestartPolicyOnFailure,
					},
				],
				restartPolicy: "Always",
			},
			statuses: [succeededState("containerA"), succeededState("containerB")],
			expectedPhase: "Succeeded",
		},
	];

	it.each(tests)("$name", (tc) => {
		const pod: V1Pod = {
			spec: tc.spec,
			status: {
				containerStatuses: tc.statuses,
			},
		};
		const phase = getPhase(pod, tc.statuses, tc.podIsTerminal ?? false, true);
		expect(phase).toBe(tc.expectedPhase);
	});
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestPodPhaseWithContainerRestartPolicyInitContainers.
browser.describe("podPhaseWithContainerRestartPolicyInitContainers", () => {
	interface ContainerRestartPolicyInitTestCase {
		name: string;
		spec: NonNullable<V1Pod["spec"]>;
		statuses: V1ContainerStatus[];
		podIsTerminal?: boolean;
		expectedPhase: NonNullable<V1PodStatus["phase"]>;
	}

	const containerRestartPolicyAlways = "Always" as const;
	const containerRestartPolicyOnFailure = "OnFailure" as const;
	const containerRestartPolicyNever = "Never" as const;

	const tests: ContainerRestartPolicyInitTestCase[] = [
		{
			name: "init container with restart policy Never failed",
			spec: {
				initContainers: [
					{
						name: "failed-container",
						restartPolicy: containerRestartPolicyNever,
					},
				],
				containers: [{ name: "container" }],
				restartPolicy: "Always",
			},
			statuses: [failedState("failed-container")],
			expectedPhase: "Failed",
		},
		{
			name: "init container with restart policy OnFailure failed",
			spec: {
				initContainers: [
					{
						name: "failed-container",
						restartPolicy: containerRestartPolicyOnFailure,
					},
				],
				containers: [{ name: "container" }],
				restartPolicy: "Never",
			},
			statuses: [failedState("failed-container")],
			expectedPhase: "Pending",
		},
		{
			name: "container with restart policy Always failed",
			spec: {
				initContainers: [
					{
						name: "failed-container",
						restartPolicy: containerRestartPolicyAlways,
					},
				],
				containers: [{ name: "container" }],
				restartPolicy: "Never",
			},
			statuses: [failedState("failed-container")],
			expectedPhase: "Pending",
		},
	];

	it.each(tests)("$name", (tc) => {
		const pod: V1Pod = {
			spec: tc.spec,
			status: {
				containerStatuses: tc.statuses,
			},
		};
		const phase = getPhase(pod, tc.statuses, tc.podIsTerminal ?? false, true);
		expect(phase).toBe(tc.expectedPhase);
	});
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestPodPhaseWithRestartAllContainers.
browser.describe("podPhaseWithRestartAllContainers", () => {
	interface RestartAllContainersTestCase {
		name: string;
		spec: NonNullable<V1Pod["spec"]>;
		statuses: V1ContainerStatus[];
		expectedPhase: NonNullable<V1PodStatus["phase"]>;
	}

	const containerRestartPolicyNever = "Never" as const;
	const containerWithRule: V1Container = {
		name: "container",
		restartPolicy: containerRestartPolicyNever,
		restartPolicyRules: [
			{
				action: "RestartAllContainers",
				exitCodes: {
					operator: "In",
					values: [42],
				},
			},
		],
	};

	const tests: RestartAllContainersTestCase[] = [
		{
			name: "regular container triggers RestartAllContainers",
			spec: {
				containers: [containerWithRule],
				restartPolicy: "Never",
			},
			statuses: [failedStateWithExitCode("container", 42)],
			expectedPhase: "Running",
		},
		{
			name: "regular container triggers RestartAllContainers, cleaned up",
			spec: {
				containers: [containerWithRule],
				restartPolicy: "Never",
			},
			statuses: [waitingStateWithRestartingAllContainers("container")],
			expectedPhase: "Running",
		},
	];

	it.each(tests)("$name", (tc) => {
		const pod: V1Pod = {
			spec: tc.spec,
			status: {
				containerStatuses: tc.statuses,
			},
		};
		const phase = getPhase(pod, tc.statuses, false, true);
		expect(phase).toBe(tc.expectedPhase);
	});
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestMakeEnvironmentVariables.
browser.describe("makeEnvironmentVariables", () => {
	interface MakeEnvironmentVariablesTestCase {
		name: string; // the name of the test case
		ns: string; // the namespace to generate environment for
		enableServiceLinks?: boolean; // enabling service links
		container: V1Container; // the container to use
		nilLister?: boolean; // whether the lister should be nil
		staticPod?: boolean; // whether the pod should be a static pod (versus an API pod)
		unsyncedServices?: boolean; // whether the services should NOT be synced
		podIPs?: string[]; // the pod IPs
		expectedEnvs?: EnvVar[]; // a set of expected environment vars
		expectedError?: boolean; // does the test fail
		expectedEvent?: string; // does the test emit an event
	}

	const trueValue = true;
	const falseValue = false;
	const services: V1Service[] = [
		buildService("kubernetes", "default", "1.2.3.1", "TCP", 8081),
		buildService("test", "test1", "1.2.3.3", "TCP", 8083),
		buildService("kubernetes", "test2", "1.2.3.4", "TCP", 8084),
		buildService("test", "test2", "1.2.3.5", "TCP", 8085),
		buildService("test", "test2", "None", "TCP", 8085),
		buildService("test", "test2", "", "TCP", 8085),
		buildService("not-special", "default", "1.2.3.8", "TCP", 8088),
		buildService("not-special", "default", "None", "TCP", 8088),
		buildService("not-special", "default", "", "TCP", 8088),
	];

	it.each<MakeEnvironmentVariablesTestCase>([
		{
			name: "if services aren't synced, non-static pods should fail",
			ns: "test1",
			enableServiceLinks: falseValue,
			container: { name: "container", env: [] },
			nilLister: false,
			staticPod: false,
			unsyncedServices: true,
			expectedEnvs: [],
			expectedError: true,
		},
		{
			name: "if services aren't synced, static pods should succeed",
			ns: "test1",
			enableServiceLinks: falseValue,
			container: { name: "container", env: [] },
			nilLister: false,
			staticPod: true,
			unsyncedServices: true,
		},
		{
			name: "api server = Y, kubelet = Y",
			ns: "test1",
			enableServiceLinks: falseValue,
			container: {
				name: "container",
				env: [
					{ name: "FOO", value: "BAR" },
					{ name: "TEST_SERVICE_HOST", value: "1.2.3.3" },
					{ name: "TEST_SERVICE_PORT", value: "8083" },
					{ name: "TEST_PORT", value: "tcp://1.2.3.3:8083" },
					{ name: "TEST_PORT_8083_TCP", value: "tcp://1.2.3.3:8083" },
					{ name: "TEST_PORT_8083_TCP_PROTO", value: "tcp" },
					{ name: "TEST_PORT_8083_TCP_PORT", value: "8083" },
					{ name: "TEST_PORT_8083_TCP_ADDR", value: "1.2.3.3" },
				],
			},
			nilLister: false,
			expectedEnvs: [
				{ name: "FOO", value: "BAR" },
				{ name: "TEST_SERVICE_HOST", value: "1.2.3.3" },
				{ name: "TEST_SERVICE_PORT", value: "8083" },
				{ name: "TEST_PORT", value: "tcp://1.2.3.3:8083" },
				{ name: "TEST_PORT_8083_TCP", value: "tcp://1.2.3.3:8083" },
				{ name: "TEST_PORT_8083_TCP_PROTO", value: "tcp" },
				{ name: "TEST_PORT_8083_TCP_PORT", value: "8083" },
				{ name: "TEST_PORT_8083_TCP_ADDR", value: "1.2.3.3" },
				{ name: "KUBERNETES_SERVICE_PORT", value: "8081" },
				{ name: "KUBERNETES_SERVICE_HOST", value: "1.2.3.1" },
				{ name: "KUBERNETES_PORT", value: "tcp://1.2.3.1:8081" },
				{ name: "KUBERNETES_PORT_8081_TCP", value: "tcp://1.2.3.1:8081" },
				{ name: "KUBERNETES_PORT_8081_TCP_PROTO", value: "tcp" },
				{ name: "KUBERNETES_PORT_8081_TCP_PORT", value: "8081" },
				{ name: "KUBERNETES_PORT_8081_TCP_ADDR", value: "1.2.3.1" },
			],
		},
		{
			name: "api server = Y, kubelet = N",
			ns: "test1",
			enableServiceLinks: falseValue,
			container: {
				name: "container",
				env: [
					{ name: "FOO", value: "BAR" },
					{ name: "TEST_SERVICE_HOST", value: "1.2.3.3" },
					{ name: "TEST_SERVICE_PORT", value: "8083" },
					{ name: "TEST_PORT", value: "tcp://1.2.3.3:8083" },
					{ name: "TEST_PORT_8083_TCP", value: "tcp://1.2.3.3:8083" },
					{ name: "TEST_PORT_8083_TCP_PROTO", value: "tcp" },
					{ name: "TEST_PORT_8083_TCP_PORT", value: "8083" },
					{ name: "TEST_PORT_8083_TCP_ADDR", value: "1.2.3.3" },
				],
			},
			nilLister: true,
			expectedEnvs: [
				{ name: "FOO", value: "BAR" },
				{ name: "TEST_SERVICE_HOST", value: "1.2.3.3" },
				{ name: "TEST_SERVICE_PORT", value: "8083" },
				{ name: "TEST_PORT", value: "tcp://1.2.3.3:8083" },
				{ name: "TEST_PORT_8083_TCP", value: "tcp://1.2.3.3:8083" },
				{ name: "TEST_PORT_8083_TCP_PROTO", value: "tcp" },
				{ name: "TEST_PORT_8083_TCP_PORT", value: "8083" },
				{ name: "TEST_PORT_8083_TCP_ADDR", value: "1.2.3.3" },
			],
		},
		{
			name: "api server = N; kubelet = Y",
			ns: "test1",
			enableServiceLinks: falseValue,
			container: {
				name: "container",
				env: [{ name: "FOO", value: "BAZ" }],
			},
			nilLister: false,
			expectedEnvs: [
				{ name: "FOO", value: "BAZ" },
				{ name: "KUBERNETES_SERVICE_HOST", value: "1.2.3.1" },
				{ name: "KUBERNETES_SERVICE_PORT", value: "8081" },
				{ name: "KUBERNETES_PORT", value: "tcp://1.2.3.1:8081" },
				{ name: "KUBERNETES_PORT_8081_TCP", value: "tcp://1.2.3.1:8081" },
				{ name: "KUBERNETES_PORT_8081_TCP_PROTO", value: "tcp" },
				{ name: "KUBERNETES_PORT_8081_TCP_PORT", value: "8081" },
				{ name: "KUBERNETES_PORT_8081_TCP_ADDR", value: "1.2.3.1" },
			],
		},
		{
			name: "api server = N; kubelet = Y; service env vars",
			ns: "test1",
			enableServiceLinks: trueValue,
			container: {
				name: "container",
				env: [{ name: "FOO", value: "BAZ" }],
			},
			nilLister: false,
			expectedEnvs: [
				{ name: "FOO", value: "BAZ" },
				{ name: "TEST_SERVICE_HOST", value: "1.2.3.3" },
				{ name: "TEST_SERVICE_PORT", value: "8083" },
				{ name: "TEST_PORT", value: "tcp://1.2.3.3:8083" },
				{ name: "TEST_PORT_8083_TCP", value: "tcp://1.2.3.3:8083" },
				{ name: "TEST_PORT_8083_TCP_PROTO", value: "tcp" },
				{ name: "TEST_PORT_8083_TCP_PORT", value: "8083" },
				{ name: "TEST_PORT_8083_TCP_ADDR", value: "1.2.3.3" },
				{ name: "KUBERNETES_SERVICE_HOST", value: "1.2.3.1" },
				{ name: "KUBERNETES_SERVICE_PORT", value: "8081" },
				{ name: "KUBERNETES_PORT", value: "tcp://1.2.3.1:8081" },
				{ name: "KUBERNETES_PORT_8081_TCP", value: "tcp://1.2.3.1:8081" },
				{ name: "KUBERNETES_PORT_8081_TCP_PROTO", value: "tcp" },
				{ name: "KUBERNETES_PORT_8081_TCP_PORT", value: "8081" },
				{ name: "KUBERNETES_PORT_8081_TCP_ADDR", value: "1.2.3.1" },
			],
		},
		{
			name: "master service in pod ns",
			ns: "test2",
			enableServiceLinks: falseValue,
			container: {
				name: "container",
				env: [{ name: "FOO", value: "ZAP" }],
			},
			nilLister: false,
			expectedEnvs: [
				{ name: "FOO", value: "ZAP" },
				{ name: "KUBERNETES_SERVICE_HOST", value: "1.2.3.1" },
				{ name: "KUBERNETES_SERVICE_PORT", value: "8081" },
				{ name: "KUBERNETES_PORT", value: "tcp://1.2.3.1:8081" },
				{ name: "KUBERNETES_PORT_8081_TCP", value: "tcp://1.2.3.1:8081" },
				{ name: "KUBERNETES_PORT_8081_TCP_PROTO", value: "tcp" },
				{ name: "KUBERNETES_PORT_8081_TCP_PORT", value: "8081" },
				{ name: "KUBERNETES_PORT_8081_TCP_ADDR", value: "1.2.3.1" },
			],
		},
		{
			name: "master service in pod ns, service env vars",
			ns: "test2",
			enableServiceLinks: trueValue,
			container: {
				name: "container",
				env: [{ name: "FOO", value: "ZAP" }],
			},
			nilLister: false,
			expectedEnvs: [
				{ name: "FOO", value: "ZAP" },
				{ name: "TEST_SERVICE_HOST", value: "1.2.3.5" },
				{ name: "TEST_SERVICE_PORT", value: "8085" },
				{ name: "TEST_PORT", value: "tcp://1.2.3.5:8085" },
				{ name: "TEST_PORT_8085_TCP", value: "tcp://1.2.3.5:8085" },
				{ name: "TEST_PORT_8085_TCP_PROTO", value: "tcp" },
				{ name: "TEST_PORT_8085_TCP_PORT", value: "8085" },
				{ name: "TEST_PORT_8085_TCP_ADDR", value: "1.2.3.5" },
				{ name: "KUBERNETES_SERVICE_HOST", value: "1.2.3.4" },
				{ name: "KUBERNETES_SERVICE_PORT", value: "8084" },
				{ name: "KUBERNETES_PORT", value: "tcp://1.2.3.4:8084" },
				{ name: "KUBERNETES_PORT_8084_TCP", value: "tcp://1.2.3.4:8084" },
				{ name: "KUBERNETES_PORT_8084_TCP_PROTO", value: "tcp" },
				{ name: "KUBERNETES_PORT_8084_TCP_PORT", value: "8084" },
				{ name: "KUBERNETES_PORT_8084_TCP_ADDR", value: "1.2.3.4" },
			],
		},
		{
			name: "pod in master service ns",
			ns: "default",
			enableServiceLinks: falseValue,
			container: { name: "container" },
			nilLister: false,
			expectedEnvs: [
				{ name: "KUBERNETES_SERVICE_HOST", value: "1.2.3.1" },
				{ name: "KUBERNETES_SERVICE_PORT", value: "8081" },
				{ name: "KUBERNETES_PORT", value: "tcp://1.2.3.1:8081" },
				{ name: "KUBERNETES_PORT_8081_TCP", value: "tcp://1.2.3.1:8081" },
				{ name: "KUBERNETES_PORT_8081_TCP_PROTO", value: "tcp" },
				{ name: "KUBERNETES_PORT_8081_TCP_PORT", value: "8081" },
				{ name: "KUBERNETES_PORT_8081_TCP_ADDR", value: "1.2.3.1" },
			],
		},
		{
			name: "pod in master service ns, service env vars",
			ns: "default",
			enableServiceLinks: trueValue,
			container: { name: "container" },
			nilLister: false,
			expectedEnvs: [
				{ name: "NOT_SPECIAL_SERVICE_HOST", value: "1.2.3.8" },
				{ name: "NOT_SPECIAL_SERVICE_PORT", value: "8088" },
				{ name: "NOT_SPECIAL_PORT", value: "tcp://1.2.3.8:8088" },
				{ name: "NOT_SPECIAL_PORT_8088_TCP", value: "tcp://1.2.3.8:8088" },
				{ name: "NOT_SPECIAL_PORT_8088_TCP_PROTO", value: "tcp" },
				{ name: "NOT_SPECIAL_PORT_8088_TCP_PORT", value: "8088" },
				{ name: "NOT_SPECIAL_PORT_8088_TCP_ADDR", value: "1.2.3.8" },
				{ name: "KUBERNETES_SERVICE_HOST", value: "1.2.3.1" },
				{ name: "KUBERNETES_SERVICE_PORT", value: "8081" },
				{ name: "KUBERNETES_PORT", value: "tcp://1.2.3.1:8081" },
				{ name: "KUBERNETES_PORT_8081_TCP", value: "tcp://1.2.3.1:8081" },
				{ name: "KUBERNETES_PORT_8081_TCP_PROTO", value: "tcp" },
				{ name: "KUBERNETES_PORT_8081_TCP_PORT", value: "8081" },
				{ name: "KUBERNETES_PORT_8081_TCP_ADDR", value: "1.2.3.1" },
			],
		},
		{
			name: "downward api pod",
			ns: "downward-api",
			enableServiceLinks: falseValue,
			container: {
				name: "container",
				env: [
					{
						name: "POD_NAME",
						valueFrom: {
							fieldRef: {
								apiVersion: "v1",
								fieldPath: "metadata.name",
							},
						},
					},
					{
						name: "POD_NAMESPACE",
						valueFrom: {
							fieldRef: {
								apiVersion: "v1",
								fieldPath: "metadata.namespace",
							},
						},
					},
					{
						name: "POD_NODE_NAME",
						valueFrom: {
							fieldRef: {
								apiVersion: "v1",
								fieldPath: "spec.nodeName",
							},
						},
					},
					{
						name: "POD_NODE_NAME_LEGACY",
						valueFrom: {
							fieldRef: {
								apiVersion: "v1",
								fieldPath: "spec.host",
							},
						},
					},
					{
						name: "POD_SERVICE_ACCOUNT_NAME",
						valueFrom: {
							fieldRef: {
								apiVersion: "v1",
								fieldPath: "spec.serviceAccountName",
							},
						},
					},
					{
						name: "POD_IP",
						valueFrom: {
							fieldRef: {
								apiVersion: "v1",
								fieldPath: "status.podIP",
							},
						},
					},
					{
						name: "POD_IPS",
						valueFrom: {
							fieldRef: {
								apiVersion: "v1",
								fieldPath: "status.podIPs",
							},
						},
					},
					{
						name: "HOST_IP",
						valueFrom: {
							fieldRef: {
								apiVersion: "v1",
								fieldPath: "status.hostIP",
							},
						},
					},
					{
						name: "HOST_IPS",
						valueFrom: {
							fieldRef: {
								apiVersion: "v1",
								fieldPath: "status.hostIPs",
							},
						},
					},
				],
			},
			podIPs: ["1.2.3.4", "fd00::6"],
			nilLister: true,
			expectedEnvs: [
				{ name: "POD_NAME", value: "dapi-test-pod-name" },
				{ name: "POD_NAMESPACE", value: "downward-api" },
				{ name: "POD_NODE_NAME", value: "node-name" },
				{ name: "POD_NODE_NAME_LEGACY", value: "node-name" },
				{ name: "POD_SERVICE_ACCOUNT_NAME", value: "special" },
				{ name: "POD_IP", value: "1.2.3.4" },
				{ name: "POD_IPS", value: "1.2.3.4,fd00::6" },
				{ name: "HOST_IP", value: "127.0.0.1" },
				{ name: "HOST_IPS", value: "127.0.0.1,::1" },
			],
		},
		{
			name: "downward api pod ips reverse order",
			ns: "downward-api",
			enableServiceLinks: falseValue,
			container: {
				name: "container",
				env: [
					{
						name: "POD_IP",
						valueFrom: {
							fieldRef: {
								apiVersion: "v1",
								fieldPath: "status.podIP",
							},
						},
					},
					{
						name: "POD_IPS",
						valueFrom: {
							fieldRef: {
								apiVersion: "v1",
								fieldPath: "status.podIPs",
							},
						},
					},
					{
						name: "HOST_IP",
						valueFrom: {
							fieldRef: {
								apiVersion: "v1",
								fieldPath: "status.hostIP",
							},
						},
					},
					{
						name: "HOST_IPS",
						valueFrom: {
							fieldRef: {
								apiVersion: "v1",
								fieldPath: "status.hostIPs",
							},
						},
					},
				],
			},
			podIPs: ["fd00::6", "1.2.3.4"],
			nilLister: true,
			expectedEnvs: [
				{ name: "POD_IP", value: "1.2.3.4" },
				{ name: "POD_IPS", value: "1.2.3.4,fd00::6" },
				{ name: "HOST_IP", value: "127.0.0.1" },
				{ name: "HOST_IPS", value: "127.0.0.1,::1" },
			],
		},
		{
			name: "downward api pod ips multiple ips",
			ns: "downward-api",
			enableServiceLinks: falseValue,
			container: {
				name: "container",
				env: [
					{
						name: "POD_IP",
						valueFrom: {
							fieldRef: {
								apiVersion: "v1",
								fieldPath: "status.podIP",
							},
						},
					},
					{
						name: "POD_IPS",
						valueFrom: {
							fieldRef: {
								apiVersion: "v1",
								fieldPath: "status.podIPs",
							},
						},
					},
					{
						name: "HOST_IP",
						valueFrom: {
							fieldRef: {
								apiVersion: "v1",
								fieldPath: "status.hostIP",
							},
						},
					},
					{
						name: "HOST_IPS",
						valueFrom: {
							fieldRef: {
								apiVersion: "v1",
								fieldPath: "status.hostIPs",
							},
						},
					},
				],
			},
			podIPs: ["1.2.3.4", "192.168.1.1.", "fd00::6"],
			nilLister: true,
			expectedEnvs: [
				{ name: "POD_IP", value: "1.2.3.4" },
				{ name: "POD_IPS", value: "1.2.3.4,fd00::6" },
				{ name: "HOST_IP", value: "127.0.0.1" },
				{ name: "HOST_IPS", value: "127.0.0.1,::1" },
			],
		},
		{
			name: "env expansion",
			ns: "test1",
			enableServiceLinks: falseValue,
			container: {
				name: "container",
				env: [
					{ name: "TEST_LITERAL", value: "test-test-test" },
					{
						name: "POD_NAME",
						valueFrom: {
							fieldRef: {
								apiVersion: "v1",
								fieldPath: "metadata.name",
							},
						},
					},
					{ name: "OUT_OF_ORDER_TEST", value: "$(OUT_OF_ORDER_TARGET)" },
					{ name: "OUT_OF_ORDER_TARGET", value: "FOO" },
					{ name: "EMPTY_VAR" },
					{ name: "EMPTY_TEST", value: "foo-$(EMPTY_VAR)" },
					{ name: "POD_NAME_TEST2", value: "test2-$(POD_NAME)" },
					{ name: "POD_NAME_TEST3", value: "$(POD_NAME_TEST2)-3" },
					{ name: "LITERAL_TEST", value: "literal-$(TEST_LITERAL)" },
					{ name: "TEST_UNDEFINED", value: "$(UNDEFINED_VAR)" },
				],
			},
			nilLister: false,
			expectedEnvs: [
				{ name: "TEST_LITERAL", value: "test-test-test" },
				{ name: "POD_NAME", value: "dapi-test-pod-name" },
				{ name: "POD_NAME_TEST2", value: "test2-dapi-test-pod-name" },
				{ name: "POD_NAME_TEST3", value: "test2-dapi-test-pod-name-3" },
				{ name: "LITERAL_TEST", value: "literal-test-test-test" },
				{ name: "OUT_OF_ORDER_TEST", value: "$(OUT_OF_ORDER_TARGET)" },
				{ name: "OUT_OF_ORDER_TARGET", value: "FOO" },
				{ name: "TEST_UNDEFINED", value: "$(UNDEFINED_VAR)" },
				{ name: "EMPTY_VAR", value: "" },
				{ name: "EMPTY_TEST", value: "foo-" },
				{ name: "KUBERNETES_SERVICE_HOST", value: "1.2.3.1" },
				{ name: "KUBERNETES_SERVICE_PORT", value: "8081" },
				{ name: "KUBERNETES_PORT", value: "tcp://1.2.3.1:8081" },
				{ name: "KUBERNETES_PORT_8081_TCP", value: "tcp://1.2.3.1:8081" },
				{ name: "KUBERNETES_PORT_8081_TCP_PROTO", value: "tcp" },
				{ name: "KUBERNETES_PORT_8081_TCP_PORT", value: "8081" },
				{ name: "KUBERNETES_PORT_8081_TCP_ADDR", value: "1.2.3.1" },
			],
		},
		{
			name: "env expansion, service env vars",
			ns: "test1",
			enableServiceLinks: trueValue,
			container: {
				name: "container",
				env: [
					{ name: "TEST_LITERAL", value: "test-test-test" },
					{
						name: "POD_NAME",
						valueFrom: {
							fieldRef: {
								apiVersion: "v1",
								fieldPath: "metadata.name",
							},
						},
					},
					{ name: "OUT_OF_ORDER_TEST", value: "$(OUT_OF_ORDER_TARGET)" },
					{ name: "OUT_OF_ORDER_TARGET", value: "FOO" },
					{ name: "EMPTY_VAR" },
					{ name: "EMPTY_TEST", value: "foo-$(EMPTY_VAR)" },
					{ name: "POD_NAME_TEST2", value: "test2-$(POD_NAME)" },
					{ name: "POD_NAME_TEST3", value: "$(POD_NAME_TEST2)-3" },
					{ name: "LITERAL_TEST", value: "literal-$(TEST_LITERAL)" },
					{ name: "SERVICE_VAR_TEST", value: "$(TEST_SERVICE_HOST):$(TEST_SERVICE_PORT)" },
					{ name: "TEST_UNDEFINED", value: "$(UNDEFINED_VAR)" },
				],
			},
			nilLister: false,
			expectedEnvs: [
				{ name: "TEST_LITERAL", value: "test-test-test" },
				{ name: "POD_NAME", value: "dapi-test-pod-name" },
				{ name: "POD_NAME_TEST2", value: "test2-dapi-test-pod-name" },
				{ name: "POD_NAME_TEST3", value: "test2-dapi-test-pod-name-3" },
				{ name: "LITERAL_TEST", value: "literal-test-test-test" },
				{ name: "TEST_SERVICE_HOST", value: "1.2.3.3" },
				{ name: "TEST_SERVICE_PORT", value: "8083" },
				{ name: "TEST_PORT", value: "tcp://1.2.3.3:8083" },
				{ name: "TEST_PORT_8083_TCP", value: "tcp://1.2.3.3:8083" },
				{ name: "TEST_PORT_8083_TCP_PROTO", value: "tcp" },
				{ name: "TEST_PORT_8083_TCP_PORT", value: "8083" },
				{ name: "TEST_PORT_8083_TCP_ADDR", value: "1.2.3.3" },
				{ name: "SERVICE_VAR_TEST", value: "1.2.3.3:8083" },
				{ name: "OUT_OF_ORDER_TEST", value: "$(OUT_OF_ORDER_TARGET)" },
				{ name: "OUT_OF_ORDER_TARGET", value: "FOO" },
				{ name: "TEST_UNDEFINED", value: "$(UNDEFINED_VAR)" },
				{ name: "EMPTY_VAR", value: "" },
				{ name: "EMPTY_TEST", value: "foo-" },
				{ name: "KUBERNETES_SERVICE_HOST", value: "1.2.3.1" },
				{ name: "KUBERNETES_SERVICE_PORT", value: "8081" },
				{ name: "KUBERNETES_PORT", value: "tcp://1.2.3.1:8081" },
				{ name: "KUBERNETES_PORT_8081_TCP", value: "tcp://1.2.3.1:8081" },
				{ name: "KUBERNETES_PORT_8081_TCP_PROTO", value: "tcp" },
				{ name: "KUBERNETES_PORT_8081_TCP_PORT", value: "8081" },
				{ name: "KUBERNETES_PORT_8081_TCP_ADDR", value: "1.2.3.1" },
			],
		},
		{
			name: "nil_enableServiceLinks",
			ns: "test",
			container: {
				name: "container",
				env: [],
			},
			nilLister: true,
			expectedError: true,
		},
	])("$name", async (tc) => {
		const fakeRecorder = newFakeRecorder(1);
		const testKubelet = newTestKubelet(false);
		try {
			const kl = testKubelet.kubelet;
			kl.recorder = fakeRecorder;
			if (tc.nilLister) {
				kl.serviceLister = undefined;
			} else if (tc.unsyncedServices) {
				kl.serviceLister = new testServiceLister();
				kl.serviceHasSynced = () => false;
			} else {
				kl.serviceLister = new testServiceLister(services);
				kl.serviceHasSynced = () => true;
			}
			const testPod: V1Pod = {
				metadata: {
					namespace: tc.ns,
					name: "dapi-test-pod-name",
					annotations: {},
				},
				spec: {
					containers: [],
					serviceAccountName: "special",
					nodeName: "node-name",
					enableServiceLinks: tc.enableServiceLinks,
				},
			};
			if (tc.staticPod) {
				testPod.metadata!.annotations![kubetypes.configSourceAnnotationKey] = kubetypes.fileSource;
			}
			const podIPs = tc.podIPs ?? [];
			const podIP = podIPs[0] ?? "";

			const [result, err] = await kl.makeEnvironmentVariables(
				context.background(),
				testPod,
				tc.container,
				podIP,
				podIPs,
			);
			const event = fakeRecorder.events?.tryReceive()?.value;
			if (event !== undefined) {
				expect(event).toBe(tc.expectedEvent);
			} else {
				expect(tc.expectedEvent ?? "").toBe("");
			}

			if (tc.expectedError) {
				expect(err).toBeDefined();
			} else {
				expect(err).toBeUndefined();
				result.sort((left, right) => left.name.localeCompare(right.name));
				const expectedEnvs = tc.expectedEnvs ?? [];
				expectedEnvs.sort((left, right) => left.name.localeCompare(right.name));
				expect(result).toEqual(expectedEnvs);
			}
		} finally {
			await testKubelet.cleanup();
		}
	});
});

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
	const desiredStateWithInitContainer = {
		nodeName: "machine",
		initContainers: [{ name: "init-1" }],
		containers: [{ name: "containerA" }],
		restartPolicy: "Always" as const,
	};
	const desiredStateWithSidecarContainer = {
		nodeName: "machine",
		initContainers: [{ name: "sidecar-1", restartPolicy: "Always" as const }],
		containers: [{ name: "containerA" }],
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
		{
			name: "Unable to get init container status from container runtime and pod has been initialized, treat it as exited normally",
			pod: {
				metadata: { name: "my-pod" },
				spec: desiredStateWithInitContainer,
				status: {
					containerStatuses: [],
				},
			},
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [
					runtimeStatus("containerA", {
						id: new ContainerID("", "foo"),
						startedAt: 1000,
						state: "Running",
					}),
				],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [],
			containers: desiredStateWithInitContainer.initContainers,
			expected: [
				newContainerStatus({
					name: "init-1",
					state: {
						terminated: {
							reason: "Completed",
							message:
								"Unable to get init container status from container runtime and pod has been initialized, treat it as exited normally",
							exitCode: 0,
						},
					},
				}),
			],
			hasInitContainers: true,
			isInitContainer: true,
		},
		{
			name: "Unable to get sidecar container status from container runtime and pod has been initialized, sidecar container should be waiting",
			pod: {
				metadata: { name: "my-pod" },
				spec: desiredStateWithSidecarContainer,
				status: {
					containerStatuses: [],
				},
			},
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [
					runtimeStatus("containerA", {
						id: new ContainerID("", "foo"),
						startedAt: 1000,
						state: "Running",
					}),
				],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [],
			containers: desiredStateWithSidecarContainer.initContainers,
			expected: [
				newContainerStatus({
					name: "sidecar-1",
					state: {
						waiting: {
							reason: "PodInitializing",
						},
					},
				}),
			],
			hasInitContainers: true,
			isInitContainer: true,
		},
		{
			// simulator only test
			name: "running container preserves old started false when kubelet restart status changes are disabled",
			pod: { spec: desiredState },
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [runtimeStatus("containerA", { state: "Running" })],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [withStarted(runningState("containerA"), false)],
			containers: [{ name: "containerA" }],
			expected: [withStarted(runningState("containerA"), false)],
		},
		{
			// simulator only test
			name: "running container preserves old started true when kubelet restart status changes are disabled",
			pod: { spec: desiredState },
			currentStatus: {
				id: "",
				name: "",
				namespace: "",
				timestamp: new Date(0),
				containerStatuses: [runtimeStatus("containerA", { state: "Running" })],
				sandboxStatuses: [],
				ips: [],
			},
			previousStatus: [withStarted(runningState("containerA"), true)],
			containers: [{ name: "containerA" }],
			expected: [withStarted(runningState("containerA"), true)],
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

	it("does not mutate runtime container status order while sorting by creation time", async () => {
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);
		const firstStatus = runtimeStatus("containerA", { createdAt: 1 });
		const secondStatus = runtimeStatus("containerB", { createdAt: 2 });
		const currentStatus: PodRuntimeStatus = {
			id: "",
			name: "",
			namespace: "",
			timestamp: new Date(0),
			containerStatuses: [firstStatus, secondStatus],
			sandboxStatuses: [],
			ips: [],
		};

		try {
			testKubelet.kubelet.convertToAPIContainerStatuses(
				tCtx,
				{ spec: desiredState },
				currentStatus,
				[],
				desiredState.containers,
				undefined,
				false,
				false,
				false,
			);

			expect(currentStatus.containerStatuses).toEqual([firstStatus, secondStatus]);
		} finally {
			await testKubelet.cleanup();
		}
	});

	// Simulator only test.
	it("orders regular statuses by name and init statuses by pod spec order", async () => {
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);
		const pod: V1Pod = {
			spec: {
				initContainers: [{ name: "initB" }, { name: "initA" }],
				containers: [{ name: "containerB" }, { name: "containerA" }],
			},
		};
		const currentStatus: PodRuntimeStatus = {
			id: "",
			name: "",
			namespace: "",
			timestamp: new Date(0),
			containerStatuses: [
				runtimeStatus("containerB"),
				runtimeStatus("containerA"),
				runtimeStatus("initA", { state: "Exited", exitCode: 0 }),
				runtimeStatus("initB", { state: "Exited", exitCode: 0 }),
			],
			sandboxStatuses: [],
			ips: [],
		};

		try {
			const regularStatuses = testKubelet.kubelet.convertToAPIContainerStatuses(
				tCtx,
				pod,
				currentStatus,
				[],
				pod.spec?.containers ?? [],
				undefined,
				false,
				false,
				false,
			);
			const initStatuses = testKubelet.kubelet.convertToAPIContainerStatuses(
				tCtx,
				pod,
				currentStatus,
				[],
				pod.spec?.initContainers ?? [],
				undefined,
				true,
				true,
				false,
			);

			expect(regularStatuses.map((status) => status.name)).toEqual(["containerA", "containerB"]);
			expect(initStatuses.map((status) => status.name)).toEqual(["initB", "initA"]);
		} finally {
			await testKubelet.cleanup();
		}
	});

	it("propagates runtime reported container user", async () => {
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);
		const pod: V1Pod = {
			spec: {
				containers: [{ name: "containerA" }],
			},
		};
		const currentStatus: PodRuntimeStatus = {
			id: "",
			name: "",
			namespace: "",
			timestamp: new Date(0),
			containerStatuses: [
				runtimeStatus("containerA", {
					user: {
						linux: {
							uid: 1000,
							gid: 1001,
							supplementalGroups: [1002, 1003],
						},
					},
				}),
			],
			sandboxStatuses: [],
			ips: [],
		};

		try {
			const statuses = testKubelet.kubelet.convertToAPIContainerStatuses(
				tCtx,
				pod,
				currentStatus,
				[],
				pod.spec?.containers ?? [],
				undefined,
				false,
				false,
				false,
			);

			expect(statuses[0]?.user).toEqual({
				linux: {
					uid: 1000,
					gid: 1001,
					supplementalGroups: [1002, 1003],
				},
			});
		} finally {
			await testKubelet.cleanup();
		}
	});
});

// Models kubernetes/pkg/kubelet/prober/prober_manager.go UpdatePodStatus.
browser.describe("probeManagerUpdatePodStatus", () => {
	it("preserves old started true for a running container with a pending startup probe when kubelet restart status changes are disabled", async () => {
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);
		const pod: V1Pod = {
			metadata: {
				uid: "pod-uid",
				name: "pod-name",
				namespace: "pod-namespace",
			},
			spec: {
				containers: [
					{
						name: "containerA",
						startupProbe: {
							exec: { command: ["true"] },
						},
					},
				],
			},
		};
		const podStatus: V1PodStatus = {
			containerStatuses: [
				withStarted(
					withID(
						runningStateWithStartedAt("containerA", testKubelet.fakeClock.now()),
						"test://containerA",
					),
					true,
				),
			],
		};
		const probeManager = new ProbeManagerImpl(
			tCtx,
			testKubelet.kubelet.statusManager,
			new ResultsManager(),
			new ResultsManager(),
			new ResultsManager(),
			new FakeContainerCommandRunner(),
			testKubelet.kubelet.recorder,
			testKubelet.fakeClock,
			new ClusterNetwork(),
		);

		try {
			probeManager.addPod(tCtx, pod);
			probeManager.updatePodStatus(tCtx, pod, podStatus);

			expect(podStatus.containerStatuses?.[0]?.started).toBe(true);
		} finally {
			await probeManager.close();
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
			const actual = await kl.generateAPIPodStatus(
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

			const actual = await testKubelet.kubelet.generateAPIPodStatus(
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
			const status = await kl.generateAPIPodStatus(
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

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestTruncatePodHostname.
browser.describe("truncatePodHostname", () => {
	const testcases: Array<{
		name: string;
		input: string;
		output: string;
	}> = [
		{
			name: "valid hostname",
			input: "test.pod.hostname",
			output: "test.pod.hostname",
		},
		{
			name: "too long hostname",
			input: "1234567.1234567.1234567.1234567.1234567.1234567.1234567.1234567.1234567.",
			output: "1234567.1234567.1234567.1234567.1234567.1234567.1234567.1234567",
		},
		{
			name: "hostname end with .",
			input: "1234567.1234567.1234567.1234567.1234567.1234567.1234567.123456.1234567.",
			output: "1234567.1234567.1234567.1234567.1234567.1234567.1234567.123456",
		},
		{
			name: "hostname end with -",
			input: "1234567.1234567.1234567.1234567.1234567.1234567.1234567.123456-1234567.",
			output: "1234567.1234567.1234567.1234567.1234567.1234567.1234567.123456",
		},
	];

	it.each(testcases)("$name", (test) => {
		const [output, err] = truncatePodHostnameIfNeeded("test-pod", test.input);

		expect(err).toBeUndefined();
		expect(output).toBe(test.output);
	});
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestGenerateAPIPodStatusHostNetworkPodIPs.
browser.describe("generateAPIPodStatusHostNetworkPodIPs", () => {
	const testcases: Array<{
		name: string;
		nodeAddresses: V1NodeAddress[];
		criPodIPs?: string[];
		podIPs: Array<{ ip: string }>;
	}> = [
		{
			name: "Simple",
			nodeAddresses: [{ type: "InternalIP", address: "10.0.0.1" }],
			podIPs: [{ ip: "10.0.0.1" }],
		},
		{
			name: "InternalIP is preferred over ExternalIP",
			nodeAddresses: [
				{ type: "ExternalIP", address: "192.168.0.1" },
				{ type: "InternalIP", address: "10.0.0.1" },
			],
			podIPs: [{ ip: "10.0.0.1" }],
		},
		{
			name: "Single-stack addresses in dual-stack cluster",
			nodeAddresses: [{ type: "InternalIP", address: "10.0.0.1" }],
			podIPs: [{ ip: "10.0.0.1" }],
		},
		{
			name: "Multiple single-stack addresses in dual-stack cluster",
			nodeAddresses: [
				{ type: "InternalIP", address: "10.0.0.1" },
				{ type: "InternalIP", address: "10.0.0.2" },
				{ type: "ExternalIP", address: "192.168.0.1" },
			],
			podIPs: [{ ip: "10.0.0.1" }],
		},
		{
			name: "Dual-stack addresses in dual-stack cluster",
			nodeAddresses: [
				{ type: "InternalIP", address: "10.0.0.1" },
				{ type: "InternalIP", address: "fd01::1234" },
			],
			podIPs: [{ ip: "10.0.0.1" }, { ip: "fd01::1234" }],
		},
		{
			name: "CRI PodIPs override NodeAddresses",
			nodeAddresses: [
				{ type: "InternalIP", address: "10.0.0.1" },
				{ type: "InternalIP", address: "fd01::1234" },
			],
			criPodIPs: ["192.168.0.1"],
			podIPs: [{ ip: "192.168.0.1" }, { ip: "fd01::1234" }],
		},
		{
			name: "CRI dual-stack PodIPs override NodeAddresses",
			nodeAddresses: [
				{ type: "InternalIP", address: "10.0.0.1" },
				{ type: "InternalIP", address: "fd01::1234" },
			],
			criPodIPs: ["192.168.0.1", "2001:db8::2"],
			podIPs: [{ ip: "192.168.0.1" }, { ip: "2001:db8::2" }],
		},
		{
			name: "CRI dual-stack PodIPs override NodeAddresses prefer IPv4",
			nodeAddresses: [
				{ type: "InternalIP", address: "10.0.0.1" },
				{ type: "InternalIP", address: "fd01::1234" },
			],
			criPodIPs: ["2001:db8::2", "192.168.0.1"],
			podIPs: [{ ip: "192.168.0.1" }, { ip: "2001:db8::2" }],
		},
	];

	it.each(testcases)("$name", async (test) => {
		const tCtx = context.background();
		const testKubelet = newTestKubelet(false);
		try {
			const kl = testKubelet.kubelet;
			const node = {
				metadata: { name: "test-node" },
				status: { addresses: test.nodeAddresses },
			};
			kl.nodeLister = {
				get: async () => [node, undefined],
				list: async (_selector: Selector) => [[node], undefined],
			};
			kl.cachedNode = node;
			const pod = podWithUIDNameNs("12345", "test-pod", "test-namespace");
			pod.spec = {
				containers: [],
				hostNetwork: true,
			};
			const status = await kl.generateAPIPodStatus(
				tCtx,
				pod,
				{
					id: pod.metadata?.uid ?? "",
					name: pod.metadata?.name ?? "",
					namespace: pod.metadata?.namespace ?? "",
					ips: test.criPodIPs ?? [],
					containerStatuses: [],
					sandboxStatuses: [],
					timestamp: new Date(0),
				},
				false,
			);

			expect(status.podIPs).toEqual(test.podIPs);
			expect(status.podIP).toBe(test.podIPs[0]?.ip);
			if (test.criPodIPs === undefined) {
				expect(status.hostIP).toBe(status.podIPs?.[0]?.ip);
			}
		} finally {
			await testKubelet.cleanup();
		}
	});
});

// Models kubernetes/pkg/kubelet/kubelet_pods_test.go TestSortPodIPs.
browser.describe("sortPodIPs", () => {
	const testcases: Array<{
		name: string;
		nodeIP: string;
		podIPs: string[];
		expectedIPs: string[];
	}> = [
		{
			name: "Simple",
			nodeIP: "",
			podIPs: ["10.0.0.1"],
			expectedIPs: ["10.0.0.1"],
		},
		{
			name: "Dual-stack",
			nodeIP: "",
			podIPs: ["10.0.0.1", "fd01::1234"],
			expectedIPs: ["10.0.0.1", "fd01::1234"],
		},
		{
			name: "Dual-stack with explicit node IP",
			nodeIP: "192.168.1.1",
			podIPs: ["10.0.0.1", "fd01::1234"],
			expectedIPs: ["10.0.0.1", "fd01::1234"],
		},
		{
			name: "Dual-stack with CRI returning wrong family first",
			nodeIP: "",
			podIPs: ["fd01::1234", "10.0.0.1"],
			expectedIPs: ["10.0.0.1", "fd01::1234"],
		},
		{
			name: "Dual-stack with explicit node IP with CRI returning wrong family first",
			nodeIP: "192.168.1.1",
			podIPs: ["fd01::1234", "10.0.0.1"],
			expectedIPs: ["10.0.0.1", "fd01::1234"],
		},
		{
			name: "Dual-stack with IPv6 node IP",
			nodeIP: "fd00::5678",
			podIPs: ["10.0.0.1", "fd01::1234"],
			expectedIPs: ["fd01::1234", "10.0.0.1"],
		},
		{
			name: "Dual-stack with IPv6 node IP, other CRI order",
			nodeIP: "fd00::5678",
			podIPs: ["fd01::1234", "10.0.0.1"],
			expectedIPs: ["fd01::1234", "10.0.0.1"],
		},
		{
			name: "No Pod IP matching Node IP",
			nodeIP: "fd00::5678",
			podIPs: ["10.0.0.1"],
			expectedIPs: ["10.0.0.1"],
		},
		{
			name: "No Pod IP matching (unspecified) Node IP",
			nodeIP: "",
			podIPs: ["fd01::1234"],
			expectedIPs: ["fd01::1234"],
		},
		{
			name: "Multiple IPv4 IPs",
			nodeIP: "",
			podIPs: ["10.0.0.1", "10.0.0.2", "10.0.0.3"],
			expectedIPs: ["10.0.0.1"],
		},
		{
			name: "Multiple Dual-Stack IPs",
			nodeIP: "",
			podIPs: ["10.0.0.1", "10.0.0.2", "fd01::1234", "10.0.0.3", "fd01::5678"],
			expectedIPs: ["10.0.0.1", "fd01::1234"],
		},
		{
			name: "Badly-formatted IPs from CRI",
			nodeIP: "",
			podIPs: ["010.000.000.001", "fd01:0:0:0:0:0:0:1234"],
			expectedIPs: ["10.0.0.1", "fd01::1234"],
		},
	];

	it.each(testcases)("$name", async (test) => {
		const testKubelet = newTestKubelet(false);
		try {
			const kl = testKubelet.kubelet;
			if (test.nodeIP !== "") {
				kl.nodeIPs = [test.nodeIP];
			}

			const podIPs = kl.sortPodIPs(test.podIPs);

			expect(podIPs).toEqual(test.expectedIPs);
		} finally {
			await testKubelet.cleanup();
		}
	});
});
