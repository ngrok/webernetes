import { V1DeleteOptions, V1Namespace, V1Node, V1Pod, V1PodList, V1Status } from "../../models";

export interface CoreV1ApiCreateNamespacedPodRequest {
	namespace: string;
	body: V1Pod;
	pretty?: string;
	dryRun?: string;
	fieldManager?: string;
	fieldValidation?: string;
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
	deleteNamespace(request: CoreV1ApiDeleteNamespaceRequest): Promise<V1Status>;
	listNamespacedPod(request: CoreV1ApiListNamespacedPodRequest): Promise<V1PodList>;
}
