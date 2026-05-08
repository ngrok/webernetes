import { CIDR, ipToNumber } from "../../net";
import { type DnsHandler, DnsListener, type DnsRequest, type DnsResponse } from "./dns";
import { NetworkError } from "./error";
import { type HttpHandler, HttpListener, type HttpRequest, type HttpResponse } from "./http";
import type { ServiceEndpoint, ServiceInstance, ServicePort } from "./service";
import type { PodSandboxInstance } from "../cri/runtime";

interface NodePortRoute {
	service: ServiceInstance;
	port: ServicePort;
}

interface ServiceEndpointRoute {
	service: ServiceInstance;
	port: ServicePort;
	key: string;
}

interface PodCIDRAllocator {
	cidr: CIDR;
	cursor?: string;
}

class TargetList {
	targets: string[] = [];
	private roundRobinIndex = 0;

	setTargets(targets: readonly string[]): void {
		this.targets = [...targets];
		if (this.targets.length === 0) {
			this.roundRobinIndex = 0;
			return;
		}
		this.roundRobinIndex %= this.targets.length;
	}

	next(): string | undefined {
		if (this.targets.length === 0) {
			return undefined;
		}
		const target = this.targets[this.roundRobinIndex];
		this.roundRobinIndex = (this.roundRobinIndex + 1) % this.targets.length;
		return target;
	}
}

function listenerKey(ip: string, port: number): string {
	return `${ip}:${port}`;
}

function namespacedNameKey(namespace: string, name: string): string {
	return `${namespace}/${name}`;
}

function servicePortKey(service: ServiceInstance, port: ServicePort): string {
	return `${namespacedNameKey(service.namespace, service.name)}:${port.port}`;
}

function serviceRouteKey(namespace: string, name: string, port: number): string {
	return `${namespacedNameKey(namespace, name)}:${port}`;
}

function isIpLiteral(host: string): boolean {
	return ipToNumber(host) !== undefined;
}

export class ClusterNetwork {
	private podIpAllocators = new Map<string, PodCIDRAllocator>();
	private podsBySandboxId = new Map<string, PodSandboxInstance>();
	private podsByIp = new Map<string, PodSandboxInstance>();
	private httpListeners = new Map<string, HttpHandler>();
	private dnsListeners = new Map<string, DnsHandler>();
	private servicesByKey = new Map<string, ServiceInstance>();
	private servicesByClusterIp = new Map<string, ServiceInstance>();
	private servicesByNodePort = new Map<number, NodePortRoute>();
	private serviceEndpointRoutes = new Map<string, ServiceEndpointRoute>();
	private targetListsByServicePort = new Map<string, TargetList>();

	setupPodSandbox(pod: PodSandboxInstance, podCIDR: string): NetworkRegistration {
		if (this.podsBySandboxId.has(pod.id)) {
			throw new NetworkError(`pod sandbox ${pod.id} is already registered`);
		}
		const ip = this.allocatePodIp(podCIDR);
		this.podsBySandboxId.set(pod.id, pod);
		this.podsByIp.set(ip, pod);
		return new NetworkRegistration(this, pod.id, pod.uid, ip);
	}

	private allocatePodIp(podCIDR: string): string {
		const allocator = this.podIpAllocator(podCIDR);
		let candidate = allocator.cursor
			? allocator.cidr.addressAfter(allocator.cursor)
			: allocator.cidr.firstAddress();
		for (const ip of allocator.cidr.addresses()) {
			const selected = candidate ?? ip;
			if (!this.podsByIp.has(selected)) {
				allocator.cursor = selected;
				return selected;
			}
			candidate = allocator.cidr.addressAfter(selected);
		}
		throw new NetworkError(`no free pod IPs in ${podCIDR}`);
	}

	private podIpAllocator(podCIDR: string): PodCIDRAllocator {
		const existing = this.podIpAllocators.get(podCIDR);
		if (existing) {
			return existing;
		}
		const allocator = { cidr: new CIDR(podCIDR) };
		this.podIpAllocators.set(podCIDR, allocator);
		return allocator;
	}

	unregisterPod(podSandboxId: string): void {
		const pod = this.podsBySandboxId.get(podSandboxId);
		if (!pod) {
			return;
		}
		this.podsBySandboxId.delete(podSandboxId);
		this.podsByIp.delete(pod.ip);
		for (const key of [...this.httpListeners.keys()]) {
			if (key.startsWith(`${pod.ip}:`)) {
				this.httpListeners.delete(key);
			}
		}
		for (const key of [...this.dnsListeners.keys()]) {
			if (key.startsWith(`${pod.ip}:`)) {
				this.dnsListeners.delete(key);
			}
		}
	}

	registerService(service: ServiceInstance): void {
		const key = namespacedNameKey(service.namespace, service.name);
		this.unregisterService(service.namespace, service.name);
		this.servicesByKey.set(key, service);
		this.servicesByClusterIp.set(service.clusterIp, service);
		for (const port of service.ports) {
			const routeKey = servicePortKey(service, port);
			this.serviceEndpointRoutes.set(routeKey, { service, port, key: routeKey });
			this.targetListsByServicePort.set(routeKey, new TargetList());
			if (port.nodePort !== undefined) {
				if (this.servicesByNodePort.has(port.nodePort)) {
					throw new NetworkError(`NodePort ${port.nodePort} is already registered`);
				}
				this.servicesByNodePort.set(port.nodePort, { service, port });
			}
		}
	}

	unregisterService(namespace: string, name: string): void {
		const key = namespacedNameKey(namespace, name);
		const service = this.servicesByKey.get(key);
		if (!service) {
			return;
		}
		this.servicesByKey.delete(key);
		this.servicesByClusterIp.delete(service.clusterIp);
		for (const port of service.ports) {
			const routeKey = servicePortKey(service, port);
			this.serviceEndpointRoutes.delete(routeKey);
			this.targetListsByServicePort.delete(routeKey);
			if (port.nodePort !== undefined) {
				this.servicesByNodePort.delete(port.nodePort);
			}
		}
	}

	setServiceTargets(
		namespace: string,
		name: string,
		port: number,
		targets: readonly string[],
	): void {
		const key = serviceRouteKey(namespace, name, port);
		const targetList = this.targetListsByServicePort.get(key) ?? new TargetList();
		targetList.setTargets(targets);
		this.targetListsByServicePort.set(key, targetList);
	}

	async fetch(target: string, init: HttpRequest = {}): Promise<HttpResponse> {
		const url = this.parseHttpTarget(target);
		if (!isIpLiteral(url.hostname)) {
			throw new NetworkError(`network fetch target ${url.hostname} must be an IP address`);
		}

		const service = this.servicesByClusterIp.get(url.hostname);
		const port = this.parseTargetPort(url, service);
		const endpoint = this.routeEndpoint({ ip: url.hostname, port });
		return await this.dispatchHttp(endpoint.ip, endpoint.port, url, init);
	}

	canConnect(host: string, port: number): boolean {
		const endpoint = this.routeEndpoint({ ip: host, port });
		return this.httpListeners.has(listenerKey(endpoint.ip, endpoint.port));
	}

	async fetchNodePort(nodePort: number, init: HttpRequest = {}): Promise<HttpResponse> {
		const route = this.servicesByNodePort.get(nodePort);
		if (route) {
			const endpoint = this.selectEndpoint(route.service, route.port);
			return await this.dispatchHttp(endpoint.ip, endpoint.port, undefined, init);
		}
		throw new NetworkError(`no Service for NodePort ${nodePort}`);
	}

	async sendDns(target: string, request: DnsRequest): Promise<DnsResponse> {
		const endpoint = this.routeEndpoint(parseEndpointTarget(target));
		const listener = this.dnsListeners.get(listenerKey(endpoint.ip, endpoint.port));
		if (!listener) {
			throw new NetworkError(`no DNS listener on ${endpoint.ip}:${endpoint.port}`);
		}
		try {
			return await listener(request);
		} catch {
			return { rcode: "SERVFAIL", answers: [] };
		}
	}

	bindHttp(podSandboxId: string, ip: string, port: number, handler: HttpHandler): HttpListener {
		if (!this.podsBySandboxId.has(podSandboxId)) {
			throw new NetworkError(`pod sandbox ${podSandboxId} is not registered`);
		}
		const key = listenerKey(ip, port);
		if (this.httpListeners.has(key)) {
			throw new NetworkError(`HTTP listener ${key} is already registered`);
		}
		this.httpListeners.set(key, handler);
		return new HttpListener(ip, port, () => {
			if (this.httpListeners.get(key) === handler) {
				this.httpListeners.delete(key);
			}
		});
	}

	bindDns(podSandboxId: string, ip: string, port: number, handler: DnsHandler): DnsListener {
		if (!this.podsBySandboxId.has(podSandboxId)) {
			throw new NetworkError(`pod sandbox ${podSandboxId} is not registered`);
		}
		const key = listenerKey(ip, port);
		if (this.dnsListeners.has(key)) {
			throw new NetworkError(`DNS listener ${key} is already registered`);
		}
		this.dnsListeners.set(key, handler);
		return new DnsListener(ip, port, () => {
			if (this.dnsListeners.get(key) === handler) {
				this.dnsListeners.delete(key);
			}
		});
	}

	private parseHttpTarget(target: string): URL {
		let url: URL;
		try {
			url = new URL(target);
		} catch (error) {
			throw new NetworkError(`invalid HTTP target ${target}`, { cause: error });
		}
		if (url.protocol !== "http:") {
			throw new NetworkError(`unsupported protocol ${url.protocol}`);
		}
		return url;
	}

	private parseTargetPort(url: URL, service?: ServiceInstance): number {
		if (!url.port) {
			if (service?.ports.length === 1) {
				return service.ports[0].port;
			}
			throw new NetworkError(`target ${url.hostname} must include a port`);
		}
		const port = Number(url.port);
		if (!Number.isInteger(port) || port <= 0 || port > 65535) {
			throw new NetworkError(`invalid port ${url.port}`);
		}
		return port;
	}

	private selectEndpoint(service: ServiceInstance, port: ServicePort): ServiceEndpoint {
		const key = servicePortKey(service, port);
		const target = this.targetListsByServicePort.get(key)?.next();
		if (!target) {
			throw new NetworkError(`Service ${service.namespace}/${service.name} has no ready endpoints`);
		}
		return parseEndpointTarget(target);
	}

	private routeEndpoint(endpoint: ServiceEndpoint): ServiceEndpoint {
		const service = this.servicesByClusterIp.get(endpoint.ip);
		if (!service) {
			return endpoint;
		}
		const port = service.ports.find((candidate) => candidate.port === endpoint.port);
		if (!port) {
			throw new NetworkError(
				`Service ${service.namespace}/${service.name} has no port ${endpoint.port}`,
			);
		}
		return this.selectEndpoint(service, port);
	}

	private async dispatchHttp(
		ip: string,
		port: number,
		url: URL | undefined,
		init: HttpRequest,
	): Promise<HttpResponse> {
		const handler = this.httpListeners.get(listenerKey(ip, port));
		if (!handler) {
			throw new NetworkError(`no HTTP listener on ${ip}:${port}`);
		}
		try {
			return await handler({
				method: init.method ?? "GET",
				path: init.path ?? `${url?.pathname ?? "/"}${url?.search ?? ""}`,
				headers: init.headers,
				body: init.body,
			});
		} catch (error) {
			return {
				status: 500,
				body: error instanceof Error ? error.message : "handler error",
			};
		}
	}
}

export class NetworkRegistration {
	constructor(
		private readonly network: ClusterNetwork,
		readonly podSandboxId: string,
		readonly podUid: string,
		readonly ip: string,
	) {}

	bindHttp(port: number, handler: HttpHandler): HttpListener {
		return this.network.bindHttp(this.podSandboxId, this.ip, port, handler);
	}

	bindDns(port: number, handler: DnsHandler): DnsListener {
		return this.network.bindDns(this.podSandboxId, this.ip, port, handler);
	}

	unregister(): void {
		this.network.unregisterPod(this.podSandboxId);
	}
}

function parseEndpointTarget(target: string): ServiceEndpoint {
	const [ip, portValue, ...extra] = target.split(":");
	const port = Number(portValue);
	if (!ip || extra.length > 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new NetworkError(`invalid Service endpoint target ${target}`);
	}
	return { ip, port };
}
