import * as k8s from "../client";
import { isNotFoundError } from "../client/errors";
import { deepEqual } from "../deep-equal";
import { retryConflicts } from "../retry";
import type { KubernetesObject } from "../client";
import type { Cluster } from "./cluster";

const LAST_APPLIED_ANNOTATION = "kubectl.kubernetes.io/last-applied-configuration";
const MERGE_PATCH_OPTIONS = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);

type CoreApplyResource<T, TKind extends string> = Omit<T, "apiVersion" | "kind"> & {
	apiVersion: "v1";
	kind: TKind;
};

export type ClusterApplyResource =
	| CoreApplyResource<k8s.V1Namespace, "Namespace">
	| CoreApplyResource<k8s.V1Node, "Node">
	| CoreApplyResource<k8s.V1Pod, "Pod">
	| CoreApplyResource<k8s.V1Service, "Service">;
export type ClusterApplyResult<T extends readonly ClusterApplyResource[]> = {
	-readonly [K in keyof T]: T[K];
};

export async function applyResources<const T extends readonly ClusterApplyResource[]>(
	cluster: Cluster,
	resources: T,
): Promise<ClusterApplyResult<T>> {
	const applied: ClusterApplyResource[] = [];
	for (const resource of resources) {
		applied.push((await applyResource(cluster, resource)) as ClusterApplyResource);
	}
	return applied as ClusterApplyResult<T>;
}

async function applyResource(
	cluster: Cluster,
	resource: KubernetesObject,
): Promise<KubernetesObject> {
	if (isNamespace(resource)) {
		return await applyNamespace(cluster, resource);
	}
	if (isNode(resource)) {
		return await applyNode(cluster, resource);
	}
	if (isPod(resource)) {
		return await applyPod(cluster, resource);
	}
	if (isService(resource)) {
		return await applyService(cluster, resource);
	}
	throw new Error(`Unsupported apply resource ${resourceKey(resource)}`);
}

function isNamespace(resource: KubernetesObject): resource is k8s.V1Namespace {
	return resourceKey(resource) === "v1/Namespace";
}

function isNode(resource: KubernetesObject): resource is k8s.V1Node {
	return resourceKey(resource) === "v1/Node";
}

function isPod(resource: KubernetesObject): resource is k8s.V1Pod {
	return resourceKey(resource) === "v1/Pod";
}

function isService(resource: KubernetesObject): resource is k8s.V1Service {
	return resourceKey(resource) === "v1/Service";
}

async function applyNamespace(
	cluster: Cluster,
	resource: k8s.V1Namespace,
): Promise<k8s.V1Namespace> {
	const desired = prepareDesiredResource(resource, false);
	const name = requiredName(desired);
	try {
		return await retryConflicts(cluster.ctx, async () => {
			const existing = await cluster.api.corev1.readNamespace({ name });
			return await cluster.api.corev1.patchNamespace(
				{
					name,
					body: createApplyPatch(existing, desired),
				},
				MERGE_PATCH_OPTIONS,
			);
		});
	} catch (error) {
		if (!isNotFoundError(error)) {
			throw error;
		}
		return await cluster.api.corev1.createNamespace({ body: withLastApplied(desired) });
	}
}

async function applyNode(cluster: Cluster, resource: k8s.V1Node): Promise<k8s.V1Node> {
	const desired = prepareDesiredResource(resource, false);
	const name = requiredName(desired);
	try {
		return await retryConflicts(cluster.ctx, async () => {
			const existing = await cluster.api.corev1.readNode({ name });
			return await cluster.api.corev1.patchNode(
				{
					name,
					body: createApplyPatch(existing, desired),
				},
				MERGE_PATCH_OPTIONS,
			);
		});
	} catch (error) {
		if (!isNotFoundError(error)) {
			throw error;
		}
		return await cluster.api.corev1.createNode({ body: withLastApplied(desired) });
	}
}

async function applyPod(cluster: Cluster, resource: k8s.V1Pod): Promise<k8s.V1Pod> {
	const desired = prepareDesiredResource(resource, true);
	const name = requiredName(desired);
	const namespace = requiredNamespace(desired);
	try {
		return await retryConflicts(cluster.ctx, async () => {
			const existing = await cluster.api.corev1.readNamespacedPod({ name, namespace });
			return await cluster.api.corev1.patchNamespacedPod(
				{
					name,
					namespace,
					body: createApplyPatch(existing, desired),
				},
				MERGE_PATCH_OPTIONS,
			);
		});
	} catch (error) {
		if (!isNotFoundError(error)) {
			throw error;
		}
		return await cluster.api.corev1.createNamespacedPod({
			namespace,
			body: withLastApplied(desired),
		});
	}
}

async function applyService(cluster: Cluster, resource: k8s.V1Service): Promise<k8s.V1Service> {
	const desired = prepareDesiredResource(resource, true);
	const name = requiredName(desired);
	const namespace = requiredNamespace(desired);
	try {
		return await retryConflicts(cluster.ctx, async () => {
			const existing = await cluster.api.corev1.readNamespacedService({ name, namespace });
			return await cluster.api.corev1.patchNamespacedService(
				{
					name,
					namespace,
					body: createApplyPatch(existing, desired),
				},
				MERGE_PATCH_OPTIONS,
			);
		});
	} catch (error) {
		if (!isNotFoundError(error)) {
			throw error;
		}
		return await cluster.api.corev1.createNamespacedService({
			namespace,
			body: withLastApplied(desired),
		});
	}
}

type PlainObject = { [key: string]: PlainValue };
type PlainValue = PlainObject | PlainValue[] | string | number | boolean | null;

function resourceKey(resource: KubernetesObject): string {
	return `${resource.apiVersion ?? "v1"}/${resource.kind ?? ""}`;
}

function prepareDesiredResource<T extends KubernetesObject>(resource: T, namespaced: boolean): T {
	const desired = structuredClone(resource);
	desired.apiVersion ??= "v1";
	desired.metadata ??= {};
	if (namespaced) {
		desired.metadata.namespace ??= "default";
	} else {
		delete desired.metadata.namespace;
	}
	delete (desired as KubernetesObject & { status?: unknown }).status;
	delete desired.metadata.resourceVersion;
	delete desired.metadata.uid;
	delete desired.metadata.creationTimestamp;
	delete desired.metadata.deletionGracePeriodSeconds;
	delete desired.metadata.deletionTimestamp;
	delete desired.metadata.generation;
	delete desired.metadata.managedFields;
	delete desired.metadata.selfLink;
	return desired;
}

function requiredName(resource: KubernetesObject): string {
	const name = resource.metadata?.name;
	if (!name) {
		throw new Error("resource name may not be empty");
	}
	return name;
}

function requiredNamespace(resource: KubernetesObject): string {
	const namespace = resource.metadata?.namespace;
	if (!namespace) {
		throw new Error(`${resourceKey(resource)} apply requires metadata.namespace`);
	}
	return namespace;
}

function createApplyPatch(existing: KubernetesObject, desired: KubernetesObject): PlainObject {
	const previous = previousLastApplied(existing);
	const patch = createThreeWayMergePatch(existing, previous ?? {}, desired);
	const metadata = ensurePlainObject(patch, "metadata");
	const annotations = ensurePlainObject(metadata, "annotations");
	annotations[LAST_APPLIED_ANNOTATION] = lastAppliedValue(desired);
	return patch;
}

function withLastApplied<T extends KubernetesObject>(resource: T): T {
	const annotated = structuredClone(resource);
	annotated.metadata ??= {};
	annotated.metadata.annotations ??= {};
	annotated.metadata.annotations[LAST_APPLIED_ANNOTATION] = lastAppliedValue(resource);
	return annotated;
}

function previousLastApplied(resource: KubernetesObject): KubernetesObject | undefined {
	const encoded = resource.metadata?.annotations?.[LAST_APPLIED_ANNOTATION];
	if (!encoded) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(encoded) as unknown;
	} catch {
		return undefined;
	}
	if (!isPlainObject(parsed)) {
		return undefined;
	}
	return parsed as KubernetesObject;
}

function lastAppliedValue(resource: KubernetesObject): string {
	const applied = structuredClone(resource);
	const annotations = applied.metadata?.annotations;
	if (annotations) {
		delete annotations[LAST_APPLIED_ANNOTATION];
		if (Object.keys(annotations).length === 0 && applied.metadata) {
			delete applied.metadata.annotations;
		}
	}
	return JSON.stringify(applied);
}

function createThreeWayMergePatch(
	existing: unknown,
	previous: unknown,
	desired: unknown,
): PlainObject {
	const patch: PlainObject = {};
	const existingObject = isPlainObject(existing) ? existing : {};
	const previousObject = isPlainObject(previous) ? previous : {};
	const desiredObject = isPlainObject(desired) ? desired : {};
	const keys = new Set([...Object.keys(previousObject), ...Object.keys(desiredObject)]);

	for (const key of keys) {
		if (!(key in desiredObject)) {
			patch[key] = null;
			continue;
		}

		const desiredValue = desiredObject[key];
		if (desiredValue === undefined) {
			continue;
		}

		const previousValue = previousObject[key];
		const existingValue = existingObject[key];
		if (isPlainObject(desiredValue) && isPlainObject(previousValue)) {
			const childPatch = createThreeWayMergePatch(existingValue, previousValue, desiredValue);
			if (Object.keys(childPatch).length > 0) {
				patch[key] = childPatch;
			}
			continue;
		}

		if (!deepEqual(desiredValue, previousValue)) {
			patch[key] = structuredClone(desiredValue);
		}
	}

	return patch;
}

function ensurePlainObject(parent: PlainObject, key: string): PlainObject {
	const current = parent[key];
	if (isPlainObject(current)) {
		return current;
	}
	const next: PlainObject = {};
	parent[key] = next;
	return next;
}

function isPlainObject(value: unknown): value is PlainObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
