import { EventEmitter } from "events";

import { Clock } from "../clock";
import * as context from "../go/context";
import { Etcd } from "./etcd";
import * as k8s from "../client";
import type { KubeList } from "../client/types";
import { Server } from "./server";
import * as http from "./cni/http";
import { ClusterNetwork } from "./cni";
import { ImageRegistry, type ExecResult, type ImageConstructor } from "./cri";
import { CoreDNS } from "./images/coredns";
import { BusyBoxImage } from "./images/busybox";
import { HelloWorldImage } from "./images/hello-world";
import { HttpEchoImage } from "./images/http-echo";
import { AgnhostImage } from "./images/agnhost";
import { DeploymentController } from "./images/deployment-controller";
import { EndpointSliceController } from "./images/endpointslice-controller";
import { GarbageCollector } from "./images/garbage-collector";
import { NamespaceController } from "./images/namespace-controller";
import { PauseImage, PauseImage39 } from "./images/pause";
import { KubeProxy } from "./images/proxy";
import { ReplicaSetController } from "./images/replicaset-controller";
import { Scheduler } from "./images/scheduler";
import { type NodePortRange, ServiceStore } from "./storage";
import { applyResources, type ClusterApplyResource, type ClusterApplyResult } from "./apply";
import type { KubeletConfiguration } from "./kubelet/apis/config";
import { buildPodFullName } from "./kubelet/container";
import { withClock } from "../clock-context";
import { type LatencyProvider, withLatencyProvider } from "../latency";
import type { NetworkHop, NetworkRequestEvent, NetworkResponseEvent } from "./cni/network";

const DEFAULT_NODE_PORT_RANGE: NodePortRange = {
	from: 30000,
	to: 32767,
};

export type ClusterInformerEventType = "add" | "update" | "delete";

export interface ClusterInformerOptions {
	namespace?: string;
	labelSelector?: string;
	fieldSelector?: string;
	onError?: (error: unknown) => void;
}

export type ClusterInformerCallback<T> = (type: ClusterInformerEventType, object: T) => void;

export interface ClusterInformerResources {
	deployments: k8s.V1Deployment;
	pods: k8s.V1Pod;
	replicasets: k8s.V1ReplicaSet;
	services: k8s.V1Service;
	namespaces: k8s.V1Namespace;
	nodes: k8s.V1Node;
	events: k8s.CoreV1Event;
	endpointslices: k8s.V1EndpointSlice;
}

export type ClusterInformerResource = keyof ClusterInformerResources;

export interface ClusterOptions {
	serviceCIDR?: string;
	nodePortRange?: NodePortRange;
	latencyProvider?: LatencyProvider;
}

export type { NetworkHop, NetworkRequestEvent, NetworkResponseEvent };

type EventEmitterListener = Parameters<EventEmitter["on"]>[1];
type ClusterLifecycleEvent = "pause" | "resume";

export class KubeClient implements k8s.KubeClient {
	readonly appsv1: k8s.KubeClient["appsv1"];
	readonly corev1: k8s.KubeClient["corev1"];
	readonly discoveryv1: k8s.KubeClient["discoveryv1"];
	constructor(readonly kubeConfig: k8s.KubeConfig) {
		this.appsv1 = this.kubeConfig.makeApiClient(k8s.AppsV1Api);
		this.corev1 = this.kubeConfig.makeApiClient(k8s.CoreV1Api);
		this.discoveryv1 = this.kubeConfig.makeApiClient(k8s.DiscoveryV1Api);
	}
}

export class Cluster extends EventEmitter {
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
		super();
		this.clock = new Clock();
		const [ctx, cancelContext] = context.withCancel(context.background());
		this.ctx = withLatencyProvider(withClock(ctx, this.clock), options.latencyProvider);
		this.cancelContext = cancelContext;
		this.etcd = new Etcd(this.ctx);
		this.serviceCIDR = options.serviceCIDR;
		this.nodePortRange = options.nodePortRange ?? DEFAULT_NODE_PORT_RANGE;
		this.kubeConfig = new k8s.KubeConfig({
			ctx: this.ctx,
			etcd: this.etcd,
			serviceCIDR: this.serviceCIDR,
			nodePortRange: this.nodePortRange,
			exec: (namespace, podName, containerName, argv) =>
				this.exec(namespace, podName, containerName, argv),
		});
		this.api = new KubeClient(this.kubeConfig);
		this.network = new ClusterNetwork({ clusterDNS: [this.dnsServiceIp] });
		this.network.on("request", (event) => this.emit("request", event));
		this.network.on("response", (event) => this.emit("response", event));

		this.imageRegistry = new ImageRegistry();
		this.imageRegistry.register(PauseImage);
		this.imageRegistry.register(PauseImage39);
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
		this.imageRegistry.register(DeploymentController);
		this.imageRegistry.register(EndpointSliceController);
		this.imageRegistry.register(GarbageCollector);
		this.imageRegistry.register(NamespaceController);
		this.imageRegistry.register(ReplicaSetController);
		this.imageRegistry.register(CoreDNS);
	}

	public async init() {
		// This sets up some key spaces in this.etcd for allocating IP ranges and
		// node port ranges for services. It's quite hacky and inelegant and I would
		// like to find a better way in future.
		await ServiceStore.initialize(this.ctx, this.etcd, {
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
			"deployment-controller",
			"webernetes/deployment-controller:latest",
		);
		await this.createControlPlanePod(
			"replicaset-controller",
			"webernetes/replicaset-controller:latest",
		);
		await this.createControlPlanePod("garbage-collector", "webernetes/garbage-collector:latest");
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

	public pause(): void {
		this.clock.pause();
		this.emit("pause");
	}

	public resume(): void {
		this.clock.resume();
		this.emit("resume");
	}

	public isPaused(): boolean {
		return this.clock.isPaused();
	}

	public override addListener(
		event: "request",
		handler: (event: NetworkRequestEvent) => void,
	): this;
	public override addListener(
		event: "response",
		handler: (event: NetworkResponseEvent) => void,
	): this;
	public override addListener(event: ClusterLifecycleEvent, handler: () => void): this;
	public override addListener(eventName: string | symbol, listener: EventEmitterListener): this;
	public override addListener(eventName: string | symbol, listener: EventEmitterListener): this {
		return super.addListener(eventName, listener);
	}

	public override on(event: "request", handler: (event: NetworkRequestEvent) => void): this;
	public override on(event: "response", handler: (event: NetworkResponseEvent) => void): this;
	public override on(event: ClusterLifecycleEvent, handler: () => void): this;
	public override on(eventName: string | symbol, listener: EventEmitterListener): this;
	public override on(eventName: string | symbol, listener: EventEmitterListener): this {
		return super.on(eventName, listener);
	}

	public override once(event: "request", handler: (event: NetworkRequestEvent) => void): this;
	public override once(event: "response", handler: (event: NetworkResponseEvent) => void): this;
	public override once(event: ClusterLifecycleEvent, handler: () => void): this;
	public override once(eventName: string | symbol, listener: EventEmitterListener): this;
	public override once(eventName: string | symbol, listener: EventEmitterListener): this {
		return super.once(eventName, listener);
	}

	public override off(event: "request", handler: (event: NetworkRequestEvent) => void): this;
	public override off(event: "response", handler: (event: NetworkResponseEvent) => void): this;
	public override off(event: ClusterLifecycleEvent, handler: () => void): this;
	public override off(eventName: string | symbol, listener: EventEmitterListener): this;
	public override off(eventName: string | symbol, listener: EventEmitterListener): this {
		return super.off(eventName, listener);
	}

	public override removeListener(
		event: "request",
		handler: (event: NetworkRequestEvent) => void,
	): this;
	public override removeListener(
		event: "response",
		handler: (event: NetworkResponseEvent) => void,
	): this;
	public override removeListener(event: ClusterLifecycleEvent, handler: () => void): this;
	public override removeListener(eventName: string | symbol, listener: EventEmitterListener): this;
	public override removeListener(eventName: string | symbol, listener: EventEmitterListener): this {
		return super.removeListener(eventName, listener);
	}

	public registerImage(image: ImageConstructor): void {
		this.imageRegistry.register(image);
	}

	/**
	 * Creates an informer for a resource collection by listing current objects and
	 * then watching future changes.
	 *
	 * Existing objects are delivered as `"add"` events, then later updates and
	 * deletes are delivered as `"update"` and `"delete"`. This is the convenient
	 * API for UI state and local caches because callers do not need to combine an
	 * initial list with a lower-level watch stream themselves.
	 *
	 * @example
	 * const informer = cluster.informer("nodes", (type, node) => {
	 *   console.log(type, node.metadata?.name);
	 * });
	 *
	 * await informer.stop();
	 */
	public informer<TResource extends ClusterInformerResource>(
		resource: TResource,
		callback: ClusterInformerCallback<ClusterInformerResources[TResource]>,
		options: ClusterInformerOptions = {},
	): k8s.Informer<ClusterInformerResources[TResource]> {
		const informer = k8s.makeInformer<ClusterInformerResources[TResource]>(
			this.kubeConfig,
			clusterResourcePath(resource, options.namespace),
			() => clusterListResource(this, resource, options),
			options.labelSelector,
			options.fieldSelector,
		);
		const typedCallback = callback as ClusterInformerCallback<ClusterInformerResources[TResource]>;
		informer.on("add", (object) => typedCallback("add", object));
		informer.on("update", (object) => typedCallback("update", object));
		informer.on("delete", (object) => typedCallback("delete", object));
		informer.on("error", (error) => options.onError?.(error));
		void informer.start().catch((error: unknown) => {
			options.onError?.(error);
		});
		return informer;
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
	public async apply<const T extends readonly ClusterApplyResource[]>(
		resources: T,
	): Promise<ClusterApplyResult<T>> {
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

// TODO(samwho): this is gross, find a better way
function clusterResourcePath(resource: ClusterInformerResource, namespace?: string): string {
	const encodedNamespace = namespace ? encodeURIComponent(namespace) : undefined;
	if (resource === "endpointslices") {
		return encodedNamespace
			? `/apis/discovery.k8s.io/v1/namespaces/${encodedNamespace}/endpointslices`
			: "/apis/discovery.k8s.io/v1/endpointslices";
	}
	if (resource === "deployments" || resource === "replicasets") {
		return encodedNamespace
			? `/apis/apps/v1/namespaces/${encodedNamespace}/${resource}`
			: `/apis/apps/v1/${resource}`;
	}
	if (
		encodedNamespace &&
		(resource === "pods" || resource === "services" || resource === "events")
	) {
		return `/api/v1/namespaces/${encodedNamespace}/${resource}`;
	}
	return `/api/v1/${resource}`;
}

// TODO(samwho): this is gross, find a better way
async function clusterListResource<TResource extends ClusterInformerResource>(
	cluster: Cluster,
	resource: TResource,
	options: ClusterInformerOptions,
): Promise<KubeList<ClusterInformerResources[TResource]>> {
	const listOptions = {
		labelSelector: options.labelSelector,
		fieldSelector: options.fieldSelector,
	};
	let list: KubeList<k8s.KubernetesObject>;
	switch (resource) {
		case "deployments":
			list = options.namespace
				? await cluster.api.appsv1.listNamespacedDeployment({
						namespace: options.namespace,
						...listOptions,
					})
				: await cluster.api.appsv1.listDeploymentForAllNamespaces(listOptions);
			break;
		case "pods":
			list = options.namespace
				? await cluster.api.corev1.listNamespacedPod({
						namespace: options.namespace,
						...listOptions,
					})
				: await cluster.api.corev1.listPodForAllNamespaces(listOptions);
			break;
		case "services":
			list = options.namespace
				? await cluster.api.corev1.listNamespacedService({
						namespace: options.namespace,
						...listOptions,
					})
				: await cluster.api.corev1.listServiceForAllNamespaces(listOptions);
			break;
		case "namespaces":
			list = await cluster.api.corev1.listNamespace(listOptions);
			break;
		case "nodes":
			list = await cluster.api.corev1.listNode(listOptions);
			break;
		case "events":
			list = options.namespace
				? await cluster.api.corev1.listNamespacedEvent({
						namespace: options.namespace,
						...listOptions,
					})
				: await cluster.api.corev1.listEventForAllNamespaces(listOptions);
			break;
		case "endpointslices":
			list = options.namespace
				? await cluster.api.discoveryv1.listNamespacedEndpointSlice({
						namespace: options.namespace,
						...listOptions,
					})
				: await cluster.api.discoveryv1.listEndpointSliceForAllNamespaces(listOptions);
			break;
		case "replicasets":
			list = options.namespace
				? await cluster.api.appsv1.listNamespacedReplicaSet({
						namespace: options.namespace,
						...listOptions,
					})
				: await cluster.api.appsv1.listReplicaSetForAllNamespaces(listOptions);
			break;
	}
	return list as KubeList<ClusterInformerResources[TResource]>;
}
