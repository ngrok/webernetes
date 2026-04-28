import { Cluster } from "./cluster";
import { Runtime } from "./cri";
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
	runtime: Runtime;

	public constructor(cluster: Cluster, options: ServerOptions) {
		this.name = options.name;
		this.podCIDR = options.podCIDR;
		this.cluster = cluster;
		this.runtime = new Runtime({
			clock: cluster.clock,
			kubeConfig: cluster.kubeConfig,
			network: cluster.network,
			imageRegistry: cluster.imageRegistry,
			idPrefix: `${this.name}-`,
		});
		this.kubelet = new Kubelet(this);
	}

	async boot() {
		await this.kubelet.start();
	}
}
