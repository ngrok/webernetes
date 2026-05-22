import type { V1Pod } from "../../../client";
import type { Backoff } from "../../../client-go/util/flowcontrol/backoff";
import type * as context from "../../../go/context";
import type { ContainerStatus, ImageSpec, PodRuntimeStatus, PodSandboxConfig } from "../../cri";
import type { StatusResponse } from "../../cri/runtime/v1/api";
import type { PodSyncResult } from "./sync-result";

// Models kubernetes/pkg/kubelet/container/runtime.go Version.
export interface Version {
	compare(other: string): [result: number, err: Error | undefined];
	toString(): string;
}

// Models kubernetes/pkg/kubelet/container/runtime.go Image.
export interface Image {
	id: string;
	repoTags: string[];
	repoDigests: string[];
	size: number;
	pinned: boolean;
}

// Models kubernetes/pkg/kubelet/container/runtime.go ImageStats.
export interface ImageStats {
	totalStorageBytes: number;
}

// Models kubernetes/pkg/kubelet/container/runtime.go RuntimeStatus.
export type RuntimeStatus = StatusResponse["status"];

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
	id: string;
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
	checkpointContainer(ctx: context.Context, options: unknown): Promise<Error | undefined>;
	generatePodStatus(event: unknown): PodRuntimeStatus | undefined;
	listMetricDescriptors(
		ctx: context.Context,
	): Promise<[descriptors: unknown[], err: Error | undefined]>;
	listPodSandboxMetrics(
		ctx: context.Context,
	): Promise<[metrics: unknown[], err: Error | undefined]>;
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
