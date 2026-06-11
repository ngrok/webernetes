import { getClock } from "../../../../clock-context";
import { retryConflicts } from "../../../../retry";
import {
	EventStore,
	NamespaceStore,
	NodeStore,
	PodStore,
	ServiceStore,
} from "../../../../cluster/storage";
import type { NodePortRange } from "../../../../cluster/storage";
import type { Etcd } from "../../../../cluster/etcd";
import type * as context from "../../../../go/context";
import { Store } from "../../../../cluster/storage/store";
import { BadRequest, Invalid, NotFound, UnsupportedMediaType } from "../../../errors";
import { filterByFields, parseFieldSelector } from "../../../fields";
import { filterByLabels, parseLabelSelector } from "../../../labels";
import { PatchStrategy } from "../../../patch";
import {
	CoreV1EventList,
	V1Binding,
	V1Namespace,
	V1NamespaceList,
	V1NodeList,
	V1PodList,
	V1ServiceList,
	V1Status,
} from "../../models";
import type { CoreV1Event } from "../../models/CoreV1Event";
import type { V1Node } from "../../models/V1Node";
import type { V1Pod } from "../../models/V1Pod";
import type { V1Service } from "../../models/V1Service";
import type {
	CoreV1ApiCreateNamespacedEventRequest,
	CoreV1ApiCreateNamespacedPodBindingRequest,
	CoreV1ApiCreateNamespacedPodRequest,
	CoreV1ApiCreateNamespacedServiceRequest,
	CoreV1ApiCreateNamespaceRequest,
	CoreV1ApiCreateNodeRequest,
	CoreV1ApiDeleteNamespacedEventRequest,
	CoreV1ApiDeleteNamespacedPodRequest,
	CoreV1ApiDeleteNamespacedServiceRequest,
	CoreV1ApiDeleteNamespaceRequest,
	CoreV1ApiDeleteNodeRequest,
	CoreV1Api as CoreV1ApiInterface,
	CoreV1ApiListEventForAllNamespacesRequest,
	CoreV1ApiListNodeRequest,
	CoreV1ApiListNamespacedEventRequest,
	CoreV1ApiListPodForAllNamespacesRequest,
	CoreV1ApiListNamespacedPodRequest,
	CoreV1ApiListNamespacedServiceRequest,
	CoreV1ApiListNamespaceRequest,
	CoreV1ApiListServiceForAllNamespacesRequest,
	CoreV1ApiPatchNamespaceRequest,
	CoreV1ApiPatchNamespacedPodRequest,
	CoreV1ApiPatchNamespacedPodStatusRequest,
	CoreV1ApiPatchNamespacedServiceRequest,
	CoreV1ApiPatchNodeRequest,
	CoreV1ApiReadNamespacedEventRequest,
	CoreV1ApiReadNamespacedPodRequest,
	CoreV1ApiReadNamespacedServiceRequest,
	CoreV1ApiReadNamespaceRequest,
	CoreV1ApiReadNodeRequest,
	CoreV1ApiReplaceNamespacedEventRequest,
	CoreV1ApiReplaceNamespacedPodRequest,
	CoreV1ApiReplaceNamespacedPodStatusRequest,
	CoreV1ApiReplaceNamespacedServiceRequest,
	CoreV1ApiReplaceNamespaceRequest,
	CoreV1ApiReplaceNodeRequest,
} from "../types/CoreV1Api";
import { rethrowApiErrors } from "./errors";
import { listResourceVersionOptions, validateDeletePreconditions } from "./resource-version";

export interface CoreV1ApiOptions {
	ctx: context.Context;
	etcd: Etcd;
	serviceCIDR?: string;
	nodePortRange: NodePortRange;
}

export class CoreV1Api implements CoreV1ApiInterface {
	private readonly ctx: context.Context;
	private readonly namespaces: Store<V1Namespace>;
	private readonly nodes: Store<V1Node>;
	private readonly events: Store<CoreV1Event>;
	private readonly pods: PodStore;
	private readonly services: Store<V1Service>;

	public constructor(options: CoreV1ApiOptions) {
		this.ctx = options.ctx;
		this.namespaces = new NamespaceStore(options.etcd);
		this.nodes = new NodeStore(options.etcd);
		this.events = new EventStore(options.etcd);
		this.pods = new PodStore(options.etcd);
		this.services = new ServiceStore(this.ctx, options.etcd, {
			serviceCIDR: options.serviceCIDR,
			nodePortRange: options.nodePortRange,
		});
	}

	public async createNamespacedEvent(
		param: CoreV1ApiCreateNamespacedEventRequest,
		_options?: unknown,
	): Promise<CoreV1Event> {
		return await rethrowApiErrors(async () => {
			param.body.metadata ??= {};
			param.body.metadata.namespace ??= param.namespace;
			return await this.events.create(param.body);
		});
	}

	async createNamespace(request: CoreV1ApiCreateNamespaceRequest): Promise<V1Namespace> {
		return await rethrowApiErrors(async () => {
			return await this.namespaces.create(request.body);
		});
	}

	async deleteNamespace(request: CoreV1ApiDeleteNamespaceRequest): Promise<V1Status> {
		return await rethrowApiErrors(async () => {
			await retryConflicts(this.ctx, async () => {
				const namespace = await this.namespaces.get(request.name);
				if (!namespace) {
					throw new NotFound(`namespaces "${request.name}" not found`);
				}
				validateDeletePreconditions("Namespace", request.name, request.body, namespace);

				const finalizers = namespace.spec?.finalizers ?? [];
				if (namespace.metadata?.deletionTimestamp && finalizers.length === 0) {
					await this.namespaces.delete(request.name);
					return;
				}

				if (!namespace.metadata?.deletionTimestamp) {
					namespace.metadata ??= {};
					namespace.metadata.deletionTimestamp = getClock(this.ctx).now();
					namespace.status ??= {};
					namespace.status.phase = "Terminating";
					await this.namespaces.update(request.name, namespace, { skipValidateUpdate: true });
				}
			});
			return {
				status: "Success",
			};
		});
	}

	public async readNamespace(request: CoreV1ApiReadNamespaceRequest): Promise<V1Namespace> {
		return await rethrowApiErrors(async () => {
			const namespace = await this.namespaces.get(request.name);
			if (!namespace) {
				throw new NotFound(`Namespace "${request.name}" not found`);
			}
			return namespace;
		});
	}

	public async readNode(request: CoreV1ApiReadNodeRequest): Promise<V1Node> {
		return await rethrowApiErrors(async () => {
			const node = await this.nodes.get(request.name);
			if (!node) {
				throw new NotFound(`Node "${request.name}" not found`);
			}

			return node;
		});
	}

	public async listNamespacedPod(request: CoreV1ApiListNamespacedPodRequest): Promise<V1PodList> {
		return await rethrowApiErrors(async () => {
			const selector = parseLabelSelector(request.labelSelector);
			const fieldSelector = parseFieldSelector(request.fieldSelector);
			const list = await this.pods.listWithResourceVersion(request.namespace, {
				...listResourceVersionOptions(request),
			});
			return {
				metadata: {
					resourceVersion: list.resourceVersion,
				},
				items: filterByFields(filterByLabels(list.items, selector), fieldSelector),
			};
		});
	}

	public async listNamespacedEvent(
		request: CoreV1ApiListNamespacedEventRequest,
	): Promise<CoreV1EventList> {
		return await rethrowApiErrors(async () => {
			const selector = parseLabelSelector(request.labelSelector);
			const fieldSelector = parseFieldSelector(request.fieldSelector);
			const list = await this.events.listWithResourceVersion(
				request.namespace,
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

	public async listNamespacedService(
		request: CoreV1ApiListNamespacedServiceRequest,
	): Promise<V1ServiceList> {
		return await rethrowApiErrors(async () => {
			const selector = parseLabelSelector(request.labelSelector);
			const fieldSelector = parseFieldSelector(request.fieldSelector);
			const list = await this.services.listWithResourceVersion(
				request.namespace,
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

	public async listPodForAllNamespaces(
		request: CoreV1ApiListPodForAllNamespacesRequest = {},
	): Promise<V1PodList> {
		return await rethrowApiErrors(async () => {
			const selector = parseLabelSelector(request.labelSelector);
			const fieldSelector = parseFieldSelector(request.fieldSelector);
			const list = await this.pods.listWithResourceVersion(
				undefined,
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

	public async listEventForAllNamespaces(
		request: CoreV1ApiListEventForAllNamespacesRequest = {},
	): Promise<CoreV1EventList> {
		return await rethrowApiErrors(async () => {
			const selector = parseLabelSelector(request.labelSelector);
			const fieldSelector = parseFieldSelector(request.fieldSelector);
			const list = await this.events.listWithResourceVersion(
				undefined,
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

	public async listServiceForAllNamespaces(
		request: CoreV1ApiListServiceForAllNamespacesRequest = {},
	): Promise<V1ServiceList> {
		return await rethrowApiErrors(async () => {
			const selector = parseLabelSelector(request.labelSelector);
			const fieldSelector = parseFieldSelector(request.fieldSelector);
			const list = await this.services.listWithResourceVersion(
				undefined,
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

	public async listNamespace(
		request: CoreV1ApiListNamespaceRequest = {},
	): Promise<V1NamespaceList> {
		return await rethrowApiErrors(async () => {
			const selector = parseLabelSelector(request.labelSelector);
			const fieldSelector = parseFieldSelector(request.fieldSelector);
			const list = await this.namespaces.listWithResourceVersion(
				undefined,
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

	public async listNode(request: CoreV1ApiListNodeRequest = {}): Promise<V1NodeList> {
		return await rethrowApiErrors(async () => {
			const selector = parseLabelSelector(request.labelSelector);
			const fieldSelector = parseFieldSelector(request.fieldSelector);
			const list = await this.nodes.listWithResourceVersion(
				undefined,
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

	public async createNode(request: CoreV1ApiCreateNodeRequest): Promise<V1Node> {
		return await rethrowApiErrors(async () => {
			return await this.nodes.create(request.body);
		});
	}

	public async deleteNode(request: CoreV1ApiDeleteNodeRequest): Promise<V1Status> {
		return await rethrowApiErrors(async () => {
			const node = await this.nodes.get(request.name);
			if (!node) {
				throw new NotFound(`Node "${request.name}" not found`);
			}
			validateDeletePreconditions("Node", request.name, request.body, node);

			await this.nodes.delete(request.name);
			return {
				status: "Success",
			};
		});
	}

	public async createNamespacedPod(
		param: CoreV1ApiCreateNamespacedPodRequest,
		_options?: unknown,
	): Promise<V1Pod> {
		return await rethrowApiErrors(async () => {
			param.body.metadata ??= {};
			param.body.metadata.namespace ??= param.namespace;
			return await this.pods.create(param.body);
		});
	}

	public async createNamespacedPodBinding(
		request: CoreV1ApiCreateNamespacedPodBindingRequest,
		_options?: unknown,
	): Promise<V1Binding> {
		return await rethrowApiErrors(async () => {
			request.body.apiVersion ??= "v1";
			request.body.kind ??= "Binding";
			request.body.metadata ??= {};
			request.body.metadata.name ??= request.name;
			request.body.metadata.namespace ??= request.namespace;
			await this.pods.bind(request.name, request.namespace, request.body);
			return request.body;
		});
	}

	public async createNamespacedService(
		param: CoreV1ApiCreateNamespacedServiceRequest,
		_options?: unknown,
	): Promise<V1Service> {
		return await rethrowApiErrors(async () => {
			param.body.metadata ??= {};
			param.body.metadata.namespace ??= param.namespace;
			return await this.services.create(param.body);
		});
	}

	public async readNamespacedPod(request: CoreV1ApiReadNamespacedPodRequest): Promise<V1Pod> {
		return await rethrowApiErrors(async () => {
			const pod = await this.pods.get(request.name, request.namespace);
			if (!pod) {
				throw new NotFound(`Pod "${request.name}" not found`);
			}

			return pod;
		});
	}

	public async readNamespacedEvent(
		request: CoreV1ApiReadNamespacedEventRequest,
	): Promise<CoreV1Event> {
		return await rethrowApiErrors(async () => {
			const event = await this.events.get(request.name, request.namespace);
			if (!event) {
				throw new NotFound(`Event "${request.name}" not found`);
			}

			return event;
		});
	}

	public async readNamespacedService(
		request: CoreV1ApiReadNamespacedServiceRequest,
	): Promise<V1Service> {
		return await rethrowApiErrors(async () => {
			const service = await this.services.get(request.name, request.namespace);
			if (!service) {
				throw new NotFound(`Service "${request.name}" not found`);
			}

			return service;
		});
	}

	public async deleteNamespacedPod(request: CoreV1ApiDeleteNamespacedPodRequest): Promise<V1Pod> {
		return await rethrowApiErrors(async () => {
			return await retryConflicts(this.ctx, async () => {
				const pod = await this.pods.get(request.name, request.namespace);
				if (!pod) {
					throw new NotFound(`Pod "${request.name}" not found`);
				}
				validateDeletePreconditions("Pod", request.name, request.body, pod);

				const gracePeriodSeconds = podDeletionGracePeriodSeconds(request, pod);
				if (gracePeriodSeconds === 0) {
					await this.pods.delete(request.name, request.namespace);
					return pod;
				}

				pod.metadata ??= {};
				if (pod.metadata.deletionTimestamp) {
					if (
						pod.metadata.deletionGracePeriodSeconds === undefined ||
						gracePeriodSeconds < pod.metadata.deletionGracePeriodSeconds
					) {
						pod.metadata.deletionGracePeriodSeconds = gracePeriodSeconds;
						return await this.pods.update(request.name, pod);
					}
					return pod;
				}

				pod.metadata.deletionTimestamp = getClock(this.ctx).now();
				pod.metadata.deletionGracePeriodSeconds = gracePeriodSeconds;
				await this.pods.update(request.name, pod);
				return pod;
			});
		});
	}

	public async deleteNamespacedService(
		request: CoreV1ApiDeleteNamespacedServiceRequest,
	): Promise<V1Service> {
		return await rethrowApiErrors(async () => {
			const service = await this.services.get(request.name, request.namespace);
			if (!service) {
				throw new NotFound(`Service "${request.name}" not found`);
			}
			validateDeletePreconditions("Service", request.name, request.body, service);

			await this.services.delete(request.name, request.namespace);
			return service;
		});
	}

	public async deleteNamespacedEvent(
		request: CoreV1ApiDeleteNamespacedEventRequest,
	): Promise<V1Status> {
		return await rethrowApiErrors(async () => {
			const event = await this.events.get(request.name, request.namespace);
			if (!event) {
				throw new NotFound(`Event "${request.name}" not found`);
			}
			validateDeletePreconditions("Event", request.name, request.body, event);

			await this.events.delete(request.name, request.namespace);
			return {
				status: "Success",
			};
		});
	}

	public async replaceNamespacedPod(request: CoreV1ApiReplaceNamespacedPodRequest): Promise<V1Pod> {
		return await rethrowApiErrors(async () => {
			const replace = async () => {
				request.body.metadata ??= {};
				request.body.metadata.name = request.name;
				request.body.metadata.namespace ??= request.namespace;
				return await this.pods.update(request.name, request.body);
			};

			if (request.body.metadata?.resourceVersion) {
				return await replace();
			}

			return await retryConflicts(this.ctx, replace);
		});
	}

	public async patchNamespacedPod(
		request: CoreV1ApiPatchNamespacedPodRequest,
		options?: unknown,
	): Promise<V1Pod> {
		return await rethrowApiErrors(async () => {
			validateMergePatchContentType(options);
			return await retryConflicts(this.ctx, async () => {
				const pod = await this.pods.get(request.name, request.namespace);
				if (!pod) {
					throw new NotFound(`Pod "${request.name}" not found`);
				}
				validatePatchName(request.body, request.name);

				const patched = mergePatch(pod, request.body);
				patched.metadata ??= {};
				patched.metadata.name = request.name;
				patched.metadata.namespace ??= request.namespace;
				return await this.pods.update(request.name, patched);
			});
		});
	}

	public async patchNamespacedPodStatus(
		request: CoreV1ApiPatchNamespacedPodStatusRequest,
		options?: unknown,
	): Promise<V1Pod> {
		return await rethrowApiErrors(async () => {
			validateMergePatchContentType(options);
			return await retryConflicts(this.ctx, async () => {
				const pod = await this.pods.get(request.name, request.namespace);
				if (!pod) {
					throw new NotFound(`Pod "${request.name}" not found`);
				}
				validatePatchName(request.body, request.name);
				validatePatchUid(request.body, request.name, pod.metadata?.uid);

				const patched = mergePatch(pod, request.body);
				patched.metadata ??= {};
				patched.metadata.name = request.name;
				patched.metadata.namespace ??= request.namespace;
				return await this.pods.update(request.name, patched);
			});
		});
	}

	public async replaceNamespacedEvent(
		request: CoreV1ApiReplaceNamespacedEventRequest,
	): Promise<CoreV1Event> {
		return await rethrowApiErrors(async () => {
			request.body.metadata ??= {};
			request.body.metadata.name = request.name;
			request.body.metadata.namespace ??= request.namespace;
			return await this.events.update(request.name, request.body);
		});
	}

	public async replaceNamespacedPodStatus(
		request: CoreV1ApiReplaceNamespacedPodStatusRequest,
	): Promise<V1Pod> {
		return await rethrowApiErrors(async () => {
			const pod = await this.pods.get(request.name, request.namespace);
			if (!pod) {
				throw new NotFound(`Pod "${request.name}" not found`);
			}

			pod.status = request.body.status;
			return await this.pods.update(request.name, pod);
		});
	}

	public async replaceNamespacedService(
		request: CoreV1ApiReplaceNamespacedServiceRequest,
	): Promise<V1Service> {
		return await rethrowApiErrors(async () => {
			request.body.metadata ??= {};
			request.body.metadata.name = request.name;
			request.body.metadata.namespace ??= request.namespace;
			return await this.services.update(request.name, request.body);
		});
	}

	public async patchNamespacedService(
		request: CoreV1ApiPatchNamespacedServiceRequest,
		options?: unknown,
	): Promise<V1Service> {
		return await rethrowApiErrors(async () => {
			validateMergePatchContentType(options);
			return await retryConflicts(this.ctx, async () => {
				const service = await this.services.get(request.name, request.namespace);
				if (!service) {
					throw new NotFound(`Service "${request.name}" not found`);
				}
				validatePatchName(request.body, request.name);

				const patched = mergePatch(service, request.body);
				patched.metadata ??= {};
				patched.metadata.name = request.name;
				patched.metadata.namespace ??= request.namespace;
				return await this.services.update(request.name, patched);
			});
		});
	}

	public async replaceNamespace(request: CoreV1ApiReplaceNamespaceRequest): Promise<V1Namespace> {
		return await rethrowApiErrors(async () => {
			request.body.metadata ??= {};
			request.body.metadata.name = request.name;
			return await this.namespaces.update(request.name, request.body);
		});
	}

	public async patchNamespace(
		request: CoreV1ApiPatchNamespaceRequest,
		options?: unknown,
	): Promise<V1Namespace> {
		return await rethrowApiErrors(async () => {
			validateMergePatchContentType(options);
			return await retryConflicts(this.ctx, async () => {
				const namespace = await this.namespaces.get(request.name);
				if (!namespace) {
					throw new NotFound(`Namespace "${request.name}" not found`);
				}
				validatePatchName(request.body, request.name);

				const patched = mergePatch(namespace, request.body);
				patched.metadata ??= {};
				patched.metadata.name = request.name;
				return await this.namespaces.update(request.name, patched);
			});
		});
	}

	public async replaceNode(request: CoreV1ApiReplaceNodeRequest): Promise<V1Node> {
		return await rethrowApiErrors(async () => {
			request.body.metadata ??= {};
			request.body.metadata.name = request.name;
			return await this.nodes.update(request.name, request.body);
		});
	}

	public async patchNode(request: CoreV1ApiPatchNodeRequest, options?: unknown): Promise<V1Node> {
		return await rethrowApiErrors(async () => {
			validateMergePatchContentType(options);
			return await retryConflicts(this.ctx, async () => {
				const node = await this.nodes.get(request.name);
				if (!node) {
					throw new NotFound(`Node "${request.name}" not found`);
				}
				validatePatchName(request.body, request.name);

				const patched = mergePatch(node, request.body);
				patched.metadata ??= {};
				patched.metadata.name = request.name;
				return await this.nodes.update(request.name, patched);
			});
		});
	}
}

type PatchObject = { [key: string]: PatchValue };
type PatchValue = PatchObject | PatchValue[] | string | number | boolean | null;

function validateMergePatchContentType(options: unknown): void {
	const contentType = getContentType(options);
	if (contentType !== PatchStrategy.MergePatch) {
		throw new UnsupportedMediaType(`Unsupported Media Type: ${contentType ?? ""}`);
	}
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

function validatePatchUid(patch: unknown, name: string, uid: string | undefined): void {
	if (!isPatchObject(patch) || !isPatchObject(patch.metadata)) {
		return;
	}
	const patchedUid = patch.metadata.uid;
	if (patchedUid !== undefined && patchedUid !== uid) {
		throw new Invalid(
			`Pod "${name}" is invalid: metadata.uid: Invalid value: "${patchedUid}": field is immutable`,
		);
	}
}

function mergePatch<T extends object>(target: T, patch: unknown): T {
	if (!isPatchObject(patch)) {
		// The real generated client defaults patch requests to JSON Patch when the
		// caller does not set a content type. The simulator currently implements
		// merge patch only; add JSON Patch here if shared tests or user code need it.
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

function podDeletionGracePeriodSeconds(
	request: CoreV1ApiDeleteNamespacedPodRequest,
	pod: V1Pod,
): number {
	return (
		request.gracePeriodSeconds ??
		request.body?.gracePeriodSeconds ??
		pod.spec?.terminationGracePeriodSeconds ??
		30
	);
}
