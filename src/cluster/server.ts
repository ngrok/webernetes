import { Cluster } from "./cluster";
import type { ClusterNetwork } from "./cni";
import {
	InProcessRuntimeService,
	type ImageManagerService,
	type RuntimeDiagnostics,
	type RuntimeService,
} from "./cri";
import { EventRecorderImpl } from "./events";
import { Kubelet, newMainKubelet, NoopPodStartupSLIObserver } from "./kubelet";
import type { Runtime as KubeletRuntime } from "./kubelet/container";
import type { KubeletConfiguration } from "./kubelet/apis/config";
import { PodListWatchClient } from "./kubelet/config";
import * as context from "../go/context";
import type { V1Node } from "../client";

export interface ServerOptions {
	name: string;
	podCIDR: string;
	ipAddresses: string[];
	kubeletConfiguration: KubeletConfiguration;
}

export class Server {
	name: string;
	podCIDR: string;
	ipAddresses: string[];
	cluster: Cluster;
	node: V1Node;
	kubelet: Kubelet;
	runtime: InProcessRuntimeService;
	runtimeService: RuntimeService;
	imageService: ImageManagerService;
	containerRuntime!: KubeletRuntime;
	runtimeDiagnostics: RuntimeDiagnostics;
	network: ClusterNetwork;
	private ctx: context.Context | undefined;
	private cancelContext: context.CancelFunc | undefined;
	private closePromise: Promise<void> | undefined;

	public constructor(cluster: Cluster, options: ServerOptions) {
		this.name = options.name;
		this.podCIDR = options.podCIDR;
		this.ipAddresses = [...options.ipAddresses];
		this.cluster = cluster;
		this.node = {
			metadata: { name: this.name },
			spec: {
				podCIDR: this.podCIDR,
			},
			status: {
				addresses: [
					...this.ipAddresses.map((address) => ({ type: "InternalIP", address })),
					{ type: "Hostname", address: this.name },
				],
			},
		};
		this.runtime = new InProcessRuntimeService({
			ctx: cluster.ctx,
			clock: cluster.clock,
			kubeConfig: cluster.kubeConfig,
			network: cluster.network,
			podCIDR: this.podCIDR,
			imageRegistry: cluster.imageRegistry,
			idPrefix: `${this.name}-`,
		});
		this.runtimeService = this.runtime;
		this.imageService = this.runtime;
		this.runtimeDiagnostics = this.runtime;
		this.network = cluster.network;
		this.kubelet = newMainKubelet(
			cluster.ctx,
			options.kubeletConfiguration,
			{
				kubeClient: cluster.api,
				podListWatchClient: new PodListWatchClient(cluster.kubeConfig),
				recorder: new EventRecorderImpl({
					api: cluster.api.corev1,
					clock: cluster.clock,
					component: "kubelet",
					host: this.name,
				}),
				podStartupLatencyTracker: new NoopPodStartupSLIObserver(),
				remoteRuntimeService: this.runtimeService,
				remoteImageService: this.imageService,
				network: this.network,
				clock: cluster.clock,
				nodeIPs: this.ipAddresses,
				node: this.node,
			},
			this.name,
			this.name,
		);
		this.kubelet.runtimeState.setNetworkState(undefined);
		this.containerRuntime = this.kubelet.containerRuntime;
	}

	async boot(ctx: context.Context) {
		[this.ctx, this.cancelContext] = context.withCancel(ctx);
		await this.kubelet.run();
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
