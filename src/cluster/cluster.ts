import { Clock } from "../clock";
import { Etcd } from "./etcd";

export class Cluster {
	readonly clock: Clock;
	readonly etcd: Etcd;

	public constructor() {
		this.clock = new Clock();
		this.etcd = new Etcd(this.clock);
	}
}
