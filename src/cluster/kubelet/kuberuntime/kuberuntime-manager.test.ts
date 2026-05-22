// oxlint-disable jest/expect-expect
// oxlint-disable jest/no-conditional-expect
import { expect, it } from "vitest";
import type { V1Container, V1Pod } from "../../../client";
import { newBackOff, type Backoff } from "../../../client-go/util/flowcontrol/backoff";
import { Clock } from "../../../clock";
import { KeyFnMap } from "../../../collections";
import * as context from "../../../go/context";
import { browser } from "../../../test/describe";
import type {
	ContainerConfig,
	ContainerStatus,
	PodSandboxConfig,
	PodRuntimeStatus,
	PodSandboxStatus,
	RuntimeService,
} from "../../cri";
import type {
	CheckpointContainerRequest,
	Container as CRIContainer,
	ContainerStatusResponse,
	MetricDescriptor,
	PodSandbox,
	PodSandboxMetrics,
	PodSandboxStatusResponse,
	UpdateRuntimeConfigRequest,
	VersionResponse,
} from "../../cri/runtime/v1/api";
import {
	buildContainerID,
	convertPodStatusToRunningPod,
	type ContainerID,
	errPodNotFound,
	hashContainer,
	newBackoffError,
	type RuntimeHelper,
	type Pod as RuntimePod,
} from "../container";
import type { InternalContainerLifecycle } from "../cm";
import { ResultsManager } from "../prober/results";
import {
	KubeGenericRuntimeManager,
	type KubeGenericRuntimeManagerOptions,
	type PodActions,
} from "./kuberuntime-manager";
import { getBackoffKey } from "./helpers";

browser.describe("KubeGenericRuntimeManager", () => {
	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestNewKubeRuntimeManager.
	it("TestNewKubeRuntimeManager", () => {
		const tCtx = context.background();
		const [, , , err] = createTestRuntimeManager(tCtx);

		expect(err).toBeUndefined();
	});

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestVersion.
	it("TestVersion", async () => {
		const tCtx = context.background();
		const [, , m, err] = createTestRuntimeManager(tCtx);
		expect(err).toBeUndefined();

		const [version, versionErr] = await m.version(tCtx);

		expect(versionErr).toBeUndefined();
		expect(version?.toString()).toBe("0.1.0");
	});

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestContainerRuntimeType.
	it("TestContainerRuntimeType", () => {
		const tCtx = context.background();
		const [, , m, err] = createTestRuntimeManager(tCtx);
		expect(err).toBeUndefined();

		const runtimeType = m.type();
		expect(runtimeType).toBe("simulator");
	});
});

browser.describe("KubeGenericRuntimeManager runtime state", () => {
	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestGetPodStatus.
	it("TestGetPodStatus", async () => {
		const tCtx = context.background();
		const [fakeRuntime, , m, err] = createTestRuntimeManager(tCtx);
		expect(err).toBeUndefined();
		const containers: V1Container[] = [
			{ name: "foo1", image: "busybox", imagePullPolicy: "IfNotPresent" },
			{ name: "foo2", image: "busybox", imagePullPolicy: "IfNotPresent" },
		];
		const pod: V1Pod = {
			metadata: { uid: "12345678", name: "foo", namespace: "new" },
			spec: { containers },
		};

		makeAndSetFakePod(tCtx, m, fakeRuntime, pod);

		const [runtimePod, getPodErr] = await m.getPod(tCtx, pod.metadata?.uid ?? "");
		expect(getPodErr).toBeUndefined();
		const [podStatus, statusErr] = await m.getPodStatus(tCtx, runtimePod as RuntimePod);

		expect(statusErr).toBeUndefined();
		expect(podStatus?.id).toBe(pod.metadata?.uid);
		expect(podStatus?.name).toBe(pod.metadata?.name);
		expect(podStatus?.namespace).toBe(pod.metadata?.namespace);
		expect(podStatus?.ips).toEqual(fakePodSandboxIPs);
	});

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestStopContainerWithNotFoundError.
	it("TestStopContainerWithNotFoundError", async () => {
		const tCtx = context.background();
		const [fakeRuntime, , m, err] = createTestRuntimeManager(tCtx);
		expect(err).toBeUndefined();
		const containers: V1Container[] = [
			{ name: "foo1", image: "busybox", imagePullPolicy: "IfNotPresent" },
			{ name: "foo2", image: "busybox", imagePullPolicy: "IfNotPresent" },
		];
		const pod: V1Pod = {
			metadata: { uid: "12345678", name: "foo", namespace: "new" },
			spec: { containers },
		};

		makeAndSetFakePod(tCtx, m, fakeRuntime, pod);
		fakeRuntime.injectError(
			"StopContainer",
			new Error("rpc error: code = NotFound desc = No such container"),
		);
		const [runtimePod, getPodErr] = await m.getPod(tCtx, pod.metadata?.uid ?? "");
		expect(getPodErr).toBeUndefined();
		const [podStatus, statusErr] = await m.getPodStatus(tCtx, runtimePod as RuntimePod);
		expect(statusErr).toBeUndefined();
		const p = convertPodStatusToRunningPod("", podStatus as PodRuntimeStatus);
		const gracePeriod = 1;

		const killErr = await m.killPod(tCtx, pod, p, gracePeriod);

		expect(killErr).toBeUndefined();
	});

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestGetPodStatusWithNotFoundError.
	it("TestGetPodStatusWithNotFoundError", async () => {
		const tCtx = context.background();
		const [fakeRuntime, , m, err] = createTestRuntimeManager(tCtx);
		expect(err).toBeUndefined();
		const containers: V1Container[] = [
			{ name: "foo1", image: "busybox", imagePullPolicy: "IfNotPresent" },
			{ name: "foo2", image: "busybox", imagePullPolicy: "IfNotPresent" },
		];
		const pod: V1Pod = {
			metadata: { uid: "12345678", name: "foo", namespace: "new" },
			spec: { containers },
		};

		makeAndSetFakePod(tCtx, m, fakeRuntime, pod);
		fakeRuntime.injectError(
			"ContainerStatus",
			new Error("rpc error: code = NotFound desc = No such container"),
		);
		const [runtimePod, getPodErr] = await m.getPod(tCtx, pod.metadata?.uid ?? "");
		expect(getPodErr).toBeUndefined();
		const [podStatus, statusErr] = await m.getPodStatus(tCtx, runtimePod as RuntimePod);

		expect(statusErr).toBeUndefined();
		expect(podStatus?.id).toBe(pod.metadata?.uid);
		expect(podStatus?.name).toBe(pod.metadata?.name);
		expect(podStatus?.namespace).toBe(pod.metadata?.namespace);
		expect(podStatus?.ips).toEqual(fakePodSandboxIPs);
	});

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestGetPods.
	it("TestGetPods", async () => {
		const tCtx = context.background();
		const [fakeRuntime, , m, err] = createTestRuntimeManager(tCtx);
		expect(err).toBeUndefined();
		const pod = {
			metadata: { uid: "12345678", name: "foo", namespace: "new" },
			spec: {
				containers: [
					{ name: "foo1", image: "busybox" },
					{ name: "foo2", image: "busybox" },
				],
			},
		} satisfies V1Pod;

		const [fakeSandbox, fakeContainers] = makeAndSetFakePod(tCtx, m, fakeRuntime, pod);

		const containers = fakeContainers.map((fakeContainer) => ({
			id: buildContainerID(m.type(), fakeContainer.id),
			name: fakeContainer.metadata.name,
			image: fakeContainer.image.image,
			imageID: fakeContainer.imageId,
			imageRef: fakeContainer.imageRef,
			imageRuntimeHandler: fakeContainer.image.runtimeHandler ?? "",
			hash: fakeContainer.hash,
			state: fakeContainer.state,
			podSandboxID: fakeSandbox.id,
			createdAt: fakeCreatedAt,
		}));
		const sandbox = {
			id: buildContainerID(m.type(), fakeSandbox.id),
			name: "",
			image: "",
			imageID: "",
			imageRef: "",
			imageRuntimeHandler: "",
			hash: 0,
			state: "Running" as const,
			podSandboxID: fakeSandbox.id,
			createdAt: fakeSandbox.createdAt,
		};
		const expectedPod: RuntimePod = {
			id: "12345678",
			name: "foo",
			namespace: "new",
			createdAt: fakeSandbox.createdAt,
			containers,
			sandboxes: [sandbox],
			timestamp: new Date(0),
		};
		const expected = [expectedPod];

		const [actual, getPodsErr] = await m.getPods(tCtx, false);
		expect(getPodsErr).toBeUndefined();
		expect(actual.map(withoutTimestamp)).toEqual(expected.map(withoutTimestamp));

		const [actualPod, getPodErr] = await m.getPod(tCtx, pod.metadata.uid);
		expect(getPodErr).toBeUndefined();
		expect(withoutTimestamp(actualPod)).toEqual(withoutTimestamp(expectedPod));

		const [, missingErr] = await m.getPod(tCtx, "non-existent-uid");
		expect(missingErr).toBe(errPodNotFound);
	});

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestGetPodsSorted.
	it("TestGetPodsSorted", async () => {
		const tCtx = context.background();
		const [fakeRuntime, , m, err] = createTestRuntimeManager(tCtx);
		expect(err).toBeUndefined();
		const pod: V1Pod = { metadata: { name: "foo", namespace: "bar" } };
		const createdTimestamps = [10, 5, 20];
		const fakeSandboxes: TestPodSandboxRecord[] = [];
		for (const [i, createdAt] of createdTimestamps.entries()) {
			pod.metadata = { ...pod.metadata, uid: String(i) };
			fakeSandboxes.push(
				makeFakePodSandbox(tCtx, m, {
					pod,
					createdAt,
					state: "Ready",
				}),
			);
		}
		fakeRuntime.setFakeSandboxes(fakeSandboxes);

		const [actual, getPodsErr] = await m.getPods(tCtx, false);

		expect(getPodsErr).toBeUndefined();
		expect(actual).toHaveLength(3);
		expect(actual[0]?.createdAt).toBe(createdTimestamps[2]);
		expect(actual[1]?.createdAt).toBe(createdTimestamps[0]);
		expect(actual[2]?.createdAt).toBe(createdTimestamps[1]);
	});

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestKillPod.
	it("TestKillPod", async () => {
		const tCtx = context.background();
		const [fakeRuntime, , m, err] = createTestRuntimeManager(tCtx);
		expect(err).toBeUndefined();
		const pod: V1Pod = {
			metadata: { uid: "12345678", name: "foo", namespace: "new" },
			spec: {
				containers: [
					{ name: "foo1", image: "busybox" },
					{ name: "foo2", image: "busybox" },
				],
			},
		};

		const [fakeSandbox, fakeContainers] = makeAndSetFakePod(tCtx, m, fakeRuntime, pod);

		const containers: RuntimePod["containers"] = new Array(fakeContainers.length);
		for (const i of containers.keys()) {
			const fakeContainer = fakeContainers[i] as TestContainerRecord;
			const c: RuntimePod["containers"][number] = {
				id: buildContainerID(m.type(), fakeContainer.id),
				name: fakeContainer.metadata.name,
				image: fakeContainer.image.image,
				imageID: fakeContainer.imageId,
				imageRef: fakeContainer.imageRef,
				imageRuntimeHandler: "",
				hash: 0,
				state: fakeContainer.state,
				podSandboxID: fakeContainer.podSandboxId,
				createdAt: fakeContainer.createdAt,
			};
			containers[i] = c;
		}
		const runningPod: RuntimePod = {
			id: pod.metadata?.uid ?? "",
			name: pod.metadata?.name ?? "",
			namespace: pod.metadata?.namespace ?? "default",
			createdAt: fakeCreatedAt,
			timestamp: new Date(0),
			containers,
			sandboxes: [
				{
					id: buildContainerID(m.type(), fakeSandbox.id),
					name: "",
					image: "",
					imageID: "",
					imageRef: "",
					imageRuntimeHandler: "",
					hash: 0,
					state: "Running",
					podSandboxID: fakeSandbox.id,
					createdAt: fakeSandbox.createdAt,
				},
			],
		};

		const killErr = await m.killPod(tCtx, pod, runningPod, undefined);

		expect(killErr).toBeUndefined();
		// Upstream also kills one ephemeral container here. The simulator does not
		// model ephemeral containers, so this assertion covers regular containers only.
		expect(fakeRuntime.containers).toHaveLength(2);
		expect(fakeRuntime.sandboxes).toHaveLength(1);
		expect(fakeRuntime.sandboxes.every((sandbox) => sandbox.state === "NotReady")).toBe(true);
		expect(fakeRuntime.containers.every((container) => container.state === "Exited")).toBe(true);
	});

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestSyncPod.
	it("TestSyncPod", async () => {
		const tCtx = context.background();
		const [fakeRuntime, fakeImage, m, err] = createTestRuntimeManager(tCtx);
		expect(err).toBeUndefined();
		const containers: V1Container[] = [
			{ name: "foo1", image: "busybox", imagePullPolicy: "IfNotPresent" },
			{ name: "foo2", image: "alpine", imagePullPolicy: "IfNotPresent" },
		];
		const pod: V1Pod = {
			metadata: { uid: "12345678", name: "foo", namespace: "new" },
			spec: { containers },
		};

		const result = await m.syncPod(
			tCtx,
			pod,
			emptyPodStatus(),
			[],
			newBackOff(1000, 60_000, new Clock()),
			false,
		);

		expect(result.error()).toBeUndefined();
		expect(fakeRuntime.containers).toHaveLength(2);
		expect(fakeImage.images).toHaveLength(2);
		expect(fakeRuntime.sandboxes).toHaveLength(1);
		expect(fakeRuntime.sandboxes.every((sandbox) => sandbox.state === "Ready")).toBe(true);
		expect(fakeRuntime.containers.every((container) => container.state === "Running")).toBe(true);
	});

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestSyncPodWithConvertedPodSysctls.
	it("TestSyncPodWithConvertedPodSysctls", async () => {
		const tCtx = context.background();
		const [fakeRuntime, , m, err] = createTestRuntimeManager(tCtx);
		expect(err).toBeUndefined();

		const containers: V1Container[] = [
			{ name: "foo", image: "busybox", imagePullPolicy: "IfNotPresent" },
		];

		const securityContext = {
			sysctls: [
				{
					name: "kernel/shm_rmid_forced",
					value: "1",
				},
				{
					name: "net/ipv4/ip_local_port_range",
					value: "1024 65535",
				},
			],
		};
		const exceptSysctls = [
			{
				name: "kernel.shm_rmid_forced",
				value: "1",
			},
			{
				name: "net.ipv4.ip_local_port_range",
				value: "1024 65535",
			},
		];
		const pod: V1Pod = {
			metadata: { uid: "12345678", name: "foo", namespace: "new" },
			spec: {
				containers,
				securityContext,
			},
		};

		const backOff = newBackOff(1000, 60_000, new Clock());
		const result = await m.syncPod(tCtx, pod, emptyPodStatus(), [], backOff, false);

		expect(result.error()).toBeUndefined();
		expect(pod.spec?.securityContext?.sysctls).toEqual(exceptSysctls);
		expect(fakeRuntime.sandboxes.every((sandbox) => sandbox.state === "Ready")).toBe(true);
		expect(fakeRuntime.containers.every((container) => container.state === "Running")).toBe(true);
	});

	// Upstream kuberuntime_manager_test.go also has these tests in this region:
	// TestPruneInitContainers, TestSyncPodWithInitContainers, and
	// TestSyncPodWithRestartAllContainers. They are intentionally not executable
	// here because this simulator's kuberuntime scope excludes init containers.
	// TestSyncPodWithSandboxAndDeletedPod depends on kubelet pod-state-provider
	// deleted-pod bookkeeping, which is also outside this runtime manager model.
});

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestComputePodActions.
browser.describe("KubeGenericRuntimeManager.computePodActions", () => {
	const [, , m, err, , livenessManager, startupManager] = createTestRuntimeManager(
		context.background(),
	);
	if (err) {
		throw err;
	}
	const [basePod, baseStatus] = makeBasePodAndStatus();
	const noAction: PodActions = podActions({
		sandboxID: baseStatus.sandboxStatuses[0]?.id,
		containersToStart: [],
		containersToKill: newContainerToKillMap(),
	});

	it.each([
		{
			name: "everything is good; do nothing",
			actions: noAction,
		},
		{
			name: "start pod sandbox and all containers for a new pod",
			mutateStatusFn: (status: PodRuntimeStatus) => {
				status.sandboxStatuses = [];
				status.containerStatuses = [];
			},
			actions: podActions({
				killPod: true,
				createSandbox: true,
				attempt: 0,
				containersToStart: [0, 1, 2],
				containersToKill: getKillMap(basePod, baseStatus, []),
			}),
		},
		{
			name: "restart exited containers if RestartPolicy == Always",
			mutatePodFn: (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Always";
				}
			},
			mutateStatusFn: (status: PodRuntimeStatus) => {
				status.containerStatuses[0] = {
					...(status.containerStatuses[0] as ContainerStatus),
					state: "Exited",
					exitCode: 0,
				};
				status.containerStatuses[1] = {
					...(status.containerStatuses[1] as ContainerStatus),
					state: "Exited",
					exitCode: 111,
				};
			},
			actions: podActions({
				sandboxID: baseStatus.sandboxStatuses[0]?.id,
				containersToStart: [0, 1],
				containersToKill: getKillMap(basePod, baseStatus, []),
			}),
		},
		{
			name: "restart failed containers if RestartPolicy == OnFailure",
			mutatePodFn: (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "OnFailure";
				}
			},
			mutateStatusFn: (status: PodRuntimeStatus) => {
				status.containerStatuses[0] = {
					...(status.containerStatuses[0] as ContainerStatus),
					state: "Exited",
					exitCode: 0,
				};
				status.containerStatuses[1] = {
					...(status.containerStatuses[1] as ContainerStatus),
					state: "Exited",
					exitCode: 111,
				};
			},
			actions: podActions({
				sandboxID: baseStatus.sandboxStatuses[0]?.id,
				containersToStart: [1],
				containersToKill: getKillMap(basePod, baseStatus, []),
			}),
		},
		{
			name: "restart created but not started containers if RestartPolicy == OnFailure",
			mutatePodFn: (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "OnFailure";
				}
			},
			mutateStatusFn: (status: PodRuntimeStatus) => {
				status.containerStatuses[0] = {
					...(status.containerStatuses[0] as ContainerStatus),
					state: "Exited",
					exitCode: 0,
				};
				status.containerStatuses[1] = {
					...(status.containerStatuses[1] as ContainerStatus),
					state: "Created",
				};
			},
			actions: podActions({
				sandboxID: baseStatus.sandboxStatuses[0]?.id,
				containersToStart: [1],
				containersToKill: getKillMap(basePod, baseStatus, []),
			}),
		},
		{
			name: "don't restart containers if RestartPolicy == Never",
			mutatePodFn: (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
			},
			mutateStatusFn: (status: PodRuntimeStatus) => {
				status.containerStatuses[0] = {
					...(status.containerStatuses[0] as ContainerStatus),
					state: "Exited",
					exitCode: 0,
				};
				status.containerStatuses[1] = {
					...(status.containerStatuses[1] as ContainerStatus),
					state: "Exited",
					exitCode: 111,
				};
			},
			actions: noAction,
		},
		{
			name: "Kill pod and recreate everything if the pod sandbox is dead, and RestartPolicy == Always",
			mutatePodFn: (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Always";
				}
			},
			mutateStatusFn: (status: PodRuntimeStatus) => {
				status.sandboxStatuses[0] = {
					...(status.sandboxStatuses[0] as PodSandboxStatus),
					state: "NotReady",
				};
			},
			actions: podActions({
				killPod: true,
				createSandbox: true,
				sandboxID: baseStatus.sandboxStatuses[0]?.id,
				attempt: 1,
				containersToStart: [0, 1, 2],
				containersToKill: getKillMap(basePod, baseStatus, []),
			}),
		},
		{
			name: "Kill pod and recreate all containers (except for the succeeded one) if the pod sandbox is dead, and RestartPolicy == OnFailure",
			mutatePodFn: (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "OnFailure";
				}
			},
			mutateStatusFn: (status: PodRuntimeStatus) => {
				status.sandboxStatuses[0] = {
					...(status.sandboxStatuses[0] as PodSandboxStatus),
					state: "NotReady",
				};
				status.containerStatuses[1] = {
					...(status.containerStatuses[1] as ContainerStatus),
					state: "Exited",
					exitCode: 0,
				};
			},
			actions: podActions({
				killPod: true,
				createSandbox: true,
				sandboxID: baseStatus.sandboxStatuses[0]?.id,
				attempt: 1,
				containersToStart: [0, 2],
				containersToKill: getKillMap(basePod, baseStatus, []),
			}),
		},
		{
			name: "Kill pod and recreate all containers if the PodSandbox does not have an IP",
			mutateStatusFn: (status: PodRuntimeStatus) => {
				status.sandboxStatuses[0] = {
					...(status.sandboxStatuses[0] as PodSandboxStatus),
					network: { ip: "" },
				};
			},
			actions: podActions({
				killPod: true,
				createSandbox: true,
				sandboxID: baseStatus.sandboxStatuses[0]?.id,
				attempt: 1,
				containersToStart: [0, 1, 2],
				containersToKill: getKillMap(basePod, baseStatus, []),
			}),
		},
		{
			name: "Kill and recreate the container if the container's spec changed",
			mutatePodFn: (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Always";
				}
			},
			mutateStatusFn: (status: PodRuntimeStatus) => {
				status.containerStatuses[1] = {
					...(status.containerStatuses[1] as ContainerStatus),
					hash: 432423432,
				};
			},
			actions: podActions({
				sandboxID: baseStatus.sandboxStatuses[0]?.id,
				containersToStart: [1],
				containersToKill: getKillMap(basePod, baseStatus, [1]),
			}),
		},
		{
			name: "Kill and recreate the container if the liveness check has failed",
			mutatePodFn: (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Always";
				}
			},
			mutateStatusFn: (status: PodRuntimeStatus) => {
				void livenessManager.set(
					(status.containerStatuses[1] as ContainerStatus).id,
					"failure",
					basePod,
				);
			},
			actions: podActions({
				sandboxID: baseStatus.sandboxStatuses[0]?.id,
				containersToStart: [1],
				containersToKill: getKillMap(basePod, baseStatus, [1]),
			}),
			resetStatusFn: (status: PodRuntimeStatus) => {
				livenessManager.remove((status.containerStatuses[1] as ContainerStatus).id);
			},
		},
		{
			name: "Kill and recreate the container if the startup check has failed",
			mutatePodFn: (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Always";
				}
			},
			mutateStatusFn: (status: PodRuntimeStatus) => {
				void startupManager.set(
					(status.containerStatuses[1] as ContainerStatus).id,
					"failure",
					basePod,
				);
			},
			actions: podActions({
				sandboxID: baseStatus.sandboxStatuses[0]?.id,
				containersToStart: [1],
				containersToKill: getKillMap(basePod, baseStatus, [1]),
			}),
			resetStatusFn: (status: PodRuntimeStatus) => {
				startupManager.remove((status.containerStatuses[1] as ContainerStatus).id);
			},
		},
		{
			name: "Verify we do not create a pod sandbox if no ready sandbox for pod with RestartPolicy=Never and all containers exited",
			mutatePodFn: (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
			},
			mutateStatusFn: (status: PodRuntimeStatus) => {
				status.sandboxStatuses[0] = {
					...(status.sandboxStatuses[0] as PodSandboxStatus),
					state: "NotReady",
					metadata: { ...(status.sandboxStatuses[0] as PodSandboxStatus).metadata, attempt: 1 },
				};
				status.containerStatuses = status.containerStatuses.map((containerStatus) => ({
					...containerStatus,
					state: "Exited",
					exitCode: 0,
				}));
			},
			actions: podActions({
				killPod: true,
				createSandbox: false,
				sandboxID: baseStatus.sandboxStatuses[0]?.id,
				attempt: 2,
				containersToStart: [],
				containersToKill: newContainerToKillMap(),
			}),
		},
		{
			name: "Verify we do not create a pod sandbox if no ready sandbox for pod with RestartPolicy=OnFailure and all containers succeeded",
			mutatePodFn: (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "OnFailure";
				}
			},
			mutateStatusFn: (status: PodRuntimeStatus) => {
				status.sandboxStatuses[0] = {
					...(status.sandboxStatuses[0] as PodSandboxStatus),
					state: "NotReady",
					metadata: { ...(status.sandboxStatuses[0] as PodSandboxStatus).metadata, attempt: 1 },
				};
				status.containerStatuses = status.containerStatuses.map((containerStatus) => ({
					...containerStatus,
					state: "Exited",
					exitCode: 0,
				}));
			},
			actions: podActions({
				killPod: true,
				createSandbox: false,
				sandboxID: baseStatus.sandboxStatuses[0]?.id,
				attempt: 2,
				containersToStart: [],
				containersToKill: newContainerToKillMap(),
			}),
		},
		{
			name: "Verify we create a pod sandbox if no ready sandbox for pod with RestartPolicy=Never and no containers have ever been created",
			mutatePodFn: (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
			},
			mutateStatusFn: (status: PodRuntimeStatus) => {
				status.sandboxStatuses[0] = {
					...(status.sandboxStatuses[0] as PodSandboxStatus),
					state: "NotReady",
					metadata: { ...(status.sandboxStatuses[0] as PodSandboxStatus).metadata, attempt: 2 },
				};
				status.containerStatuses = [];
			},
			actions: podActions({
				killPod: true,
				createSandbox: true,
				sandboxID: baseStatus.sandboxStatuses[0]?.id,
				attempt: 3,
				containersToStart: [0, 1, 2],
				containersToKill: newContainerToKillMap(),
			}),
		},
		{
			name: "Kill and recreate the container if the container is in unknown state",
			mutatePodFn: (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
			},
			mutateStatusFn: (status: PodRuntimeStatus) => {
				status.containerStatuses[1] = {
					...(status.containerStatuses[1] as ContainerStatus),
					state: "Unknown",
				};
			},
			actions: podActions({
				sandboxID: baseStatus.sandboxStatuses[0]?.id,
				containersToStart: [1],
				containersToKill: getKillMap(basePod, baseStatus, [1]),
			}),
		},
		{
			name: "Restart the container if the container is in created state",
			mutatePodFn: (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
			},
			mutateStatusFn: (status: PodRuntimeStatus) => {
				status.containerStatuses[1] = {
					...(status.containerStatuses[1] as ContainerStatus),
					state: "Created",
				};
			},
			actions: podActions({
				sandboxID: baseStatus.sandboxStatuses[0]?.id,
				containersToStart: [1],
				containersToKill: newContainerToKillMap(),
			}),
		},
	] satisfies ComputePodActionsCase[])("$name", (test) => {
		const [pod, status] = makeBasePodAndStatus();
		test.mutatePodFn?.(pod);
		test.mutateStatusFn?.(status);

		const actions = m.computePodActions(context.background(), pod, status, false);
		verifyActions(test.actions, actions);
		test.resetStatusFn?.(status);
	});
});

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestComputePodActionsForRestartAllContainers.
browser.describe("KubeGenericRuntimeManager.computePodActions restart all containers", () => {
	const allContainersRestartingTrue = [
		{
			type: "AllContainersRestarting",
			status: "True",
		},
	];
	const allContainersRestartingFalse = [
		{
			type: "AllContainersRestarting",
			status: "False",
		},
	];
	const restartAllContainersRules: NonNullable<V1Container["restartPolicyRules"]> = [
		{
			action: "RestartAllContainers",
			exitCodes: {
				operator: "In",
				values: [1],
			},
		},
	];

	it.each([
		{
			name: "pod not marked for RestartAllContainers",
			podFunc: () => {
				const [pod] = makeBasePodAndStatus();
				pod.status = { conditions: allContainersRestartingFalse };
				return pod;
			},
			podStatusFunc: () => makeBasePodAndStatus()[1],
		},
		{
			name: "pod marked for RestartAllContainers",
			podFunc: () => {
				const [pod] = makeBasePodAndStatus();
				pod.status = { conditions: allContainersRestartingTrue };
				return pod;
			},
			podStatusFunc: () => makeBasePodAndStatus()[1],
			restartAllContainers: true,
			containersToRemove: [
				{
					container: { name: "foo1" },
					containerID: buildContainerID("simulator", "id1"),
					kill: true,
				},
				{
					container: { name: "foo2" },
					containerID: buildContainerID("simulator", "id2"),
					kill: true,
				},
				{
					container: { name: "foo3" },
					containerID: buildContainerID("simulator", "id3"),
					kill: true,
				},
			],
		},
		// Upstream has init-container and restartable-init rows here. The simulator
		// intentionally does not model init containers yet, so those rows are omitted.
		{
			name: "removes past terminated statuses",
			podFunc: () => {
				const [pod] = makeBasePodAndStatus();
				if (pod.spec) {
					pod.spec.restartPolicy = "Always";
					const source = pod.spec.containers?.[2];
					if (source) {
						source.restartPolicy = "Always";
						source.restartPolicyRules = restartAllContainersRules;
					}
				}
				pod.status = { conditions: allContainersRestartingTrue };
				return pod;
			},
			podStatusFunc: () => {
				const [, status] = makeBasePodAndStatus();
				const t1 = Date.now();
				const t0 = t1 - 60_000;
				status.containerStatuses[0].createdAt = t1;
				status.containerStatuses[1].createdAt = t1;
				status.containerStatuses[2] = {
					...status.containerStatuses[2],
					state: "Exited",
					exitCode: 1,
					createdAt: t1,
				};
				status.containerStatuses.push(
					{
						...containerStatus("foo1", "id1-past", "Exited"),
						exitCode: 99,
						createdAt: t0,
					},
					{
						...containerStatus("foo2", "id2-past", "Exited"),
						exitCode: 99,
						createdAt: t0,
					},
					{
						...containerStatus("foo3", "id3-past", "Exited"),
						exitCode: 99,
						createdAt: t0,
					},
				);
				return status;
			},
			restartAllContainers: true,
			containersToRemove: [
				{
					container: { name: "foo1" },
					containerID: buildContainerID("simulator", "id1"),
					kill: true,
				},
				{
					container: { name: "foo1" },
					containerID: buildContainerID("simulator", "id1-past"),
					kill: false,
				},
				{
					container: { name: "foo2" },
					containerID: buildContainerID("simulator", "id2"),
					kill: true,
				},
				{
					container: { name: "foo2" },
					containerID: buildContainerID("simulator", "id2-past"),
					kill: false,
				},
				{
					container: { name: "foo3" },
					containerID: buildContainerID("simulator", "id3-past"),
					kill: false,
				},
				{
					container: { name: "foo3" },
					containerID: buildContainerID("simulator", "id3"),
					kill: false,
				},
			],
		},
		{
			name: "all containers removed, start regular container",
			podFunc: () => makeBasePodAndStatus()[0],
			podStatusFunc: () => {
				const [, status] = makeBasePodAndStatus();
				status.containerStatuses = [];
				return status;
			},
			containersToStart: [0, 1, 2],
		},
	] satisfies RestartAllContainersCase[])("$name", (test) => {
		const [, , m, err] = createTestRuntimeManager(context.background());
		expect(err).toBeUndefined();
		const pod = test.podFunc();
		const status = test.podStatusFunc();

		const actions = m.computePodActions(
			context.background(),
			pod,
			status,
			test.restartAllContainers ?? false,
		);

		const expected: PodActions = podActions({
			createSandbox: false,
			killPod: false,
			sandboxID: status.sandboxStatuses[0]?.id ?? "",
			containersToKill: newContainerToKillMap(),
			containersToStart: [],
		});
		if (test.containersToStart !== undefined) {
			expected.containersToStart = test.containersToStart;
		}

		const containerSpecByName = new Map<string, V1Container>();
		for (const c of pod.spec?.containers ?? []) {
			containerSpecByName.set(c.name, c);
		}
		for (const info of test.containersToRemove ?? []) {
			const cName = info.container.name;
			info.container = containerSpecByName.get(cName) ?? info.container;
			expected.containersToReset?.push(info);
		}

		verifyActions(expected, actions);
	});
});

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestComputePodActionsWithContainerRestartRules.
browser.describe("KubeGenericRuntimeManager.computePodActions container restart rules", () => {
	const [basePod, baseStatus] = makeBasePodAndStatus();
	const noAction: PodActions = podActions({
		sandboxID: baseStatus.sandboxStatuses[0]?.id,
		containersToStart: [],
		containersToKill: newContainerToKillMap(),
	});

	it.each([
		{
			name: "restart exited containers if RestartPolicy == Always",
			mutatePodFn: (pod: V1Pod) => {
				const containers = pod.spec?.containers ?? [];
				if (containers[0]) {
					containers[0].restartPolicy = "Always";
				}
				if (containers[1]) {
					containers[1].restartPolicy = "Always";
				}
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
			},
			mutateStatusFn: (status: PodRuntimeStatus) => {
				status.containerStatuses[0] = {
					...(status.containerStatuses[0] as ContainerStatus),
					state: "Exited",
					exitCode: 0,
				};
				status.containerStatuses[1] = {
					...(status.containerStatuses[1] as ContainerStatus),
					state: "Exited",
					exitCode: 111,
				};
			},
			actions: podActions({
				sandboxID: baseStatus.sandboxStatuses[0]?.id,
				containersToStart: [0, 1],
				containersToKill: getKillMap(basePod, baseStatus, []),
			}),
		},
		{
			name: "restart failed containers if RestartPolicy == OnFailure",
			mutatePodFn: (pod: V1Pod) => {
				const containers = pod.spec?.containers ?? [];
				if (containers[0]) {
					containers[0].restartPolicy = "OnFailure";
				}
				if (containers[1]) {
					containers[1].restartPolicy = "OnFailure";
				}
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
			},
			mutateStatusFn: (status: PodRuntimeStatus) => {
				status.containerStatuses[0] = {
					...(status.containerStatuses[0] as ContainerStatus),
					state: "Exited",
					exitCode: 0,
				};
				status.containerStatuses[1] = {
					...(status.containerStatuses[1] as ContainerStatus),
					state: "Exited",
					exitCode: 111,
				};
			},
			actions: podActions({
				sandboxID: baseStatus.sandboxStatuses[0]?.id,
				containersToStart: [1],
				containersToKill: getKillMap(basePod, baseStatus, []),
			}),
		},
		{
			name: "restart created but not started containers if RestartPolicy == OnFailure",
			mutatePodFn: (pod: V1Pod) => {
				const containers = pod.spec?.containers ?? [];
				if (containers[0]) {
					containers[0].restartPolicy = "OnFailure";
				}
				if (containers[1]) {
					containers[1].restartPolicy = "OnFailure";
				}
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
			},
			mutateStatusFn: (status: PodRuntimeStatus) => {
				status.containerStatuses[0] = {
					...(status.containerStatuses[0] as ContainerStatus),
					state: "Exited",
					exitCode: 0,
				};
				status.containerStatuses[1] = {
					...(status.containerStatuses[1] as ContainerStatus),
					state: "Created",
				};
			},
			actions: podActions({
				sandboxID: baseStatus.sandboxStatuses[0]?.id,
				containersToStart: [1],
				containersToKill: getKillMap(basePod, baseStatus, []),
			}),
		},
		{
			name: "don't restart containers if RestartPolicy == Never",
			mutatePodFn: (pod: V1Pod) => {
				const containers = pod.spec?.containers ?? [];
				if (containers[0]) {
					containers[0].restartPolicy = "Never";
				}
				if (containers[1]) {
					containers[1].restartPolicy = "Never";
				}
				if (pod.spec) {
					pod.spec.restartPolicy = "Always";
				}
			},
			mutateStatusFn: (status: PodRuntimeStatus) => {
				status.containerStatuses[0] = {
					...(status.containerStatuses[0] as ContainerStatus),
					state: "Exited",
					exitCode: 0,
				};
				status.containerStatuses[1] = {
					...(status.containerStatuses[1] as ContainerStatus),
					state: "Exited",
					exitCode: 111,
				};
			},
			actions: noAction,
		},
		{
			name: "Kill pod and recreate all containers (except for the succeeded one) if the pod sandbox is dead",
			mutatePodFn: (pod: V1Pod) => {
				const containers = pod.spec?.containers ?? [];
				if (containers[1]) {
					containers[1].restartPolicy = "OnFailure";
				}
				if (pod.spec) {
					pod.spec.restartPolicy = "Always";
				}
			},
			mutateStatusFn: (status: PodRuntimeStatus) => {
				status.sandboxStatuses[0] = {
					...(status.sandboxStatuses[0] as PodSandboxStatus),
					state: "NotReady",
				};
				status.containerStatuses[1] = {
					...(status.containerStatuses[1] as ContainerStatus),
					state: "Exited",
					exitCode: 0,
				};
			},
			actions: podActions({
				killPod: true,
				createSandbox: true,
				sandboxID: baseStatus.sandboxStatuses[0]?.id,
				attempt: 1,
				containersToStart: [0, 2],
				containersToKill: getKillMap(basePod, baseStatus, []),
			}),
		},
	] satisfies ComputePodActionsCase[])("$name", async (test) => {
		const fixture = createTestRuntimeManager(context.background());
		const [, , m] = fixture;
		const [pod, status] = makeBasePodAndStatus();
		test.mutatePodFn?.(pod);
		test.mutateStatusFn?.(status);

		const actions = m.computePodActions(context.background(), pod, status, false);
		verifyActions(test.actions, actions);
	});

	// Upstream also covers TestComputePodActionsWithInitContainers,
	// TestComputePodActionsWithRestartableInitContainers, and
	// TestComputePodActionsWithInitAndEphemeralContainers. Those tables are left
	// out here because this simulator intentionally excludes init and ephemeral
	// containers from kuberuntime behavior.
});

// Upstream kuberuntime_manager_test.go has pod resize, actuated resource, and
// image-volume tests before TestDoBackOff. The simulator does not model
// allocationManager resource actuation, in-place pod resize, or Kubernetes
// volumes/CSI image volumes, so those tests are outside the current project scope.

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestDoBackOff.
browser.describe("KubeGenericRuntimeManager.doBackOff", () => {
	it.each([
		{
			name: "container running",
			podStatus: (clock: Clock) => ({
				...emptyPodStatus(clock),
				containerStatuses: [containerStatus("foocontainer", "id1", "Running")],
			}),
			backoff: (clock: Clock) => newBackOff(1000, 60_000, clock),
			expectedInBackOff: false,
		},
		{
			name: "not in backoff",
			podStatus: (clock: Clock) => ({
				...emptyPodStatus(clock),
				containerStatuses: [
					{
						...containerStatus("foocontainer", "id1", "Exited"),
						finishedAt: clock.nowMs(),
					},
				],
			}),
			backoff: (clock: Clock) => newBackOff(1000, 60_000, clock),
			expectedInBackOff: false,
		},
		{
			name: "in backoff",
			podStatus: (clock: Clock) => ({
				...emptyPodStatus(clock),
				containerStatuses: [
					{
						...containerStatus("foocontainer", "id1", "Exited"),
						finishedAt: clock.nowMs(),
					},
				],
			}),
			backoff: (clock: Clock) => newBackOff(1000, 60_000, clock),
			backoffUpdateFn: (backOff, pod, podStatus) => {
				const container = pod.spec?.containers?.[0] as V1Container;
				const status = podStatus.containerStatuses[0] as ContainerStatus;
				backOff.next(getBackoffKey(pod, container), new Date(status.finishedAt ?? 0));
			},
			expectedInBackOff: true,
			expectedError: (_clock: Clock, podStatus: PodRuntimeStatus) =>
				newBackoffError(
					new Error("CrashLoopBackOff"),
					new Date(((podStatus.containerStatuses[0] as ContainerStatus).finishedAt ?? 0) + 1000),
				),
		},
	] satisfies DoBackOffCase[])("$name", async (test) => {
		const [, , manager, , clock] = createTestRuntimeManager(context.background());
		const pod = testBackoffPod();
		const container = pod.spec?.containers?.[0] as V1Container;
		const podStatus = test.podStatus(clock);
		const backOff = test.backoff(clock);
		const doBackOffManager = manager as unknown as DoBackOffManager;
		test.backoffUpdateFn?.(backOff, pod, podStatus);

		const [inBackOff, msg, err] = await doBackOffManager.doBackOff(
			context.background(),
			pod,
			container,
			podStatus,
			backOff,
		);

		expect(inBackOff).toBe(test.expectedInBackOff);
		const expectedError = test.expectedError?.(clock, podStatus);
		expect(err).toEqual(expectedError);
		if (test.expectedInBackOff) {
			expect(msg).not.toBe("");
		} else {
			expect(msg).toBe("");
		}
	});
});

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestOnPodSandboxReadyInvocation.
browser.describe("KubeGenericRuntimeManager.OnPodSandboxReady invocation", () => {
	it.each([
		{
			name: "OnPodSandboxReady succeeds with feature enabled",
			onPodSandboxReadyShouldErr: false,
			deviceAllocationShouldErr: false,
			expectOnPodSandboxReady: true,
			expectSyncPodSuccess: true,
			expectDeviceAllocation: false,
			enablePodReadyToStartContainers: true,
			description:
				"Verifies OnPodSandboxReady is called and succeeds with PodReadyToStartContainersCondition feature gate enabled",
		},
		{
			name: "OnPodSandboxReady succeeds with feature disabled",
			onPodSandboxReadyShouldErr: false,
			deviceAllocationShouldErr: false,
			expectOnPodSandboxReady: true,
			expectSyncPodSuccess: true,
			expectDeviceAllocation: false,
			enablePodReadyToStartContainers: false,
			description:
				"Verifies OnPodSandboxReady is called and succeeds with PodReadyToStartContainersCondition feature gate disabled",
		},
		{
			name: "OnPodSandboxReady fails but SyncPod continues with feature enabled",
			onPodSandboxReadyShouldErr: true,
			deviceAllocationShouldErr: false,
			expectOnPodSandboxReady: true,
			expectSyncPodSuccess: true,
			expectDeviceAllocation: false,
			enablePodReadyToStartContainers: true,
			description:
				"Verifies OnPodSandboxReady errors don't block pod creation with PodReadyToStartContainersCondition feature gate enabled",
		},
		{
			name: "OnPodSandboxReady fails but SyncPod continues with feature disabled",
			onPodSandboxReadyShouldErr: true,
			deviceAllocationShouldErr: false,
			expectOnPodSandboxReady: true,
			expectSyncPodSuccess: true,
			expectDeviceAllocation: false,
			enablePodReadyToStartContainers: false,
			description:
				"Verifies OnPodSandboxReady errors don't block pod creation with PodReadyToStartContainersCondition feature gate disabled",
		},
		// Upstream also has four PrepareDynamicResources device-allocation cases here.
		// The simulator intentionally does not model DRA/resource claim allocation yet,
		// so these cases are kept visible but not executable until that scope is added.
		// {
		// 	name: "PrepareDynamicResources (device allocation) called before OnPodSandboxReady with feature enabled",
		// 	onPodSandboxReadyShouldErr: false,
		// 	deviceAllocationShouldErr: false,
		// 	expectOnPodSandboxReady: true,
		// 	expectSyncPodSuccess: true,
		// 	expectDeviceAllocation: true,
		// 	enablePodReadyToStartContainers: true,
		// 	description:
		// 		"Verifies the order (PrepareDynamicResources -> OnPodSandboxReady) in case of pod with ResourceClaims with PodReadyToStartContainersCondition feature gate enabled",
		// },
		// {
		// 	name: "PrepareDynamicResources (device allocation) called before OnPodSandboxReady with feature disabled",
		// 	onPodSandboxReadyShouldErr: false,
		// 	deviceAllocationShouldErr: false,
		// 	expectOnPodSandboxReady: true,
		// 	expectSyncPodSuccess: true,
		// 	expectDeviceAllocation: true,
		// 	enablePodReadyToStartContainers: false,
		// 	description:
		// 		"Verifies the order (PrepareDynamicResources -> OnPodSandboxReady) in case of pod with ResourceClaims with PodReadyToStartContainersCondition feature gate disabled",
		// },
		// {
		// 	name: "PrepareDynamicResources (device allocation) failure prevents sandbox creation with feature enabled",
		// 	onPodSandboxReadyShouldErr: false,
		// 	deviceAllocationShouldErr: true,
		// 	expectOnPodSandboxReady: false,
		// 	expectSyncPodSuccess: true,
		// 	expectDeviceAllocation: true,
		// 	enablePodReadyToStartContainers: true,
		// 	description:
		// 		"Verifies PrepareDynamicResources failure causes early return in case of pod with ResourceClaims with PodReadyToStartContainersCondition feature gate enabled",
		// },
		// {
		// 	name: "PrepareDynamicResources (device allocation) failure prevents sandbox creation with feature disabled",
		// 	onPodSandboxReadyShouldErr: false,
		// 	deviceAllocationShouldErr: true,
		// 	expectOnPodSandboxReady: false,
		// 	expectSyncPodSuccess: true,
		// 	expectDeviceAllocation: true,
		// 	enablePodReadyToStartContainers: false,
		// 	description:
		// 		"Verifies PrepareDynamicResources failure causes early return in case of pod with ResourceClaims with PodReadyToStartContainersCondition feature gate disabled",
		// },
	] satisfies OnPodSandboxReadyCase[])("$name", async (test) => {
		const tCtx = context.background();
		const [fakeRuntime, fakeImage, m, err] = createTestRuntimeManager(tCtx);
		expect(err).toBeUndefined();
		const testHelper = new TestRuntimeHelper(fakeRuntime);
		if (test.onPodSandboxReadyShouldErr) {
			testHelper.onPodSandboxReadyError = new Error(
				"OnPodSandboxReady intentionally failed for testing",
			);
		}
		if (test.deviceAllocationShouldErr) {
			testHelper.prepareDynamicResourcesError = new Error(
				"PrepareDynamicResources intentionally failed for testing",
			);
		}
		m.runtimeHelper = testHelper;

		const pod = {
			metadata: { uid: "test-pod-uid", name: "test-pod", namespace: "test-namespace" },
			spec: {
				containers: [{ name: "test-container", image: "busybox", imagePullPolicy: "IfNotPresent" }],
			},
		};
		const result = await m.syncPod(
			tCtx,
			pod,
			emptyPodStatus(),
			[],
			newBackOff(1000, 60_000, new Clock()),
			false,
		);

		if (test.expectSyncPodSuccess) {
			expect(result.error()).toBeUndefined();
		} else {
			expect(result.error()).toBeDefined();
		}

		if (test.expectDeviceAllocation) {
			expect(testHelper.prepareDynamicResourcesCalled).toBe(true);
			if (test.expectOnPodSandboxReady && testHelper.onPodSandboxReadyCalled) {
				expect(testHelper.prepareDynamicResourcesCalled).toBe(true);
			}
		}

		expect(testHelper.onPodSandboxReadyCalled).toBe(test.expectOnPodSandboxReady);
		if (test.expectOnPodSandboxReady) {
			expect(testHelper.onPodSandboxReadyPod).toBeDefined();
			expect(testHelper.onPodSandboxReadyPod?.metadata?.uid).toBe(pod.metadata.uid);
			expect(testHelper.onPodSandboxReadyPod?.metadata?.name).toBe(pod.metadata.name);
			expect(testHelper.onPodSandboxReadyPod?.metadata?.namespace).toBe(pod.metadata.namespace);
			expect(testHelper.onPodSandboxReadyCtx).toBeDefined();
			expect(fakeRuntime.sandboxes).toHaveLength(1);
			expect(fakeRuntime.sandboxes.every((sandbox) => sandbox.state === "Ready")).toBe(true);
		}
		if (test.expectSyncPodSuccess && !test.deviceAllocationShouldErr) {
			expect(fakeRuntime.containers).toHaveLength(1);
			expect(fakeImage.images).toHaveLength(1);
			expect(fakeRuntime.containers.every((container) => container.state === "Running")).toBe(true);
		}
		if (test.deviceAllocationShouldErr) {
			expect(fakeRuntime.sandboxes).toHaveLength(0);
			expect(fakeRuntime.containers).toHaveLength(0);
		}
	});
});

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestOnPodSandboxReadyTiming.
browser.describe("KubeGenericRuntimeManager.OnPodSandboxReady timing", () => {
	it("invokes OnPodSandboxReady after sandbox creation and before container creation", async () => {
		const tCtx = context.background();
		const [fakeRuntime, fakeImage, m, err] = createTestRuntimeManager(tCtx);
		expect(err).toBeUndefined();
		const testHelper = new TestRuntimeHelper(fakeRuntime);

		let sandboxCount = 0;
		let containerCount = 0;
		let imageCount = 0;

		testHelper.captureStateFunc = () => {
			sandboxCount = fakeRuntime.sandboxes.length;
			containerCount = fakeRuntime.containers.length;
			imageCount = fakeImage.images.length;
		};

		m.runtimeHelper = testHelper;

		const pod = {
			metadata: { uid: "timing-test-pod", name: "timing-test", namespace: "default" },
			spec: {
				containers: [{ name: "test-container", image: "busybox", imagePullPolicy: "IfNotPresent" }],
			},
		};

		const result = await m.syncPod(
			tCtx,
			pod,
			emptyPodStatus(),
			[],
			newBackOff(1000, 60_000, new Clock()),
			false,
		);
		expect(result.error()).toBeUndefined();

		expect(sandboxCount).toBe(1);
		expect(containerCount).toBe(0);
		expect(imageCount).toBe(0);

		expect(fakeRuntime.sandboxes).toHaveLength(1);
		expect(fakeRuntime.containers).toHaveLength(1);
	});
});

type TestRuntimeManagerFixture = [
	fakeRuntime: TestRuntimeService,
	fakeImage: TestImageService,
	manager: KubeGenericRuntimeManager,
	err: Error | undefined,
	clock: Clock,
	livenessManager: ResultsManager,
	startupManager: ResultsManager,
];

interface ComputePodActionsCase {
	name: string;
	mutatePodFn?: (pod: V1Pod) => void;
	mutateStatusFn?: (status: PodRuntimeStatus) => void;
	actions: PodActions;
	resetStatusFn?: (status: PodRuntimeStatus) => void;
}

interface RestartAllContainersCase {
	name: string;
	podFunc: () => V1Pod;
	podStatusFunc: () => PodRuntimeStatus;
	restartAllContainers?: boolean;
	containersToRemove?: Array<{
		container: Pick<V1Container, "name">;
		containerID: ContainerID;
		kill: boolean;
	}>;
	containersToStart?: number[];
}

interface DoBackOffCase {
	name: string;
	podStatus: (clock: Clock) => PodRuntimeStatus;
	backoff: (clock: Clock) => Backoff;
	backoffUpdateFn?: (backOff: Backoff, pod: V1Pod, podStatus: PodRuntimeStatus) => void;
	expectedInBackOff: boolean;
	expectedError?: (clock: Clock, podStatus: PodRuntimeStatus) => Error;
}

interface DoBackOffManager {
	doBackOff(
		ctx: context.Context,
		pod: V1Pod,
		container: V1Container,
		podStatus: PodRuntimeStatus,
		backOff: Backoff,
	): Promise<[isInBackOff: boolean, msg: string, err: Error | undefined]>;
}

interface OnPodSandboxReadyCase {
	name: string;
	onPodSandboxReadyShouldErr: boolean;
	deviceAllocationShouldErr: boolean;
	expectOnPodSandboxReady: boolean;
	expectSyncPodSuccess: boolean;
	expectDeviceAllocation: boolean;
	enablePodReadyToStartContainers: boolean;
	description: string;
}

function createTestRuntimeManager(ctx: context.Context): TestRuntimeManagerFixture {
	const clock = new Clock();
	const fakeRuntime = new TestRuntimeService();
	const fakeImage = new TestImageService();
	const livenessManager = new ResultsManager();
	const startupManager = new ResultsManager();
	const manager = new KubeGenericRuntimeManager({
		ctx,
		runtimeService: fakeRuntime,
		imageService: {} as KubeGenericRuntimeManagerOptions["imageService"],
		runtimeHelper: new TestRuntimeHelper(fakeRuntime),
		imagePuller: fakeImage,
		events: {
			event: async () => undefined,
		} as unknown as KubeGenericRuntimeManagerOptions["events"],
		internalLifecycle: testInternalLifecycle(),
		livenessManager,
		runner: {
			run: async () => ["", undefined],
		} as KubeGenericRuntimeManagerOptions["runner"],
		startupManager,
		clock,
	});
	return [fakeRuntime, fakeImage, manager, undefined, clock, livenessManager, startupManager];
}

class TestImageService {
	images: string[] = [];

	async ensureImageExists(
		_ctx: context.Context,
		_objRef: unknown,
		_pod: V1Pod,
		requestedImage: string,
	): Promise<[string, string, undefined]> {
		this.images.push(requestedImage);
		return [requestedImage, "", undefined];
	}
}

interface TestPodSandboxRecord {
	id: string;
	metadata: PodSandbox["metadata"];
	state: PodSandbox["state"];
	createdAt: number;
	labels: Record<string, string>;
	annotations: Record<string, string>;
	network?: PodSandboxStatus["network"];
}

interface TestContainerRecord {
	id: string;
	podSandboxId: string;
	metadata: ContainerConfig["metadata"];
	image: ContainerConfig["image"];
	imageRef: string;
	imageId: string;
	state: ContainerStatus["state"];
	createdAt: number;
	labels: Record<string, string>;
	annotations: Record<string, string>;
	hash: number;
}

class TestRuntimeService implements RuntimeService {
	sandboxCount = 0;
	containerCount = 0;
	sandboxes: TestPodSandboxRecord[] = [];
	containers: TestContainerRecord[] = [];
	private readonly injectedErrors = new Map<string, Error>();

	setFakeSandboxes(sandboxes: TestPodSandboxRecord[]): void {
		this.sandboxes = sandboxes;
		this.sandboxCount = sandboxes.length;
	}

	setFakeContainers(containers: TestContainerRecord[]): void {
		this.containers = containers;
		this.containerCount = containers.length;
	}

	injectError(operation: string, err: Error): void {
		this.injectedErrors.set(operation, err);
	}

	async version(): Promise<[VersionResponse, undefined]> {
		return [
			{
				version: "0.1.0",
				runtimeName: "simulator",
				runtimeVersion: "0.1.0",
				runtimeApiVersion: "0.1.0",
			},
			undefined,
		];
	}

	async runPodSandbox(
		_ctx: context.Context,
		config: PodSandboxConfig,
		_runtimeHandler?: string,
	): Promise<[string, undefined]> {
		this.sandboxCount++;
		const id = `sandbox-${this.sandboxCount}`;
		this.sandboxes.push({
			id,
			metadata: config.metadata,
			state: "Ready",
			createdAt: fakeCreatedAt + this.sandboxCount,
			labels: config.labels ?? {},
			annotations: config.annotations ?? {},
			network: { ip: fakePodSandboxIPs[0] ?? "" },
		});
		return [id, undefined];
	}

	async podSandboxStatus(
		_ctx: context.Context,
		podSandboxId: string,
	): Promise<[PodSandboxStatusResponse, undefined]> {
		const sandbox = this.sandboxes.find((item) => item.id === podSandboxId) ?? this.sandboxes[0];
		if (!sandbox) {
			return [podSandboxStatusResponse(), undefined];
		}
		return [
			{
				status: {
					id: sandbox.id,
					metadata: sandbox.metadata,
					state: sandbox.state,
					createdAt: sandbox.createdAt,
					network: sandbox.network,
					labels: sandbox.labels,
					annotations: sandbox.annotations,
				},
			},
			undefined,
		];
	}

	async createContainer(
		_ctx: context.Context,
		podSandboxId: string,
		config: ContainerConfig,
	): Promise<[string, undefined]> {
		this.containerCount++;
		const id = `container-${this.containerCount}`;
		this.containers.push({
			id,
			podSandboxId,
			metadata: config.metadata,
			image: config.image,
			imageRef: config.image.image,
			imageId: config.image.image,
			state: "Created",
			createdAt: fakeCreatedAt + this.containerCount,
			labels: config.labels ?? {},
			annotations: config.annotations ?? {},
			hash: Number.parseInt(config.annotations?.["io.kubernetes.container.hash"] ?? "0", 16) || 0,
		});
		return [id, undefined];
	}

	async startContainer(_ctx: context.Context, containerId: string): Promise<undefined> {
		const container = this.containers.find((item) => item.id === containerId);
		if (container) {
			container.state = "Running";
		}
		return undefined;
	}

	async status(): Promise<[undefined, undefined]> {
		return [undefined, undefined];
	}

	async stopContainer(_ctx: context.Context, containerId: string): Promise<Error | undefined> {
		const injected = this.injectedErrors.get("StopContainer");
		if (injected) {
			return injected;
		}
		const container = this.containers.find((item) => item.id === containerId);
		if (container) {
			container.state = "Exited";
		}
		return undefined;
	}

	async removeContainer(_ctx: context.Context, containerId: string): Promise<undefined> {
		this.containers = this.containers.filter((item) => item.id !== containerId);
		return undefined;
	}

	async listContainers(): Promise<[CRIContainer[], undefined]> {
		return [
			this.containers.map((container) => ({
				id: container.id,
				podSandboxId: container.podSandboxId,
				metadata: container.metadata,
				image: container.image,
				imageRef: container.imageRef,
				state: container.state,
				createdAt: container.createdAt,
				labels: container.labels,
				annotations: container.annotations,
				imageId: container.imageId,
			})),
			undefined,
		];
	}

	async containerStatus(
		_ctx: context.Context,
		containerId: string,
	): Promise<[ContainerStatusResponse | undefined, Error | undefined]> {
		const injected = this.injectedErrors.get("ContainerStatus");
		if (injected) {
			return [undefined, injected];
		}
		const container = this.containers.find((item) => item.id === containerId);
		if (!container) {
			return [undefined, new Error(`container ${containerId} not found`)];
		}
		return [
			{
				status: {
					id: buildContainerID("simulator", container.id),
					name: container.metadata.name,
					imageRef: container.imageRef,
					imageRuntimeHandler: container.image.runtimeHandler ?? "",
					hash: container.hash,
					state: container.state,
					restartCount: container.metadata.attempt,
					createdAt: container.createdAt,
					labels: { ...container.labels },
					annotations: { ...container.annotations },
					ready: container.state === "Running",
				},
			},
			undefined,
		];
	}

	async execSync(): Promise<[undefined, undefined]> {
		return [undefined, undefined];
	}

	async checkpointContainer(
		_ctx: context.Context,
		_options: CheckpointContainerRequest,
	): Promise<undefined> {
		return undefined;
	}

	async stopPodSandbox(_ctx: context.Context, podSandboxId: string): Promise<undefined> {
		const sandbox = this.sandboxes.find((item) => item.id === podSandboxId);
		if (sandbox) {
			sandbox.state = "NotReady";
		}
		return undefined;
	}

	async removePodSandbox(): Promise<undefined> {
		return undefined;
	}

	async listPodSandbox(): Promise<[PodSandbox[], undefined]> {
		return [
			this.sandboxes.map((sandbox) => ({
				id: sandbox.id,
				metadata: sandbox.metadata,
				state: sandbox.state,
				createdAt: sandbox.createdAt,
				labels: sandbox.labels,
				annotations: sandbox.annotations,
			})),
			undefined,
		];
	}

	async updateRuntimeConfig(
		_ctx: context.Context,
		_config: UpdateRuntimeConfigRequest,
	): Promise<undefined> {
		return undefined;
	}

	async listMetricDescriptors(): Promise<[MetricDescriptor[], undefined]> {
		return [[], undefined];
	}

	async listPodSandboxMetrics(): Promise<[PodSandboxMetrics[], undefined]> {
		return [[], undefined];
	}
}

class TestRuntimeHelper implements RuntimeHelper {
	onPodSandboxReadyCalled = false;
	onPodSandboxReadyCtx: context.Context | undefined;
	onPodSandboxReadyError: Error | undefined;
	onPodSandboxReadyPod: V1Pod | undefined;
	prepareDynamicResourcesCalled = false;
	prepareDynamicResourcesError: Error | undefined;
	captureStateFunc: (() => void) | undefined;
	sandboxCountAtCallback = -1;
	containerCountAtCallback = -1;

	constructor(private readonly fakeRuntime: TestRuntimeService) {}

	generateRunContainerOptions(): [{ envs: [] }, undefined, undefined] {
		return [{ envs: [] }, undefined, undefined];
	}

	getPodDNS(): [{ servers: []; searches: []; options: [] }, undefined] {
		return [{ servers: [], searches: [], options: [] }, undefined];
	}

	generatePodHostNameAndDomain(pod: V1Pod): [string, string, undefined] {
		return [pod.metadata?.name ?? "", "", undefined];
	}

	onPodSandboxReady(_ctx: context.Context, pod: V1Pod): Error | undefined {
		this.onPodSandboxReadyCalled = true;
		this.onPodSandboxReadyCtx = _ctx;
		this.onPodSandboxReadyPod = pod;
		this.sandboxCountAtCallback = this.fakeRuntime.sandboxCount;
		this.containerCountAtCallback = this.fakeRuntime.containerCount;
		this.captureStateFunc?.();
		return this.onPodSandboxReadyError;
	}

	getPodCgroupParent(_pod: V1Pod): string {
		return "";
	}

	getPodDir(_podUid: string): string {
		return "";
	}

	getExtraSupplementalGroupsForPod(_pod: V1Pod): number[] {
		return [];
	}

	getOrCreateUserNamespaceMappings(
		_pod: V1Pod | undefined,
		_runtimeHandler: string,
	): [undefined, undefined] {
		return [undefined, undefined];
	}

	prepareDynamicResources(_ctx: context.Context, _pod: V1Pod): Error | undefined {
		this.prepareDynamicResourcesCalled = true;
		return this.prepareDynamicResourcesError;
	}

	unprepareDynamicResources(_ctx: context.Context, _pod: V1Pod): undefined {
		return undefined;
	}

	requestPodReinspect(_podUid: string): void {}

	requestPodRelist(_podUid: string): void {}

	podCPUAndMemoryStats(): [undefined, undefined] {
		return [undefined, undefined];
	}
}

function testInternalLifecycle(): InternalContainerLifecycle {
	return {
		preCreateContainer: () => undefined,
		preStartContainer: () => undefined,
		postStopContainer: () => undefined,
	};
}

function withoutTimestamp(pod: RuntimePod | undefined): Omit<RuntimePod, "timestamp"> | undefined {
	if (!pod) {
		return undefined;
	}
	const { timestamp: _timestamp, ...rest } = pod;
	return {
		...rest,
		containers: [...rest.containers].toSorted((left, right) =>
			left.id.id.localeCompare(right.id.id),
		),
		sandboxes: [...rest.sandboxes].toSorted((left, right) => left.id.id.localeCompare(right.id.id)),
	};
}

const fakeCreatedAt = 1;
const fakePodSandboxIPs = ["10.0.0.1"];

interface SandboxTemplate {
	pod: V1Pod;
	attempt?: number;
	createdAt: number;
	state: PodSandbox["state"];
	running?: boolean;
	terminating?: boolean;
}

interface ContainerTemplate {
	pod: V1Pod;
	container: V1Container;
	sandboxAttempt?: number;
	attempt?: number;
	createdAt: number;
	state: ContainerStatus["state"];
}

function makeAndSetFakePod(
	ctx: context.Context,
	m: KubeGenericRuntimeManager,
	fakeRuntime: TestRuntimeService,
	pod: V1Pod,
): [TestPodSandboxRecord, TestContainerRecord[]] {
	const sandbox = makeFakePodSandbox(ctx, m, {
		pod,
		createdAt: fakeCreatedAt,
		state: "Ready",
	});

	const containers: TestContainerRecord[] = [];
	const newTemplate = (container: V1Container): ContainerTemplate => ({
		pod,
		container,
		createdAt: fakeCreatedAt,
		state: "Running",
	});
	for (const container of pod.spec?.containers ?? []) {
		containers.push(makeFakeContainer(ctx, m, newTemplate(container)));
	}

	fakeRuntime.setFakeSandboxes([sandbox]);
	fakeRuntime.setFakeContainers(containers);
	return [sandbox, containers];
}

function makeFakePodSandbox(
	ctx: context.Context,
	m: KubeGenericRuntimeManager,
	template: SandboxTemplate,
): TestPodSandboxRecord {
	const [sandboxConfig, sandboxConfigErr] = m.generatePodSandboxConfig(
		ctx,
		template.pod,
		template.attempt ?? 0,
	);
	expect(sandboxConfigErr).toBeUndefined();
	expect(sandboxConfig).toBeDefined();
	const metadata = sandboxConfig?.metadata ?? {
		uid: "",
		name: "",
		namespace: "default",
		attempt: template.attempt ?? 0,
	};
	return {
		id: buildSandboxName(metadata),
		metadata,
		state: template.state,
		createdAt: template.createdAt,
		labels: sandboxConfig?.labels ?? {},
		annotations: sandboxConfig?.annotations ?? {},
		network: { ip: fakePodSandboxIPs[0] ?? "" },
	};
}

function makeFakeContainer(
	ctx: context.Context,
	m: KubeGenericRuntimeManager,
	template: ContainerTemplate,
): TestContainerRecord {
	const [sandboxConfig, sandboxConfigErr] = m.generatePodSandboxConfig(
		ctx,
		template.pod,
		template.sandboxAttempt ?? 0,
	);
	expect(sandboxConfigErr).toBeUndefined();
	expect(sandboxConfig).toBeDefined();

	const [containerConfig, cleanupAction, containerConfigErr] = m.generateContainerConfig(
		ctx,
		template.container,
		template.pod,
		template.attempt ?? 0,
		"",
		template.container.image ?? "",
		[],
		undefined,
		undefined,
	);
	cleanupAction?.();
	expect(containerConfigErr).toBeUndefined();
	expect(containerConfig).toBeDefined();

	const podSandboxID = buildSandboxName(
		sandboxConfig?.metadata ?? {
			uid: "",
			name: "",
			namespace: "default",
			attempt: template.sandboxAttempt ?? 0,
		},
	);
	const metadata = containerConfig?.metadata ?? {
		name: template.container.name,
		attempt: template.attempt ?? 0,
	};
	const containerID = buildContainerName(metadata, podSandboxID);
	const imageRef = containerConfig?.image.image ?? template.container.image ?? "";
	return {
		id: containerID,
		podSandboxId: podSandboxID,
		metadata,
		image: containerConfig?.image ?? { image: template.container.image ?? "" },
		imageRef,
		imageId: imageRef,
		state: template.state,
		createdAt: template.createdAt,
		labels: containerConfig?.labels ?? {},
		annotations: containerConfig?.annotations ?? {},
		hash: hashContainer(template.container),
	};
}

function buildSandboxName(metadata: PodSandboxConfig["metadata"]): string {
	return `${metadata.name}_${metadata.namespace}_${metadata.uid}_${metadata.attempt}`;
}

function buildContainerName(metadata: ContainerConfig["metadata"], podSandboxID: string): string {
	return `${metadata.name}_${metadata.attempt}_${podSandboxID}`;
}

function makeBasePodAndStatus(): [V1Pod, PodRuntimeStatus] {
	const pod: V1Pod = {
		metadata: { uid: "12345678", name: "foo", namespace: "new" },
		spec: {
			restartPolicy: "Always",
			containers: [
				{ name: "foo1", image: "busybox" },
				{ name: "foo2", image: "busybox" },
				{ name: "foo3", image: "busybox" },
			],
		},
	};
	const status: PodRuntimeStatus = {
		id: "12345678",
		name: "foo",
		namespace: "new",
		ips: ["10.0.0.1"],
		timestamp: new Date(0),
		sandboxStatuses: [
			{
				id: "sandbox-id",
				metadata: { name: "foo", namespace: "new", uid: "12345678", attempt: 0 },
				state: "Ready",
				createdAt: 0,
				network: { ip: "10.0.0.1" },
				labels: {},
				annotations: {},
			},
		],
		containerStatuses: [
			containerStatus("foo1", "id1", "Running", pod.spec?.containers?.[0]),
			containerStatus("foo2", "id2", "Running", pod.spec?.containers?.[1]),
			containerStatus("foo3", "id3", "Running", pod.spec?.containers?.[2]),
		],
	};
	return [pod, status];
}

function containerStatus(
	name: string,
	id: string,
	state: ContainerStatus["state"],
	container?: V1Container,
): ContainerStatus {
	return {
		id: buildContainerID("simulator", id),
		name,
		imageRef: container?.image ?? "busybox",
		imageRuntimeHandler: "",
		hash: container ? hashContainer(container) : 0,
		state,
		restartCount: 0,
		createdAt: 0,
		labels: {},
		annotations: {},
		ready: state === "Running",
	};
}

function emptyPodStatus(_clock?: Clock): PodRuntimeStatus {
	return {
		id: "12345678",
		name: "foo",
		namespace: "new",
		ips: [],
		timestamp: new Date(0),
		containerStatuses: [],
		sandboxStatuses: [],
	};
}

function testBackoffPod(): V1Pod {
	return {
		metadata: { uid: "12345678", name: "foo", namespace: "new" },
		spec: {
			containers: [{ name: "foocontainer", image: "busybox" }],
		},
	};
}

function podSandboxStatusResponse(): PodSandboxStatusResponse {
	return {
		status: {
			id: "sandbox-1",
			metadata: {
				name: "test-pod",
				namespace: "test-namespace",
				uid: "test-pod-uid",
				attempt: 0,
			},
			state: "Ready",
			createdAt: 0,
			network: { ip: "10.0.0.1" },
			labels: {},
			annotations: {},
		},
	};
}

function getKillMap(
	pod: V1Pod,
	status: PodRuntimeStatus,
	containerIndexes: number[],
	overrides: Partial<ContainerToKillInfo> = {},
): ContainerToKillMap {
	const containersToKill = newContainerToKillMap();
	for (const index of containerIndexes) {
		const containerStatus = status.containerStatuses[index] as ContainerStatus;
		const container = pod.spec?.containers?.[index] as V1Container;
		containersToKill.set(containerStatus.id, {
			container,
			name: container.name,
			message: "",
			...overrides,
		});
	}
	return containersToKill;
}

type ContainerKillReason =
	| "StartupProbe"
	| "LivenessProbe"
	| "FailedPostStartHook"
	| "RestartAllContainers"
	| "Unknown";

interface ContainerToKillInfo {
	container: V1Container;
	name: string;
	message: string;
	reason?: ContainerKillReason;
}

type ContainerToKillMap = KeyFnMap<ContainerID, ContainerToKillInfo>;

function containerIDKey(containerID: ContainerID): string {
	return `${containerID.type}://${containerID.id}`;
}

function cloneContainerID(containerID: ContainerID): ContainerID {
	return buildContainerID(containerID.type, containerID.id);
}

function newContainerToKillMap(): ContainerToKillMap {
	return new KeyFnMap(containerIDKey, undefined, cloneContainerID);
}

function verifyActions(expected: PodActions, actual: PodActions): void {
	if (actual.containersToKill !== undefined) {
		const containersToKill = newContainerToKillMap();
		for (const [containerID, info] of actual.containersToKill) {
			info.message = "";
			delete info.reason;
			containersToKill.set(containerID, info);
		}
		actual.containersToKill = containersToKill;
	}
	// Upstream normalizes ContainersToUpdate here. The simulator does not model
	// container resource updates or pod resize, so PodActions has no equivalent field.
	expect(actual).toEqual(podActions(expected));
}

function podActions(actions: Partial<PodActions>): PodActions {
	return {
		killPod: actions.killPod ?? false,
		createSandbox: actions.createSandbox ?? false,
		sandboxID: actions.sandboxID ?? "",
		attempt: actions.attempt ?? 0,
		containersToStart: actions.containersToStart ?? [],
		containersToKill: actions.containersToKill ?? newContainerToKillMap(),
		containersToReset: actions.containersToReset ?? [],
	};
}
