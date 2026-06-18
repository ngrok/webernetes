/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { V1Container, V1Pod } from "../../../../client";

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto PodSandboxMetadata.
export interface PodSandboxMetadata {
	uid: string;
	name: string;
	namespace: string;
	attempt: number;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto DNSConfig.
export interface DnsConfig {
	servers: string[];
	searches: string[];
	options: string[];
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto PortMapping.
export interface PortMapping {
	protocol?: "TCP" | "UDP" | "SCTP";
	containerPort: number;
	hostPort?: number;
	hostIp?: string;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto PodSandboxConfig.
export interface PodSandboxConfig {
	metadata: PodSandboxMetadata;
	hostname?: string;
	logDirectory?: string;
	dnsConfig?: DnsConfig;
	portMappings?: PortMapping[];
	labels?: Record<string, string>;
	annotations?: Record<string, string>;

	// Simulator-only deviation: carry the full pod resource so the in-process
	// network can attribute requests to their origin.
	pod: V1Pod;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ImageSpec.
export interface ImageSpec {
	image: string;
	userSpecifiedImage?: string;
	runtimeHandler?: string;
	annotations?: Record<string, string>;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto Image.
export interface Image {
	id: string;
	repoTags: string[];
	repoDigests: string[];
	size: number;
	spec?: ImageSpec;
	pinned: boolean;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ContainerMetadata.
export interface ContainerMetadata {
	name: string;
	attempt: number;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ContainerConfig.
export interface ContainerConfig {
	metadata: ContainerMetadata;
	image: ImageSpec;
	command?: string[];
	args?: string[];
	workingDir?: string;
	env?: Record<string, string>;
	ports?: ContainerPort[];
	labels?: Record<string, string>;
	annotations?: Record<string, string>;
	stopSignal?: "SIGTERM" | "SIGKILL";
	sourceContainer?: V1Container;
}

export interface ContainerPort {
	name?: string;
	containerPort: number;
	protocol?: "TCP" | "UDP" | "SCTP";
}

export type PodSandboxState = "Ready" | "NotReady";

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto PodSandboxStatus.
export interface PodSandboxStatus {
	id: string;
	metadata: PodSandboxMetadata;
	state: PodSandboxState;
	createdAt: number;
	network?: {
		ip: string;
		additionalIps?: Array<{ ip: string }>;
	};
	labels: Record<string, string>;
	annotations: Record<string, string>;
}

export interface ContainerStatus {
	id: string;
	name: string;
	image?: ImageSpec;
	imageRef: string;
	imageId?: string;
	imageRuntimeHandler: string;
	hash: number;
	state: "Created" | "Running" | "Exited" | "Unknown";
	restartCount: number;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	exitCode?: number;
	reason?: string;
	message?: string;
	labels: Record<string, string>;
	annotations: Record<string, string>;
	ready: boolean;
}

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
	status?: ContainerStatus;
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

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto RuntimeHandlerFeatures.
export interface RuntimeHandlerFeatures {
	recursiveReadOnlyMounts?: boolean;
	userNamespaces?: boolean;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto RuntimeHandler.
export interface RuntimeHandler {
	name: string;
	features?: RuntimeHandlerFeatures;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto RuntimeFeatures.
export interface RuntimeFeatures {
	supplementalGroupsPolicy?: boolean;
	userNamespacesHostNetwork?: boolean;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto StatusRequest.
export interface StatusRequest {
	verbose?: boolean;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto StatusResponse.
export interface StatusResponse {
	status?: RuntimeStatus;
	runtimeHandlers?: RuntimeHandler[];
	features?: RuntimeFeatures;
	info?: Record<string, string>;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto NetworkConfig.
export interface NetworkConfig {
	podCidr?: string;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto RuntimeConfig.
export interface RuntimeConfig {
	networkConfig?: NetworkConfig;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto UpdateRuntimeConfigRequest.
export interface UpdateRuntimeConfigRequest {
	runtimeConfig: RuntimeConfig;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto UpdateRuntimeConfigResponse.
export type UpdateRuntimeConfigResponse = Record<string, never>;

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto CheckpointContainerRequest.
export interface CheckpointContainerRequest {
	containerId: string;
	location: string;
	timeout: number;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto CheckpointContainerResponse.
export type CheckpointContainerResponse = Record<string, never>;

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ContainerEventResponse.
export interface ContainerEventResponse {
	containerId: string;
	containerEventType: string;
	createdAt: number;
	podSandboxStatus: PodSandboxStatus;
	containersStatuses: ContainerStatus[];
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ListMetricDescriptorsRequest.
export type ListMetricDescriptorsRequest = Record<string, never>;

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto MetricDescriptor.
export interface MetricDescriptor {
	name: string;
	help: string;
	labelKeys: string[];
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ListMetricDescriptorsResponse.
export interface ListMetricDescriptorsResponse {
	descriptors: MetricDescriptor[];
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto MetricType.
export type MetricType = "COUNTER" | "GAUGE";

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto Metric.
export interface Metric {
	name: string;
	timestamp: number;
	metricType: MetricType;
	labelValues: string[];
	value?: number;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ContainerMetrics.
export interface ContainerMetrics {
	containerId: string;
	metrics: Metric[];
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto PodSandboxMetrics.
export interface PodSandboxMetrics {
	podSandboxId: string;
	metrics: Metric[];
	containerMetrics: ContainerMetrics[];
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ListPodSandboxMetricsRequest.
export type ListPodSandboxMetricsRequest = Record<string, never>;

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ListPodSandboxMetricsResponse.
export interface ListPodSandboxMetricsResponse {
	podMetrics: PodSandboxMetrics[];
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ImageStatusRequest.
export interface ImageStatusRequest {
	image: ImageSpec;
	verbose?: boolean;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ImageFilter.
export interface ImageFilter {
	image?: ImageSpec;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ListImagesRequest.
export interface ListImagesRequest {
	filter?: ImageFilter;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ListImagesResponse.
export interface ListImagesResponse {
	images: Image[];
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ImageStatusResponse.
export interface ImageStatusResponse {
	image?: Image;
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

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto RemoveImageRequest.
export interface RemoveImageRequest {
	image: ImageSpec;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto RemoveImageResponse.
export type RemoveImageResponse = Record<string, never>;

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ImageFsInfoRequest.
export type ImageFsInfoRequest = Record<string, never>;

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto UInt64Value.
export interface UInt64Value {
	value: number;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto FilesystemIdentifier.
export interface FilesystemIdentifier {
	mountpoint: string;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto FilesystemUsage.
export interface FilesystemUsage {
	timestamp: number;
	fsId?: FilesystemIdentifier;
	usedBytes?: UInt64Value;
	inodesUsed?: UInt64Value;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto WindowsFilesystemUsage.
export interface WindowsFilesystemUsage {
	timestamp: number;
	fsId?: FilesystemIdentifier;
	usedBytes?: UInt64Value;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto ImageFsInfoResponse.
export interface ImageFsInfoResponse {
	imageFilesystems: FilesystemUsage[];
	containerFilesystems: FilesystemUsage[];
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
	updateRuntimeConfig(request: UpdateRuntimeConfigRequest): Promise<UpdateRuntimeConfigResponse>;
	checkpointContainer(request: CheckpointContainerRequest): Promise<CheckpointContainerResponse>;
	listMetricDescriptors(
		request: ListMetricDescriptorsRequest,
	): Promise<ListMetricDescriptorsResponse>;
	listPodSandboxMetrics(
		request: ListPodSandboxMetricsRequest,
	): Promise<ListPodSandboxMetricsResponse>;
}

// Models staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api_grpc.pb.go ImageServiceClient.
export interface ImageServiceClient {
	listImages(request: ListImagesRequest): Promise<ListImagesResponse>;
	imageStatus(request: ImageStatusRequest): Promise<ImageStatusResponse>;
	pullImage(request: PullImageRequest): Promise<PullImageResponse>;
	removeImage(request: RemoveImageRequest): Promise<RemoveImageResponse>;
	imageFsInfo(request: ImageFsInfoRequest): Promise<ImageFsInfoResponse>;
}
