import * as k8s from "../../client";
import type { ProcessContext } from "../cri";
import { BaseImage } from "./base";

export class KubeProxy extends BaseImage {
	static readonly imageName = "webernetes/kube-proxy";
	static readonly imageVersion = "1.0";

	readonly defaultCommand = ["kube-proxy"];
	private nodeInformer: k8s.Informer<k8s.V1Node> | undefined;
	private serviceInformer: k8s.Informer<k8s.V1Service> | undefined;
	private endpointSliceInformer: k8s.Informer<k8s.V1EndpointSlice> | undefined;
	private readonly services = new Map<string, k8s.V1Service>();
	private readonly endpointSlices = new Map<string, k8s.V1EndpointSlice>();
	private readonly endpointSliceKeysByService = new Map<string, Set<string>>();

	override async exec(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "kube-proxy") {
			return await super.exec(ctx, argv);
		}
		await this.startServiceRouting(ctx);
		try {
			return await ctx.waitUntilKilled();
		} finally {
			await this.close();
		}
	}

	private async close(): Promise<void> {
		await this.nodeInformer?.stop();
		await this.serviceInformer?.stop();
		await this.endpointSliceInformer?.stop();
	}

	private async startServiceRouting(ctx: ProcessContext): Promise<void> {
		this.nodeInformer = k8s.makeInformer(
			ctx.kubeConfig,
			"/api/v1/nodes",
			async () => await ctx.api.corev1.listNode(),
		);
		this.serviceInformer = k8s.makeInformer(
			ctx.kubeConfig,
			"/api/v1/services",
			async () => await ctx.api.corev1.listServiceForAllNamespaces(),
		);
		this.endpointSliceInformer = k8s.makeInformer(
			ctx.kubeConfig,
			"/apis/discovery.k8s.io/v1/endpointslices",
			async () => await ctx.api.discoveryv1.listEndpointSliceForAllNamespaces(),
		);
		this.nodeInformer.on("add", (node) => this.upsertNode(ctx, node));
		this.nodeInformer.on("update", (node) => this.upsertNode(ctx, node));
		this.nodeInformer.on("delete", (node) => this.deleteNode(ctx, node));
		this.serviceInformer.on("add", (service) => this.upsertService(ctx, service));
		this.serviceInformer.on("update", (service) => this.upsertService(ctx, service));
		this.serviceInformer.on("delete", (service) => this.deleteService(ctx, service));
		this.endpointSliceInformer.on("add", (slice) => this.upsertEndpointSlice(ctx, slice));
		this.endpointSliceInformer.on("update", (slice) => this.upsertEndpointSlice(ctx, slice));
		this.endpointSliceInformer.on("delete", (slice) => this.deleteEndpointSlice(ctx, slice));

		await this.nodeInformer.start();
		await this.serviceInformer.start();
		await this.endpointSliceInformer.start();
		this.reconcileAllServices(ctx);
	}

	private upsertNode(ctx: ProcessContext, node: k8s.V1Node): void {
		const name = node.metadata?.name;
		if (!name) {
			return;
		}
		// This is to make it possible to route to NodePort Services via the node's
		// IP address and node address names.
		ctx.network.registerNode(node);
	}

	private deleteNode(ctx: ProcessContext, node: k8s.V1Node): void {
		const name = node.metadata?.name;
		if (!name) {
			return;
		}
		ctx.network.unregisterNode(name);
	}

	private upsertService(ctx: ProcessContext, service: k8s.V1Service): void {
		this.services.set(serviceKey(service), service);
		this.reconcileService(ctx, service);
	}

	private deleteService(ctx: ProcessContext, service: k8s.V1Service): void {
		const namespace = service.metadata?.namespace ?? "default";
		const name = service.metadata?.name;
		if (!name) {
			return;
		}
		this.services.delete(serviceKey(service));
		ctx.network.unregisterService(namespace, name);
	}

	private upsertEndpointSlice(ctx: ProcessContext, slice: k8s.V1EndpointSlice): void {
		const key = endpointSliceKey(slice);
		const previous = this.endpointSlices.get(key);
		if (previous) {
			this.unindexEndpointSlice(previous);
		}
		this.endpointSlices.set(key, slice);
		this.indexEndpointSlice(slice);
		this.reconcileServiceForEndpointSlice(ctx, slice);
	}

	private deleteEndpointSlice(ctx: ProcessContext, slice: k8s.V1EndpointSlice): void {
		const key = endpointSliceKey(slice);
		const stored = this.endpointSlices.get(key) ?? slice;
		this.unindexEndpointSlice(stored);
		this.endpointSlices.delete(key);
		this.reconcileServiceForEndpointSlice(ctx, stored);
	}

	private reconcileAllServices(ctx: ProcessContext): void {
		for (const service of this.services.values()) {
			this.reconcileService(ctx, service);
		}
	}

	private reconcileServiceForEndpointSlice(ctx: ProcessContext, slice: k8s.V1EndpointSlice): void {
		const serviceName = endpointSliceServiceName(slice);
		if (!serviceName) {
			return;
		}
		const service = this.services.get(
			namespacedNameKey(slice.metadata?.namespace ?? "default", serviceName),
		);
		if (service) {
			this.reconcileService(ctx, service);
		}
	}

	private reconcileService(ctx: ProcessContext, service: k8s.V1Service): void {
		const namespace = service.metadata?.namespace ?? "default";
		const name = service.metadata?.name;
		if (!name || !isRoutableService(service)) {
			if (name) {
				ctx.network.unregisterService(namespace, name);
			}
			return;
		}
		ctx.network.registerService(service);
		for (const port of service.spec?.ports ?? []) {
			ctx.network.setServiceTargets(
				namespace,
				name,
				port.port,
				this.targetsForServicePort(service, port),
			);
		}
	}

	private targetsForServicePort(service: k8s.V1Service, port: k8s.V1ServicePort): string[] {
		const slices = this.endpointSlicesForService(service);
		const targets: string[] = [];
		for (const slice of slices) {
			for (const endpointPort of slice.ports ?? []) {
				if ((endpointPort.name ?? "") !== (port.name ?? "") || endpointPort.port === undefined) {
					continue;
				}
				for (const endpoint of slice.endpoints) {
					if (endpoint.conditions?.ready === false) {
						continue;
					}
					const address = endpoint.addresses[0];
					if (address) {
						targets.push(`${address}:${endpointPort.port}`);
					}
				}
			}
		}
		return targets;
	}

	private endpointSlicesForService(service: k8s.V1Service): k8s.V1EndpointSlice[] {
		const namespace = service.metadata?.namespace ?? "default";
		const name = service.metadata?.name ?? "";
		return [...(this.endpointSliceKeysByService.get(namespacedNameKey(namespace, name)) ?? [])]
			.map((key) => this.endpointSlices.get(key))
			.filter((slice) => slice !== undefined);
	}

	private indexEndpointSlice(slice: k8s.V1EndpointSlice): void {
		const serviceName = endpointSliceServiceName(slice);
		if (!serviceName) {
			return;
		}
		addToIndex(
			this.endpointSliceKeysByService,
			namespacedNameKey(slice.metadata?.namespace ?? "default", serviceName),
			endpointSliceKey(slice),
		);
	}

	private unindexEndpointSlice(slice: k8s.V1EndpointSlice): void {
		const serviceName = endpointSliceServiceName(slice);
		if (!serviceName) {
			return;
		}
		removeFromIndex(
			this.endpointSliceKeysByService,
			namespacedNameKey(slice.metadata?.namespace ?? "default", serviceName),
			endpointSliceKey(slice),
		);
	}
}

function serviceKey(service: k8s.V1Service): string {
	return namespacedNameKey(service.metadata?.namespace ?? "default", service.metadata?.name ?? "");
}

function isRoutableService(service: k8s.V1Service): boolean {
	const type = service.spec?.type ?? "ClusterIP";
	const clusterIP = service.spec?.clusterIP;
	return (
		(type === "ClusterIP" || type === "NodePort") && clusterIP !== undefined && clusterIP !== "None"
	);
}

function endpointSliceKey(slice: k8s.V1EndpointSlice): string {
	return namespacedNameKey(slice.metadata?.namespace ?? "default", slice.metadata?.name ?? "");
}

function endpointSliceServiceName(slice: k8s.V1EndpointSlice): string | undefined {
	return slice.metadata?.labels?.["kubernetes.io/service-name"];
}

function namespacedNameKey(namespace: string, name: string): string {
	return `${namespace}/${name}`;
}

function addToIndex(index: Map<string, Set<string>>, ownerKey: string, value: string): void {
	let values = index.get(ownerKey);
	if (!values) {
		values = new Set();
		index.set(ownerKey, values);
	}
	values.add(value);
}

function removeFromIndex(index: Map<string, Set<string>>, ownerKey: string, value: string): void {
	const values = index.get(ownerKey);
	if (!values) {
		return;
	}
	values.delete(value);
	if (values.size === 0) {
		index.delete(ownerKey);
	}
}
