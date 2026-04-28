import { V1DeleteOptions, V1EndpointSlice, V1EndpointSliceList, V1Status } from "../../models";

export interface DiscoveryV1ApiCreateNamespacedEndpointSliceRequest {
	namespace: string;
	body: V1EndpointSlice;
	pretty?: string;
	dryRun?: string;
	fieldManager?: string;
	fieldValidation?: string;
}

export interface DiscoveryV1ApiDeleteNamespacedEndpointSliceRequest {
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

export interface DiscoveryV1ApiListEndpointSliceForAllNamespacesRequest {
	allowWatchBookmarks?: boolean;
	_continue?: string;
	fieldSelector?: string;
	labelSelector?: string;
	limit?: number;
	pretty?: string;
	resourceVersion?: string;
	resourceVersionMatch?: string;
	sendInitialEvents?: boolean;
	timeoutSeconds?: number;
	watch?: boolean;
}

export interface DiscoveryV1ApiListNamespacedEndpointSliceRequest {
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

export interface DiscoveryV1ApiReadNamespacedEndpointSliceRequest {
	name: string;
	namespace: string;
	pretty?: string;
}

export interface DiscoveryV1ApiReplaceNamespacedEndpointSliceRequest {
	name: string;
	namespace: string;
	body: V1EndpointSlice;
	pretty?: string;
	dryRun?: string;
	fieldManager?: string;
	fieldValidation?: string;
}

export interface DiscoveryV1Api {
	createNamespacedEndpointSlice(
		request: DiscoveryV1ApiCreateNamespacedEndpointSliceRequest,
	): Promise<V1EndpointSlice>;
	deleteNamespacedEndpointSlice(
		request: DiscoveryV1ApiDeleteNamespacedEndpointSliceRequest,
	): Promise<V1Status>;
	listEndpointSliceForAllNamespaces(
		request?: DiscoveryV1ApiListEndpointSliceForAllNamespacesRequest,
	): Promise<V1EndpointSliceList>;
	listNamespacedEndpointSlice(
		request: DiscoveryV1ApiListNamespacedEndpointSliceRequest,
	): Promise<V1EndpointSliceList>;
	readNamespacedEndpointSlice(
		request: DiscoveryV1ApiReadNamespacedEndpointSliceRequest,
	): Promise<V1EndpointSlice>;
	replaceNamespacedEndpointSlice(
		request: DiscoveryV1ApiReplaceNamespacedEndpointSliceRequest,
	): Promise<V1EndpointSlice>;
}
