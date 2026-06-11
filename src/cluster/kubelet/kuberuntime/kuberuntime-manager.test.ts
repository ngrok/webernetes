/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// oxlint-disable jest/expect-expect
// oxlint-disable jest/no-conditional-expect
import { expect, it } from "vitest";
import type { V1Container, V1Pod } from "../../../client";
import { newBackOff, type Backoff } from "../../../client-go/util/flowcontrol/backoff";
import type { Clock } from "../../../clock";
import { getClock } from "../../../clock-context";
import { KeyFnMap } from "../../../collections";
import * as context from "../../../go/context";
import { browser } from "../../../test/describe";
import type { ContainerConfig, PodSandboxStatus } from "../../cri";
import type { ExecSyncResponse } from "../../cri/runtime/v1/api";
import {
	buildContainerID,
	convertPodStatusToRunningPod,
	type ContainerID,
	errPodNotFound,
	hashContainer,
	newBackoffError,
	type PodStatus as PodRuntimeStatus,
	runtimeProtocol,
	type Pod as RuntimePod,
	type Status as ContainerStatus,
} from "../container";
import { KubeGenericRuntimeManager, type PodActions } from "./kuberuntime-manager";
import { getBackoffKey } from "./helpers";
import { newContainerAnnotations, newContainerLabels } from "./labels";
import {
	createTestRuntimeManager,
	fakeCreatedAt,
	fakePodSandboxIPs,
	makeAndSetFakePod,
	makeFakePodSandbox,
	type TestContainerRecord,
	type TestPodSandboxRecord,
	TestRuntimeHelper,
	withoutTimestamp,
} from "./kuberuntime-test-helpers";

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container_linux_test.go makeExpectedConfig.
async function makeExpectedConfig(
	ctx: context.Context,
	_t: unknown,
	m: KubeGenericRuntimeManager,
	pod: V1Pod,
	containerIndex: number,
	_enforceMemoryQoS: boolean,
): Promise<ContainerConfig> {
	const container = pod.spec?.containers[containerIndex] as V1Container;
	const podIP = "";
	const restartCount = 0;
	const [opts] = await m.runtimeHelper.generateRunContainerOptions(
		ctx,
		pod,
		container,
		podIP,
		[podIP],
		undefined,
	);
	const restartCountUint32 = restartCount;

	const expectedConfig: ContainerConfig = {
		metadata: {
			name: container.name,
			attempt: restartCountUint32,
		},
		image: { image: container.image ?? "", userSpecifiedImage: container.image },
		command: container.command,
		args: undefined,
		workingDir: container.workingDir,
		labels: newContainerLabels(container, pod),
		annotations: newContainerAnnotations(ctx, container, pod, restartCount, opts ?? {}),
		env: Object.fromEntries((opts?.envs ?? []).map((env) => [env.name, env.value])),
		ports: (container.ports ?? []).map((port) => ({
			name: port.name,
			containerPort: port.containerPort,
			protocol: runtimeProtocol(port.protocol),
		})),
	};
	return expectedConfig;
}

browser.describe("KubeGenericRuntimeManager", ({ ctx }) => {
	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestNewKubeRuntimeManager.
	it("TestNewKubeRuntimeManager", () => {
		const [, , , err] = createTestRuntimeManager(ctx);

		expect(err).toBeUndefined();
	});

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestVersion.
	it("TestVersion", async () => {
		const [, , m, err] = createTestRuntimeManager(ctx);
		expect(err).toBeUndefined();

		const [version, versionErr] = await m.version(ctx);

		expect(versionErr).toBeUndefined();
		expect(version?.toString()).toBe("0.1.0");
	});

	it("generatePodSandboxConfig preserves pod labels and Kubernetes identity labels", async () => {
		const [, , m, err] = createTestRuntimeManager(ctx);
		expect(err).toBeUndefined();

		const [config, configErr] = await m.generatePodSandboxConfig(
			ctx,
			{
				metadata: {
					name: "labeled-pod",
					namespace: "test-ns",
					uid: "pod-uid",
					labels: { app: "demo" },
				},
				spec: {
					containers: [{ name: "main", image: "pause" }],
				},
			},
			0,
		);

		expect(configErr).toBeUndefined();
		expect(config?.labels).toMatchObject({
			app: "demo",
			"io.kubernetes.pod.name": "labeled-pod",
			"io.kubernetes.pod.namespace": "test-ns",
			"io.kubernetes.pod.uid": "pod-uid",
		});
	});

	it("runInContainer returns an error for non-zero exec exit codes", async () => {
		const [runtime, , m, err] = createTestRuntimeManager(ctx);
		expect(err).toBeUndefined();
		runtime.execSync = async (): Promise<[ExecSyncResponse, undefined]> => [
			{ exitCode: 42, stdout: "out", stderr: "err" },
			undefined,
		];

		const [output, runErr] = await m.runInContainer(
			ctx,
			buildContainerID("simulator", "container-id"),
			["false"],
		);

		expect(output).toBe("outerr");
		expect(runErr?.message).toBe("command terminated with exit code 42");
	});

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestContainerRuntimeType.
	it("TestContainerRuntimeType", () => {
		const [, , m, err] = createTestRuntimeManager(ctx);
		expect(err).toBeUndefined();

		const runtimeType = m.type();
		expect(runtimeType).toBe("simulator");
	});

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_container_linux_test.go TestGenerateContainerConfig.
	it("TestGenerateContainerConfig", async () => {
		const [, _imageService, m, err] = createTestRuntimeManager(ctx);
		expect(err).toBeUndefined();

		const runAsUser = 1000;
		const runAsGroup = 2000;
		const pod: V1Pod = {
			metadata: {
				uid: "12345678",
				name: "bar",
				namespace: "new",
			},
			spec: {
				containers: [
					{
						name: "foo",
						image: "busybox",
						imagePullPolicy: "IfNotPresent",
						command: ["testCommand"],
						workingDir: "testWorkingDir",
						securityContext: {
							runAsUser,
							runAsGroup,
						},
					},
				],
			},
		};

		const expectedConfig = await makeExpectedConfig(ctx, undefined, m, pod, 0, false);
		const container = pod.spec?.containers[0] as V1Container;
		const [containerConfig, , containerConfigErr] = await m.generateContainerConfig(
			ctx,
			container,
			pod,
			0,
			"",
			container.image ?? "",
			[],
			undefined,
			undefined,
		);
		expect(containerConfigErr).toBeUndefined();
		expect(containerConfig).toEqual(expectedConfig);

		// Upstream also verifies Linux RunAsUser/RunAsGroup and RunAsNonRoot
		// image-user failure paths here. The simulator does not currently model
		// Linux container config or image user lookup in generateContainerConfig.
	});
});

browser.describe("KubeGenericRuntimeManager runtime state", ({ ctx }) => {
	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestGetPodStatus.
	it("TestGetPodStatus", async () => {
		const [fakeRuntime, , m, err] = createTestRuntimeManager(ctx);
		expect(err).toBeUndefined();
		const containers: V1Container[] = [
			{ name: "foo1", image: "busybox", imagePullPolicy: "IfNotPresent" },
			{ name: "foo2", image: "busybox", imagePullPolicy: "IfNotPresent" },
		];
		const pod: V1Pod = {
			metadata: { uid: "12345678", name: "foo", namespace: "new" },
			spec: { containers },
		};

		await makeAndSetFakePod(ctx, m, fakeRuntime, pod);

		const [runtimePod, getPodErr] = await m.getPod(ctx, pod.metadata?.uid ?? "");
		expect(getPodErr).toBeUndefined();
		const [podStatus, statusErr] = await m.getPodStatus(ctx, runtimePod as RuntimePod);

		expect(statusErr).toBeUndefined();
		expect(podStatus?.id).toBe(pod.metadata?.uid);
		expect(podStatus?.name).toBe(pod.metadata?.name);
		expect(podStatus?.namespace).toBe(pod.metadata?.namespace);
		expect(podStatus?.ips).toEqual(fakePodSandboxIPs);
	});

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestStopContainerWithNotFoundError.
	it("TestStopContainerWithNotFoundError", async () => {
		const [fakeRuntime, , m, err] = createTestRuntimeManager(ctx);
		expect(err).toBeUndefined();
		const containers: V1Container[] = [
			{ name: "foo1", image: "busybox", imagePullPolicy: "IfNotPresent" },
			{ name: "foo2", image: "busybox", imagePullPolicy: "IfNotPresent" },
		];
		const pod: V1Pod = {
			metadata: { uid: "12345678", name: "foo", namespace: "new" },
			spec: { containers },
		};

		await makeAndSetFakePod(ctx, m, fakeRuntime, pod);
		fakeRuntime.injectError(
			"StopContainer",
			new Error("rpc error: code = NotFound desc = No such container"),
		);
		const [runtimePod, getPodErr] = await m.getPod(ctx, pod.metadata?.uid ?? "");
		expect(getPodErr).toBeUndefined();
		const [podStatus, statusErr] = await m.getPodStatus(ctx, runtimePod as RuntimePod);
		expect(statusErr).toBeUndefined();
		const p = convertPodStatusToRunningPod("", podStatus as PodRuntimeStatus);
		const gracePeriod = 1;

		const killErr = await m.killPod(ctx, pod, p, gracePeriod);

		expect(killErr).toBeUndefined();
	});

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestGetPodStatusWithNotFoundError.
	it("TestGetPodStatusWithNotFoundError", async () => {
		const [fakeRuntime, , m, err] = createTestRuntimeManager(ctx);
		expect(err).toBeUndefined();
		const containers: V1Container[] = [
			{ name: "foo1", image: "busybox", imagePullPolicy: "IfNotPresent" },
			{ name: "foo2", image: "busybox", imagePullPolicy: "IfNotPresent" },
		];
		const pod: V1Pod = {
			metadata: { uid: "12345678", name: "foo", namespace: "new" },
			spec: { containers },
		};

		await makeAndSetFakePod(ctx, m, fakeRuntime, pod);
		fakeRuntime.injectError(
			"ContainerStatus",
			new Error("rpc error: code = NotFound desc = No such container"),
		);
		const [runtimePod, getPodErr] = await m.getPod(ctx, pod.metadata?.uid ?? "");
		expect(getPodErr).toBeUndefined();
		const [podStatus, statusErr] = await m.getPodStatus(ctx, runtimePod as RuntimePod);

		expect(statusErr).toBeUndefined();
		expect(podStatus?.id).toBe(pod.metadata?.uid);
		expect(podStatus?.name).toBe(pod.metadata?.name);
		expect(podStatus?.namespace).toBe(pod.metadata?.namespace);
		expect(podStatus?.ips).toEqual(fakePodSandboxIPs);
	});

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestGetPods.
	it("TestGetPods", async () => {
		const [fakeRuntime, , m, err] = createTestRuntimeManager(ctx);
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

		const [fakeSandbox, fakeContainers] = await makeAndSetFakePod(ctx, m, fakeRuntime, pod);

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

		const [actual, getPodsErr] = await m.getPods(ctx, false);
		expect(getPodsErr).toBeUndefined();
		expect(actual.map(withoutTimestamp)).toEqual(expected.map(withoutTimestamp));

		const [actualPod, getPodErr] = await m.getPod(ctx, pod.metadata.uid);
		expect(getPodErr).toBeUndefined();
		expect(withoutTimestamp(actualPod)).toEqual(withoutTimestamp(expectedPod));

		const [, missingErr] = await m.getPod(ctx, "non-existent-uid");
		expect(missingErr).toBe(errPodNotFound);
	});

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestGetPodsSorted.
	it("TestGetPodsSorted", async () => {
		const [fakeRuntime, , m, err] = createTestRuntimeManager(ctx);
		expect(err).toBeUndefined();
		const pod: V1Pod = { metadata: { name: "foo", namespace: "bar" } };
		const createdTimestamps = [10, 5, 20];
		const fakeSandboxes: TestPodSandboxRecord[] = [];
		for (const [i, createdAt] of createdTimestamps.entries()) {
			pod.metadata = { ...pod.metadata, uid: String(i) };
			fakeSandboxes.push(
				await makeFakePodSandbox(ctx, m, {
					pod,
					createdAt,
					state: "Ready",
				}),
			);
		}
		fakeRuntime.setFakeSandboxes(fakeSandboxes);

		const [actual, getPodsErr] = await m.getPods(ctx, false);

		expect(getPodsErr).toBeUndefined();
		expect(actual).toHaveLength(3);
		expect(actual[0]?.createdAt).toBe(createdTimestamps[2]);
		expect(actual[1]?.createdAt).toBe(createdTimestamps[0]);
		expect(actual[2]?.createdAt).toBe(createdTimestamps[1]);
	});

	// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestKillPod.
	it("TestKillPod", async () => {
		const [fakeRuntime, , m, err] = createTestRuntimeManager(ctx);
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

		const [fakeSandbox, fakeContainers] = await makeAndSetFakePod(ctx, m, fakeRuntime, pod);

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

		const killErr = await m.killPod(ctx, pod, runningPod, undefined);

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
		const [fakeRuntime, fakeImage, m, err] = createTestRuntimeManager(ctx);
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
			ctx,
			pod,
			emptyPodStatus(),
			[],
			newBackOff(1000, 60_000, getClock(ctx)),
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
		const [fakeRuntime, , m, err] = createTestRuntimeManager(ctx);
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

		const backOff = newBackOff(1000, 60_000, getClock(ctx));
		const result = await m.syncPod(ctx, pod, emptyPodStatus(), [], backOff, false);

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
browser.describe("KubeGenericRuntimeManager.computePodActions", ({ ctx }) => {
	const [, , m, err] = createTestRuntimeManager(ctx);
	if (err) {
		throw err;
	}
	const livenessManager = m.livenessManager;
	const startupManager = m.startupManager;
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
			mutateStatusFn: async (status: PodRuntimeStatus) => {
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
			mutatePodFn: async (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Always";
				}
			},
			mutateStatusFn: async (status: PodRuntimeStatus) => {
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
			mutatePodFn: async (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "OnFailure";
				}
			},
			mutateStatusFn: async (status: PodRuntimeStatus) => {
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
			mutatePodFn: async (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "OnFailure";
				}
			},
			mutateStatusFn: async (status: PodRuntimeStatus) => {
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
			mutatePodFn: async (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
			},
			mutateStatusFn: async (status: PodRuntimeStatus) => {
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
			mutatePodFn: async (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Always";
				}
			},
			mutateStatusFn: async (status: PodRuntimeStatus) => {
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
			mutatePodFn: async (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "OnFailure";
				}
			},
			mutateStatusFn: async (status: PodRuntimeStatus) => {
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
			mutateStatusFn: async (status: PodRuntimeStatus) => {
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
			mutatePodFn: async (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Always";
				}
			},
			mutateStatusFn: async (status: PodRuntimeStatus) => {
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
			mutatePodFn: async (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Always";
				}
			},
			mutateStatusFn: async (status: PodRuntimeStatus) => {
				await livenessManager.set(
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
			mutatePodFn: async (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Always";
				}
			},
			mutateStatusFn: async (status: PodRuntimeStatus) => {
				await startupManager.set(
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
			mutatePodFn: async (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
			},
			mutateStatusFn: async (status: PodRuntimeStatus) => {
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
			mutatePodFn: async (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "OnFailure";
				}
			},
			mutateStatusFn: async (status: PodRuntimeStatus) => {
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
			mutatePodFn: async (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
			},
			mutateStatusFn: async (status: PodRuntimeStatus) => {
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
			mutatePodFn: async (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
			},
			mutateStatusFn: async (status: PodRuntimeStatus) => {
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
			mutatePodFn: async (pod: V1Pod) => {
				if (pod.spec) {
					pod.spec.restartPolicy = "Never";
				}
			},
			mutateStatusFn: async (status: PodRuntimeStatus) => {
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
	] satisfies ComputePodActionsCase[])("$name", async (test) => {
		const [pod, status] = makeBasePodAndStatus();
		if (test.mutatePodFn) {
			await test.mutatePodFn(pod);
		}
		if (test.mutateStatusFn) {
			await test.mutateStatusFn(status);
		}

		const actions = m.computePodActions(ctx, pod, status, false);
		verifyActions(test.actions, actions);
		test.resetStatusFn?.(status);
	});
});

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestComputePodActionsForRestartAllContainers.
browser.describe(
	"KubeGenericRuntimeManager.computePodActions restart all containers",
	({ ctx }) => {
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
			const [, , m, err] = createTestRuntimeManager(ctx);
			expect(err).toBeUndefined();
			const pod = test.podFunc();
			const status = test.podStatusFunc();

			const actions = m.computePodActions(ctx, pod, status, test.restartAllContainers ?? false);

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
	},
);

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestComputePodActionsWithContainerRestartRules.
browser.describe(
	"KubeGenericRuntimeManager.computePodActions container restart rules",
	({ ctx }) => {
		const [basePod, baseStatus] = makeBasePodAndStatus();
		const noAction: PodActions = podActions({
			sandboxID: baseStatus.sandboxStatuses[0]?.id,
			containersToStart: [],
			containersToKill: newContainerToKillMap(),
		});

		it.each([
			{
				name: "restart exited containers if RestartPolicy == Always",
				mutatePodFn: async (pod: V1Pod) => {
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
				mutateStatusFn: async (status: PodRuntimeStatus) => {
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
				mutatePodFn: async (pod: V1Pod) => {
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
				mutateStatusFn: async (status: PodRuntimeStatus) => {
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
				mutatePodFn: async (pod: V1Pod) => {
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
				mutateStatusFn: async (status: PodRuntimeStatus) => {
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
				mutatePodFn: async (pod: V1Pod) => {
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
				mutateStatusFn: async (status: PodRuntimeStatus) => {
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
				mutatePodFn: async (pod: V1Pod) => {
					const containers = pod.spec?.containers ?? [];
					if (containers[1]) {
						containers[1].restartPolicy = "OnFailure";
					}
					if (pod.spec) {
						pod.spec.restartPolicy = "Always";
					}
				},
				mutateStatusFn: async (status: PodRuntimeStatus) => {
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
			const [, , m] = createTestRuntimeManager(ctx);
			const [pod, status] = makeBasePodAndStatus();
			if (test.mutatePodFn) {
				await test.mutatePodFn(pod);
			}
			if (test.mutateStatusFn) {
				await test.mutateStatusFn(status);
			}

			const actions = m.computePodActions(ctx, pod, status, false);
			verifyActions(test.actions, actions);
		});

		// Upstream also covers TestComputePodActionsWithInitContainers,
		// TestComputePodActionsWithRestartableInitContainers, and
		// TestComputePodActionsWithInitAndEphemeralContainers. Those tables are left
		// out here because this simulator intentionally excludes init and ephemeral
		// containers from kuberuntime behavior.
	},
);

// Upstream kuberuntime_manager_test.go has pod resize, actuated resource, and
// image-volume tests before TestDoBackOff. The simulator does not model
// allocationManager resource actuation, in-place pod resize, or Kubernetes
// volumes/CSI image volumes, so those tests are outside the current project scope.

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go TestDoBackOff.
browser.describe("KubeGenericRuntimeManager.doBackOff", ({ ctx }) => {
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
		const [, , manager] = createTestRuntimeManager(ctx);
		const clock = getClock(ctx);
		const pod = testBackoffPod();
		const container = pod.spec?.containers?.[0] as V1Container;
		const podStatus = test.podStatus(clock);
		const backOff = test.backoff(clock);
		const doBackOffManager = manager as unknown as DoBackOffManager;
		test.backoffUpdateFn?.(backOff, pod, podStatus);

		const [inBackOff, msg, err] = await doBackOffManager.doBackOff(
			ctx,
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
browser.describe("KubeGenericRuntimeManager.OnPodSandboxReady invocation", ({ ctx }) => {
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
		const [fakeRuntime, fakeImage, m, err] = createTestRuntimeManager(ctx);
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
			ctx,
			pod,
			emptyPodStatus(),
			[],
			newBackOff(1000, 60_000, getClock(ctx)),
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
browser.describe("KubeGenericRuntimeManager.OnPodSandboxReady timing", ({ ctx }) => {
	it("invokes OnPodSandboxReady after sandbox creation and before container creation", async () => {
		const [fakeRuntime, fakeImage, m, err] = createTestRuntimeManager(ctx);
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
			ctx,
			pod,
			emptyPodStatus(),
			[],
			newBackOff(1000, 60_000, getClock(ctx)),
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

interface ComputePodActionsCase {
	name: string;
	mutatePodFn?: (pod: V1Pod) => Promise<void>;
	mutateStatusFn?: (status: PodRuntimeStatus) => Promise<void>;
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
		image: container?.image ?? "busybox",
		imageID: container?.image ?? "busybox",
		imageRef: container?.image ?? "busybox",
		imageRuntimeHandler: "",
		hash: container ? hashContainer(container) : 0,
		state,
		restartCount: 0,
		createdAt: 0,
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
