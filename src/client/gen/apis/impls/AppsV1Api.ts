import { retryConflicts } from "../../../../retry";
import { labelSelectorAsSelector } from "../../../../apimachinery/pkg/apis/meta/v1/helpers";
import { strategicMergePatch } from "../../../../apimachinery/pkg/util/strategicpatch/patch";
import type { Etcd } from "../../../../cluster/etcd";
import { DeploymentStore, ReplicaSetStore, Store } from "../../../../cluster/storage";
import type * as context from "../../../../go/context";
import { BadRequest, NotFound, UnsupportedMediaType } from "../../../errors";
import { filterByFields, parseFieldSelector } from "../../../fields";
import { filterByLabels, parseLabelSelector } from "../../../labels";
import { PatchStrategy } from "../../../patch";
import type {
	V1Deployment,
	V1DeploymentList,
	V1LabelSelector,
	V1ReplicaSet,
	V1ReplicaSetList,
	V1Scale,
	V1Status,
} from "../../models";
import type {
	AppsV1Api as AppsV1ApiInterface,
	AppsV1ApiCreateNamespacedDeploymentRequest,
	AppsV1ApiCreateNamespacedReplicaSetRequest,
	AppsV1ApiDeleteCollectionNamespacedDeploymentRequest,
	AppsV1ApiDeleteCollectionNamespacedReplicaSetRequest,
	AppsV1ApiDeleteNamespacedDeploymentRequest,
	AppsV1ApiDeleteNamespacedReplicaSetRequest,
	AppsV1ApiListDeploymentForAllNamespacesRequest,
	AppsV1ApiListNamespacedDeploymentRequest,
	AppsV1ApiListNamespacedReplicaSetRequest,
	AppsV1ApiListReplicaSetForAllNamespacesRequest,
	AppsV1ApiPatchNamespacedDeploymentRequest,
	AppsV1ApiPatchNamespacedDeploymentScaleRequest,
	AppsV1ApiPatchNamespacedDeploymentStatusRequest,
	AppsV1ApiPatchNamespacedReplicaSetRequest,
	AppsV1ApiPatchNamespacedReplicaSetScaleRequest,
	AppsV1ApiPatchNamespacedReplicaSetStatusRequest,
	AppsV1ApiReadNamespacedDeploymentRequest,
	AppsV1ApiReadNamespacedDeploymentScaleRequest,
	AppsV1ApiReadNamespacedDeploymentStatusRequest,
	AppsV1ApiReadNamespacedReplicaSetRequest,
	AppsV1ApiReadNamespacedReplicaSetScaleRequest,
	AppsV1ApiReadNamespacedReplicaSetStatusRequest,
	AppsV1ApiReplaceNamespacedDeploymentRequest,
	AppsV1ApiReplaceNamespacedDeploymentScaleRequest,
	AppsV1ApiReplaceNamespacedDeploymentStatusRequest,
	AppsV1ApiReplaceNamespacedReplicaSetRequest,
	AppsV1ApiReplaceNamespacedReplicaSetScaleRequest,
	AppsV1ApiReplaceNamespacedReplicaSetStatusRequest,
} from "../types/AppsV1Api";
import { rethrowApiErrors } from "./errors";
import { listResourceVersionOptions } from "./resource-version";
import { deleteResource } from "./delete";

export interface AppsV1ApiOptions {
	ctx: context.Context;
	etcd: Etcd;
}

export class AppsV1Api implements AppsV1ApiInterface {
	private readonly ctx: context.Context;
	private readonly deployments: Store<V1Deployment>;
	private readonly replicaSets: Store<V1ReplicaSet>;

	public constructor(options: AppsV1ApiOptions) {
		this.ctx = options.ctx;
		this.deployments = new DeploymentStore(options.etcd);
		this.replicaSets = new ReplicaSetStore(options.etcd);
	}

	public async createNamespacedDeployment(
		request: AppsV1ApiCreateNamespacedDeploymentRequest,
	): Promise<V1Deployment> {
		return await rethrowApiErrors(async () => {
			request.body.metadata ??= {};
			request.body.metadata.namespace ??= request.namespace;
			return await this.deployments.create(request.body);
		});
	}

	public async deleteCollectionNamespacedDeployment(
		request: AppsV1ApiDeleteCollectionNamespacedDeploymentRequest,
	): Promise<V1Status> {
		return await rethrowApiErrors(async () => {
			const list = await this.list(this.deployments, request.namespace, request);
			for (const deployment of list.items) {
				const name = deployment.metadata?.name;
				if (name) {
					await this.deleteDeployment({ ...request, name, namespace: request.namespace });
				}
			}
			return successStatus();
		});
	}

	public async deleteNamespacedDeployment(
		request: AppsV1ApiDeleteNamespacedDeploymentRequest,
	): Promise<V1Status> {
		return await rethrowApiErrors(async () => await this.deleteDeployment(request));
	}

	public async listDeploymentForAllNamespaces(
		request: AppsV1ApiListDeploymentForAllNamespacesRequest = {},
	): Promise<V1DeploymentList> {
		return await this.list(this.deployments, undefined, request);
	}

	public async listNamespacedDeployment(
		request: AppsV1ApiListNamespacedDeploymentRequest,
	): Promise<V1DeploymentList> {
		return await this.list(this.deployments, request.namespace, request);
	}

	public async patchNamespacedDeployment(
		request: AppsV1ApiPatchNamespacedDeploymentRequest,
		options?: unknown,
	): Promise<V1Deployment> {
		return await this.patchResource(this.deployments, "Deployment.apps", request, options);
	}

	public async patchNamespacedDeploymentScale(
		request: AppsV1ApiPatchNamespacedDeploymentScaleRequest,
		options?: unknown,
	): Promise<V1Scale> {
		return await rethrowApiErrors(async () => {
			validateMergePatchContentType(options);
			return await retryConflicts(this.ctx, async () => {
				const deployment = await this.getDeployment(request.name, request.namespace);
				const patched = mergePatch(deploymentScale(deployment), request.body);
				deployment.spec ??= { selector: {}, template: {} };
				deployment.spec.replicas = patched.spec?.replicas ?? deployment.spec.replicas;
				const updated = await this.deployments.update(request.name, deployment);
				return deploymentScale(updated);
			});
		});
	}

	public async patchNamespacedDeploymentStatus(
		request: AppsV1ApiPatchNamespacedDeploymentStatusRequest,
		options?: unknown,
	): Promise<V1Deployment> {
		return await this.patchStatus(this.deployments, "Deployment.apps", request, options);
	}

	public async readNamespacedDeployment(
		request: AppsV1ApiReadNamespacedDeploymentRequest,
	): Promise<V1Deployment> {
		return await rethrowApiErrors(
			async () => await this.getDeployment(request.name, request.namespace),
		);
	}

	public async readNamespacedDeploymentScale(
		request: AppsV1ApiReadNamespacedDeploymentScaleRequest,
	): Promise<V1Scale> {
		return await rethrowApiErrors(async () => {
			return deploymentScale(await this.getDeployment(request.name, request.namespace));
		});
	}

	public async readNamespacedDeploymentStatus(
		request: AppsV1ApiReadNamespacedDeploymentStatusRequest,
	): Promise<V1Deployment> {
		return await this.readNamespacedDeployment(request);
	}

	public async replaceNamespacedDeployment(
		request: AppsV1ApiReplaceNamespacedDeploymentRequest,
	): Promise<V1Deployment> {
		return await this.replaceResource(this.deployments, request);
	}

	public async replaceNamespacedDeploymentScale(
		request: AppsV1ApiReplaceNamespacedDeploymentScaleRequest,
	): Promise<V1Scale> {
		return await rethrowApiErrors(async () => {
			return await retryConflicts(this.ctx, async () => {
				const deployment = await this.getDeployment(request.name, request.namespace);
				deployment.spec ??= { selector: {}, template: {} };
				deployment.spec.replicas = request.body.spec?.replicas ?? deployment.spec.replicas;
				const updated = await this.deployments.update(request.name, deployment);
				return deploymentScale(updated);
			});
		});
	}

	public async replaceNamespacedDeploymentStatus(
		request: AppsV1ApiReplaceNamespacedDeploymentStatusRequest,
	): Promise<V1Deployment> {
		return await this.replaceStatus(this.deployments, request);
	}

	public async createNamespacedReplicaSet(
		request: AppsV1ApiCreateNamespacedReplicaSetRequest,
	): Promise<V1ReplicaSet> {
		return await rethrowApiErrors(async () => {
			request.body.metadata ??= {};
			request.body.metadata.namespace ??= request.namespace;
			return await this.replicaSets.create(request.body);
		});
	}

	public async deleteCollectionNamespacedReplicaSet(
		request: AppsV1ApiDeleteCollectionNamespacedReplicaSetRequest,
	): Promise<V1Status> {
		return await rethrowApiErrors(async () => {
			const list = await this.list(this.replicaSets, request.namespace, request);
			for (const replicaSet of list.items) {
				const name = replicaSet.metadata?.name;
				if (name) {
					await this.deleteReplicaSet({ ...request, name, namespace: request.namespace });
				}
			}
			return successStatus();
		});
	}

	public async deleteNamespacedReplicaSet(
		request: AppsV1ApiDeleteNamespacedReplicaSetRequest,
	): Promise<V1Status> {
		return await rethrowApiErrors(async () => await this.deleteReplicaSet(request));
	}

	public async listReplicaSetForAllNamespaces(
		request: AppsV1ApiListReplicaSetForAllNamespacesRequest = {},
	): Promise<V1ReplicaSetList> {
		return await this.list(this.replicaSets, undefined, request);
	}

	public async listNamespacedReplicaSet(
		request: AppsV1ApiListNamespacedReplicaSetRequest,
	): Promise<V1ReplicaSetList> {
		return await this.list(this.replicaSets, request.namespace, request);
	}

	public async patchNamespacedReplicaSet(
		request: AppsV1ApiPatchNamespacedReplicaSetRequest,
		options?: unknown,
	): Promise<V1ReplicaSet> {
		return await this.patchResource(this.replicaSets, "ReplicaSet.apps", request, options);
	}

	public async patchNamespacedReplicaSetScale(
		request: AppsV1ApiPatchNamespacedReplicaSetScaleRequest,
		options?: unknown,
	): Promise<V1Scale> {
		return await rethrowApiErrors(async () => {
			validateMergePatchContentType(options);
			return await retryConflicts(this.ctx, async () => {
				const replicaSet = await this.getReplicaSet(request.name, request.namespace);
				const patched = mergePatch(replicaSetScale(replicaSet), request.body);
				replicaSet.spec ??= { selector: {} };
				replicaSet.spec.replicas = patched.spec?.replicas ?? replicaSet.spec.replicas;
				const updated = await this.replicaSets.update(request.name, replicaSet);
				return replicaSetScale(updated);
			});
		});
	}

	public async patchNamespacedReplicaSetStatus(
		request: AppsV1ApiPatchNamespacedReplicaSetStatusRequest,
		options?: unknown,
	): Promise<V1ReplicaSet> {
		return await this.patchStatus(this.replicaSets, "ReplicaSet.apps", request, options);
	}

	public async readNamespacedReplicaSet(
		request: AppsV1ApiReadNamespacedReplicaSetRequest,
	): Promise<V1ReplicaSet> {
		return await rethrowApiErrors(
			async () => await this.getReplicaSet(request.name, request.namespace),
		);
	}

	public async readNamespacedReplicaSetScale(
		request: AppsV1ApiReadNamespacedReplicaSetScaleRequest,
	): Promise<V1Scale> {
		return await rethrowApiErrors(async () => {
			return replicaSetScale(await this.getReplicaSet(request.name, request.namespace));
		});
	}

	public async readNamespacedReplicaSetStatus(
		request: AppsV1ApiReadNamespacedReplicaSetStatusRequest,
	): Promise<V1ReplicaSet> {
		return await this.readNamespacedReplicaSet(request);
	}

	public async replaceNamespacedReplicaSet(
		request: AppsV1ApiReplaceNamespacedReplicaSetRequest,
	): Promise<V1ReplicaSet> {
		return await this.replaceResource(this.replicaSets, request);
	}

	public async replaceNamespacedReplicaSetScale(
		request: AppsV1ApiReplaceNamespacedReplicaSetScaleRequest,
	): Promise<V1Scale> {
		return await rethrowApiErrors(async () => {
			return await retryConflicts(this.ctx, async () => {
				const replicaSet = await this.getReplicaSet(request.name, request.namespace);
				replicaSet.spec ??= { selector: {} };
				replicaSet.spec.replicas = request.body.spec?.replicas ?? replicaSet.spec.replicas;
				const updated = await this.replicaSets.update(request.name, replicaSet);
				return replicaSetScale(updated);
			});
		});
	}

	public async replaceNamespacedReplicaSetStatus(
		request: AppsV1ApiReplaceNamespacedReplicaSetStatusRequest,
	): Promise<V1ReplicaSet> {
		return await this.replaceStatus(this.replicaSets, request);
	}

	private async getDeployment(name: string, namespace: string): Promise<V1Deployment> {
		const deployment = await this.deployments.get(name, namespace);
		if (!deployment) {
			throw new NotFound(`Deployment.apps "${name}" not found`);
		}
		return deployment;
	}

	private async getReplicaSet(name: string, namespace: string): Promise<V1ReplicaSet> {
		const replicaSet = await this.replicaSets.get(name, namespace);
		if (!replicaSet) {
			throw new NotFound(`ReplicaSet.apps "${name}" not found`);
		}
		return replicaSet;
	}

	private async deleteDeployment(
		request:
			| AppsV1ApiDeleteNamespacedDeploymentRequest
			| (AppsV1ApiDeleteCollectionNamespacedDeploymentRequest & { name: string }),
	): Promise<V1Status> {
		await deleteResource(
			this.ctx,
			this.deployments,
			"Deployment.apps",
			request.name,
			request.namespace,
			request,
		);
		return successStatus();
	}

	private async deleteReplicaSet(
		request:
			| AppsV1ApiDeleteNamespacedReplicaSetRequest
			| (AppsV1ApiDeleteCollectionNamespacedReplicaSetRequest & { name: string }),
	): Promise<V1Status> {
		await deleteResource(
			this.ctx,
			this.replicaSets,
			"ReplicaSet.apps",
			request.name,
			request.namespace,
			request,
		);
		return successStatus();
	}

	private async list<T extends V1Deployment | V1ReplicaSet>(
		store: Store<T>,
		namespace: string | undefined,
		request: ListRequest,
	): Promise<{ metadata: { resourceVersion: string }; items: T[] }> {
		return await rethrowApiErrors(async () => {
			const selector = parseLabelSelector(request.labelSelector);
			const fieldSelector = parseFieldSelector(request.fieldSelector);
			const list = await store.listWithResourceVersion(
				namespace,
				listResourceVersionOptions(request),
			);
			return {
				metadata: {
					resourceVersion: list.resourceVersion,
				},
				items: filterByFields(filterByLabels(list.items, selector), fieldSelector),
			};
		});
	}

	private async replaceResource<T extends V1Deployment | V1ReplicaSet>(
		store: Store<T>,
		request: { name: string; namespace: string; body: T },
	): Promise<T> {
		return await rethrowApiErrors(async () => {
			const replace = async () => {
				request.body.metadata ??= {};
				request.body.metadata.name = request.name;
				request.body.metadata.namespace ??= request.namespace;
				return await store.update(request.name, request.body);
			};
			if (request.body.metadata?.resourceVersion) {
				return await replace();
			}
			return await retryConflicts(this.ctx, replace);
		});
	}

	private async patchResource<T extends V1Deployment | V1ReplicaSet>(
		store: Store<T>,
		kind: string,
		request: { name: string; namespace: string; body: unknown },
		options?: unknown,
	): Promise<T> {
		return await rethrowApiErrors(async () => {
			const patchStrategy = validateAppsPatchContentType(options);
			return await retryConflicts(this.ctx, async () => {
				const current = await store.get(request.name, request.namespace);
				if (!current) {
					throw new NotFound(`${kind} "${request.name}" not found`);
				}
				validatePatchName(request.body, request.name);
				const patched =
					patchStrategy === PatchStrategy.StrategicMergePatch
						? strategicMergePatch(current, request.body)
						: mergePatch(current, request.body);
				patched.metadata ??= {};
				patched.metadata.name = request.name;
				patched.metadata.namespace ??= request.namespace;
				return await store.update(request.name, patched);
			});
		});
	}

	private async replaceStatus<T extends V1Deployment | V1ReplicaSet>(
		store: Store<T>,
		request: { name: string; namespace: string; body: T },
	): Promise<T> {
		return await rethrowApiErrors(async () => {
			const current = await store.get(request.name, request.namespace);
			if (!current) {
				throw new NotFound(`${request.body.kind ?? "Resource"} "${request.name}" not found`);
			}
			current.status = request.body.status;
			return await store.update(request.name, current, { skipValidateUpdate: true });
		});
	}

	private async patchStatus<T extends V1Deployment | V1ReplicaSet>(
		store: Store<T>,
		kind: string,
		request: { name: string; namespace: string; body: unknown },
		options?: unknown,
	): Promise<T> {
		return await rethrowApiErrors(async () => {
			validateMergePatchContentType(options);
			return await retryConflicts(this.ctx, async () => {
				const current = await store.get(request.name, request.namespace);
				if (!current) {
					throw new NotFound(`${kind} "${request.name}" not found`);
				}
				validatePatchName(request.body, request.name);
				const patched = mergePatch(current, request.body);
				current.status = patched.status;
				return await store.update(request.name, current, { skipValidateUpdate: true });
			});
		});
	}
}

interface ListRequest {
	_continue?: string;
	fieldSelector?: string;
	labelSelector?: string;
	resourceVersion?: string;
	resourceVersionMatch?: string;
}

type PatchObject = { [key: string]: PatchValue };
type PatchValue = PatchObject | PatchValue[] | string | number | boolean | null;

function successStatus(): V1Status {
	return {
		status: "Success",
	};
}

function deploymentScale(deployment: V1Deployment): V1Scale {
	return {
		apiVersion: "autoscaling/v1",
		kind: "Scale",
		metadata: scaleMetadata(deployment),
		spec: {
			replicas: deployment.spec?.replicas ?? 0,
		},
		status: {
			replicas: deployment.status?.replicas ?? 0,
			selector: labelSelectorToString(deployment.spec?.selector),
		},
	};
}

function replicaSetScale(replicaSet: V1ReplicaSet): V1Scale {
	return {
		apiVersion: "autoscaling/v1",
		kind: "Scale",
		metadata: scaleMetadata(replicaSet),
		spec: {
			replicas: replicaSet.spec?.replicas ?? 0,
		},
		status: {
			replicas: replicaSet.status?.replicas ?? 0,
			selector: labelSelectorToString(replicaSet.spec?.selector),
		},
	};
}

function labelSelectorToString(selector: V1LabelSelector | undefined): string {
	const [converted, err] = labelSelectorAsSelector(selector);
	if (err || !converted) {
		return "";
	}
	return converted.string();
}

function scaleMetadata(resource: V1Deployment | V1ReplicaSet): V1Scale["metadata"] {
	return {
		name: resource.metadata?.name,
		namespace: resource.metadata?.namespace,
		uid: resource.metadata?.uid,
		resourceVersion: resource.metadata?.resourceVersion,
		creationTimestamp: resource.metadata?.creationTimestamp,
	};
}

function validateMergePatchContentType(options: unknown): void {
	const contentType = getContentType(options);
	if (contentType !== PatchStrategy.MergePatch) {
		throw new UnsupportedMediaType(`Unsupported Media Type: ${contentType ?? ""}`);
	}
}

function validateAppsPatchContentType(options: unknown): PatchStrategy {
	const contentType = getContentType(options);
	if (
		contentType !== PatchStrategy.MergePatch &&
		contentType !== PatchStrategy.StrategicMergePatch
	) {
		throw new UnsupportedMediaType(`Unsupported Media Type: ${contentType ?? ""}`);
	}
	return contentType;
}

function getContentType(options: unknown): string | undefined {
	if (!isPatchObject(options) || !isPatchObject(options.headers)) {
		return undefined;
	}
	for (const [key, value] of Object.entries(options.headers)) {
		if (key.toLowerCase() === "content-type" && typeof value === "string") {
			return value.split(";")[0]?.trim();
		}
	}
	return undefined;
}

function validatePatchName(patch: unknown, name: string): void {
	if (!isPatchObject(patch) || !isPatchObject(patch.metadata)) {
		return;
	}
	const patchedName = patch.metadata.name;
	if (patchedName !== undefined && patchedName !== name) {
		throw new BadRequest(
			`the name of the object (${patchedName}) does not match the name on the URL (${name})`,
		);
	}
}

function mergePatch<T extends object>(target: T, patch: unknown): T {
	if (!isPatchObject(patch)) {
		throw new Error("Merge patch body must be an object");
	}
	return applyPatchObject(structuredClone(target), patch);
}

function applyPatchObject<T extends object>(target: T, patch: PatchObject): T {
	const result = target as { [key: string]: unknown };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete result[key];
			continue;
		}
		if (isPatchObject(value) && isPatchObject(result[key])) {
			result[key] = applyPatchObject(result[key], value);
			continue;
		}
		result[key] = structuredClone(value);
	}
	return target;
}

function isPatchObject(value: unknown): value is PatchObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
