import { KubeConfig } from "../config";
import { isNotFoundError } from "../errors";
import {
	AppsV1Api as AppsV1ApiImpl,
	CoreV1Api as CoreV1ApiImpl,
	DiscoveryV1Api as DiscoveryV1ApiImpl,
} from "../gen/apis/impls";
import type { AppsV1Api, CoreV1Api, DiscoveryV1Api } from "../gen/apis/types";
import type {
	CoreV1Event,
	CoreV1EventList,
	V1Binding,
	V1Deployment,
	V1DeploymentList,
	V1EndpointSlice,
	V1EndpointSliceList,
	V1Namespace,
	V1NamespaceList,
	V1Node,
	V1NodeList,
	V1Pod,
	V1PodList,
	V1ReplicaSet,
	V1ReplicaSetList,
	V1Scale,
	V1Service,
	V1ServiceList,
	V1Status,
} from "../gen/models";
import type { KubeClient } from "../types";
import type { MaybePromise } from "../../promise";
import { Etcd } from "../../cluster/etcd";
import type * as context from "../../go/context";

export type ClientAction = {
	verb: string;
	resource: string;
	subresource?: string;
	request?: unknown;
};

export type ClientReaction<TObj = unknown, TErr = Error | undefined> = [
	handled: boolean,
	obj: TObj | undefined,
	err: TErr,
];

export type ClientReactor<TObj = unknown, TErr = Error | undefined> = (
	action: ClientAction,
) => MaybePromise<ClientReaction<TObj, TErr>>;

export type TestKubeClientObject =
	| CoreV1Event
	| V1Deployment
	| V1EndpointSlice
	| V1Namespace
	| V1Node
	| V1Pod
	| V1ReplicaSet
	| V1Service;

type ClientReactionObjects = {
	create: {
		events: CoreV1Event;
		deployments: V1Deployment;
		namespaces: V1Namespace;
		nodes: V1Node;
		pods: V1Pod | V1Binding;
		services: V1Service;
		replicasets: V1ReplicaSet;
		endpointslices: V1EndpointSlice;
	};
	delete: {
		events: V1Status;
		deployments: V1Status;
		namespaces: V1Status;
		nodes: V1Status;
		pods: V1Pod;
		services: V1Service;
		replicasets: V1Status;
		endpointslices: V1Status;
	};
	get: {
		events: CoreV1Event;
		deployments: V1Deployment | V1Scale;
		namespaces: V1Namespace;
		nodes: V1Node;
		pods: V1Pod;
		services: V1Service;
		replicasets: V1ReplicaSet | V1Scale;
		endpointslices: V1EndpointSlice;
	};
	list: {
		events: CoreV1EventList;
		deployments: V1DeploymentList;
		namespaces: V1NamespaceList;
		nodes: V1NodeList;
		pods: V1PodList;
		services: V1ServiceList;
		replicasets: V1ReplicaSetList;
		endpointslices: V1EndpointSliceList;
	};
	patch: {
		namespaces: V1Namespace;
		deployments: V1Deployment | V1Scale;
		nodes: V1Node;
		pods: V1Pod;
		services: V1Service;
		replicasets: V1ReplicaSet | V1Scale;
	};
	update: {
		events: CoreV1Event;
		deployments: V1Deployment | V1Scale;
		namespaces: V1Namespace;
		nodes: V1Node;
		pods: V1Pod;
		services: V1Service;
		replicasets: V1ReplicaSet | V1Scale;
		endpointslices: V1EndpointSlice;
	};
};

type ClientVerb = keyof ClientReactionObjects;

type ClientResourceForVerb<TVerb extends ClientVerb> = keyof ClientReactionObjects[TVerb] & string;

type ClientReactionObject<
	TVerb extends ClientVerb,
	TResource extends ClientResourceForVerb<TVerb>,
> = ClientReactionObjects[TVerb][TResource];

type ClientActionHandler = <T>(
	verb: string,
	resource: string,
	subresource: string | undefined,
	request: unknown,
	delegate: () => Promise<T>,
) => Promise<T>;

export class TestKubeClient implements KubeClient {
	readonly appsv1: AppsV1Api;
	readonly corev1: CoreV1Api;
	readonly discoveryv1: DiscoveryV1Api;
	private readonly actionList: ClientAction[] = [];
	private readonly reactors: {
		verb: string;
		resource: string;
		reactor: ClientReactor<unknown, unknown>;
	}[] = [];

	constructor(readonly kubeConfig: KubeConfig) {
		this.appsv1 = new RecordingAppsV1Api(
			kubeConfig.makeApiClient(AppsV1ApiImpl),
			this.handle.bind(this),
		);
		this.corev1 = new RecordingCoreV1Api(
			kubeConfig.makeApiClient(CoreV1ApiImpl),
			this.handle.bind(this),
		);
		this.discoveryv1 = new RecordingDiscoveryV1Api(
			kubeConfig.makeApiClient(DiscoveryV1ApiImpl),
			this.handle.bind(this),
		);
	}

	addReactor<
		TVerb extends ClientVerb,
		TResource extends ClientResourceForVerb<TVerb>,
		TErr = Error | undefined,
	>(
		verb: TVerb,
		resource: TResource,
		reactor: ClientReactor<ClientReactionObject<TVerb, TResource>, TErr>,
	): void;
	addReactor(verb: string, resource: string, reactor: ClientReactor<unknown, unknown>): void;
	addReactor(verb: string, resource: string, reactor: ClientReactor<unknown, unknown>): void {
		this.reactors.push({ verb, resource, reactor });
	}

	actions(): ClientAction[] {
		return [...this.actionList];
	}

	clearActions(): void {
		this.actionList.length = 0;
	}

	private async handle<T>(
		verb: string,
		resource: string,
		subresource: string | undefined,
		request: unknown,
		delegate: () => Promise<T>,
	): Promise<T> {
		const action = { ...clientAction(verb, resource, subresource), request };
		this.actionList.push(action);

		for (const { verb: reactorVerb, resource: reactorResource, reactor } of this.reactors) {
			if (matchesReactor(reactorVerb, verb) && matchesReactor(reactorResource, resource)) {
				const [handled, obj, err] = await reactor(action);
				if (handled) {
					if (err !== undefined) {
						throw err;
					}
					return obj as T;
				}
			}
		}

		return await delegate();
	}
}

export async function newTestKubeClient(
	ctx: context.Context,
	objects: TestKubeClientObject[] = [],
): Promise<[TestKubeClient, KubeConfig]> {
	const kubeConfig = new KubeConfig({
		ctx,
		etcd: new Etcd(ctx),
		nodePortRange: { from: 30000, to: 32767 },
	});
	const client = new TestKubeClient(kubeConfig);
	await seedTestKubeClient(client, objects);
	client.clearActions();
	return [client, kubeConfig];
}

export async function seedTestKubeClient(
	client: TestKubeClient,
	objects: TestKubeClientObject[],
): Promise<void> {
	for (const object of objects) {
		if (object.kind === "Namespace") {
			await ensureNamespaceObject(client, object as V1Namespace);
		}
	}
	for (const object of objects) {
		if (object.kind === "Namespace") {
			continue;
		}
		const namespace = testObjectNamespace(object);
		if (namespace) {
			await ensureNamespace(client, namespace);
		}
		await createTestObject(client, object);
	}
}

async function ensureNamespace(client: TestKubeClient, namespace: string): Promise<void> {
	await ensureNamespaceObject(client, { metadata: { name: namespace } });
}

async function ensureNamespaceObject(
	client: TestKubeClient,
	namespace: V1Namespace,
): Promise<void> {
	const name = namespace.metadata?.name;
	if (!name) {
		throw new Error("namespace test object is missing metadata.name");
	}
	try {
		await client.corev1.readNamespace({ name });
	} catch (error) {
		if (!isNotFoundError(error)) {
			throw error;
		}
		await client.corev1.createNamespace({ body: structuredClone(namespace) });
	}
}

async function createTestObject(
	client: TestKubeClient,
	object: TestKubeClientObject,
): Promise<void> {
	const apiVersion = testObjectApiVersion(object);
	const kind = object.kind;
	if (apiVersion === "apps/v1" && kind === "Deployment") {
		await client.appsv1.createNamespacedDeployment({
			namespace: namespacedTestObjectNamespace(object),
			body: structuredClone(object as V1Deployment),
		});
		return;
	}
	if (apiVersion === "apps/v1" && kind === "ReplicaSet") {
		await client.appsv1.createNamespacedReplicaSet({
			namespace: namespacedTestObjectNamespace(object),
			body: structuredClone(object as V1ReplicaSet),
		});
		return;
	}
	if (apiVersion === "v1" && kind === "Event") {
		await client.corev1.createNamespacedEvent({
			namespace: namespacedTestObjectNamespace(object),
			body: structuredClone(object as CoreV1Event),
		});
		return;
	}
	if (apiVersion === "v1" && kind === "Node") {
		await client.corev1.createNode({
			body: structuredClone(object as V1Node),
		});
		return;
	}
	if (apiVersion === "v1" && kind === "Pod") {
		await client.corev1.createNamespacedPod({
			namespace: namespacedTestObjectNamespace(object),
			body: structuredClone(object as V1Pod),
		});
		return;
	}
	if (apiVersion === "v1" && kind === "Service") {
		await client.corev1.createNamespacedService({
			namespace: namespacedTestObjectNamespace(object),
			body: structuredClone(object as V1Service),
		});
		return;
	}
	if (apiVersion === "discovery.k8s.io/v1" && kind === "EndpointSlice") {
		await client.discoveryv1.createNamespacedEndpointSlice({
			namespace: namespacedTestObjectNamespace(object),
			body: structuredClone(object as V1EndpointSlice),
		});
		return;
	}
	throw new Error(`unsupported test object ${apiVersion ?? ""}/${kind ?? ""}`);
}

function testObjectApiVersion(object: TestKubeClientObject): string {
	if (!object.apiVersion) {
		throw new Error(`test object ${object.kind ?? ""} is missing apiVersion`);
	}
	return object.apiVersion;
}

function testObjectNamespace(object: TestKubeClientObject): string | undefined {
	switch (object.kind) {
		case "Deployment":
		case "EndpointSlice":
		case "Event":
		case "Pod":
		case "ReplicaSet":
		case "Service":
			return object.metadata?.namespace ?? "default";
		case "Namespace":
		case "Node":
			return undefined;
		default:
			throw new Error(`unsupported test object kind ${object.kind ?? ""}`);
	}
}

function namespacedTestObjectNamespace(object: TestKubeClientObject): string {
	return testObjectNamespace(object) ?? "default";
}

export function clientAction(verb: string, resource: string, subresource?: string): ClientAction {
	return subresource === undefined ? { verb, resource } : { verb, resource, subresource };
}

function matchesReactor(pattern: string, value: string): boolean {
	return pattern === "*" || pattern === value;
}

class RecordingAppsV1Api implements AppsV1Api {
	constructor(
		private readonly delegate: AppsV1Api,
		private readonly handle: ClientActionHandler,
	) {}

	createNamespacedDeployment: AppsV1Api["createNamespacedDeployment"] = async (request) => {
		return await this.handle("create", "deployments", undefined, request, async () => {
			return await this.delegate.createNamespacedDeployment(request);
		});
	};

	deleteCollectionNamespacedDeployment: AppsV1Api["deleteCollectionNamespacedDeployment"] = async (
		request,
	) => {
		return await this.handle("delete", "deployments", undefined, request, async () => {
			return await this.delegate.deleteCollectionNamespacedDeployment(request);
		});
	};

	deleteNamespacedDeployment: AppsV1Api["deleteNamespacedDeployment"] = async (request) => {
		return await this.handle("delete", "deployments", undefined, request, async () => {
			return await this.delegate.deleteNamespacedDeployment(request);
		});
	};

	listDeploymentForAllNamespaces: AppsV1Api["listDeploymentForAllNamespaces"] = async (request) => {
		return await this.handle("list", "deployments", undefined, request, async () => {
			return await this.delegate.listDeploymentForAllNamespaces(request);
		});
	};

	listNamespacedDeployment: AppsV1Api["listNamespacedDeployment"] = async (request) => {
		return await this.handle("list", "deployments", undefined, request, async () => {
			return await this.delegate.listNamespacedDeployment(request);
		});
	};

	patchNamespacedDeployment: AppsV1Api["patchNamespacedDeployment"] = async (request, options) => {
		return await this.handle("patch", "deployments", undefined, request, async () => {
			return await this.delegate.patchNamespacedDeployment(request, options);
		});
	};

	patchNamespacedDeploymentScale: AppsV1Api["patchNamespacedDeploymentScale"] = async (
		request,
		options,
	) => {
		return await this.handle("patch", "deployments", "scale", request, async () => {
			return await this.delegate.patchNamespacedDeploymentScale(request, options);
		});
	};

	patchNamespacedDeploymentStatus: AppsV1Api["patchNamespacedDeploymentStatus"] = async (
		request,
		options,
	) => {
		return await this.handle("patch", "deployments", "status", request, async () => {
			return await this.delegate.patchNamespacedDeploymentStatus(request, options);
		});
	};

	readNamespacedDeployment: AppsV1Api["readNamespacedDeployment"] = async (request) => {
		return await this.handle("get", "deployments", undefined, request, async () => {
			return await this.delegate.readNamespacedDeployment(request);
		});
	};

	readNamespacedDeploymentScale: AppsV1Api["readNamespacedDeploymentScale"] = async (request) => {
		return await this.handle("get", "deployments", "scale", request, async () => {
			return await this.delegate.readNamespacedDeploymentScale(request);
		});
	};

	readNamespacedDeploymentStatus: AppsV1Api["readNamespacedDeploymentStatus"] = async (request) => {
		return await this.handle("get", "deployments", "status", request, async () => {
			return await this.delegate.readNamespacedDeploymentStatus(request);
		});
	};

	replaceNamespacedDeployment: AppsV1Api["replaceNamespacedDeployment"] = async (request) => {
		return await this.handle("update", "deployments", undefined, request, async () => {
			return await this.delegate.replaceNamespacedDeployment(request);
		});
	};

	replaceNamespacedDeploymentScale: AppsV1Api["replaceNamespacedDeploymentScale"] = async (
		request,
	) => {
		return await this.handle("update", "deployments", "scale", request, async () => {
			return await this.delegate.replaceNamespacedDeploymentScale(request);
		});
	};

	replaceNamespacedDeploymentStatus: AppsV1Api["replaceNamespacedDeploymentStatus"] = async (
		request,
	) => {
		return await this.handle("update", "deployments", "status", request, async () => {
			return await this.delegate.replaceNamespacedDeploymentStatus(request);
		});
	};

	createNamespacedReplicaSet: AppsV1Api["createNamespacedReplicaSet"] = async (request) => {
		return await this.handle("create", "replicasets", undefined, request, async () => {
			return await this.delegate.createNamespacedReplicaSet(request);
		});
	};

	deleteCollectionNamespacedReplicaSet: AppsV1Api["deleteCollectionNamespacedReplicaSet"] = async (
		request,
	) => {
		return await this.handle("delete", "replicasets", undefined, request, async () => {
			return await this.delegate.deleteCollectionNamespacedReplicaSet(request);
		});
	};

	deleteNamespacedReplicaSet: AppsV1Api["deleteNamespacedReplicaSet"] = async (request) => {
		return await this.handle("delete", "replicasets", undefined, request, async () => {
			return await this.delegate.deleteNamespacedReplicaSet(request);
		});
	};

	listReplicaSetForAllNamespaces: AppsV1Api["listReplicaSetForAllNamespaces"] = async (request) => {
		return await this.handle("list", "replicasets", undefined, request, async () => {
			return await this.delegate.listReplicaSetForAllNamespaces(request);
		});
	};

	listNamespacedReplicaSet: AppsV1Api["listNamespacedReplicaSet"] = async (request) => {
		return await this.handle("list", "replicasets", undefined, request, async () => {
			return await this.delegate.listNamespacedReplicaSet(request);
		});
	};

	patchNamespacedReplicaSet: AppsV1Api["patchNamespacedReplicaSet"] = async (request, options) => {
		return await this.handle("patch", "replicasets", undefined, request, async () => {
			return await this.delegate.patchNamespacedReplicaSet(request, options);
		});
	};

	patchNamespacedReplicaSetScale: AppsV1Api["patchNamespacedReplicaSetScale"] = async (
		request,
		options,
	) => {
		return await this.handle("patch", "replicasets", "scale", request, async () => {
			return await this.delegate.patchNamespacedReplicaSetScale(request, options);
		});
	};

	patchNamespacedReplicaSetStatus: AppsV1Api["patchNamespacedReplicaSetStatus"] = async (
		request,
		options,
	) => {
		return await this.handle("patch", "replicasets", "status", request, async () => {
			return await this.delegate.patchNamespacedReplicaSetStatus(request, options);
		});
	};

	readNamespacedReplicaSet: AppsV1Api["readNamespacedReplicaSet"] = async (request) => {
		return await this.handle("get", "replicasets", undefined, request, async () => {
			return await this.delegate.readNamespacedReplicaSet(request);
		});
	};

	readNamespacedReplicaSetScale: AppsV1Api["readNamespacedReplicaSetScale"] = async (request) => {
		return await this.handle("get", "replicasets", "scale", request, async () => {
			return await this.delegate.readNamespacedReplicaSetScale(request);
		});
	};

	readNamespacedReplicaSetStatus: AppsV1Api["readNamespacedReplicaSetStatus"] = async (request) => {
		return await this.handle("get", "replicasets", "status", request, async () => {
			return await this.delegate.readNamespacedReplicaSetStatus(request);
		});
	};

	replaceNamespacedReplicaSet: AppsV1Api["replaceNamespacedReplicaSet"] = async (request) => {
		return await this.handle("update", "replicasets", undefined, request, async () => {
			return await this.delegate.replaceNamespacedReplicaSet(request);
		});
	};

	replaceNamespacedReplicaSetScale: AppsV1Api["replaceNamespacedReplicaSetScale"] = async (
		request,
	) => {
		return await this.handle("update", "replicasets", "scale", request, async () => {
			return await this.delegate.replaceNamespacedReplicaSetScale(request);
		});
	};

	replaceNamespacedReplicaSetStatus: AppsV1Api["replaceNamespacedReplicaSetStatus"] = async (
		request,
	) => {
		return await this.handle("update", "replicasets", "status", request, async () => {
			return await this.delegate.replaceNamespacedReplicaSetStatus(request);
		});
	};
}

class RecordingCoreV1Api implements CoreV1Api {
	constructor(
		private readonly delegate: CoreV1Api,
		private readonly handle: ClientActionHandler,
	) {}

	createNamespacedEvent: CoreV1Api["createNamespacedEvent"] = async (request) => {
		return await this.handle("create", "events", undefined, request, async () => {
			return await this.delegate.createNamespacedEvent(request);
		});
	};

	createNamespace: CoreV1Api["createNamespace"] = async (request) => {
		return await this.handle("create", "namespaces", undefined, request, async () => {
			return await this.delegate.createNamespace(request);
		});
	};

	createNode: CoreV1Api["createNode"] = async (request) => {
		return await this.handle("create", "nodes", undefined, request, async () => {
			return await this.delegate.createNode(request);
		});
	};

	createNamespacedPodBinding: CoreV1Api["createNamespacedPodBinding"] = async (request) => {
		return await this.handle("create", "pods", "binding", request, async () => {
			return await this.delegate.createNamespacedPodBinding(request);
		});
	};

	createNamespacedPod: CoreV1Api["createNamespacedPod"] = async (request) => {
		return await this.handle("create", "pods", undefined, request, async () => {
			return await this.delegate.createNamespacedPod(request);
		});
	};

	createNamespacedService: CoreV1Api["createNamespacedService"] = async (request) => {
		return await this.handle("create", "services", undefined, request, async () => {
			return await this.delegate.createNamespacedService(request);
		});
	};

	deleteNamespacedEvent: CoreV1Api["deleteNamespacedEvent"] = async (request) => {
		return await this.handle("delete", "events", undefined, request, async () => {
			return await this.delegate.deleteNamespacedEvent(request);
		});
	};

	deleteNamespacedPod: CoreV1Api["deleteNamespacedPod"] = async (request) => {
		return await this.handle("delete", "pods", undefined, request, async () => {
			return await this.delegate.deleteNamespacedPod(request);
		});
	};

	deleteNamespacedService: CoreV1Api["deleteNamespacedService"] = async (request) => {
		return await this.handle("delete", "services", undefined, request, async () => {
			return await this.delegate.deleteNamespacedService(request);
		});
	};

	deleteNamespace: CoreV1Api["deleteNamespace"] = async (request) => {
		return await this.handle("delete", "namespaces", undefined, request, async () => {
			return await this.delegate.deleteNamespace(request);
		});
	};

	deleteNode: CoreV1Api["deleteNode"] = async (request) => {
		return await this.handle("delete", "nodes", undefined, request, async () => {
			return await this.delegate.deleteNode(request);
		});
	};

	listEventForAllNamespaces: CoreV1Api["listEventForAllNamespaces"] = async (request) => {
		return await this.handle("list", "events", undefined, request, async () => {
			return await this.delegate.listEventForAllNamespaces(request);
		});
	};

	listNamespace: CoreV1Api["listNamespace"] = async (request) => {
		return await this.handle("list", "namespaces", undefined, request, async () => {
			return await this.delegate.listNamespace(request);
		});
	};

	listNode: CoreV1Api["listNode"] = async (request) => {
		return await this.handle("list", "nodes", undefined, request, async () => {
			return await this.delegate.listNode(request);
		});
	};

	listNamespacedEvent: CoreV1Api["listNamespacedEvent"] = async (request) => {
		return await this.handle("list", "events", undefined, request, async () => {
			return await this.delegate.listNamespacedEvent(request);
		});
	};

	listNamespacedPod: CoreV1Api["listNamespacedPod"] = async (request) => {
		return await this.handle("list", "pods", undefined, request, async () => {
			return await this.delegate.listNamespacedPod(request);
		});
	};

	listNamespacedService: CoreV1Api["listNamespacedService"] = async (request) => {
		return await this.handle("list", "services", undefined, request, async () => {
			return await this.delegate.listNamespacedService(request);
		});
	};

	listPodForAllNamespaces: CoreV1Api["listPodForAllNamespaces"] = async (request) => {
		return await this.handle("list", "pods", undefined, request, async () => {
			return await this.delegate.listPodForAllNamespaces(request);
		});
	};

	listServiceForAllNamespaces: CoreV1Api["listServiceForAllNamespaces"] = async (request) => {
		return await this.handle("list", "services", undefined, request, async () => {
			return await this.delegate.listServiceForAllNamespaces(request);
		});
	};

	readNamespacedEvent: CoreV1Api["readNamespacedEvent"] = async (request) => {
		return await this.handle("get", "events", undefined, request, async () => {
			return await this.delegate.readNamespacedEvent(request);
		});
	};

	readNamespacedPod: CoreV1Api["readNamespacedPod"] = async (request) => {
		return await this.handle("get", "pods", undefined, request, async () => {
			return await this.delegate.readNamespacedPod(request);
		});
	};

	readNamespacedService: CoreV1Api["readNamespacedService"] = async (request) => {
		return await this.handle("get", "services", undefined, request, async () => {
			return await this.delegate.readNamespacedService(request);
		});
	};

	readNamespace: CoreV1Api["readNamespace"] = async (request) => {
		return await this.handle("get", "namespaces", undefined, request, async () => {
			return await this.delegate.readNamespace(request);
		});
	};

	readNode: CoreV1Api["readNode"] = async (request) => {
		return await this.handle("get", "nodes", undefined, request, async () => {
			return await this.delegate.readNode(request);
		});
	};

	patchNamespace: CoreV1Api["patchNamespace"] = async (request, options) => {
		return await this.handle("patch", "namespaces", undefined, request, async () => {
			return await this.delegate.patchNamespace(request, options);
		});
	};

	patchNode: CoreV1Api["patchNode"] = async (request, options) => {
		return await this.handle("patch", "nodes", undefined, request, async () => {
			return await this.delegate.patchNode(request, options);
		});
	};

	patchNamespacedPod: CoreV1Api["patchNamespacedPod"] = async (request, options) => {
		return await this.handle("patch", "pods", undefined, request, async () => {
			return await this.delegate.patchNamespacedPod(request, options);
		});
	};

	patchNamespacedPodStatus: CoreV1Api["patchNamespacedPodStatus"] = async (request, options) => {
		return await this.handle("patch", "pods", "status", request, async () => {
			return await this.delegate.patchNamespacedPodStatus(request, options);
		});
	};

	patchNamespacedService: CoreV1Api["patchNamespacedService"] = async (request, options) => {
		return await this.handle("patch", "services", undefined, request, async () => {
			return await this.delegate.patchNamespacedService(request, options);
		});
	};

	replaceNamespacedEvent: CoreV1Api["replaceNamespacedEvent"] = async (request) => {
		return await this.handle("update", "events", undefined, request, async () => {
			return await this.delegate.replaceNamespacedEvent(request);
		});
	};

	replaceNamespacedPod: CoreV1Api["replaceNamespacedPod"] = async (request) => {
		return await this.handle("update", "pods", undefined, request, async () => {
			return await this.delegate.replaceNamespacedPod(request);
		});
	};

	replaceNamespacedPodStatus: CoreV1Api["replaceNamespacedPodStatus"] = async (request) => {
		return await this.handle("update", "pods", "status", request, async () => {
			return await this.delegate.replaceNamespacedPodStatus(request);
		});
	};

	replaceNamespacedService: CoreV1Api["replaceNamespacedService"] = async (request) => {
		return await this.handle("update", "services", undefined, request, async () => {
			return await this.delegate.replaceNamespacedService(request);
		});
	};

	replaceNamespace: CoreV1Api["replaceNamespace"] = async (request) => {
		return await this.handle("update", "namespaces", undefined, request, async () => {
			return await this.delegate.replaceNamespace(request);
		});
	};

	replaceNode: CoreV1Api["replaceNode"] = async (request) => {
		return await this.handle("update", "nodes", undefined, request, async () => {
			return await this.delegate.replaceNode(request);
		});
	};
}

class RecordingDiscoveryV1Api implements DiscoveryV1Api {
	constructor(
		private readonly delegate: DiscoveryV1Api,
		private readonly handle: ClientActionHandler,
	) {}

	createNamespacedEndpointSlice: DiscoveryV1Api["createNamespacedEndpointSlice"] = async (
		request,
	) => {
		return await this.handle("create", "endpointslices", undefined, request, async () => {
			return await this.delegate.createNamespacedEndpointSlice(request);
		});
	};

	deleteNamespacedEndpointSlice: DiscoveryV1Api["deleteNamespacedEndpointSlice"] = async (
		request,
	) => {
		return await this.handle("delete", "endpointslices", undefined, request, async () => {
			return await this.delegate.deleteNamespacedEndpointSlice(request);
		});
	};

	listEndpointSliceForAllNamespaces: DiscoveryV1Api["listEndpointSliceForAllNamespaces"] = async (
		request,
	) => {
		return await this.handle("list", "endpointslices", undefined, request, async () => {
			return await this.delegate.listEndpointSliceForAllNamespaces(request);
		});
	};

	listNamespacedEndpointSlice: DiscoveryV1Api["listNamespacedEndpointSlice"] = async (request) => {
		return await this.handle("list", "endpointslices", undefined, request, async () => {
			return await this.delegate.listNamespacedEndpointSlice(request);
		});
	};

	readNamespacedEndpointSlice: DiscoveryV1Api["readNamespacedEndpointSlice"] = async (request) => {
		return await this.handle("get", "endpointslices", undefined, request, async () => {
			return await this.delegate.readNamespacedEndpointSlice(request);
		});
	};

	replaceNamespacedEndpointSlice: DiscoveryV1Api["replaceNamespacedEndpointSlice"] = async (
		request,
	) => {
		return await this.handle("update", "endpointslices", undefined, request, async () => {
			return await this.delegate.replaceNamespacedEndpointSlice(request);
		});
	};
}
