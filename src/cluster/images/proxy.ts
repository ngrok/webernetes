import * as k8s from "../../client";
import type { ClusterNetwork, ServiceInstance } from "../cni";
import type { ProcessContext } from "../cri";
import { BaseImage } from "./base";

export interface KubeProxyOptions {
	kubeConfig: k8s.KubeConfig;
	network: ClusterNetwork;
}

export class KubeProxy extends BaseImage {
	private readonly coreApi: k8s.CoreV1Api;
	private readonly discoveryApi: k8s.DiscoveryV1Api;
	private serviceInformer: k8s.Informer<k8s.V1Service> | undefined;
	private endpointSliceInformer: k8s.Informer<k8s.V1EndpointSlice> | undefined;
	private readonly services = new Map<string, k8s.V1Service>();
	private readonly endpointSlices = new Map<string, k8s.V1EndpointSlice>();
	private readonly endpointSliceKeysByService = new Map<string, Set<string>>();

	constructor(private readonly options: KubeProxyOptions) {
		super();
		this.coreApi = options.kubeConfig.makeApiClient(k8s.CoreV1Api);
		this.discoveryApi = options.kubeConfig.makeApiClient(k8s.DiscoveryV1Api);
	}

	async start(context: ProcessContext, _argv: readonly string[]): Promise<number> {
		await this.startServiceRouting();
		try {
			return await context.waitUntilKilled();
		} finally {
			await this.close();
		}
	}

	private async close(): Promise<void> {
		await this.serviceInformer?.stop();
		await this.endpointSliceInformer?.stop();
	}

	private async startServiceRouting(): Promise<void> {
		this.serviceInformer = k8s.makeInformer(
			this.options.kubeConfig,
			"/api/v1/services",
			async () => await this.coreApi.listServiceForAllNamespaces(),
		);
		this.endpointSliceInformer = k8s.makeInformer(
			this.options.kubeConfig,
			"/apis/discovery.k8s.io/v1/endpointslices",
			async () => await this.discoveryApi.listEndpointSliceForAllNamespaces(),
		);
		this.serviceInformer.on("add", (service) => this.upsertService(service));
		this.serviceInformer.on("update", (service) => this.upsertService(service));
		this.serviceInformer.on("delete", (service) => this.deleteService(service));
		this.endpointSliceInformer.on("add", (slice) => this.upsertEndpointSlice(slice));
		this.endpointSliceInformer.on("update", (slice) => this.upsertEndpointSlice(slice));
		this.endpointSliceInformer.on("delete", (slice) => this.deleteEndpointSlice(slice));

		await this.serviceInformer.start();
		await this.endpointSliceInformer.start();
		this.reconcileAllServices();
	}

	private upsertService(service: k8s.V1Service): void {
		this.services.set(serviceKey(service), service);
		this.reconcileService(service);
	}

	private deleteService(service: k8s.V1Service): void {
		const namespace = service.metadata?.namespace ?? "default";
		const name = service.metadata?.name;
		if (!name) {
			return;
		}
		this.services.delete(serviceKey(service));
		this.options.network.unregisterService(namespace, name);
	}

	private upsertEndpointSlice(slice: k8s.V1EndpointSlice): void {
		const key = endpointSliceKey(slice);
		const previous = this.endpointSlices.get(key);
		if (previous) {
			this.unindexEndpointSlice(previous);
		}
		this.endpointSlices.set(key, slice);
		this.indexEndpointSlice(slice);
		this.reconcileServiceForEndpointSlice(slice);
	}

	private deleteEndpointSlice(slice: k8s.V1EndpointSlice): void {
		const key = endpointSliceKey(slice);
		const stored = this.endpointSlices.get(key) ?? slice;
		this.unindexEndpointSlice(stored);
		this.endpointSlices.delete(key);
		this.reconcileServiceForEndpointSlice(stored);
	}

	private reconcileAllServices(): void {
		for (const service of this.services.values()) {
			this.reconcileService(service);
		}
	}

	private reconcileServiceForEndpointSlice(slice: k8s.V1EndpointSlice): void {
		const serviceName = endpointSliceServiceName(slice);
		if (!serviceName) {
			return;
		}
		const service = this.services.get(
			namespacedNameKey(slice.metadata?.namespace ?? "default", serviceName),
		);
		if (service) {
			this.reconcileService(service);
		}
	}

	private reconcileService(service: k8s.V1Service): void {
		const instance = this.serviceInstance(service);
		if (!instance) {
			const namespace = service.metadata?.namespace ?? "default";
			const name = service.metadata?.name;
			if (name) {
				this.options.network.unregisterService(namespace, name);
			}
			return;
		}
		this.options.network.registerService(instance);
		for (const port of instance.ports) {
			this.options.network.setServiceTargets(
				instance.namespace,
				instance.name,
				port.port,
				this.targetsForServicePort(instance, port),
			);
		}
	}

	private serviceInstance(service: k8s.V1Service): ServiceInstance | undefined {
		const type = service.spec?.type ?? "ClusterIP";
		if (type !== "ClusterIP" && type !== "NodePort") {
			return undefined;
		}
		const name = service.metadata?.name;
		const namespace = service.metadata?.namespace ?? "default";
		const clusterIp = service.spec?.clusterIP;
		if (!name || !clusterIp || clusterIp === "None") {
			return undefined;
		}
		return {
			uid: service.metadata?.uid ?? `${namespace}/${name}`,
			name,
			namespace,
			clusterIp,
			type,
			ports: (service.spec?.ports ?? []).map((port) => ({
				name: port.name,
				port: port.port,
				targetPort: port.targetPort ?? port.port,
				nodePort: port.nodePort,
				protocol:
					port.protocol === "TCP" || port.protocol === "UDP" || port.protocol === "SCTP"
						? port.protocol
						: undefined,
			})),
		};
	}

	private targetsForServicePort(
		service: ServiceInstance,
		port: ServiceInstance["ports"][number],
	): string[] {
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

	private endpointSlicesForService(service: ServiceInstance): k8s.V1EndpointSlice[] {
		return [
			...(this.endpointSliceKeysByService.get(namespacedNameKey(service.namespace, service.name)) ??
				[]),
		]
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
