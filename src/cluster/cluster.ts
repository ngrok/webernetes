import { Clock } from "../clock";
import { Etcd } from "./etcd";
import { NamespaceStore } from "./storage";

export class Cluster {
	readonly clock: Clock;
	readonly etcd: Etcd;

	public constructor() {
		this.clock = new Clock();
		this.etcd = new Etcd(this.clock);
	}

	public async init() {
		const namespaces = new NamespaceStore(this.etcd);
		await namespaces.create({ metadata: { name: "default" } });
	}
}
