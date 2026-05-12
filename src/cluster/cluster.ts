import { Clock } from "../clock";
import { Etcd } from "./etcd";
import * as k8s from "../client";
import { Server } from "./server";
import { ClusterNetwork, type HttpRequest, type HttpResponse } from "./cni";
import { ImageRegistry, type ExecResult } from "./cri";
import { CoreDNS } from "./images/coredns";
import { BusyBoxImage } from "./images/busybox";
import { HttpEchoImage } from "./images/http-echo";
import { AgnhostImage } from "./images/agnhost";
import { EndpointSliceController } from "./images/endpointslice-controller";
import { PauseImage } from "./images/pause";
import { KubeProxy } from "./images/proxy";
import { Scheduler } from "./images/scheduler";
import { type NodePortRange, ServiceStore } from "./storage";
import { applyResources } from "./apply";

const DEFAULT_NODE_PORT_RANGE: NodePortRange = {
	from: 30000,
	to: 32767,
};
const KUBE_DNS_CLUSTER_IP = "10.96.0.10";

export interface ClusterOptions {
	serviceCIDR?: string;
	nodePortRange?: NodePortRange;
}

class K8sApi {
	readonly corev1: k8s.CoreV1Api;
	constructor(private readonly kubeConfig: k8s.KubeConfig) {
		this.corev1 = this.kubeConfig.makeApiClient(k8s.CoreV1Api);
	}
}

export class Cluster {
	readonly clock: Clock;
	readonly etcd: Etcd;
	readonly kubeConfig: k8s.KubeConfig;
	readonly api: K8sApi;
	readonly servers: Server[];
	readonly network: ClusterNetwork;
	readonly imageRegistry: ImageRegistry;
	readonly serviceCIDR: string | undefined;
	readonly nodePortRange: NodePortRange;
	readonly dnsServiceIp = KUBE_DNS_CLUSTER_IP;

	public constructor(options: ClusterOptions = {}) {
		this.clock = new Clock();
		this.etcd = new Etcd(this.clock);
		this.serviceCIDR = options.serviceCIDR;
		this.nodePortRange = options.nodePortRange ?? DEFAULT_NODE_PORT_RANGE;
		this.kubeConfig = new k8s.KubeConfig(this);
		this.api = new K8sApi(this.kubeConfig);
		this.network = new ClusterNetwork();

		this.imageRegistry = new ImageRegistry();
		this.imageRegistry.register("registry.k8s.io/pause:3.10", new PauseImage());
		this.imageRegistry.register("busybox:1.36", new BusyBoxImage());
		this.imageRegistry.register("hashicorp/http-echo:1.0", new HttpEchoImage());
		this.imageRegistry.register("registry.k8s.io/e2e-test-images/agnhost:2.40", new AgnhostImage());

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
		this.imageRegistry.register(
			"k8s-web-simulator/coredns:latest",
			new CoreDNS({
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
		await this.api.corev1.createNamespace({
			body: { metadata: { name: "default" } },
		});

		// Create a kube-system namespace for control plane pods.
		await this.api.corev1.createNamespace({
			body: { metadata: { name: "kube-system" } },
		});

		// Seed the initial servers.
		for (const server of this.servers) {
			await this.api.corev1.createNode({
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

		// kube-dns requires a ClusterIP to be set so we have an IP we can use in
		// each pod's DNS config.
		await this.api.corev1.createNamespacedService({
			namespace: "kube-system",
			body: {
				metadata: {
					name: "kube-dns",
					namespace: "kube-system",
					labels: {
						"k8s-app": "kube-dns",
					},
				},
				spec: {
					type: "ClusterIP",
					clusterIP: this.dnsServiceIp,
					selector: {
						"k8s-app": "kube-dns",
					},
					ports: [{ name: "dns", port: 53, targetPort: 53, protocol: "UDP" }],
				},
			},
		});
		await this.createControlPlanePod(
			"coredns",
			"k8s-web-simulator/coredns:latest",
			{
				"k8s-app": "kube-dns",
			},
			[{ containerPort: 53 }],
		);
	}

	public async fetchNodePort(nodePort: number, request: HttpRequest = {}): Promise<HttpResponse> {
		return await this.network.fetchNodePort(nodePort, request);
	}

	public async exec(
		namespace: string,
		podName: string,
		containerName: string | undefined,
		argv: string[],
	): Promise<ExecResult> {
		const pod = await this.api.corev1.readNamespacedPod({ namespace, name: podName });
		const nodeName = pod.spec?.nodeName;
		if (!nodeName) {
			throw new Error(`pod ${namespace}/${podName} is not scheduled`);
		}
		const server = this.servers.find((candidate) => candidate.name === nodeName);
		if (!server) {
			throw new Error(`node ${nodeName} not found`);
		}
		return await server.kubelet.exec(namespace, podName, containerName, argv);
	}

	// Mimics kubectl's client-side apply for object literals. This intentionally
	// leaves out less common flags such as --overwrite, --field-manager,
	// --server-side, and alpha --prune support until tests or callers need them.
	public async apply<T extends k8s.KubernetesObject>(resources: T[]): Promise<T[]> {
		return await applyResources(this, resources);
	}

	public close() {
		for (const server of this.servers) {
			server.kubelet.close();
		}
		this.etcd.close();
		this.clock.clear();
	}

	private async createControlPlanePod(
		name: string,
		image: string,
		labels: Record<string, string> = {},
		ports: k8s.V1ContainerPort[] = [],
	): Promise<void> {
		await this.api.corev1.createNamespacedPod({
			namespace: "kube-system",
			body: {
				metadata: {
					name,
					namespace: "kube-system",
					labels: {
						component: name,
						tier: "control-plane",
						...labels,
					},
				},
				spec: {
					nodeName: this.servers[0].name,
					containers: [{ name, image, ports }],
				},
			},
		});
	}
}
