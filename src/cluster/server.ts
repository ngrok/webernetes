import { Cluster } from "./cluster";
import { Kubelet } from "./kubelet";

export interface ServerOptions {
	name: string;
	podCIDR: string;
}

export class Server {
	name: string;
	podCIDR: string;
	cluster: Cluster;
	kubelet: Kubelet;

	public constructor(cluster: Cluster, options: ServerOptions) {
		this.name = options.name;
		this.podCIDR = options.podCIDR;
		this.cluster = cluster;
		this.kubelet = new Kubelet(this);
	}
}
