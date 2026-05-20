import type {
	ContainerConfig,
	ContainerStatus,
	ImageSpec,
	PodSandboxConfig,
	PodSandboxState,
	PodSandboxStatus,
} from "../../runtime";

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto VersionRequest.
export interface VersionRequest {
	version: string;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto VersionResponse.
export interface VersionResponse {
	version: string;
	runtimeName: string;
	runtimeVersion: string;
	runtimeApiVersion: string;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto RunPodSandboxRequest.
export interface RunPodSandboxRequest {
	config: PodSandboxConfig;
	runtimeHandler?: string;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto RunPodSandboxResponse.
export interface RunPodSandboxResponse {
	podSandboxId: string;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto StopPodSandboxRequest.
export interface StopPodSandboxRequest {
	podSandboxId: string;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto StopPodSandboxResponse.
export type StopPodSandboxResponse = Record<string, never>;

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto RemovePodSandboxRequest.
export interface RemovePodSandboxRequest {
	podSandboxId: string;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto RemovePodSandboxResponse.
export type RemovePodSandboxResponse = Record<string, never>;

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto PodSandboxStatusRequest.
export interface PodSandboxStatusRequest {
	podSandboxId: string;
	verbose?: boolean;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto PodSandboxStatusResponse.
export interface PodSandboxStatusResponse {
	status: PodSandboxStatus;
	info?: Record<string, string>;
	containersStatuses?: ContainerStatus[];
	timestamp?: number;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto PodSandboxStateValue.
export interface PodSandboxStateValue {
	state: PodSandboxState;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto PodSandboxFilter.
export interface PodSandboxFilter {
	id?: string;
	state?: PodSandboxStateValue;
	labelSelector?: Record<string, string>;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ListPodSandboxRequest.
export interface ListPodSandboxRequest {
	filter?: PodSandboxFilter;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto PodSandbox.
export interface PodSandbox {
	id: string;
	metadata: PodSandboxStatus["metadata"];
	state: PodSandboxState;
	createdAt: number;
	labels: Record<string, string>;
	annotations: Record<string, string>;
	runtimeHandler?: string;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ListPodSandboxResponse.
export interface ListPodSandboxResponse {
	items: PodSandbox[];
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto CreateContainerRequest.
export interface CreateContainerRequest {
	podSandboxId: string;
	config: ContainerConfig;
	sandboxConfig: PodSandboxConfig;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto CreateContainerResponse.
export interface CreateContainerResponse {
	containerId: string;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto StartContainerRequest.
export interface StartContainerRequest {
	containerId: string;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto StartContainerResponse.
export type StartContainerResponse = Record<string, never>;

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto StopContainerRequest.
export interface StopContainerRequest {
	containerId: string;
	timeout?: number;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto StopContainerResponse.
export type StopContainerResponse = Record<string, never>;

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto RemoveContainerRequest.
export interface RemoveContainerRequest {
	containerId: string;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto RemoveContainerResponse.
export type RemoveContainerResponse = Record<string, never>;

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ContainerStateValue.
export interface ContainerStateValue {
	state: ContainerStatus["state"];
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ContainerFilter.
export interface ContainerFilter {
	id?: string;
	state?: ContainerStateValue;
	podSandboxId?: string;
	labelSelector?: Record<string, string>;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ListContainersRequest.
export interface ListContainersRequest {
	filter?: ContainerFilter;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto Container.
export interface Container {
	id: string;
	podSandboxId: string;
	metadata: ContainerConfig["metadata"];
	image: ImageSpec;
	imageRef: string;
	state: ContainerStatus["state"];
	createdAt: number;
	labels: Record<string, string>;
	annotations: Record<string, string>;
	imageId: string;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ListContainersResponse.
export interface ListContainersResponse {
	containers: Container[];
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ContainerStatusRequest.
export interface ContainerStatusRequest {
	containerId: string;
	verbose?: boolean;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ContainerStatusResponse.
export interface ContainerStatusResponse {
	status: ContainerStatus;
	info?: Record<string, string>;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ExecSyncRequest.
export interface ExecSyncRequest {
	containerId: string;
	cmd: string[];
	timeout?: number;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ExecSyncResponse.
export interface ExecSyncResponse {
	stdout: string;
	stderr: string;
	exitCode: number;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto RuntimeCondition.
export interface RuntimeCondition {
	type: string;
	status: boolean;
	reason?: string;
	message?: string;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto RuntimeStatus.
export interface RuntimeStatus {
	conditions: RuntimeCondition[];
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto StatusRequest.
export interface StatusRequest {
	verbose?: boolean;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto StatusResponse.
export interface StatusResponse {
	status: RuntimeStatus;
	info?: Record<string, string>;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ImageStatusRequest.
export interface ImageStatusRequest {
	image: ImageSpec;
	verbose?: boolean;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ImageStatusResponse.
export interface ImageStatusResponse {
	image?: ImageSpec;
	info?: Record<string, string>;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto PullImageRequest.
export interface PullImageRequest {
	image: ImageSpec;
	sandboxConfig?: PodSandboxConfig;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto PullImageResponse.
export interface PullImageResponse {
	imageRef: string;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api_grpc.pb.go RuntimeServiceClient.
export interface RuntimeServiceClient {
	version(request: VersionRequest): Promise<VersionResponse>;
	runPodSandbox(request: RunPodSandboxRequest): Promise<RunPodSandboxResponse>;
	stopPodSandbox(request: StopPodSandboxRequest): Promise<StopPodSandboxResponse>;
	removePodSandbox(request: RemovePodSandboxRequest): Promise<RemovePodSandboxResponse>;
	podSandboxStatus(request: PodSandboxStatusRequest): Promise<PodSandboxStatusResponse>;
	listPodSandbox(request: ListPodSandboxRequest): Promise<ListPodSandboxResponse>;
	createContainer(request: CreateContainerRequest): Promise<CreateContainerResponse>;
	startContainer(request: StartContainerRequest): Promise<StartContainerResponse>;
	stopContainer(request: StopContainerRequest): Promise<StopContainerResponse>;
	removeContainer(request: RemoveContainerRequest): Promise<RemoveContainerResponse>;
	listContainers(request: ListContainersRequest): Promise<ListContainersResponse>;
	containerStatus(request: ContainerStatusRequest): Promise<ContainerStatusResponse>;
	execSync(request: ExecSyncRequest): Promise<ExecSyncResponse>;
	status(request: StatusRequest): Promise<StatusResponse>;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api_grpc.pb.go ImageServiceClient.
export interface ImageServiceClient {
	imageStatus(request: ImageStatusRequest): Promise<ImageStatusResponse>;
	pullImage(request: PullImageRequest): Promise<PullImageResponse>;
}
