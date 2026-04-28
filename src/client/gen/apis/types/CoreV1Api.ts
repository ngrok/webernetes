import {
	V1DeleteOptions,
	V1Namespace,
	V1Node,
	V1Pod,
	V1PodList,
	V1Service,
	V1ServiceList,
	V1Status,
} from "../../models";

export interface CoreV1ApiCreateNamespacedPodRequest {
	namespace: string;
	body: V1Pod;
	pretty?: string;
	dryRun?: string;
	fieldManager?: string;
	fieldValidation?: string;
}

export interface CoreV1ApiDeleteNamespacedPodRequest {
	name: string;
	namespace: string;
	pretty?: string;
	dryRun?: string;
	gracePeriodSeconds?: number;
	ignoreStoreReadErrorWithClusterBreakingPotential?: boolean;
	orphanDependents?: boolean;
	propagationPolicy?: string;
	body?: V1DeleteOptions;
}

export interface CoreV1ApiListNamespacedPodRequest {
	namespace: string;
	pretty?: string;
	allowWatchBookmarks?: boolean;
	_continue?: string;
	fieldSelector?: string;
	labelSelector?: string;
	limit?: number;
	resourceVersion?: string;
	resourceVersionMatch?: string;
	sendInitialEvents?: boolean;
	timeoutSeconds?: number;
	watch?: boolean;
}

export interface CoreV1ApiListPodForAllNamespacesRequest {
	pretty?: string;
	allowWatchBookmarks?: boolean;
	_continue?: string;
	fieldSelector?: string;
	labelSelector?: string;
	limit?: number;
	resourceVersion?: string;
	resourceVersionMatch?: string;
	sendInitialEvents?: boolean;
	timeoutSeconds?: number;
	watch?: boolean;
}

export interface CoreV1ApiReadNamespacedPodRequest {
	name: string;
	namespace: string;
	pretty?: string;
}

export interface CoreV1ApiReplaceNamespacedPodRequest {
	name: string;
	namespace: string;
	body: V1Pod;
	pretty?: string;
	dryRun?: string;
	fieldManager?: string;
	fieldValidation?: string;
}

export interface CoreV1ApiReplaceNamespacedPodStatusRequest {
	name: string;
	namespace: string;
	body: V1Pod;
	pretty?: string;
	dryRun?: string;
	fieldManager?: string;
	fieldValidation?: string;
}

export interface CoreV1ApiCreateNamespacedServiceRequest {
	namespace: string;
	body: V1Service;
	pretty?: string;
	dryRun?: string;
	fieldManager?: string;
	fieldValidation?: string;
}

export interface CoreV1ApiDeleteNamespacedServiceRequest {
	name: string;
	namespace: string;
	pretty?: string;
	dryRun?: string;
	gracePeriodSeconds?: number;
	ignoreStoreReadErrorWithClusterBreakingPotential?: boolean;
	orphanDependents?: boolean;
	propagationPolicy?: string;
	body?: V1DeleteOptions;
}

export interface CoreV1ApiListNamespacedServiceRequest {
	namespace: string;
	pretty?: string;
	allowWatchBookmarks?: boolean;
	_continue?: string;
	fieldSelector?: string;
	labelSelector?: string;
	limit?: number;
	resourceVersion?: string;
	resourceVersionMatch?: string;
	sendInitialEvents?: boolean;
	timeoutSeconds?: number;
	watch?: boolean;
}

export interface CoreV1ApiListServiceForAllNamespacesRequest {
	pretty?: string;
	allowWatchBookmarks?: boolean;
	_continue?: string;
	fieldSelector?: string;
	labelSelector?: string;
	limit?: number;
	resourceVersion?: string;
	resourceVersionMatch?: string;
	sendInitialEvents?: boolean;
	timeoutSeconds?: number;
	watch?: boolean;
}

export interface CoreV1ApiReadNamespacedServiceRequest {
	name: string;
	namespace: string;
	pretty?: string;
}

export interface CoreV1ApiReplaceNamespacedServiceRequest {
	name: string;
	namespace: string;
	body: V1Service;
	pretty?: string;
	dryRun?: string;
	fieldManager?: string;
	fieldValidation?: string;
}

export interface CoreV1ApiCreateNamespaceRequest {
	body: V1Namespace;
	pretty?: string;
	dryRun?: string;
	fieldManager?: string;
	fieldValidation?: string;
}

export interface CoreV1ApiCreateNodeRequest {
	body: V1Node;
	pretty?: string;
	dryRun?: string;
	fieldManager?: string;
	fieldValidation?: string;
}

export interface CoreV1ApiDeleteNamespaceRequest {
	name: string;
	pretty?: string;
	dryRun?: string;
	gracePeriodSeconds?: number;
	ignoreStoreReadErrorWithClusterBreakingPotential?: boolean;
	orphanDependents?: boolean;
	propagationPolicy?: string;
	body?: V1DeleteOptions;
}

export interface CoreV1Api {
	createNamespace(request: CoreV1ApiCreateNamespaceRequest): Promise<V1Namespace>;
	createNode(request: CoreV1ApiCreateNodeRequest): Promise<V1Node>;
	createNamespacedPod(request: CoreV1ApiCreateNamespacedPodRequest): Promise<V1Pod>;
	createNamespacedService(request: CoreV1ApiCreateNamespacedServiceRequest): Promise<V1Service>;
	deleteNamespacedPod(request: CoreV1ApiDeleteNamespacedPodRequest): Promise<V1Pod>;
	deleteNamespacedService(request: CoreV1ApiDeleteNamespacedServiceRequest): Promise<V1Service>;
	deleteNamespace(request: CoreV1ApiDeleteNamespaceRequest): Promise<V1Status>;
	listNamespacedPod(request: CoreV1ApiListNamespacedPodRequest): Promise<V1PodList>;
	listNamespacedService(request: CoreV1ApiListNamespacedServiceRequest): Promise<V1ServiceList>;
	listPodForAllNamespaces(request?: CoreV1ApiListPodForAllNamespacesRequest): Promise<V1PodList>;
	listServiceForAllNamespaces(
		request?: CoreV1ApiListServiceForAllNamespacesRequest,
	): Promise<V1ServiceList>;
	readNamespacedPod(request: CoreV1ApiReadNamespacedPodRequest): Promise<V1Pod>;
	readNamespacedService(request: CoreV1ApiReadNamespacedServiceRequest): Promise<V1Service>;
	replaceNamespacedPod(request: CoreV1ApiReplaceNamespacedPodRequest): Promise<V1Pod>;
	replaceNamespacedPodStatus(request: CoreV1ApiReplaceNamespacedPodStatusRequest): Promise<V1Pod>;
	replaceNamespacedService(request: CoreV1ApiReplaceNamespacedServiceRequest): Promise<V1Service>;
}
