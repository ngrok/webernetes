import { Cluster } from "../../../../cluster";
import { PodStore } from "../../../../storage/pods";
import type { V1Pod } from "../../models/V1Pod";
import type {
	CoreV1ApiCreateNamespacedPodRequest,
	CoreV1Api as CoreV1ApiInterface,
} from "../types/CoreV1Api";

export class CoreV1Api implements CoreV1ApiInterface {
	private readonly storage: PodStore;

	public constructor(cluster: Cluster) {
		this.storage = new PodStore(cluster.etcd);
	}

	public async createNamespacedPod(
		param: CoreV1ApiCreateNamespacedPodRequest,
		_options?: unknown,
	): Promise<V1Pod> {
		return await this.storage.create(param.body);
	}
}
