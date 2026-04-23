import { V1Pod } from "../client";
import type { Etcd } from "../cluster/etcd";
import { Store } from "./storage";

export class PodStore extends Store<V1Pod> {
	constructor(etcd: Etcd) {
		super(etcd, {
			defaultQualifiedResource: "pods",
			singularQualifiedResource: "pod",
			namespaced: true,
		});
	}

	protected override validateCreate(pod: V1Pod): void {
		if (!pod.metadata?.name) {
			throw new Error("Pod name is required");
		}
	}

	protected override validateUpdate(pod: V1Pod): void {
		if (!pod.metadata?.name) {
			throw new Error("Pod name is required");
		}
	}
}
