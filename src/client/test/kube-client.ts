import { KubeConfig } from "../config";
import {
	CoreV1Api as CoreV1ApiImpl,
	DiscoveryV1Api as DiscoveryV1ApiImpl,
} from "../gen/apis/impls";
import type { CoreV1Api, DiscoveryV1Api } from "../gen/apis/types";
import type {
	CoreV1Event,
	CoreV1EventList,
	V1Binding,
	V1EndpointSlice,
	V1EndpointSliceList,
	V1Namespace,
	V1NamespaceList,
	V1Node,
	V1NodeList,
	V1Pod,
	V1PodList,
	V1Service,
	V1ServiceList,
	V1Status,
} from "../gen/models";
import type { KubeClient } from "../types";
import type { MaybePromise } from "../../promise";

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

type ClientReactionObjects = {
	create: {
		events: CoreV1Event;
		namespaces: V1Namespace;
		nodes: V1Node;
		pods: V1Pod | V1Binding;
		services: V1Service;
		endpointslices: V1EndpointSlice;
	};
	delete: {
		events: V1Status;
		namespaces: V1Status;
		nodes: V1Status;
		pods: V1Pod;
		services: V1Service;
		endpointslices: V1Status;
	};
	get: {
		events: CoreV1Event;
		namespaces: V1Namespace;
		nodes: V1Node;
		pods: V1Pod;
		services: V1Service;
		endpointslices: V1EndpointSlice;
	};
	list: {
		events: CoreV1EventList;
		namespaces: V1NamespaceList;
		nodes: V1NodeList;
		pods: V1PodList;
		services: V1ServiceList;
		endpointslices: V1EndpointSliceList;
	};
	patch: {
		namespaces: V1Namespace;
		nodes: V1Node;
		pods: V1Pod;
		services: V1Service;
	};
	update: {
		events: CoreV1Event;
		namespaces: V1Namespace;
		nodes: V1Node;
		pods: V1Pod;
		services: V1Service;
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
	readonly corev1: CoreV1Api;
	readonly discoveryv1: DiscoveryV1Api;
	private readonly actionList: ClientAction[] = [];
	private readonly reactors: {
		verb: string;
		resource: string;
		reactor: ClientReactor<unknown, unknown>;
	}[] = [];

	constructor(readonly kubeConfig: KubeConfig) {
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

export function clientAction(verb: string, resource: string, subresource?: string): ClientAction {
	return subresource === undefined ? { verb, resource } : { verb, resource, subresource };
}

function matchesReactor(pattern: string, value: string): boolean {
	return pattern === "*" || pattern === value;
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
