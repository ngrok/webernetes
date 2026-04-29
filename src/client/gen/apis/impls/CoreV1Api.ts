import { Cluster } from "../../../../cluster";
import { NamespaceStore, NodeStore, PodStore, ServiceStore } from "../../../../cluster/storage";
import { Store } from "../../../../cluster/storage/store";
import { NotFound } from "../../../errors";
import { filterByLabels, parseLabelSelector } from "../../../labels";
import { V1Namespace, V1NodeList, V1PodList, V1ServiceList, V1Status } from "../../models";
import type { V1Node } from "../../models/V1Node";
import type { V1Pod } from "../../models/V1Pod";
import type { V1Service } from "../../models/V1Service";
import type {
	CoreV1ApiCreateNamespacedPodRequest,
	CoreV1ApiCreateNamespacedServiceRequest,
	CoreV1ApiCreateNamespaceRequest,
	CoreV1ApiCreateNodeRequest,
	CoreV1ApiDeleteNamespacedPodRequest,
	CoreV1ApiDeleteNamespacedServiceRequest,
	CoreV1ApiDeleteNamespaceRequest,
	CoreV1Api as CoreV1ApiInterface,
	CoreV1ApiListNodeRequest,
	CoreV1ApiListPodForAllNamespacesRequest,
	CoreV1ApiListNamespacedPodRequest,
	CoreV1ApiListNamespacedServiceRequest,
	CoreV1ApiListServiceForAllNamespacesRequest,
	CoreV1ApiReadNamespacedPodRequest,
	CoreV1ApiReadNamespacedServiceRequest,
	CoreV1ApiReplaceNamespacedPodRequest,
	CoreV1ApiReplaceNamespacedPodStatusRequest,
	CoreV1ApiReplaceNamespacedServiceRequest,
} from "../types/CoreV1Api";
import { rethrowApiErrors } from "./errors";

export class CoreV1Api implements CoreV1ApiInterface {
	private readonly namespaces: Store<V1Namespace>;
	private readonly nodes: Store<V1Node>;
	private readonly pods: Store<V1Pod>;
	private readonly services: Store<V1Service>;

	public constructor(cluster: Cluster) {
		this.namespaces = new NamespaceStore(cluster.etcd);
		this.nodes = new NodeStore(cluster.etcd);
		this.pods = new PodStore(cluster.etcd);
		this.services = new ServiceStore(cluster.etcd, {
			serviceCIDR: cluster.serviceCIDR,
			nodePortRange: cluster.nodePortRange,
		});
	}

	async createNamespace(request: CoreV1ApiCreateNamespaceRequest): Promise<V1Namespace> {
		return await rethrowApiErrors(async () => {
			return await this.namespaces.create(request.body);
		});
	}

	async deleteNamespace(request: CoreV1ApiDeleteNamespaceRequest): Promise<V1Status> {
		return await rethrowApiErrors(async () => {
			await this.namespaces.delete(request.name);
			return {
				status: "Success",
			};
		});
	}

	public async listNamespacedPod(request: CoreV1ApiListNamespacedPodRequest): Promise<V1PodList> {
		return await rethrowApiErrors(async () => {
			const selector = parseLabelSelector(request.labelSelector);
			return {
				metadata: {
					resourceVersion: "",
				},
				items: filterByLabels(await this.pods.list(request.namespace), selector),
			};
		});
	}

	public async listNamespacedService(
		request: CoreV1ApiListNamespacedServiceRequest,
	): Promise<V1ServiceList> {
		return await rethrowApiErrors(async () => {
			const selector = parseLabelSelector(request.labelSelector);
			return {
				metadata: {
					resourceVersion: "",
				},
				items: filterByLabels(await this.services.list(request.namespace), selector),
			};
		});
	}

	public async listPodForAllNamespaces(
		request: CoreV1ApiListPodForAllNamespacesRequest = {},
	): Promise<V1PodList> {
		return await rethrowApiErrors(async () => {
			const selector = parseLabelSelector(request.labelSelector);
			return {
				metadata: {
					resourceVersion: "",
				},
				items: filterByLabels(await this.pods.list(), selector),
			};
		});
	}

	public async listServiceForAllNamespaces(
		request: CoreV1ApiListServiceForAllNamespacesRequest = {},
	): Promise<V1ServiceList> {
		return await rethrowApiErrors(async () => {
			const selector = parseLabelSelector(request.labelSelector);
			return {
				metadata: {
					resourceVersion: "",
				},
				items: filterByLabels(await this.services.list(), selector),
			};
		});
	}

	public async listNode(request: CoreV1ApiListNodeRequest = {}): Promise<V1NodeList> {
		return await rethrowApiErrors(async () => {
			const selector = parseLabelSelector(request.labelSelector);
			return {
				metadata: {
					resourceVersion: "",
				},
				items: filterByLabels(await this.nodes.list(), selector),
			};
		});
	}

	public async createNode(request: CoreV1ApiCreateNodeRequest): Promise<V1Node> {
		return await rethrowApiErrors(async () => {
			return await this.nodes.create(request.body);
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
			const pod = await this.pods.get(request.name, request.namespace);
			if (!pod) {
				throw new NotFound(`Pod "${request.name}" not found`);
			}

			await this.pods.delete(request.name, request.namespace);
			return pod;
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

			await this.services.delete(request.name, request.namespace);
			return service;
		});
	}

	public async replaceNamespacedPod(request: CoreV1ApiReplaceNamespacedPodRequest): Promise<V1Pod> {
		return await rethrowApiErrors(async () => {
			request.body.metadata ??= {};
			request.body.metadata.name = request.name;
			request.body.metadata.namespace ??= request.namespace;
			return await this.pods.update(request.name, request.body);
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
}
