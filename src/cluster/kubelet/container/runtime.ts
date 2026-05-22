import type { V1Pod } from "../../../client";
import type { Backoff } from "../../../client-go/util/flowcontrol/backoff";
import type * as context from "../../../go/context";
import type { ContainerStatus, PodRuntimeStatus, PodSandboxConfig } from "../../cri";
import type {
	CheckpointContainerRequest,
	ContainerEventResponse,
	MetricDescriptor,
	PodSandboxMetrics,
} from "../../cri/runtime/v1/api";
import type { PodSyncResult } from "./sync-result";

// Models kubernetes/pkg/kubelet/container/runtime.go Version.
export interface Version {
	compare(other: string): [result: number, err: Error | undefined];
	toString(): string;
}

// Models kubernetes/pkg/kubelet/container/runtime.go RuntimeConditionType.
export type RuntimeConditionType = string;

// Models kubernetes/pkg/kubelet/container/runtime.go RuntimeReady.
export const runtimeReady: RuntimeConditionType = "RuntimeReady";

// Models kubernetes/pkg/kubelet/container/runtime.go NetworkReady.
export const networkReady: RuntimeConditionType = "NetworkReady";

// Models kubernetes/pkg/kubelet/container/runtime.go RuntimeStatus.
export class RuntimeStatus {
	conditions: RuntimeCondition[];
	handlers: RuntimeHandler[];
	features: RuntimeFeatures | undefined;

	constructor(
		options: {
			conditions?: RuntimeCondition[];
			handlers?: RuntimeHandler[];
			features?: RuntimeFeatures | undefined;
		} = {},
	) {
		this.conditions = options.conditions ?? [];
		this.handlers = options.handlers ?? [];
		this.features = options.features;
	}

	// Models kubernetes/pkg/kubelet/container/runtime.go RuntimeStatus.GetRuntimeCondition.
	getRuntimeCondition(type: RuntimeConditionType): RuntimeCondition | undefined {
		return this.conditions.find((condition) => condition.type === type);
	}

	toString(): string {
		return `Runtime Conditions: ${this.conditions.map((condition) => condition.toString()).join(", ")}; Handlers: ${this.handlers.map((handler) => handler.toString()).join(", ")}, Features: ${this.features?.toString() ?? "nil"}`;
	}
}

// Models kubernetes/pkg/kubelet/container/runtime.go RuntimeHandler.
export class RuntimeHandler {
	name: string;
	supportsRecursiveReadOnlyMounts: boolean;
	supportsUserNamespaces: boolean;

	constructor(options: {
		name: string;
		supportsRecursiveReadOnlyMounts?: boolean;
		supportsUserNamespaces?: boolean;
	}) {
		this.name = options.name;
		this.supportsRecursiveReadOnlyMounts = options.supportsRecursiveReadOnlyMounts ?? false;
		this.supportsUserNamespaces = options.supportsUserNamespaces ?? false;
	}

	toString(): string {
		return `Name=${this.name} SupportsRecursiveReadOnlyMounts: ${this.supportsRecursiveReadOnlyMounts} SupportsUserNamespaces: ${this.supportsUserNamespaces}`;
	}
}

// Models kubernetes/pkg/kubelet/container/runtime.go RuntimeCondition.
export class RuntimeCondition {
	type: RuntimeConditionType;
	status: boolean;
	reason: string;
	message: string;

	constructor(options: {
		type: RuntimeConditionType;
		status: boolean;
		reason?: string;
		message?: string;
	}) {
		this.type = options.type;
		this.status = options.status;
		this.reason = options.reason ?? "";
		this.message = options.message ?? "";
	}

	toString(): string {
		return `${this.type}=${this.status} reason:${this.reason} message:${this.message}`;
	}
}

// Models kubernetes/pkg/kubelet/container/runtime.go RuntimeFeatures.
export class RuntimeFeatures {
	supplementalGroupsPolicy: boolean;
	userNamespacesHostNetwork: boolean;

	constructor(
		options: {
			supplementalGroupsPolicy?: boolean;
			userNamespacesHostNetwork?: boolean;
		} = {},
	) {
		this.supplementalGroupsPolicy = options.supplementalGroupsPolicy ?? false;
		this.userNamespacesHostNetwork = options.userNamespacesHostNetwork ?? false;
	}

	toString(): string {
		return `SupplementalGroupsPolicy: ${this.supplementalGroupsPolicy} UserNamespacesHostNetwork: ${this.userNamespacesHostNetwork}`;
	}
}

// Models kubernetes/pkg/kubelet/container/runtime.go Status.
export type Status = ContainerStatus;

// Models kubernetes/pkg/kubelet/container/runtime.go GCPolicy.
export interface GCPolicy {
	minAgeMs?: number;
	maxPerPodContainer?: number;
	maxContainers?: number;
}

// Models kubernetes/pkg/kubelet/types SwapBehavior.
export type SwapBehavior = "NoSwap" | "LimitedSwap" | "UnlimitedSwap";

// Models kubernetes/pkg/kubelet/container/runtime.go ErrPodNotFound.
export const errPodNotFound = new Error("pod sandboxes not found");

// Models kubernetes/pkg/kubelet/container/runtime.go ContainerID.
export class ContainerID {
	constructor(
		readonly type: string,
		readonly id: string,
	) {}

	toString(): string {
		return `${this.type}://${this.id}`;
	}
}

// Models kubernetes/pkg/kubelet/container/runtime.go State.
export type State = "Created" | "Running" | "Exited" | "Unknown";

// Models kubernetes/pkg/kubelet/container/runtime.go Pod.
export interface Pod {
	id: string;
	name: string;
	namespace: string;
	createdAt: number;
	containers: Container[];
	sandboxes: Container[];
	timestamp: Date;
}

// Models kubernetes/pkg/kubelet/container/runtime.go Container.
export interface Container {
	id: ContainerID;
	name: string;
	image: string;
	imageID: string;
	imageRef: string;
	imageRuntimeHandler: string;
	hash: number;
	state: State;
	podSandboxID: string;
	createdAt: number;
}

export interface EnvVar {
	name: string;
	value: string;
}

export interface Annotation {
	name: string;
	value: string;
}

// Models kubernetes/pkg/kubelet/container/runtime.go ImageSpec.
export interface ImageSpec {
	image: string;
	runtimeHandler?: string;
	annotations?: Annotation[];
}

// Models kubernetes/pkg/kubelet/container/runtime.go Image.
export interface Image {
	id: string;
	repoTags: string[];
	repoDigests: string[];
	size: number;
	spec: ImageSpec;
	pinned: boolean;
}

// Models kubernetes/pkg/kubelet/container/runtime.go ImageStats.
export interface ImageStats {
	totalStorageBytes: number;
}

// Models kubernetes/pkg/kubelet/container/runtime.go Mount.
export interface Mount {
	name: string;
	containerPath: string;
	hostPath: string;
	readOnly: boolean;
	recursiveReadOnly: boolean;
	selinuxRelabel: boolean;
	propagation?: string;
	image?: ImageSpec;
	imageSubPath?: string;
}

// Models kubernetes/pkg/kubelet/container/runtime.go ImageVolumes.
export type ImageVolumes = Map<string, ImageSpec>;

// Models kubernetes/pkg/kubelet/container/runtime.go DeviceInfo.
export interface DeviceInfo {
	pathOnHost: string;
	pathInContainer: string;
	permissions: string;
}

// Models kubernetes/pkg/kubelet/container/runtime.go CDIDevice.
export interface CDIDevice {
	name: string;
}

// Models kubernetes/pkg/kubelet/container/runtime.go RunContainerOptions.
export interface RunContainerOptions {
	envs?: EnvVar[];
	mounts?: Mount[];
	devices?: DeviceInfo[];
	cdiDevices?: CDIDevice[];
	annotations?: Annotation[];
	podContainerDir?: string;
	readOnly?: boolean;
}

// Models kubernetes/pkg/kubelet/container/runtime.go ImageService.
export interface ImageService {
	pullImage(
		ctx: context.Context,
		image: ImageSpec,
		credentials: unknown[],
		podSandboxConfig: PodSandboxConfig,
	): Promise<[imageRef: string, credentialsUsed: unknown | undefined, err: Error | undefined]>;
	getImageRef(
		ctx: context.Context,
		image: ImageSpec,
	): Promise<[imageRef: string, err: Error | undefined]>;
	listImages(ctx: context.Context): Promise<[images: Image[], err: Error | undefined]>;
	removeImage(ctx: context.Context, image: ImageSpec): Promise<Error | undefined>;
	imageStats(
		ctx: context.Context,
	): Promise<[imageStats: ImageStats | undefined, err: Error | undefined]>;
	imageFsInfo(ctx: context.Context): Promise<[imageFsInfo: unknown, err: Error | undefined]>;
	getImageSize(
		ctx: context.Context,
		image: ImageSpec,
	): Promise<[imageSize: number, err: Error | undefined]>;
}

// Models kubernetes/pkg/kubelet/container/runtime.go Runtime.
export interface Runtime extends ImageService {
	type(): string;
	version(ctx: context.Context): Promise<[version: Version | undefined, err: Error | undefined]>;
	apiVersion(): Promise<[version: Version | undefined, err: Error | undefined]>;
	status(
		ctx: context.Context,
	): Promise<[status: RuntimeStatus | undefined, err: Error | undefined]>;
	getPods(ctx: context.Context, all: boolean): Promise<[pods: Pod[], err: Error | undefined]>;
	getPod(
		ctx: context.Context,
		podUid: string,
	): Promise<[pod: Pod | undefined, err: Error | undefined]>;
	garbageCollect(
		ctx: context.Context,
		gcPolicy: GCPolicy,
		allSourcesReady: boolean,
		evictNonDeletedPods: boolean,
	): Promise<Error | undefined>;
	syncPod(
		ctx: context.Context,
		pod: V1Pod,
		podStatus: PodRuntimeStatus,
		pullSecrets: unknown[],
		backOff: Backoff,
		restartAllContainers: boolean,
	): Promise<PodSyncResult>;
	getPodStatus(
		ctx: context.Context,
		pod: Pod,
	): Promise<[podStatus: PodRuntimeStatus | undefined, err: Error | undefined]>;
	killPod(
		ctx: context.Context,
		pod: V1Pod | undefined,
		runningPod: Pod,
		gracePeriodOverride: number | undefined,
	): Promise<Error | undefined>;
	deleteContainer(ctx: context.Context, containerID: ContainerID): Promise<Error | undefined>;
	updatePodCIDR(ctx: context.Context, podCIDR: string): Promise<Error | undefined>;
	checkpointContainer(
		ctx: context.Context,
		options: CheckpointContainerRequest,
	): Promise<Error | undefined>;
	generatePodStatus(event: ContainerEventResponse): PodRuntimeStatus | undefined;
	listMetricDescriptors(
		ctx: context.Context,
	): Promise<[descriptors: MetricDescriptor[], err: Error | undefined]>;
	listPodSandboxMetrics(
		ctx: context.Context,
	): Promise<[metrics: PodSandboxMetrics[], err: Error | undefined]>;
	getContainerStatus(
		ctx: context.Context,
		podUid: string,
		id: ContainerID,
	): Promise<[status: Status | undefined, err: Error | undefined]>;
	getContainerSwapBehavior(
		pod: V1Pod,
		container: NonNullable<V1Pod["spec"]>["containers"][number],
	): SwapBehavior;
	isPodResizeInProgress(allocatedPod: V1Pod, podStatus: PodRuntimeStatus): boolean;
	updateActuatedPodLevelResources(actuatedPod: V1Pod): Promise<Error | undefined>;
}

// Models kubernetes/pkg/kubelet/container/runtime.go CommandRunner.
export interface CommandRunner {
	runInContainer(
		ctx: context.Context,
		id: ContainerID,
		cmd: string[],
		timeoutSeconds?: number,
	): Promise<[output: string, err: Error | undefined]>;
}

// Models kubernetes/pkg/kubelet/container/runtime.go PodStatus.FindContainerStatusByName.
export function findContainerStatusByName(
	podStatus: PodRuntimeStatus,
	containerName: string,
): ContainerStatus | undefined {
	return podStatus.containerStatuses.find(
		(containerStatus) => containerStatus.name === containerName,
	);
}

// Models kubernetes/pkg/kubelet/container/runtime.go Pod.FindContainerByID.
export function findContainerByID(pod: Pod, id: ContainerID): Container | undefined {
	return pod.containers.find(
		(container) => container.id.type === id.type && container.id.id === id.id,
	);
}

// Models kubernetes/pkg/kubelet/container/runtime.go Pod.FindSandboxByID.
export function findSandboxByID(pod: Pod, id: ContainerID): Container | undefined {
	return pod.sandboxes.find((sandbox) => sandbox.id.type === id.type && sandbox.id.id === id.id);
}

// Models kubernetes/pkg/kubelet/container/runtime.go BuildContainerID.
export function buildContainerID(type: string, id: string): ContainerID {
	return new ContainerID(type, id);
}

// Models kubernetes/pkg/kubelet/container/runtime.go ParseContainerID.
export function parseContainerID(containerID: string | undefined): ContainerID {
	const parts = containerID?.replace(/^"+|"+$/g, "").split("://") ?? [];
	if (parts.length !== 2) {
		return new ContainerID("", "");
	}
	return new ContainerID(parts[0] ?? "", parts[1] ?? "");
}

// Models kubernetes/pkg/kubelet/container/runtime.go GetPodFullName.
export function getPodFullName(pod: V1Pod): string {
	// Use underscore as the delimiter because it is not allowed in pod name
	// (DNS subdomain format), while allowed in the container name format.
	return `${pod.metadata?.name ?? ""}_${pod.metadata?.namespace ?? "default"}`;
}

// Models kubernetes/pkg/kubelet/container/runtime.go BuildPodFullName.
export function buildPodFullName(name: string, namespace: string): string {
	return `${name}_${namespace}`;
}

// Models kubernetes/pkg/kubelet/container/runtime.go ParsePodFullName.
export function parsePodFullName(podFullName: string): [string, string] {
	const parts = podFullName.split("_");
	if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
		throw new Error(`failed to parse the pod full name "${podFullName}"`);
	}
	return [parts[0] ?? "", parts[1] ?? ""];
}

// Models kubernetes/pkg/kubelet/container/runtime.go Pod.ToAPIPod.
export function toAPIPod(pod: Pod): V1Pod {
	return {
		metadata: {
			uid: pod.id,
			name: pod.name,
			namespace: pod.namespace,
		},
		spec: {
			containers: pod.containers.map((container) => ({
				name: container.name,
				image: container.image,
			})),
		},
	};
}
