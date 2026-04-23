import { Cluster } from "../../../../cluster";
import { NamespaceStore, PodStore } from "../../../../cluster/storage";
import { Store } from "../../../../cluster/storage/store";
import { V1Namespace, V1PodList, V1Status } from "../../models";
import type { V1Pod } from "../../models/V1Pod";
import type {
	CoreV1ApiCreateNamespacedPodRequest,
	CoreV1ApiCreateNamespaceRequest,
	CoreV1ApiDeleteNamespaceRequest,
	CoreV1Api as CoreV1ApiInterface,
	CoreV1ApiListNamespacedPodRequest,
} from "../types/CoreV1Api";
import { rethrowApiErrors } from "./errors";

export class CoreV1Api implements CoreV1ApiInterface {
	private readonly namespaces: Store<V1Namespace>;
	private readonly pods: Store<V1Pod>;

	public constructor(cluster: Cluster) {
		this.namespaces = new NamespaceStore(cluster.etcd);
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
			const pods = await this.pods.list(request.namespace);
			return {
				metadata: {
					resourceVersion: "",
				},
				items: pods,
			};
		});
	}

	public async createNamespacedPod(
		param: CoreV1ApiCreateNamespacedPodRequest,
		_options?: unknown,
	): Promise<V1Pod> {
		return await rethrowApiErrors(async () => {
			return await this.pods.create(param.body);
		});
	}
}
