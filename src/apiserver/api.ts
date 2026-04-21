import type { Clock } from "../clock";
import { Etcd } from "../etcd";
import { NodeStore } from "./storage/nodes";
export { Event } from "./storage/storage";
import { PodStore } from "./storage/pods";

export class Api {
	public readonly v1: CoreV1;

	constructor(clock: Clock) {
		const etcd = new Etcd(clock);

		this.v1 = new CoreV1(etcd);
	}
}

class CoreV1 {
	public readonly pods: PodStore;
	public readonly nodes: NodeStore;

	constructor(etcd: Etcd) {
		this.pods = new PodStore(etcd);
		this.nodes = new NodeStore(etcd);
	}
}
