import { Clock } from "../clock";
import { Etcd } from "./etcd";
import * as k8s from "../client";
import { Server } from "./server";
import { ClusterNetwork, type HttpRequest, type HttpResponse } from "./cni";
import { ImageRegistry } from "./cri";
import { HttpEchoImage } from "./images/http-echo";
import { EndpointSliceController } from "./images/endpointslice-controller";
import { PauseImage } from "./images/pause";
import { KubeProxy } from "./images/proxy";
import { Scheduler } from "./images/scheduler";
import { type NodePortRange, ServiceStore } from "./storage";

const DEFAULT_NODE_PORT_RANGE: NodePortRange = {
	from: 30000,
	to: 32767,
};

export interface ClusterOptions {
	serviceCIDR?: string;
	nodePortRange?: NodePortRange;
}

export class Cluster {
	readonly clock: Clock;
	readonly etcd: Etcd;
	readonly kubeConfig: k8s.KubeConfig;
	readonly api: k8s.CoreV1Api;
	readonly servers: Server[];
	readonly network: ClusterNetwork;
	readonly imageRegistry: ImageRegistry;
	readonly serviceCIDR: string | undefined;
	readonly nodePortRange: NodePortRange;

	public constructor(options: ClusterOptions = {}) {
		this.clock = new Clock();
		this.etcd = new Etcd(this.clock);
		this.serviceCIDR = options.serviceCIDR;
		this.nodePortRange = options.nodePortRange ?? DEFAULT_NODE_PORT_RANGE;
		this.kubeConfig = new k8s.KubeConfig(this);
		this.api = this.kubeConfig.makeApiClient(k8s.CoreV1Api);
		this.network = new ClusterNetwork({
			podCIDR: "10.0.0.0/16",
		});

		this.imageRegistry = new ImageRegistry();
		this.imageRegistry.register("rancher/pause:3.6", new PauseImage());
		for (const ref of [
			"hashicorp/http-echo",
			"hashicorp/http-echo:latest",
			"hashicorp/http-echo:1.0",
		]) {
			this.imageRegistry.register(ref, new HttpEchoImage());
		}

		this.servers = [
			new Server(this, { name: "node-1", podCIDR: "10.0.0.0/24" }),
			new Server(this, { name: "node-2", podCIDR: "10.0.1.0/24" }),
			new Server(this, { name: "node-3", podCIDR: "10.0.2.0/24" }),
		];

		this.imageRegistry.register(
			"k8s-web-simulator/kube-scheduler:latest",
			new Scheduler(
				this.kubeConfig,
				this.servers.map((server) => server.name),
			),
		);
		this.imageRegistry.register(
			"k8s-web-simulator/kube-proxy:latest",
			new KubeProxy({
				kubeConfig: this.kubeConfig,
				network: this.network,
			}),
		);
		this.imageRegistry.register(
			"k8s-web-simulator/endpointslice-controller:latest",
			new EndpointSliceController({
				kubeConfig: this.kubeConfig,
			}),
		);
	}

	public async init() {
		await ServiceStore.initialize(this.etcd, {
			serviceCIDR: this.serviceCIDR,
			nodePortRange: this.nodePortRange,
		});

		// The default namespace should exist by default (ha).
		await this.api.createNamespace({
			body: { metadata: { name: "default" } },
		});

		// Create a kube-system namespace for control plane pods.
		await this.api.createNamespace({
			body: { metadata: { name: "kube-system" } },
		});

		// Seed the initial servers.
		for (const server of this.servers) {
			await this.api.createNode({
				body: {
					metadata: { name: server.name },
					spec: {
						podCIDR: server.podCIDR,
					},
				},
			});
		}

		for (const server of this.servers) {
			await server.boot();
		}

		await this.createControlPlanePod("kube-scheduler", "k8s-web-simulator/kube-scheduler:latest");
		await this.createControlPlanePod(
			"endpointslice-controller",
			"k8s-web-simulator/endpointslice-controller:latest",
		);
		await this.createControlPlanePod("kube-proxy", "k8s-web-simulator/kube-proxy:latest");
	}

	public async fetchNodePort(nodePort: number, request: HttpRequest = {}): Promise<HttpResponse> {
		return await this.network.fetchNodePort(nodePort, request);
	}

	public close() {
		for (const server of this.servers) {
			server.kubelet.close();
		}
		this.etcd.close();
		this.clock.clear();
	}

	private async createControlPlanePod(name: string, image: string): Promise<void> {
		await this.api.createNamespacedPod({
			namespace: "kube-system",
			body: {
				metadata: {
					name,
					namespace: "kube-system",
					labels: {
						component: name,
						tier: "control-plane",
					},
				},
				spec: {
					nodeName: this.servers[0].name,
					containers: [{ name, image }],
				},
			},
		});
	}
}
