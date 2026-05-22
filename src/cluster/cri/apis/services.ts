import type {
	ContainerFilter,
	ContainerStatusResponse,
	CheckpointContainerRequest,
	ExecSyncResponse,
	ImageFilter,
	ImageFsInfoResponse,
	ImageStatusResponse,
	ListContainersResponse,
	MetricDescriptor,
	PodSandboxMetrics,
	ListPodSandboxResponse,
	PodSandboxFilter,
	PodSandboxStatusResponse,
	StatusResponse,
	UpdateRuntimeConfigRequest,
	VersionResponse,
} from "../runtime/v1/api";
import type * as context from "../../../go/context";
import type { ContainerConfig, Image, ImageSpec, PodSandboxConfig } from "../runtime";

export type ServiceError = Error | undefined;

// Models staging/src/k8s.io/cri-api/pkg/apis/services.go RuntimeVersioner.
export interface RuntimeVersioner {
	version(
		ctx: context.Context,
		apiVersion: string,
	): Promise<[response: VersionResponse | undefined, err: ServiceError]>;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/services.go ContainerManager.
export interface ContainerManager {
	createContainer(
		ctx: context.Context,
		podSandboxId: string,
		config: ContainerConfig,
		sandboxConfig: PodSandboxConfig,
	): Promise<[containerId: string, err: ServiceError]>;
	startContainer(ctx: context.Context, containerId: string): Promise<ServiceError>;
	stopContainer(ctx: context.Context, containerId: string, timeout?: number): Promise<ServiceError>;
	removeContainer(ctx: context.Context, containerId: string): Promise<ServiceError>;
	listContainers(
		ctx: context.Context,
		filter?: ContainerFilter,
	): Promise<[containers: ListContainersResponse["containers"], err: ServiceError]>;
	containerStatus(
		ctx: context.Context,
		containerId: string,
		verbose?: boolean,
	): Promise<[response: ContainerStatusResponse | undefined, err: ServiceError]>;
	execSync(
		ctx: context.Context,
		containerId: string,
		cmd: string[],
		timeout?: number,
	): Promise<[response: ExecSyncResponse | undefined, err: ServiceError]>;
	checkpointContainer(
		ctx: context.Context,
		options: CheckpointContainerRequest,
	): Promise<ServiceError>;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/services.go PodSandboxManager.
export interface PodSandboxManager {
	runPodSandbox(
		ctx: context.Context,
		config: PodSandboxConfig,
		runtimeHandler?: string,
	): Promise<[podSandboxId: string, err: ServiceError]>;
	stopPodSandbox(ctx: context.Context, podSandboxId: string): Promise<ServiceError>;
	removePodSandbox(ctx: context.Context, podSandboxId: string): Promise<ServiceError>;
	podSandboxStatus(
		ctx: context.Context,
		podSandboxId: string,
		verbose?: boolean,
	): Promise<[response: PodSandboxStatusResponse | undefined, err: ServiceError]>;
	listPodSandbox(
		ctx: context.Context,
		filter?: PodSandboxFilter,
	): Promise<[items: ListPodSandboxResponse["items"], err: ServiceError]>;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/services.go RuntimeService.
export interface RuntimeService extends RuntimeVersioner, ContainerManager, PodSandboxManager {
	status(
		ctx: context.Context,
		verbose?: boolean,
	): Promise<[response: StatusResponse | undefined, err: ServiceError]>;
	updateRuntimeConfig(
		ctx: context.Context,
		config: UpdateRuntimeConfigRequest,
	): Promise<ServiceError>;
	listMetricDescriptors(
		ctx: context.Context,
	): Promise<[descriptors: MetricDescriptor[], err: ServiceError]>;
	listPodSandboxMetrics(
		ctx: context.Context,
	): Promise<[metrics: PodSandboxMetrics[], err: ServiceError]>;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/services.go ImageManagerService.
export interface ImageManagerService {
	imageStatus(
		ctx: context.Context,
		image: ImageSpec,
		verbose?: boolean,
	): Promise<[response: ImageStatusResponse | undefined, err: ServiceError]>;
	pullImage(
		ctx: context.Context,
		image: ImageSpec,
		credentials: unknown[],
		podSandboxConfig?: PodSandboxConfig,
	): Promise<[imageRef: string, err: ServiceError]>;
	listImages(
		ctx: context.Context,
		filter?: ImageFilter,
	): Promise<[images: Image[], err: ServiceError]>;
	removeImage(ctx: context.Context, image: ImageSpec): Promise<ServiceError>;
	imageFsInfo(ctx: context.Context): Promise<[response: ImageFsInfoResponse, err: ServiceError]>;
}
