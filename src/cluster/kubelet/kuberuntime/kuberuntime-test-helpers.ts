/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect } from "vitest";
import type { V1Container, V1Pod } from "../../../client";
import { newBackOff } from "../../../client-go/util/flowcontrol/backoff";
import { getClock } from "../../../clock-context";
import * as context from "../../../go/context";
import type {
	ContainerConfig,
	ContainerStatus as CRIContainerStatus,
	Image as CRIImage,
	ImageFilter,
	ImageFsInfoResponse,
	ImageManagerService,
	ImageSpec as CRIImageSpec,
	ImageStatusResponse,
	PodSandboxConfig,
	PodSandboxStatus,
	RuntimeService,
} from "../../cri";
import type {
	CheckpointContainerRequest,
	Container as CRIContainer,
	ContainerStatusResponse,
	ExecSyncResponse,
	MetricDescriptor,
	PodSandbox,
	PodSandboxMetrics,
	PodSandboxStatusResponse,
	UpdateRuntimeConfigRequest,
	VersionResponse,
} from "../../cri/runtime/v1/api";
import { hashContainer, type Pod as RuntimePod, type RuntimeHelper } from "../container";
import type { InternalContainerLifecycle } from "../cm";
import { ResultsManager } from "../prober/results";
import { ClusterNetwork } from "../../cni";
import { KubeGenericRuntimeManager, type PodStateProvider } from "./kuberuntime-manager";

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go createTestRuntimeManager.
export type TestRuntimeManagerFixture = [
	fakeRuntime: TestRuntimeService,
	fakeImage: TestImageService,
	manager: KubeGenericRuntimeManager,
	err: Error | undefined,
];

export type TestRuntimeManagerErrors = Map<string, Error[]>;

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go makeFakePodSandbox.
export interface TestPodSandboxRecord {
	id: string;
	metadata: PodSandbox["metadata"];
	state: PodSandbox["state"];
	createdAt: number;
	labels: Record<string, string>;
	annotations: Record<string, string>;
	network?: PodSandboxStatus["network"];
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go makeFakeContainer.
export interface TestContainerRecord {
	id: string;
	podSandboxId: string;
	metadata: ContainerConfig["metadata"];
	image: ContainerConfig["image"];
	imageRef: string;
	imageId: string;
	state: CRIContainerStatus["state"];
	createdAt: number;
	labels: Record<string, string>;
	annotations: Record<string, string>;
	hash: number;
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go sandboxTemplate.
export interface SandboxTemplate {
	pod: V1Pod;
	attempt?: number;
	createdAt: number;
	state: PodSandbox["state"];
	running?: boolean;
	terminating?: boolean;
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go containerTemplate.
export interface ContainerTemplate {
	pod: V1Pod;
	container: V1Container;
	sandboxAttempt?: number;
	attempt?: number;
	createdAt: number;
	state: CRIContainerStatus["state"];
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go fakeCreatedAt.
export const fakeCreatedAt = 1;
// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go fakePodSandboxIPs.
export const fakePodSandboxIPs = ["10.0.0.1"];

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go createTestRuntimeManager.
export function createTestRuntimeManager(ctx: context.Context): TestRuntimeManagerFixture {
	return createTestRuntimeManagerWithErrors(ctx, undefined);
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go createTestRuntimeManagerWithErrors.
export function createTestRuntimeManagerWithErrors(
	ctx: context.Context,
	errors: TestRuntimeManagerErrors | undefined,
): TestRuntimeManagerFixture {
	const clock = getClock(ctx);
	const fakeRuntime = new TestRuntimeService(errors);
	const fakeImage = new TestImageService();
	const livenessManager = new ResultsManager();
	const startupManager = new ResultsManager();
	const podStateProvider = new FakePodStateProvider();
	const manager = new KubeGenericRuntimeManager({
		ctx,
		runtimeService: fakeRuntime,
		imageService: fakeImage,
		podStateProvider,
		runtimeHelper: new TestRuntimeHelper(fakeRuntime),
		events: {
			event: async () => undefined,
			eventf: async () => undefined,
			annotatedEventf: async () => undefined,
		},
		internalLifecycle: testInternalLifecycle(),
		livenessManager,
		imageBackOff: newBackOff(10 * 1000, 300 * 1000, clock),
		network: new ClusterNetwork(),
		startupManager,
	});
	return [fakeRuntime, fakeImage, manager, undefined];
}

// Models kubernetes/pkg/kubelet/kuberuntime/fake_kuberuntime_manager.go fakePodStateProvider.
export class FakePodStateProvider implements PodStateProvider {
	removed = new Set<string>();
	terminated = new Set<string>();

	async isPodTerminationRequested(uid: string): Promise<boolean> {
		return this.terminated.has(uid);
	}

	async shouldPodContentBeRemoved(uid: string): Promise<boolean> {
		return this.removed.has(uid);
	}

	async shouldPodRuntimeBeRemoved(uid: string): Promise<boolean> {
		return this.terminated.has(uid);
	}
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go createTestRuntimeManager image service dependency.
export class TestImageService implements ImageManagerService {
	images: string[] = [];

	async imageStatus(
		_ctx: context.Context,
		_image: CRIImageSpec,
		_verbose?: boolean,
	): Promise<[response: ImageStatusResponse | undefined, err: Error | undefined]> {
		return [{ image: undefined }, undefined];
	}

	async pullImage(
		_ctx: context.Context,
		image: CRIImageSpec,
		_credentials: unknown[],
		_podSandboxConfig?: PodSandboxConfig,
	): Promise<[imageRef: string, err: Error | undefined]> {
		this.images.push(image.image);
		return [image.image, undefined];
	}

	async listImages(
		_ctx: context.Context,
		_filter?: ImageFilter,
	): Promise<[images: CRIImage[], err: Error | undefined]> {
		return [[], undefined];
	}

	async removeImage(_ctx: context.Context, _image: CRIImageSpec): Promise<Error | undefined> {
		return undefined;
	}

	async imageFsInfo(
		_ctx: context.Context,
	): Promise<[response: ImageFsInfoResponse, err: Error | undefined]> {
		return [{ imageFilesystems: [], containerFilesystems: [] }, undefined];
	}
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go createTestRuntimeManager runtime service dependency.
export class TestRuntimeService implements RuntimeService {
	sandboxCount = 0;
	containerCount = 0;
	sandboxes: TestPodSandboxRecord[] = [];
	containers: TestContainerRecord[] = [];
	calls: string[] = [];
	private readonly errors: TestRuntimeManagerErrors;

	constructor(errors: TestRuntimeManagerErrors | undefined = undefined) {
		this.errors = errors ?? new Map<string, Error[]>();
	}

	setFakeSandboxes(sandboxes: TestPodSandboxRecord[]): void {
		this.sandboxes = sandboxes;
		this.sandboxCount = sandboxes.length;
	}

	setFakeContainers(containers: TestContainerRecord[]): void {
		this.containers = containers;
		this.containerCount = containers.length;
	}

	injectError(operation: string, err: Error): void {
		this.errors.set(operation, [...(this.errors.get(operation) ?? []), err]);
	}

	getCalls(): string[] {
		return [...this.calls];
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
		this.calls.push("StopContainer");
		const injected = this.nextInjectedError("StopContainer");
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
		this.calls.push("RemoveContainer");
		this.containers = this.containers.filter((item) => item.id !== containerId);
		return undefined;
	}

	async listContainers(
		_ctx?: context.Context,
		_filter?: unknown,
	): Promise<[CRIContainer[], undefined]> {
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
		const injected = this.nextInjectedError("ContainerStatus");
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
					id: container.id,
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

	private nextInjectedError(operation: string): Error | undefined {
		const errors = this.errors.get(operation);
		if (errors === undefined || errors.length === 0) {
			return undefined;
		}
		const [err, ...remaining] = errors;
		this.errors.set(operation, remaining);
		return err;
	}

	async execSync(): Promise<[ExecSyncResponse | undefined, undefined]> {
		return [undefined, undefined];
	}

	async checkpointContainer(
		_ctx: context.Context,
		_options: CheckpointContainerRequest,
	): Promise<undefined> {
		return undefined;
	}

	async stopPodSandbox(_ctx: context.Context, podSandboxId: string): Promise<undefined> {
		this.calls.push("StopPodSandbox");
		const sandbox = this.sandboxes.find((item) => item.id === podSandboxId);
		if (sandbox) {
			sandbox.state = "NotReady";
		}
		return undefined;
	}

	async removePodSandbox(_ctx: context.Context, podSandboxId: string): Promise<undefined> {
		this.calls.push("RemovePodSandbox");
		this.sandboxes = this.sandboxes.filter((item) => item.id !== podSandboxId);
		return undefined;
	}

	async listPodSandbox(
		_ctx?: context.Context,
		_filter?: unknown,
	): Promise<[PodSandbox[], undefined]> {
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

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go createTestRuntimeManager runtime helper dependency.
export class TestRuntimeHelper implements RuntimeHelper {
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

	async generateRunContainerOptions(): Promise<[{ envs: [] }, undefined, undefined]> {
		return [{ envs: [] }, undefined, undefined];
	}

	async getPodDNS(): Promise<[{ servers: []; searches: []; options: [] }, undefined]> {
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

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go createTestRuntimeManager internal lifecycle dependency.
export function testInternalLifecycle(): InternalContainerLifecycle {
	return {
		preCreateContainer: () => undefined,
		preStartContainer: () => undefined,
		postStopContainer: () => undefined,
	};
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go runtime pod comparison helper.
export function withoutTimestamp(
	pod: RuntimePod | undefined,
): Omit<RuntimePod, "timestamp"> | undefined {
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

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go makeAndSetFakePod.
export async function makeAndSetFakePod(
	ctx: context.Context,
	m: KubeGenericRuntimeManager,
	fakeRuntime: TestRuntimeService,
	pod: V1Pod,
): Promise<[TestPodSandboxRecord, TestContainerRecord[]]> {
	const sandbox = await makeFakePodSandbox(ctx, m, {
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
		containers.push(await makeFakeContainer(ctx, m, newTemplate(container)));
	}

	fakeRuntime.setFakeSandboxes([sandbox]);
	fakeRuntime.setFakeContainers(containers);
	return [sandbox, containers];
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go makeFakePodSandboxes.
export async function makeFakePodSandboxes(
	ctx: context.Context,
	m: KubeGenericRuntimeManager,
	templates: SandboxTemplate[],
): Promise<TestPodSandboxRecord[]> {
	const sandboxes: TestPodSandboxRecord[] = [];
	for (const template of templates) {
		sandboxes.push(await makeFakePodSandbox(ctx, m, template));
	}
	return sandboxes;
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go makeFakeContainers.
export async function makeFakeContainers(
	ctx: context.Context,
	m: KubeGenericRuntimeManager,
	templates: ContainerTemplate[],
): Promise<TestContainerRecord[]> {
	const containers: TestContainerRecord[] = [];
	for (const template of templates) {
		containers.push(await makeFakeContainer(ctx, m, template));
	}
	return containers;
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go makeFakePodSandbox.
export async function makeFakePodSandbox(
	ctx: context.Context,
	m: KubeGenericRuntimeManager,
	template: SandboxTemplate,
): Promise<TestPodSandboxRecord> {
	const [sandboxConfig, sandboxConfigErr] = await m.generatePodSandboxConfig(
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

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go makeFakeContainer.
export async function makeFakeContainer(
	ctx: context.Context,
	m: KubeGenericRuntimeManager,
	template: ContainerTemplate,
): Promise<TestContainerRecord> {
	const [sandboxConfig, sandboxConfigErr] = await m.generatePodSandboxConfig(
		ctx,
		template.pod,
		template.sandboxAttempt ?? 0,
	);
	expect(sandboxConfigErr).toBeUndefined();
	expect(sandboxConfig).toBeDefined();

	const [containerConfig, cleanupAction, containerConfigErr] = await m.generateContainerConfig(
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

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go makeTestContainer.
export function makeTestContainer(name: string, image: string): V1Container {
	return { name, image };
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go makeTestPod.
export function makeTestPod(
	podName: string,
	podNamespace: string,
	podUID: string,
	containers: V1Container[],
): V1Pod {
	return {
		metadata: {
			name: podName,
			namespace: podNamespace,
			uid: podUID,
		},
		spec: { containers },
	};
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go buildSandboxName.
export function buildSandboxName(metadata: PodSandboxConfig["metadata"]): string {
	return `${metadata.name}_${metadata.namespace}_${metadata.uid}_${metadata.attempt}`;
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go buildContainerName.
export function buildContainerName(
	metadata: ContainerConfig["metadata"],
	podSandboxID: string,
): string {
	return `${metadata.name}_${metadata.attempt}_${podSandboxID}`;
}

// Models kubernetes/pkg/kubelet/kuberuntime/kuberuntime_manager_test.go podSandboxStatusResponse.
function podSandboxStatusResponse(): PodSandboxStatusResponse {
	return {
		status: {
			id: "",
			metadata: {
				name: "",
				namespace: "",
				uid: "",
				attempt: 0,
			},
			state: "NotReady",
			createdAt: 0,
			labels: {},
			annotations: {},
		},
	};
}
