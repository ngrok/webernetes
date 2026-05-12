import { V1Pod } from "../../client";
import { Etcd } from "../etcd";
import { Store } from "./store";

export class PodStore extends Store<V1Pod> {
	constructor(etcd: Etcd) {
		super(etcd, {
			apiVersion: "v1",
			defaultQualifiedResource: "pods",
			kind: "Pod",
			singularQualifiedResource: "pod",
			namespaced: true,
		});
	}

	protected async validateCreate(pod: V1Pod): Promise<void> {
		if (!pod.metadata?.name) {
			throw new Error("Pod name is required");
		}

		if (!pod.spec) {
			throw new Error("Pod spec is required");
		}
	}

	protected async validateUpdate(pod: V1Pod): Promise<void> {
		await this.validateCreate(pod);
	}
}
