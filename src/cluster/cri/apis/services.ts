import type {
	ContainerFilter,
	ContainerStatusResponse,
	ExecSyncResponse,
	ImageStatusResponse,
	ListContainersResponse,
	ListPodSandboxResponse,
	PodSandboxFilter,
	PodSandboxStatusResponse,
	StatusResponse,
	VersionResponse,
} from "../runtime/v1/api";
import type * as context from "../../../go/context";
import type { ContainerConfig, ImageSpec, PodSandboxConfig } from "../runtime";

// Models staging/src/k8s.io/cri-api/pkg/apis/services.go RuntimeVersioner.
export interface RuntimeVersioner {
	version(ctx: context.Context, apiVersion: string): Promise<VersionResponse>;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/services.go ContainerManager.
export interface ContainerManager {
	createContainer(
		ctx: context.Context,
		podSandboxId: string,
		config: ContainerConfig,
		sandboxConfig: PodSandboxConfig,
	): Promise<string>;
	startContainer(ctx: context.Context, containerId: string): Promise<void>;
	stopContainer(ctx: context.Context, containerId: string, timeout?: number): Promise<void>;
	removeContainer(ctx: context.Context, containerId: string): Promise<void>;
	listContainers(
		ctx: context.Context,
		filter?: ContainerFilter,
	): Promise<ListContainersResponse["containers"]>;
	containerStatus(
		ctx: context.Context,
		containerId: string,
		verbose?: boolean,
	): Promise<ContainerStatusResponse>;
	execSync(
		ctx: context.Context,
		containerId: string,
		cmd: string[],
		timeout?: number,
	): Promise<ExecSyncResponse>;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/services.go PodSandboxManager.
export interface PodSandboxManager {
	runPodSandbox(
		ctx: context.Context,
		config: PodSandboxConfig,
		runtimeHandler?: string,
	): Promise<string>;
	stopPodSandbox(ctx: context.Context, podSandboxId: string): Promise<void>;
	removePodSandbox(ctx: context.Context, podSandboxId: string): Promise<void>;
	podSandboxStatus(
		ctx: context.Context,
		podSandboxId: string,
		verbose?: boolean,
	): Promise<PodSandboxStatusResponse>;
	listPodSandbox(
		ctx: context.Context,
		filter?: PodSandboxFilter,
	): Promise<ListPodSandboxResponse["items"]>;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/services.go RuntimeService.
export interface RuntimeService extends RuntimeVersioner, ContainerManager, PodSandboxManager {
	status(ctx: context.Context, verbose?: boolean): Promise<StatusResponse>;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/services.go ImageManagerService.
export interface ImageManagerService {
	getImageRef(
		ctx: context.Context,
		image: ImageSpec,
	): Promise<[imageRef: string, err: Error | undefined]>;
	getImageSize(
		ctx: context.Context,
		image: ImageSpec,
	): Promise<[imageSize: number, err: Error | undefined]>;
	imageStatus(
		ctx: context.Context,
		image: ImageSpec,
		verbose?: boolean,
	): Promise<ImageStatusResponse>;
	pullImage(
		ctx: context.Context,
		image: ImageSpec,
		credentials: unknown[],
		podSandboxConfig?: PodSandboxConfig,
	): Promise<[imageRef: string, credentialsUsed: unknown | undefined, err: Error | undefined]>;
}
