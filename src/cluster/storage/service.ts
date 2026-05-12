import { V1Service, V1ServicePort, V1ServiceSpec } from "../../client";
import { Etcd } from "../etcd";
import { IpRange, PortRange } from "./allocatable";
import { Store } from "./store";

const DEFAULT_SERVICE_CIDR = "10.96.0.0/12";

export interface NodePortRange {
	from: number;
	to: number;
}

export interface ServiceStoreOptions {
	serviceCIDR?: string;
	nodePortRange: NodePortRange;
}

function serviceType(service: V1Service): string {
	return service.spec?.type ?? "ClusterIP";
}

function requiresClusterIP(service: V1Service): boolean {
	const type = serviceType(service);
	return type === "ClusterIP" || type === "NodePort" || type === "LoadBalancer";
}

function requiresNodePorts(service: V1Service): boolean {
	const type = serviceType(service);
	return type === "NodePort" || type === "LoadBalancer";
}

function specFor(service: V1Service): V1ServiceSpec {
	service.spec ??= {};
	return service.spec;
}

function portIdentity(port: V1ServicePort, index: number): string {
	return `${port.name ?? ""}|${port.port}|${port.protocol ?? "TCP"}|${index}`;
}

function clusterIPRangeName(serviceCIDR: string): string {
	return `serviceallocations/clusterips/${encodeURIComponent(serviceCIDR)}`;
}

function nodePortRangeName(): string {
	return "serviceallocations/nodeports";
}

export class ServiceStore extends Store<V1Service> {
	private readonly clusterIPs: IpRange;
	private readonly nodePorts: PortRange;
	private readonly nodePortRange: NodePortRange;

	static async initialize(etcd: Etcd, options: ServiceStoreOptions): Promise<void> {
		const serviceCIDR = options.serviceCIDR ?? DEFAULT_SERVICE_CIDR;
		await IpRange.create(etcd, clusterIPRangeName(serviceCIDR), serviceCIDR);
		await PortRange.create(
			etcd,
			nodePortRangeName(),
			options.nodePortRange.from,
			options.nodePortRange.to,
		);
	}

	constructor(etcd: Etcd, options: ServiceStoreOptions) {
		super(etcd, {
			apiVersion: "v1",
			defaultQualifiedResource: "services",
			kind: "Service",
			singularQualifiedResource: "service",
			namespaced: true,
		});
		const serviceCIDR = options.serviceCIDR ?? DEFAULT_SERVICE_CIDR;
		this.clusterIPs = IpRange.open(etcd, clusterIPRangeName(serviceCIDR), serviceCIDR);
		this.nodePortRange = options.nodePortRange;
		this.nodePorts = PortRange.open(
			etcd,
			nodePortRangeName(),
			this.nodePortRange.from,
			this.nodePortRange.to,
		);
	}

	protected override async validateCreate(service: V1Service): Promise<void> {
		if (!service.metadata?.name) {
			throw new Error("Service name is required");
		}

		if (!service.spec) {
			throw new Error("Service spec is required");
		}
	}

	protected override async validateUpdate(service: V1Service, _existing: V1Service): Promise<void> {
		await this.validateCreate(service);
	}

	protected override async prepareCreate(service: V1Service): Promise<void> {
		service.spec ??= {};
		service.spec.type ??= "ClusterIP";
		this.defaultPorts(service.spec.ports);

		await this.allocateClusterIP(service);
		await this.allocateNodePorts(service);
	}

	protected override async prepareUpdate(service: V1Service, existing: V1Service): Promise<void> {
		service.spec ??= {};
		service.spec.type ??= existing.spec?.type ?? "ClusterIP";
		this.defaultPorts(service.spec.ports);
		this.preserveClusterIP(service, existing);
		this.preserveNodePorts(service, existing);

		await this.allocateClusterIP(service, existing);
		await this.allocateNodePorts(service, existing);
		await this.releaseOldAllocations(service, existing);
	}

	protected override async prepareDelete(service: V1Service): Promise<void> {
		await this.releaseServiceAllocations(service);
	}

	private defaultPorts(ports: Array<V1ServicePort> | undefined): void {
		for (const port of ports ?? []) {
			port.protocol ??= "TCP";
			port.targetPort ??= port.port;
		}
	}

	private preserveClusterIP(service: V1Service, existing: V1Service | undefined): void {
		const spec = specFor(service);
		if (!requiresClusterIP(service)) {
			spec.clusterIP = undefined;
			spec.clusterIPs = undefined;
			return;
		}

		if (!spec.clusterIP && existing?.spec?.clusterIP) {
			spec.clusterIP = existing.spec.clusterIP;
		}
		if (!spec.clusterIPs && existing?.spec?.clusterIPs) {
			spec.clusterIPs = [...existing.spec.clusterIPs];
		}
	}

	private preserveNodePorts(service: V1Service, existing: V1Service | undefined): void {
		const spec = specFor(service);
		if (!requiresNodePorts(service)) {
			for (const port of spec.ports ?? []) {
				port.nodePort = undefined;
			}
			return;
		}

		const oldPorts = existing?.spec?.ports ?? [];
		const oldByIdentity = new Map<string, V1ServicePort>();
		oldPorts.forEach((port, index) => oldByIdentity.set(portIdentity(port, index), port));

		for (const [index, port] of (spec.ports ?? []).entries()) {
			if (port.nodePort) {
				continue;
			}
			const oldPort = oldByIdentity.get(portIdentity(port, index)) ?? oldPorts[index];
			if (oldPort?.nodePort) {
				port.nodePort = oldPort.nodePort;
			}
		}
	}

	private async allocateClusterIP(service: V1Service, existing?: V1Service): Promise<void> {
		const spec = specFor(service);
		if (!requiresClusterIP(service)) {
			return;
		}

		if (spec.clusterIP === "None") {
			// Headless Services are valid Kubernetes API objects, but this phase only
			// supports Services that get routable ClusterIP/NodePort allocations.
			throw new Error('Headless Services with clusterIP "None" are not supported yet');
		}

		if (spec.clusterIP) {
			this.validateClusterIP(spec.clusterIP);
			await this.claimClusterIP(spec.clusterIP, existing);
			spec.clusterIPs = [spec.clusterIP];
			return;
		}

		const allocatedIP = await this.nextClusterIP(service);
		spec.clusterIP = allocatedIP;
		spec.clusterIPs = [allocatedIP];
	}

	private async allocateNodePorts(service: V1Service, existing?: V1Service): Promise<void> {
		const ports = specFor(service).ports ?? [];
		if (!requiresNodePorts(service)) {
			for (const port of ports) {
				if (port.nodePort !== undefined) {
					throw new Error("nodePort may only be set for NodePort or LoadBalancer Services");
				}
			}
			return;
		}

		for (const port of ports) {
			if (port.nodePort !== undefined) {
				this.validateNodePort(port.nodePort);
				await this.claimNodePort(port.nodePort, existing);
				continue;
			}

			port.nodePort = await this.nextNodePort(service);
		}
	}

	private validateClusterIP(clusterIP: string): void {
		if (!this.clusterIPs.contains(clusterIP)) {
			throw new Error(`clusterIP ${clusterIP} is outside the configured Service CIDR`);
		}
	}

	private validateNodePort(nodePort: number): void {
		if (
			!Number.isInteger(nodePort) ||
			nodePort < this.nodePortRange.from ||
			nodePort > this.nodePortRange.to
		) {
			throw new Error(`nodePort ${nodePort} is outside the valid range`);
		}
	}

	private async nextClusterIP(_service: V1Service): Promise<string> {
		try {
			return await this.clusterIPs.allocate();
		} catch (error) {
			if (error instanceof Error && /no free space/.test(error.message)) {
				throw new Error("No Service clusterIP addresses are available", { cause: error });
			}
			throw error;
		}
	}

	private async nextNodePort(_service: V1Service): Promise<number> {
		try {
			return await this.nodePorts.allocate();
		} catch (error) {
			if (error instanceof Error && /no free space/.test(error.message)) {
				throw new Error("No Service nodePorts are available", { cause: error });
			}
			throw error;
		}
	}

	private async claimClusterIP(clusterIP: string, existing?: V1Service): Promise<void> {
		if (this.serviceClusterIPs(existing).includes(clusterIP)) {
			return;
		}
		try {
			await this.clusterIPs.claim(clusterIP);
		} catch (error) {
			if (error instanceof Error && /already allocated/.test(error.message)) {
				throw new Error(`clusterIP ${clusterIP} is already allocated`, { cause: error });
			}
			throw error;
		}
	}

	private async claimNodePort(nodePort: number, existing?: V1Service): Promise<void> {
		if (this.serviceNodePorts(existing).includes(nodePort)) {
			return;
		}
		try {
			await this.nodePorts.claim(nodePort);
		} catch (error) {
			if (error instanceof Error && /already allocated/.test(error.message)) {
				throw new Error(`nodePort ${nodePort} is already allocated`, { cause: error });
			}
			throw error;
		}
	}

	private async releaseOldAllocations(service: V1Service, existing: V1Service): Promise<void> {
		const currentClusterIPs = new Set(this.serviceClusterIPs(service));
		for (const clusterIP of this.serviceClusterIPs(existing)) {
			if (!currentClusterIPs.has(clusterIP)) {
				await this.clusterIPs.release(clusterIP);
			}
		}

		const currentNodePorts = new Set(this.serviceNodePorts(service));
		for (const nodePort of this.serviceNodePorts(existing)) {
			if (!currentNodePorts.has(nodePort)) {
				await this.nodePorts.release(nodePort);
			}
		}
	}

	private async releaseServiceAllocations(service: V1Service): Promise<void> {
		for (const clusterIP of this.serviceClusterIPs(service)) {
			await this.clusterIPs.release(clusterIP);
		}
		for (const nodePort of this.serviceNodePorts(service)) {
			await this.nodePorts.release(nodePort);
		}
	}

	private serviceClusterIPs(service: V1Service | undefined): string[] {
		const clusterIPs = new Set<string>();
		if (service?.spec?.clusterIP && service.spec.clusterIP !== "None") {
			clusterIPs.add(service.spec.clusterIP);
		}
		for (const clusterIP of service?.spec?.clusterIPs ?? []) {
			if (clusterIP !== "None") {
				clusterIPs.add(clusterIP);
			}
		}
		return [...clusterIPs];
	}

	private serviceNodePorts(service: V1Service | undefined): number[] {
		const nodePorts: number[] = [];
		for (const port of service?.spec?.ports ?? []) {
			if (port.nodePort !== undefined) {
				nodePorts.push(port.nodePort);
			}
		}
		return nodePorts;
	}
}
