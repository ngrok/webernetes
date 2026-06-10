import { Clock } from "../clock";
import * as context from "../go/context";
import { Etcd } from "./etcd";
import * as k8s from "../client";
import { Server } from "./server";
import * as http from "./cni/http";
import { ClusterNetwork } from "./cni";
import { ImageRegistry, type ExecResult, type ImageConstructor } from "./cri";
import { CoreDNS } from "./images/coredns";
import { BusyBoxImage } from "./images/busybox";
import { HelloWorldImage } from "./images/hello-world";
import { HttpEchoImage } from "./images/http-echo";
import { AgnhostImage } from "./images/agnhost";
import { EndpointSliceController } from "./images/endpointslice-controller";
import { NamespaceController } from "./images/namespace-controller";
import { PauseImage } from "./images/pause";
import { KubeProxy } from "./images/proxy";
import { Scheduler } from "./images/scheduler";
import { type NodePortRange, ServiceStore } from "./storage";
import { applyResources } from "./apply";
import type { KubeletConfiguration } from "./kubelet/apis/config";
import { buildPodFullName } from "./kubelet/container";
import { type LatencyProvider, withLatencyProvider } from "../latency";

const DEFAULT_NODE_PORT_RANGE: NodePortRange = {
	from: 30000,
	to: 32767,
};

export interface ClusterOptions {
	serviceCIDR?: string;
	nodePortRange?: NodePortRange;
	latencyProvider?: LatencyProvider;
}

export class KubeClient implements k8s.KubeClient {
	readonly corev1: k8s.KubeClient["corev1"];
	readonly discoveryv1: k8s.KubeClient["discoveryv1"];
	constructor(readonly kubeConfig: k8s.KubeConfig) {
		this.corev1 = this.kubeConfig.makeApiClient(k8s.CoreV1Api);
		this.discoveryv1 = this.kubeConfig.makeApiClient(k8s.DiscoveryV1Api);
	}
}

export class Cluster {
	readonly clock: Clock;
	readonly etcd: Etcd;
	readonly kubeConfig: k8s.KubeConfig;
	readonly api: KubeClient;
	readonly servers: Server[];
	readonly network: ClusterNetwork;
	readonly imageRegistry: ImageRegistry;
	readonly serviceCIDR: string | undefined;
	readonly nodePortRange: NodePortRange;
	readonly dnsServiceIp = "10.96.0.10";
	readonly ctx: context.Context;
	private readonly cancelContext: context.CancelFunc;
	private closePromise: Promise<void> | undefined;

	public constructor(options: ClusterOptions = {}) {
		this.clock = new Clock();
		const [ctx, cancelContext] = context.withCancel(context.background());
		this.ctx = withLatencyProvider(ctx, options.latencyProvider);
		this.cancelContext = cancelContext;
		this.etcd = new Etcd(this.clock);
		this.serviceCIDR = options.serviceCIDR;
		this.nodePortRange = options.nodePortRange ?? DEFAULT_NODE_PORT_RANGE;
		this.kubeConfig = new k8s.KubeConfig({
			clock: this.clock,
			etcd: this.etcd,
			serviceCIDR: this.serviceCIDR,
			nodePortRange: this.nodePortRange,
			exec: (namespace, podName, containerName, argv) =>
				this.exec(namespace, podName, containerName, argv),
		});
		this.api = new KubeClient(this.kubeConfig);
		this.network = new ClusterNetwork({ clusterDNS: [this.dnsServiceIp] });

		this.imageRegistry = new ImageRegistry();
		this.imageRegistry.register(PauseImage);
		this.imageRegistry.register(BusyBoxImage);
		this.imageRegistry.register(HelloWorldImage);
		this.imageRegistry.register(HttpEchoImage);
		this.imageRegistry.register(AgnhostImage);

		const kubeletConfiguration: KubeletConfiguration = {
			syncFrequencyMs: 60 * 1000,
			clusterDNS: [this.dnsServiceIp],
			registryPullQPS: 5,
			registryBurst: 10,
			serializeImagePulls: true,
			maxParallelImagePulls: undefined,
			minimumGCAgeMs: 0,
			maxPerPodContainerCount: 1,
			maxContainerCount: -1,
			nodeStatusMaxImages: 50,
			clusterDomain: "cluster.local",
		};
		const serverDNSConfig = {
			servers: [this.dnsServiceIp],
			searches: [],
			options: [],
		};

		this.servers = [
			new Server(this, {
				name: "node-1",
				podCIDR: "10.0.0.0/24",
				ipAddresses: ["192.168.1.1"],
				kubeletConfiguration,
				dnsConfig: serverDNSConfig,
			}),
			new Server(this, {
				name: "node-2",
				podCIDR: "10.0.1.0/24",
				ipAddresses: ["192.168.1.2"],
				kubeletConfiguration,
				dnsConfig: serverDNSConfig,
			}),
			new Server(this, {
				name: "node-3",
				podCIDR: "10.0.2.0/24",
				ipAddresses: ["192.168.1.3"],
				kubeletConfiguration,
				dnsConfig: serverDNSConfig,
			}),
		];

		this.imageRegistry.register(Scheduler);
		this.imageRegistry.register(KubeProxy);
		this.imageRegistry.register(EndpointSliceController);
		this.imageRegistry.register(NamespaceController);
		this.imageRegistry.register(CoreDNS);
	}

	public async init() {
		// This sets up some key spaces in this.etcd for allocating IP ranges and
		// node port ranges for services. It's quite hacky and inelegant and I would
		// like to find a better way in future.
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

		// Create Nodes for the initial servers.
		for (const server of this.servers) {
			await this.api.corev1.createNode({ body: server.node });
		}

		for (const server of this.servers) {
			await server.boot(this.ctx);
		}

		await this.createControlPlanePod("kube-scheduler", "webernetes/kube-scheduler:latest");
		await this.createControlPlanePod(
			"namespace-controller",
			"webernetes/namespace-controller:latest",
		);
		await this.createControlPlanePod(
			"endpointslice-controller",
			"webernetes/endpointslice-controller:latest",
		);
		await this.createControlPlanePod("kube-proxy", "webernetes/kube-proxy:latest");
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
			"webernetes/coredns:latest",
			{
				"k8s-app": "kube-dns",
			},
			[{ containerPort: 53 }],
		);
	}

	public async fetch(target: http.FetchInput, init: http.FetchInit = {}): Promise<http.Response> {
		return await this.network.fetch(this.ctx, this.servers[0].node, target, init);
	}

	public registerImage(image: ImageConstructor): void {
		this.imageRegistry.register(image);
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

		const podFullName = buildPodFullName(podName, namespace);
		const resolvedContainerName =
			containerName ??
			((pod.spec?.containers?.length ?? 0) === 1 ? pod.spec?.containers?.[0]?.name : undefined);
		if (!resolvedContainerName) {
			throw new Error(`container name is required for pod ${namespace}/${podName}`);
		}

		const [container, findErr] = await server.kubelet.findContainer(
			this.ctx,
			podFullName,
			pod.metadata?.uid ?? "",
			resolvedContainerName,
		);
		if (findErr) {
			throw findErr;
		}
		if (!container) {
			throw new Error(`container not found (${JSON.stringify(resolvedContainerName)})`);
		}
		if (!server.kubelet.runtimeService) {
			throw new Error("remote runtime service is not configured");
		}
		const [response, err] = await server.kubelet.runtimeService.execSync(
			this.ctx,
			container.id.id,
			argv,
		);
		if (err) {
			throw err;
		}
		if (!response) {
			throw new Error("execSync returned no response");
		}
		return response;
	}

	// Mimics kubectl's client-side apply for object literals. This intentionally
	// leaves out less common flags such as --overwrite, --field-manager,
	// --server-side, and alpha --prune support until tests or callers need them.
	public async apply<T extends k8s.KubernetesObject>(resources: T[]): Promise<T[]> {
		return await applyResources(this, resources);
	}

	public close(): Promise<void> {
		if (!this.closePromise) {
			this.cancelContext();
			this.closePromise = (async () => {
				await Promise.all(this.servers.map((server) => server.close()));
				this.etcd.close();
				this.clock.clear();
			})();
		}
		return this.closePromise;
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
					// For now, all control plane pods are scheduled to the first server.
					// This is a fairly arbitrary choice.
					nodeName: this.servers[0].name,
					containers: [{ name, image, ports }],
				},
			},
		});
	}
}
