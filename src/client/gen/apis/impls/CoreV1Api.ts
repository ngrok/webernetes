import { Cluster } from "../../../../cluster";
import { NamespaceStore, NodeStore, PodStore } from "../../../../cluster/storage";
import { Store } from "../../../../cluster/storage/store";
import { NotFound } from "../../../errors";
import { V1Namespace, V1PodList, V1Status } from "../../models";
import type { V1Node } from "../../models/V1Node";
import type { V1Pod } from "../../models/V1Pod";
import type {
	CoreV1ApiCreateNamespacedPodRequest,
	CoreV1ApiCreateNamespaceRequest,
	CoreV1ApiCreateNodeRequest,
	CoreV1ApiDeleteNamespacedPodRequest,
	CoreV1ApiDeleteNamespaceRequest,
	CoreV1Api as CoreV1ApiInterface,
	CoreV1ApiListNamespacedPodRequest,
	CoreV1ApiReadNamespacedPodRequest,
	CoreV1ApiReplaceNamespacedPodRequest,
} from "../types/CoreV1Api";
import { rethrowApiErrors } from "./errors";

function parseLabelSelector(selector?: string): Record<string, string> {
	if (!selector) {
		return {};
	}

	const result: Record<string, string> = {};
	for (const pair of selector.split(",")) {
		const [key, value] = pair.split("=");
		if (key && value) {
			result[key.trim()] = value.trim();
		}
	}

	return result;
}

function labelsMatch(labels: Record<string, string>, selector: Record<string, string>): boolean {
	for (const [key, value] of Object.entries(selector)) {
		if (labels[key] !== value) {
			return false;
		}
	}

	return true;
}

export class CoreV1Api implements CoreV1ApiInterface {
	private readonly namespaces: Store<V1Namespace>;
	private readonly nodes: Store<V1Node>;
	private readonly pods: Store<V1Pod>;

	public constructor(cluster: Cluster) {
		this.namespaces = new NamespaceStore(cluster.etcd);
		this.nodes = new NodeStore(cluster.etcd);
		this.pods = new PodStore(cluster.etcd);
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
			const pods = (await this.pods.list(request.namespace)).filter((pod) =>
				labelsMatch(pod.metadata?.labels ?? {}, selector),
			);
			return {
				metadata: {
					resourceVersion: "",
				},
				items: pods,
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

	public async readNamespacedPod(request: CoreV1ApiReadNamespacedPodRequest): Promise<V1Pod> {
		return await rethrowApiErrors(async () => {
			const pod = await this.pods.get(request.name, request.namespace);
			if (!pod) {
				throw new NotFound(`Pod "${request.name}" not found`);
			}

			return pod;
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

	public async replaceNamespacedPod(request: CoreV1ApiReplaceNamespacedPodRequest): Promise<V1Pod> {
		return await rethrowApiErrors(async () => {
			request.body.metadata ??= {};
			request.body.metadata.name = request.name;
			request.body.metadata.namespace ??= request.namespace;
			return await this.pods.update(request.name, request.body);
		});
	}
}
