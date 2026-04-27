import { Clock } from "../clock";
import { Etcd } from "./etcd";
import * as k8s from "../client";
import { Server } from "./server";
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
	readonly serviceCIDR: string | undefined;
	readonly nodePortRange: NodePortRange;

	public constructor(options: ClusterOptions = {}) {
		this.clock = new Clock();
		this.etcd = new Etcd(this.clock);
		this.serviceCIDR = options.serviceCIDR;
		this.nodePortRange = options.nodePortRange ?? DEFAULT_NODE_PORT_RANGE;
		this.kubeConfig = new k8s.KubeConfig(this);
		this.api = this.kubeConfig.makeApiClient(k8s.CoreV1Api);
		this.servers = [
			new Server(this, { name: "node-1", podCIDR: "10.0.0.0/24" }),
			new Server(this, { name: "node-2", podCIDR: "10.0.1.0/24" }),
			new Server(this, { name: "node-3", podCIDR: "10.0.2.0/24" }),
		];
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
	}

	public close() {
		this.etcd.close();
		this.clock.clear();
	}
}
