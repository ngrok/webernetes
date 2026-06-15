import {
	V1DeleteOptions,
	V1Deployment,
	V1DeploymentList,
	V1ReplicaSet,
	V1ReplicaSetList,
	V1Scale,
	V1Status,
} from "../../models";

interface ListRequest {
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

interface DeleteRequest {
	pretty?: string;
	dryRun?: string;
	gracePeriodSeconds?: number;
	ignoreStoreReadErrorWithClusterBreakingPotential?: boolean;
	orphanDependents?: boolean;
	propagationPolicy?: string;
	body?: V1DeleteOptions;
}

interface WriteRequest {
	pretty?: string;
	dryRun?: string;
	fieldManager?: string;
	fieldValidation?: string;
}

interface PatchRequest extends WriteRequest {
	force?: boolean;
}

export interface AppsV1ApiCreateNamespacedDeploymentRequest extends WriteRequest {
	namespace: string;
	body: V1Deployment;
}

export interface AppsV1ApiDeleteCollectionNamespacedDeploymentRequest
	extends ListRequest, DeleteRequest {
	namespace: string;
}

export interface AppsV1ApiDeleteNamespacedDeploymentRequest extends DeleteRequest {
	name: string;
	namespace: string;
}

export interface AppsV1ApiListDeploymentForAllNamespacesRequest extends ListRequest {}

export interface AppsV1ApiListNamespacedDeploymentRequest extends ListRequest {
	namespace: string;
}

export interface AppsV1ApiPatchNamespacedDeploymentRequest extends PatchRequest {
	name: string;
	namespace: string;
	body: unknown;
}

export interface AppsV1ApiPatchNamespacedDeploymentScaleRequest extends PatchRequest {
	name: string;
	namespace: string;
	body: unknown;
}

export interface AppsV1ApiPatchNamespacedDeploymentStatusRequest extends PatchRequest {
	name: string;
	namespace: string;
	body: unknown;
}

export interface AppsV1ApiReadNamespacedDeploymentRequest {
	name: string;
	namespace: string;
	pretty?: string;
}

export interface AppsV1ApiReadNamespacedDeploymentScaleRequest {
	name: string;
	namespace: string;
	pretty?: string;
}

export interface AppsV1ApiReadNamespacedDeploymentStatusRequest {
	name: string;
	namespace: string;
	pretty?: string;
}

export interface AppsV1ApiReplaceNamespacedDeploymentRequest extends WriteRequest {
	name: string;
	namespace: string;
	body: V1Deployment;
}

export interface AppsV1ApiReplaceNamespacedDeploymentScaleRequest extends WriteRequest {
	name: string;
	namespace: string;
	body: V1Scale;
}

export interface AppsV1ApiReplaceNamespacedDeploymentStatusRequest extends WriteRequest {
	name: string;
	namespace: string;
	body: V1Deployment;
}

export interface AppsV1ApiCreateNamespacedReplicaSetRequest extends WriteRequest {
	namespace: string;
	body: V1ReplicaSet;
}

export interface AppsV1ApiDeleteCollectionNamespacedReplicaSetRequest
	extends ListRequest, DeleteRequest {
	namespace: string;
}

export interface AppsV1ApiDeleteNamespacedReplicaSetRequest extends DeleteRequest {
	name: string;
	namespace: string;
}

export interface AppsV1ApiListReplicaSetForAllNamespacesRequest extends ListRequest {}

export interface AppsV1ApiListNamespacedReplicaSetRequest extends ListRequest {
	namespace: string;
}

export interface AppsV1ApiPatchNamespacedReplicaSetRequest extends PatchRequest {
	name: string;
	namespace: string;
	body: unknown;
}

export interface AppsV1ApiPatchNamespacedReplicaSetScaleRequest extends PatchRequest {
	name: string;
	namespace: string;
	body: unknown;
}

export interface AppsV1ApiPatchNamespacedReplicaSetStatusRequest extends PatchRequest {
	name: string;
	namespace: string;
	body: unknown;
}

export interface AppsV1ApiReadNamespacedReplicaSetRequest {
	name: string;
	namespace: string;
	pretty?: string;
}

export interface AppsV1ApiReadNamespacedReplicaSetScaleRequest {
	name: string;
	namespace: string;
	pretty?: string;
}

export interface AppsV1ApiReadNamespacedReplicaSetStatusRequest {
	name: string;
	namespace: string;
	pretty?: string;
}

export interface AppsV1ApiReplaceNamespacedReplicaSetRequest extends WriteRequest {
	name: string;
	namespace: string;
	body: V1ReplicaSet;
}

export interface AppsV1ApiReplaceNamespacedReplicaSetScaleRequest extends WriteRequest {
	name: string;
	namespace: string;
	body: V1Scale;
}

export interface AppsV1ApiReplaceNamespacedReplicaSetStatusRequest extends WriteRequest {
	name: string;
	namespace: string;
	body: V1ReplicaSet;
}

export interface AppsV1Api {
	createNamespacedDeployment(
		request: AppsV1ApiCreateNamespacedDeploymentRequest,
		options?: unknown,
	): Promise<V1Deployment>;
	deleteCollectionNamespacedDeployment(
		request: AppsV1ApiDeleteCollectionNamespacedDeploymentRequest,
		options?: unknown,
	): Promise<V1Status>;
	deleteNamespacedDeployment(
		request: AppsV1ApiDeleteNamespacedDeploymentRequest,
		options?: unknown,
	): Promise<V1Status>;
	listDeploymentForAllNamespaces(
		request?: AppsV1ApiListDeploymentForAllNamespacesRequest,
		options?: unknown,
	): Promise<V1DeploymentList>;
	listNamespacedDeployment(
		request: AppsV1ApiListNamespacedDeploymentRequest,
		options?: unknown,
	): Promise<V1DeploymentList>;
	patchNamespacedDeployment(
		request: AppsV1ApiPatchNamespacedDeploymentRequest,
		options?: unknown,
	): Promise<V1Deployment>;
	patchNamespacedDeploymentScale(
		request: AppsV1ApiPatchNamespacedDeploymentScaleRequest,
		options?: unknown,
	): Promise<V1Scale>;
	patchNamespacedDeploymentStatus(
		request: AppsV1ApiPatchNamespacedDeploymentStatusRequest,
		options?: unknown,
	): Promise<V1Deployment>;
	readNamespacedDeployment(
		request: AppsV1ApiReadNamespacedDeploymentRequest,
		options?: unknown,
	): Promise<V1Deployment>;
	readNamespacedDeploymentScale(
		request: AppsV1ApiReadNamespacedDeploymentScaleRequest,
		options?: unknown,
	): Promise<V1Scale>;
	readNamespacedDeploymentStatus(
		request: AppsV1ApiReadNamespacedDeploymentStatusRequest,
		options?: unknown,
	): Promise<V1Deployment>;
	replaceNamespacedDeployment(
		request: AppsV1ApiReplaceNamespacedDeploymentRequest,
		options?: unknown,
	): Promise<V1Deployment>;
	replaceNamespacedDeploymentScale(
		request: AppsV1ApiReplaceNamespacedDeploymentScaleRequest,
		options?: unknown,
	): Promise<V1Scale>;
	replaceNamespacedDeploymentStatus(
		request: AppsV1ApiReplaceNamespacedDeploymentStatusRequest,
		options?: unknown,
	): Promise<V1Deployment>;

	createNamespacedReplicaSet(
		request: AppsV1ApiCreateNamespacedReplicaSetRequest,
		options?: unknown,
	): Promise<V1ReplicaSet>;
	deleteCollectionNamespacedReplicaSet(
		request: AppsV1ApiDeleteCollectionNamespacedReplicaSetRequest,
		options?: unknown,
	): Promise<V1Status>;
	deleteNamespacedReplicaSet(
		request: AppsV1ApiDeleteNamespacedReplicaSetRequest,
		options?: unknown,
	): Promise<V1Status>;
	listReplicaSetForAllNamespaces(
		request?: AppsV1ApiListReplicaSetForAllNamespacesRequest,
		options?: unknown,
	): Promise<V1ReplicaSetList>;
	listNamespacedReplicaSet(
		request: AppsV1ApiListNamespacedReplicaSetRequest,
		options?: unknown,
	): Promise<V1ReplicaSetList>;
	patchNamespacedReplicaSet(
		request: AppsV1ApiPatchNamespacedReplicaSetRequest,
		options?: unknown,
	): Promise<V1ReplicaSet>;
	patchNamespacedReplicaSetScale(
		request: AppsV1ApiPatchNamespacedReplicaSetScaleRequest,
		options?: unknown,
	): Promise<V1Scale>;
	patchNamespacedReplicaSetStatus(
		request: AppsV1ApiPatchNamespacedReplicaSetStatusRequest,
		options?: unknown,
	): Promise<V1ReplicaSet>;
	readNamespacedReplicaSet(
		request: AppsV1ApiReadNamespacedReplicaSetRequest,
		options?: unknown,
	): Promise<V1ReplicaSet>;
	readNamespacedReplicaSetScale(
		request: AppsV1ApiReadNamespacedReplicaSetScaleRequest,
		options?: unknown,
	): Promise<V1Scale>;
	readNamespacedReplicaSetStatus(
		request: AppsV1ApiReadNamespacedReplicaSetStatusRequest,
		options?: unknown,
	): Promise<V1ReplicaSet>;
	replaceNamespacedReplicaSet(
		request: AppsV1ApiReplaceNamespacedReplicaSetRequest,
		options?: unknown,
	): Promise<V1ReplicaSet>;
	replaceNamespacedReplicaSetScale(
		request: AppsV1ApiReplaceNamespacedReplicaSetScaleRequest,
		options?: unknown,
	): Promise<V1Scale>;
	replaceNamespacedReplicaSetStatus(
		request: AppsV1ApiReplaceNamespacedReplicaSetStatusRequest,
		options?: unknown,
	): Promise<V1ReplicaSet>;
}
