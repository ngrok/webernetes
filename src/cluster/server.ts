import { Cluster } from "./cluster";
import { Runtime } from "./cri";
import { Kubelet } from "./kubelet";
import * as context from "../go/context";

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
	private ctx: context.Context | undefined;
	private cancelContext: context.CancelFunc | undefined;
	private closePromise: Promise<void> | undefined;

	public constructor(cluster: Cluster, options: ServerOptions) {
		this.name = options.name;
		this.podCIDR = options.podCIDR;
		this.cluster = cluster;
		this.runtime = new Runtime({
			clock: cluster.clock,
			kubeConfig: cluster.kubeConfig,
			network: cluster.network,
			podCIDR: this.podCIDR,
			imageRegistry: cluster.imageRegistry,
			idPrefix: `${this.name}-`,
		});
		this.kubelet = new Kubelet(this);
	}

	async boot(ctx: context.Context) {
		[this.ctx, this.cancelContext] = context.withCancel(ctx);
		await this.kubelet.start(this.ctx);
	}

	close(): Promise<void> {
		if (!this.closePromise) {
			this.cancelContext?.();
			this.closePromise = (async () => {
				await this.kubelet.close();
				await this.runtime.close();
			})();
		}
		return this.closePromise;
	}
}
