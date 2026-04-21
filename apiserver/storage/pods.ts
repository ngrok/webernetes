import type { Etcd } from "../../etcd";
import type { Pod } from "../../types/core/v1/types";
import { Store } from "./storage";

export class PodStore extends Store<Pod> {
	constructor(etcd: Etcd) {
		super(etcd, {
			defaultQualifiedResource: "pods",
			singularQualifiedResource: "pod",
			namespaced: true,
		});
	}

	protected override validateCreate(pod: Pod): void {
		if (!pod.metadata?.name) {
			throw new Error("Pod name is required");
		}
	}

	protected override validateUpdate(pod: Pod): void {
		if (!pod.metadata?.name) {
			throw new Error("Pod name is required");
		}
	}
}
