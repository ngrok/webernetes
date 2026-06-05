import type { V1Pod } from "../../../client";
import type { Backoff } from "../../../client-go/util/flowcontrol/backoff";
import { deepMerge } from "../../../deep-merge";
import type * as context from "../../../go/context";
import type { DeepPartial } from "../../../utility-types";
import type { ImageFsInfoResponse, PodSandboxConfig, PodSandboxStatus } from "../../cri";
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

	clone(): RuntimeHandler {
		return new RuntimeHandler(structuredClone(this));
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
export interface Status {
	id: ContainerID;
	name: string;
	state: State;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	exitCode?: number;
	image: string;
	imageID: string;
	imageRef: string;
	imageRuntimeHandler: string;
	hash: number;
	restartCount: number;
	reason?: string;
	message?: string;
	resources?: ContainerResources;
	user?: ContainerUser;
	mounts?: Mount[];
	stopSignal?: string;
}

// Models kubernetes/pkg/kubelet/container/runtime.go ContainerResources.
export interface ContainerResources {
	cpuRequest?: unknown;
	cpuLimit?: unknown;
	memoryRequest?: unknown;
	memoryLimit?: unknown;
}

// Models kubernetes/pkg/kubelet/container/runtime.go ContainerUser.
export interface ContainerUser {
	linux?: LinuxContainerUser;
}

// Models kubernetes/pkg/kubelet/container/runtime.go LinuxContainerUser.
export interface LinuxContainerUser {
	uid?: number;
	gid?: number;
	supplementalGroups?: number[];
}

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

// Models kubernetes/pkg/kubelet/container/runtime.go ContainerReasonStatusUnknown.
export const containerReasonStatusUnknown = "ContainerStatusUnknown";

// Models kubernetes/pkg/kubelet/container/runtime.go MaxPodTerminationMessageLogLength.
export const maxPodTerminationMessageLogLength = 1024 * 12;

// Models kubernetes/pkg/kubelet/container/runtime.go ContainerID.
export class ContainerID {
	constructor(
		readonly type: string,
		readonly id: string,
	) {}

	// Models kubernetes/pkg/kubelet/container/runtime.go ContainerID.IsEmpty.
	isEmpty(): boolean {
		return this.type === "" && this.id === "";
	}

	// Models kubernetes/pkg/kubelet/container/runtime.go ContainerID.String.
	toString(): string {
		return `${this.type}://${this.id}`;
	}
}

// Models kubernetes/pkg/kubelet/container/runtime.go ContainerID.
export function newContainerID(id: DeepPartial<ContainerID> = {}): ContainerID {
	return new ContainerID(id.type ?? "", id.id ?? "");
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

// Models kubernetes/pkg/kubelet/container/runtime.go Pod.
export function newPod(pod: DeepPartial<Pod> = {}): Pod {
	const normalizedPod: DeepPartial<Pod> = { ...pod };
	if (pod.containers) {
		normalizedPod.containers = pod.containers.map((container) => newContainer(container));
	}
	if (pod.sandboxes) {
		normalizedPod.sandboxes = pod.sandboxes.map((sandbox) => newContainer(sandbox));
	}
	return deepMerge<Pod>(
		{
			id: "",
			name: "",
			namespace: "",
			createdAt: 0,
			containers: [],
			sandboxes: [],
			timestamp: new Date(0),
		},
		normalizedPod,
	);
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

// Models kubernetes/pkg/kubelet/container/runtime.go Container.
export function newContainer(container: DeepPartial<Container> = {}): Container {
	const normalizedContainer: DeepPartial<Container> = { ...container };
	if (container.id) {
		normalizedContainer.id = newContainerID(container.id);
	}
	return deepMerge<Container>(
		{
			id: newContainerID(),
			name: "",
			image: "",
			imageID: "",
			imageRef: "",
			imageRuntimeHandler: "",
			hash: 0,
			state: "Created",
			podSandboxID: "",
			createdAt: 0,
		},
		normalizedContainer,
	);
}

// Models kubernetes/pkg/kubelet/container/runtime.go PodStatus.
export interface PodStatus {
	id: string;
	name: string;
	namespace: string;
	ips: string[];
	containerStatuses: Status[];
	activeContainerStatuses?: Status[];
	sandboxStatuses: PodSandboxStatus[];
	timestamp: Date;
}

// Models kubernetes/pkg/kubelet/container/runtime.go PodStatus.
export function newPodStatus(status: DeepPartial<PodStatus> = {}): PodStatus {
	return deepMerge<PodStatus>(
		{
			id: "",
			name: "",
			namespace: "",
			ips: [],
			containerStatuses: [],
			sandboxStatuses: [],
			timestamp: new Date(0),
		},
		status,
	);
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
	imageFsInfo(
		ctx: context.Context,
	): Promise<[imageFsInfo: ImageFsInfoResponse | undefined, err: Error | undefined]>;
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
		podStatus: PodStatus,
		pullSecrets: unknown[],
		backOff: Backoff,
		restartAllContainers: boolean,
	): Promise<PodSyncResult>;
	getPodStatus(
		ctx: context.Context,
		pod: Pod,
	): Promise<[podStatus: PodStatus | undefined, err: Error | undefined]>;
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
	generatePodStatus(event: ContainerEventResponse): PodStatus | undefined;
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
	isPodResizeInProgress(allocatedPod: V1Pod, podStatus: PodStatus): boolean;
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

// Models k8s.io/utils/exec/exec.go ExitError.
export interface ExitError extends Error {
	exited(): boolean;
	exitStatus(): number;
}

export function isExitError(err: Error | undefined): err is ExitError {
	if (!err) {
		return false;
	}
	return (
		"exited" in err &&
		typeof err.exited === "function" &&
		"exitStatus" in err &&
		typeof err.exitStatus === "function"
	);
}

// Models k8s.io/utils/exec/exec.go CodeExitError for local command runner results.
export class ContainerCommandExitError extends Error implements ExitError {
	constructor(private readonly code: number) {
		super(`command terminated with exit code ${code}`);
		this.name = "ContainerCommandExitError";
	}

	exited(): boolean {
		return true;
	}

	exitStatus(): number {
		return this.code;
	}
}

// Models kubernetes/pkg/kubelet/container/runtime.go PodStatus.FindContainerStatusByName.
export function findContainerStatusByName(
	podStatus: PodStatus,
	containerName: string,
): Status | undefined {
	return podStatus.containerStatuses.find(
		(containerStatus) => containerStatus.name === containerName,
	);
}

// Models kubernetes/pkg/kubelet/container/runtime.go PodStatus.GetRunningContainerStatuses.
export function getRunningContainerStatuses(podStatus: PodStatus): Status[] {
	return podStatus.containerStatuses.filter(
		(containerStatus) => containerStatus.state === "Running",
	);
}

// Models kubernetes/pkg/kubelet/container/runtime.go Pods.FindPodByID.
export function findPodByID(pods: Pod[], podUID: string): Pod {
	return pods.find((pod) => pod.id === podUID) ?? newPod();
}

// Models kubernetes/pkg/kubelet/container/runtime.go Pods.FindPodByFullName.
export function findPodByFullName(pods: Pod[], podFullName: string): Pod {
	return pods.find((pod) => buildPodFullName(pod.name, pod.namespace) === podFullName) ?? newPod();
}

// Models kubernetes/pkg/kubelet/container/runtime.go Pods.FindPod.
export function findPod(pods: Pod[], podFullName: string, podUID: string): Pod {
	if (podFullName.length > 0) {
		return findPodByFullName(pods, podFullName);
	}
	return findPodByID(pods, podUID);
}

// Models kubernetes/pkg/kubelet/container/runtime.go Pod.FindContainerByName.
export function findContainerByName(pod: Pod, containerName: string): Container | undefined {
	return pod.containers.find((container) => container.name === containerName);
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

// Models kubernetes/pkg/kubelet/container/runtime.go Pod.IsEmpty.
export function podIsEmpty(pod: Pod): boolean {
	return (
		pod.id === "" &&
		pod.name === "" &&
		pod.namespace === "" &&
		pod.createdAt === 0 &&
		pod.containers.length === 0 &&
		pod.sandboxes.length === 0 &&
		pod.timestamp.getTime() === 0
	);
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
	return `${pod.metadata?.name ?? ""}_${pod.metadata?.namespace ?? ""}`;
}

// Models kubernetes/pkg/kubelet/container/runtime.go BuildPodFullName.
export function buildPodFullName(name: string, namespace: string): string {
	return `${name}_${namespace}`;
}

// Models kubernetes/pkg/kubelet/container/runtime.go ParsePodFullName.
export function parsePodFullName(podFullName: string): [string, string, Error | undefined] {
	const parts = podFullName.split("_");
	if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
		return ["", "", new Error(`failed to parse the pod full name "${podFullName}"`)];
	}
	return [parts[0] ?? "", parts[1] ?? "", undefined];
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
