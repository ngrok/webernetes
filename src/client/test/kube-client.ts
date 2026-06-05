import { KubeConfig } from "../config";
import {
	CoreV1Api as CoreV1ApiImpl,
	DiscoveryV1Api as DiscoveryV1ApiImpl,
} from "../gen/apis/impls";
import type { CoreV1Api, DiscoveryV1Api } from "../gen/apis/types";
import type { KubeClient } from "../types";

export type ClientAction = {
	verb: string;
	resource: string;
	subresource?: string;
};

// TODO(samwho): implement the ability to mock responses
export class TestKubeClient implements KubeClient {
	readonly corev1: CoreV1Api;
	readonly discoveryv1: DiscoveryV1Api;
	private readonly actionList: ClientAction[] = [];

	constructor(readonly kubeConfig: KubeConfig) {
		this.corev1 = new RecordingCoreV1Api(kubeConfig.makeApiClient(CoreV1ApiImpl), this.actionList);
		this.discoveryv1 = new RecordingDiscoveryV1Api(
			kubeConfig.makeApiClient(DiscoveryV1ApiImpl),
			this.actionList,
		);
	}

	actions(): ClientAction[] {
		return [...this.actionList];
	}

	clearActions(): void {
		this.actionList.length = 0;
	}
}

export function clientAction(verb: string, resource: string, subresource?: string): ClientAction {
	return subresource === undefined ? { verb, resource } : { verb, resource, subresource };
}

class RecordingCoreV1Api implements CoreV1Api {
	constructor(
		private readonly delegate: CoreV1Api,
		private readonly actions: ClientAction[],
	) {}

	createNamespacedEvent: CoreV1Api["createNamespacedEvent"] = async (request) => {
		this.record("create", "events");
		return await this.delegate.createNamespacedEvent(request);
	};

	createNamespace: CoreV1Api["createNamespace"] = async (request) => {
		this.record("create", "namespaces");
		return await this.delegate.createNamespace(request);
	};

	createNode: CoreV1Api["createNode"] = async (request) => {
		this.record("create", "nodes");
		return await this.delegate.createNode(request);
	};

	createNamespacedPodBinding: CoreV1Api["createNamespacedPodBinding"] = async (request) => {
		this.record("create", "pods", "binding");
		return await this.delegate.createNamespacedPodBinding(request);
	};

	createNamespacedPod: CoreV1Api["createNamespacedPod"] = async (request) => {
		this.record("create", "pods");
		return await this.delegate.createNamespacedPod(request);
	};

	createNamespacedService: CoreV1Api["createNamespacedService"] = async (request) => {
		this.record("create", "services");
		return await this.delegate.createNamespacedService(request);
	};

	deleteNamespacedEvent: CoreV1Api["deleteNamespacedEvent"] = async (request) => {
		this.record("delete", "events");
		return await this.delegate.deleteNamespacedEvent(request);
	};

	deleteNamespacedPod: CoreV1Api["deleteNamespacedPod"] = async (request) => {
		this.record("delete", "pods");
		return await this.delegate.deleteNamespacedPod(request);
	};

	deleteNamespacedService: CoreV1Api["deleteNamespacedService"] = async (request) => {
		this.record("delete", "services");
		return await this.delegate.deleteNamespacedService(request);
	};

	deleteNamespace: CoreV1Api["deleteNamespace"] = async (request) => {
		this.record("delete", "namespaces");
		return await this.delegate.deleteNamespace(request);
	};

	deleteNode: CoreV1Api["deleteNode"] = async (request) => {
		this.record("delete", "nodes");
		return await this.delegate.deleteNode(request);
	};

	listEventForAllNamespaces: CoreV1Api["listEventForAllNamespaces"] = async (request) => {
		this.record("list", "events");
		return await this.delegate.listEventForAllNamespaces(request);
	};

	listNamespace: CoreV1Api["listNamespace"] = async (request) => {
		this.record("list", "namespaces");
		return await this.delegate.listNamespace(request);
	};

	listNode: CoreV1Api["listNode"] = async (request) => {
		this.record("list", "nodes");
		return await this.delegate.listNode(request);
	};

	listNamespacedEvent: CoreV1Api["listNamespacedEvent"] = async (request) => {
		this.record("list", "events");
		return await this.delegate.listNamespacedEvent(request);
	};

	listNamespacedPod: CoreV1Api["listNamespacedPod"] = async (request) => {
		this.record("list", "pods");
		return await this.delegate.listNamespacedPod(request);
	};

	listNamespacedService: CoreV1Api["listNamespacedService"] = async (request) => {
		this.record("list", "services");
		return await this.delegate.listNamespacedService(request);
	};

	listPodForAllNamespaces: CoreV1Api["listPodForAllNamespaces"] = async (request) => {
		this.record("list", "pods");
		return await this.delegate.listPodForAllNamespaces(request);
	};

	listServiceForAllNamespaces: CoreV1Api["listServiceForAllNamespaces"] = async (request) => {
		this.record("list", "services");
		return await this.delegate.listServiceForAllNamespaces(request);
	};

	readNamespacedEvent: CoreV1Api["readNamespacedEvent"] = async (request) => {
		this.record("get", "events");
		return await this.delegate.readNamespacedEvent(request);
	};

	readNamespacedPod: CoreV1Api["readNamespacedPod"] = async (request) => {
		this.record("get", "pods");
		return await this.delegate.readNamespacedPod(request);
	};

	readNamespacedService: CoreV1Api["readNamespacedService"] = async (request) => {
		this.record("get", "services");
		return await this.delegate.readNamespacedService(request);
	};

	readNamespace: CoreV1Api["readNamespace"] = async (request) => {
		this.record("get", "namespaces");
		return await this.delegate.readNamespace(request);
	};

	readNode: CoreV1Api["readNode"] = async (request) => {
		this.record("get", "nodes");
		return await this.delegate.readNode(request);
	};

	patchNamespace: CoreV1Api["patchNamespace"] = async (request, options) => {
		this.record("patch", "namespaces");
		return await this.delegate.patchNamespace(request, options);
	};

	patchNode: CoreV1Api["patchNode"] = async (request, options) => {
		this.record("patch", "nodes");
		return await this.delegate.patchNode(request, options);
	};

	patchNamespacedPod: CoreV1Api["patchNamespacedPod"] = async (request, options) => {
		this.record("patch", "pods");
		return await this.delegate.patchNamespacedPod(request, options);
	};

	patchNamespacedPodStatus: CoreV1Api["patchNamespacedPodStatus"] = async (request, options) => {
		this.record("patch", "pods", "status");
		return await this.delegate.patchNamespacedPodStatus(request, options);
	};

	patchNamespacedService: CoreV1Api["patchNamespacedService"] = async (request, options) => {
		this.record("patch", "services");
		return await this.delegate.patchNamespacedService(request, options);
	};

	replaceNamespacedEvent: CoreV1Api["replaceNamespacedEvent"] = async (request) => {
		this.record("update", "events");
		return await this.delegate.replaceNamespacedEvent(request);
	};

	replaceNamespacedPod: CoreV1Api["replaceNamespacedPod"] = async (request) => {
		this.record("update", "pods");
		return await this.delegate.replaceNamespacedPod(request);
	};

	replaceNamespacedPodStatus: CoreV1Api["replaceNamespacedPodStatus"] = async (request) => {
		this.record("update", "pods", "status");
		return await this.delegate.replaceNamespacedPodStatus(request);
	};

	replaceNamespacedService: CoreV1Api["replaceNamespacedService"] = async (request) => {
		this.record("update", "services");
		return await this.delegate.replaceNamespacedService(request);
	};

	replaceNamespace: CoreV1Api["replaceNamespace"] = async (request) => {
		this.record("update", "namespaces");
		return await this.delegate.replaceNamespace(request);
	};

	replaceNode: CoreV1Api["replaceNode"] = async (request) => {
		this.record("update", "nodes");
		return await this.delegate.replaceNode(request);
	};

	private record(verb: string, resource: string, subresource?: string): void {
		this.actions.push(clientAction(verb, resource, subresource));
	}
}

class RecordingDiscoveryV1Api implements DiscoveryV1Api {
	constructor(
		private readonly delegate: DiscoveryV1Api,
		private readonly actions: ClientAction[],
	) {}

	createNamespacedEndpointSlice: DiscoveryV1Api["createNamespacedEndpointSlice"] = async (
		request,
	) => {
		this.record("create", "endpointslices");
		return await this.delegate.createNamespacedEndpointSlice(request);
	};

	deleteNamespacedEndpointSlice: DiscoveryV1Api["deleteNamespacedEndpointSlice"] = async (
		request,
	) => {
		this.record("delete", "endpointslices");
		return await this.delegate.deleteNamespacedEndpointSlice(request);
	};

	listEndpointSliceForAllNamespaces: DiscoveryV1Api["listEndpointSliceForAllNamespaces"] = async (
		request,
	) => {
		this.record("list", "endpointslices");
		return await this.delegate.listEndpointSliceForAllNamespaces(request);
	};

	listNamespacedEndpointSlice: DiscoveryV1Api["listNamespacedEndpointSlice"] = async (request) => {
		this.record("list", "endpointslices");
		return await this.delegate.listNamespacedEndpointSlice(request);
	};

	readNamespacedEndpointSlice: DiscoveryV1Api["readNamespacedEndpointSlice"] = async (request) => {
		this.record("get", "endpointslices");
		return await this.delegate.readNamespacedEndpointSlice(request);
	};

	replaceNamespacedEndpointSlice: DiscoveryV1Api["replaceNamespacedEndpointSlice"] = async (
		request,
	) => {
		this.record("update", "endpointslices");
		return await this.delegate.replaceNamespacedEndpointSlice(request);
	};

	private record(verb: string, resource: string, subresource?: string): void {
		this.actions.push(clientAction(verb, resource, subresource));
	}
}
