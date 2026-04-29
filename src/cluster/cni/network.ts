import { CIDR, ipToNumber } from "../../net";
import { type DnsHandler, DnsListener, type DnsRequest, type DnsResponse } from "./dns";
import { NetworkError } from "./error";
import { type HttpHandler, HttpListener, type HttpRequest, type HttpResponse } from "./http";
import type { ServiceEndpoint, ServiceInstance, ServicePort } from "./service";
import type { PodSandboxInstance } from "../cri/runtime";

export interface ClusterNetworkOptions {
	podCIDR: string;
}

interface NodePortRoute {
	service: ServiceInstance;
	port: ServicePort;
}

interface ServiceEndpointRoute {
	service: ServiceInstance;
	port: ServicePort;
	key: string;
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
	private readonly podCIDR: CIDR;
	private podIpCursor: string | undefined;
	private podsBySandboxId = new Map<string, PodSandboxInstance>();
	private podsByIp = new Map<string, PodSandboxInstance>();
	private httpListeners = new Map<string, HttpHandler>();
	private dnsListeners = new Map<string, DnsHandler>();
	private servicesByKey = new Map<string, ServiceInstance>();
	private servicesByClusterIp = new Map<string, ServiceInstance>();
	private servicesByNodePort = new Map<number, NodePortRoute>();
	private serviceEndpointRoutes = new Map<string, ServiceEndpointRoute>();
	private targetsByServicePort = new Map<string, string[]>();

	constructor(options: ClusterNetworkOptions) {
		// TODO: This really shouldn't be here, we should be allocating pod IPs with
		// the node podCIDR. This is convenient for now, but wrong.
		this.podCIDR = new CIDR(options.podCIDR);
	}

	setupPodSandbox(pod: PodSandboxInstance): NetworkRegistration {
		if (this.podsBySandboxId.has(pod.id)) {
			throw new NetworkError(`pod sandbox ${pod.id} is already registered`);
		}
		const ip = this.allocatePodIp();
		this.podsBySandboxId.set(pod.id, pod);
		this.podsByIp.set(ip, pod);
		return new NetworkRegistration(this, pod.id, pod.uid, ip);
	}

	private allocatePodIp(): string {
		let candidate = this.podIpCursor
			? this.podCIDR.addressAfter(this.podIpCursor)
			: this.podCIDR.firstAddress();
		for (const ip of this.podCIDR.addresses()) {
			const selected = candidate ?? ip;
			if (!this.podsByIp.has(selected)) {
				this.podIpCursor = selected;
				return selected;
			}
			candidate = this.podCIDR.addressAfter(selected);
		}
		throw new NetworkError(`no free pod IPs in ${this.podCIDR}`);
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
			this.targetsByServicePort.set(routeKey, []);
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
			this.targetsByServicePort.delete(routeKey);
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
		this.targetsByServicePort.set(serviceRouteKey(namespace, name, port), [...targets]);
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
		const targets = this.targetsByServicePort.get(servicePortKey(service, port)) ?? [];
		if (targets.length === 0) {
			throw new NetworkError(`Service ${service.namespace}/${service.name} has no ready endpoints`);
		}
		return parseEndpointTarget(targets[Math.floor(Math.random() * targets.length)]);
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
