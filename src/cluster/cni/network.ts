import { EventEmitter } from "events";

import { CIDR, isIPLiteral } from "../../net";
import {
	type DnsHandler,
	DnsListener,
	type DnsRecordType,
	type DnsRequest,
	type DnsResponse,
} from "./dns";
import { NetworkError } from "./error";
import * as http from "./http";
import { Channel, select } from "../../go/channel";
import * as context from "../../go/context";
import * as time from "../../go/time";
import type { V1Node, V1Pod, V1Service, V1ServicePort } from "../../client";
import { getLatencyProvider } from "../../latency";
import type { DnsConfig } from "../cri/runtime/v1/api";
import type { PodSandboxInstance } from "../cri/runtime";

interface NetworkEndpoint {
	ip: string;
	port: number;
}

interface NetworkRoute {
	endpoint: NetworkEndpoint;
	chain: NetworkHop[];
}

interface NodePortRoute {
	service: V1Service;
	port: V1ServicePort;
}

interface PodCIDRAllocator {
	cidr: CIDR;
	cursor?: string;
}

type FetchDefaultResult =
	| { type: "response"; response: http.Response }
	| { type: "error"; error: NetworkError };

export type FetchOrigin = V1Pod | V1Node;

export const networkRequestIDHeader = "X-Webernetes-Request-Id";

export type NetworkHop =
	| { type: "pod"; pod: V1Pod }
	| { type: "node"; node: V1Node }
	| { type: "service"; service: V1Service }
	| { type: "external"; host: string };

export interface NetworkRequestEvent {
	request: http.Request;
	chain: NetworkHop[];
	latencyMs: number;
	error?: Error;
}

export interface NetworkResponseEvent {
	request: http.Request;
	response?: http.Response;
	error?: Error;
	chain: NetworkHop[];
	latencyMs: number;
}

export interface ClusterNetworkOptions {
	clusterDNS?: readonly string[];
}

const internalIPCIDRs = [
	new CIDR("10.0.0.0/8"),
	new CIDR("172.16.0.0/12"),
	new CIDR("192.168.0.0/16"),
	new CIDR("fc00::/7"),
	new CIDR("fe80::/10"),
];

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

function servicePortKey(service: V1Service, port: V1ServicePort): string {
	return `${namespacedNameKey(serviceNamespace(service), serviceName(service))}:${port.port}`;
}

function serviceRouteKey(namespace: string, name: string, port: number): string {
	return `${namespacedNameKey(namespace, name)}:${port}`;
}

function serviceNamespace(service: V1Service): string {
	return service.metadata?.namespace ?? "default";
}

function serviceName(service: V1Service): string {
	return service.metadata?.name ?? "";
}

function serviceClusterIP(service: V1Service): string | undefined {
	const clusterIP = service.spec?.clusterIP;
	return clusterIP && clusterIP !== "None" ? clusterIP : undefined;
}

function serviceType(service: V1Service): "ClusterIP" | "NodePort" | undefined {
	const type = service.spec?.type ?? "ClusterIP";
	return type === "ClusterIP" || type === "NodePort" ? type : undefined;
}

function isInternalIPLiteral(host: string): boolean {
	return internalIPCIDRs.some((cidr) => cidr.contains(host));
}

function isLocalhost(host: string): boolean {
	return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function isPodOrigin(origin: FetchOrigin): origin is V1Pod {
	return origin.kind === "Pod" || (origin.spec !== undefined && "containers" in origin.spec);
}

function isNodeOrigin(origin: FetchOrigin): origin is V1Node {
	return origin.kind === "Node" || (origin.status !== undefined && "addresses" in origin.status);
}

export class ClusterNetwork extends EventEmitter {
	private podIpAllocators = new Map<string, PodCIDRAllocator>();
	private podsBySandboxId = new Map<string, PodSandboxInstance>();
	private podsByIp = new Map<string, PodSandboxInstance>();
	private podDnsConfigsByUid = new Map<string, DnsConfig>();
	private nodesByName = new Map<string, V1Node>();
	private nodeIpsByName = new Map<string, Set<string>>();
	private nodeNamesByIp = new Map<string, Set<string>>();
	private nodeAliasesByName = new Map<string, Set<string>>();
	private nodeIpsByAlias = new Map<string, Set<string>>();
	private httpListeners = new Map<string, http.Handler>();
	private dnsListeners = new Map<string, DnsHandler>();
	private servicesByKey = new Map<string, V1Service>();
	private servicesByClusterIp = new Map<string, V1Service>();
	private servicesByNodePort = new Map<number, NodePortRoute>();
	private targetListsByServicePort = new Map<string, TargetList>();
	private nextRequestID = 1;

	constructor(private readonly options: ClusterNetworkOptions = {}) {
		super();
	}

	public override on(event: "request", handler: (event: NetworkRequestEvent) => void): this;
	public override on(event: "response", handler: (event: NetworkResponseEvent) => void): this;
	public override on(
		event: string,
		handler: ((event: NetworkRequestEvent) => void) | ((event: NetworkResponseEvent) => void),
	): this {
		return super.on(event, handler);
	}

	private allocateRequestID(): string {
		return String(this.nextRequestID++);
	}

	private rejectUserRequestIDHeader(headers: http.Header): void {
		if (http.hasHeader(headers, networkRequestIDHeader)) {
			throw new NetworkError(`${networkRequestIDHeader} is managed by ClusterNetwork`);
		}
	}

	setupPodSandbox(pod: PodSandboxInstance, podCIDR: string): NetworkRegistration {
		if (this.podsBySandboxId.has(pod.id)) {
			throw new NetworkError(`pod sandbox ${pod.id} is already registered`);
		}
		const ip = this.allocatePodIp(podCIDR);
		this.podsBySandboxId.set(pod.id, pod);
		this.podsByIp.set(ip, pod);
		if (pod.config.dnsConfig) {
			this.podDnsConfigsByUid.set(pod.uid, pod.config.dnsConfig);
		}
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

	registerNode(node: V1Node): void {
		const name = node.metadata?.name;
		if (!name) {
			throw new NetworkError("node must have metadata.name");
		}
		this.unregisterNode(name);
		const addresses = node.status?.addresses ?? [];
		const ips = new Set(
			addresses
				.filter((address) => address.type === "InternalIP" || address.type === "ExternalIP")
				.map((address) => address.address)
				.filter((address) => isIPLiteral(address)),
		);
		this.nodesByName.set(name, node);
		this.nodeIpsByName.set(name, ips);
		for (const ip of ips) {
			const nodeNames = this.nodeNamesByIp.get(ip) ?? new Set<string>();
			nodeNames.add(name);
			this.nodeNamesByIp.set(ip, nodeNames);
		}
		const firstIp = ips.values().next().value;
		const validAliases = new Set(
			addresses
				.filter(
					(address) =>
						address.type === "Hostname" ||
						address.type === "InternalDNS" ||
						address.type === "ExternalDNS",
				)
				.map((address) => address.address)
				.filter((alias) => alias.length > 0)
				.map((alias) => alias.toLowerCase()),
		);
		this.nodeAliasesByName.set(name, validAliases);
		if (firstIp) {
			for (const alias of validAliases) {
				const aliasIps = this.nodeIpsByAlias.get(alias) ?? new Set<string>();
				aliasIps.add(firstIp);
				this.nodeIpsByAlias.set(alias, aliasIps);
			}
		}
	}

	unregisterNode(name: string): void {
		const ips = this.nodeIpsByName.get(name) ?? new Set<string>();
		const aliases = this.nodeAliasesByName.get(name) ?? new Set<string>();
		if (ips.size === 0 && aliases.size === 0) {
			return;
		}
		this.nodeIpsByName.delete(name);
		for (const ip of ips) {
			const nodeNames = this.nodeNamesByIp.get(ip);
			if (!nodeNames) {
				continue;
			}
			nodeNames.delete(name);
			if (nodeNames.size === 0) {
				this.nodeNamesByIp.delete(ip);
			}
		}
		this.nodeAliasesByName.delete(name);
		this.nodesByName.delete(name);
		for (const alias of aliases) {
			const aliasIps = this.nodeIpsByAlias.get(alias);
			if (!aliasIps) {
				continue;
			}
			for (const ip of ips) {
				aliasIps.delete(ip);
			}
			if (aliasIps.size === 0) {
				this.nodeIpsByAlias.delete(alias);
			}
		}
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
		if (![...this.podsBySandboxId.values()].some((candidate) => candidate.uid === pod.uid)) {
			this.podDnsConfigsByUid.delete(pod.uid);
		}
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

	registerService(service: V1Service): void {
		const name = serviceName(service);
		if (!name) {
			throw new NetworkError("service must have metadata.name");
		}
		const namespace = serviceNamespace(service);
		const clusterIP = serviceClusterIP(service);
		if (!clusterIP) {
			throw new NetworkError(`Service ${namespace}/${name} must have a ClusterIP`);
		}
		const type = serviceType(service);
		if (!type) {
			throw new NetworkError(`unsupported Service type ${service.spec?.type}`);
		}
		const key = namespacedNameKey(namespace, name);
		this.unregisterService(namespace, name);
		this.servicesByKey.set(key, service);
		this.servicesByClusterIp.set(clusterIP, service);
		for (const port of service.spec?.ports ?? []) {
			const routeKey = servicePortKey(service, port);
			this.targetListsByServicePort.set(routeKey, new TargetList());
			if (type === "NodePort" && port.nodePort !== undefined) {
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
		const clusterIP = serviceClusterIP(service);
		if (clusterIP) {
			this.servicesByClusterIp.delete(clusterIP);
		}
		for (const port of service.spec?.ports ?? []) {
			const routeKey = servicePortKey(service, port);
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

	async fetch(
		ctx: context.Context,
		origin: FetchOrigin,
		target: http.FetchInput,
		init: http.FetchInit = {},
	): Promise<http.Response> {
		const method = init.method;
		const headers = http.headerFromInit(init.headers);
		const body = init.body;
		this.rejectUserRequestIDHeader(headers);
		const requestID = this.allocateRequestID();
		const url = this.parseHttpTarget(target);
		const chain: NetworkHop[] = [this.originHop(origin)];
		withRequestIDHeader(headers, requestID);
		let matchedClusterTarget = false;
		if (isLocalhost(url.hostname)) {
			const originalHost = url.host;
			const resolved = this.originIP(origin);
			if (!resolved) {
				throw new NetworkError(`could not resolve ${url.hostname}`);
			}
			url.hostname = resolved;
			withHostHeader(headers, originalHost);
			matchedClusterTarget = true;
		} else if (this.nodeIpsByAlias.has(url.hostname)) {
			const originalHost = url.host;
			const resolved = this.nodeIPForAlias(url.hostname);
			if (!resolved) {
				throw new NetworkError(`could not resolve ${url.hostname}`);
			}
			url.hostname = resolved;
			withHostHeader(headers, originalHost);
			matchedClusterTarget = true;
		} else if (!isIPLiteral(url.hostname)) {
			const originalHost = url.host;
			const resolved = await this.resolveHostname(origin, url.hostname);
			if (!resolved) {
				chain.push({ type: "external", host: url.hostname });
				const request = this.httpRequest(url, method, headers, body);
				await this.emitRequestEvent(ctx, { request, chain });
				let response: http.Response;
				try {
					response = await this.fetchDefault(
						ctx,
						target,
						method,
						withoutRequestIDHeader(headers),
						body,
					);
				} catch (error) {
					await this.emitResponseEvent(ctx, {
						request,
						error: errorFromUnknown(error),
						chain: chain.toReversed(),
					});
					throw error;
				}
				await this.emitResponseEvent(ctx, {
					request,
					response: withResponseIDHeader(response, requestID),
					chain: chain.toReversed(),
				});
				return response;
			}
			url.hostname = resolved;
			withHostHeader(headers, originalHost);
			matchedClusterTarget = true;
		}

		const service = this.servicesByClusterIp.get(url.hostname);
		matchedClusterTarget ||= service !== undefined || this.isClusterAddress(url.hostname);
		if (!matchedClusterTarget) {
			if (isInternalIPLiteral(url.hostname)) {
				if (url.protocol !== "http:") {
					throw new NetworkError(`requests to internal addresses must be http:// for now`);
				}
				const port = this.parseTargetPort(url, service);
				return await this.dispatchResolvedHttp(
					ctx,
					{ endpoint: { ip: url.hostname, port }, chain },
					url,
					method,
					headers,
					body,
					requestID,
				);
			}
			chain.push({ type: "external", host: url.hostname });
			const request = this.httpRequest(url, method, headers, body);
			await this.emitRequestEvent(ctx, { request, chain });
			let response: http.Response;
			try {
				response = await this.fetchDefault(
					ctx,
					target,
					method,
					withoutRequestIDHeader(headers),
					body,
				);
			} catch (error) {
				await this.emitResponseEvent(ctx, {
					request,
					error: errorFromUnknown(error),
					chain: chain.toReversed(),
				});
				throw error;
			}
			await this.emitResponseEvent(ctx, {
				request,
				response: withResponseIDHeader(response, requestID),
				chain: chain.toReversed(),
			});
			return response;
		}
		if (url.protocol !== "http:") {
			throw new NetworkError(`unsupported protocol ${url.protocol}`);
		}
		const port = this.parseTargetPort(url, service);
		let route: NetworkRoute;
		try {
			route = this.routeFetchEndpoint({ ip: url.hostname, port }, chain);
		} catch (error) {
			const networkError = errorFromUnknown(error);
			await this.emitRequestEvent(ctx, {
				request: this.httpRequest(url, method, headers, body),
				chain,
				error: networkError,
			});
			throw error;
		}
		return await this.dispatchResolvedHttp(ctx, route, url, method, headers, body, requestID);
	}

	canConnect(host: string, port: number): boolean {
		const route = this.routeFetchEndpoint({ ip: host, port }, []);
		return this.httpListeners.has(listenerKey(route.endpoint.ip, route.endpoint.port));
	}

	async sendDns(target: string, request: DnsRequest): Promise<DnsResponse> {
		const { endpoint } = this.routeEndpoint(parseEndpointTarget(target), []);
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

	async resolveDns(
		origin: FetchOrigin,
		name: string,
		type: DnsRecordType = "A",
	): Promise<DnsResponse> {
		const dnsConfig = this.dnsConfigForOrigin(origin);
		const serverIp = dnsConfig?.servers[0];
		if (!serverIp) {
			return { rcode: "NXDOMAIN", answers: [] };
		}
		for (const candidate of dnsLookupCandidates(name, dnsConfig.searches, dnsConfig.options)) {
			const response = await this.sendDns(`${serverIp}:53`, { name: candidate, type });
			if (response.rcode !== "NXDOMAIN" || response.answers.length > 0) {
				return response;
			}
		}
		return { rcode: "NXDOMAIN", answers: [] };
	}

	bindHttp(podSandboxId: string, ip: string, port: number, handler: http.Handler): http.Listener {
		if (!this.podsBySandboxId.has(podSandboxId)) {
			throw new NetworkError(`pod sandbox ${podSandboxId} is not registered`);
		}
		const key = listenerKey(ip, port);
		if (this.httpListeners.has(key)) {
			throw new NetworkError(`HTTP listener ${key} is already registered`);
		}
		this.httpListeners.set(key, handler);
		return new http.Listener(ip, port, () => {
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

	private parseHttpTarget(target: http.FetchInput): URL {
		let url: URL;
		try {
			url = new URL(target.toString());
		} catch (error) {
			throw new NetworkError(`invalid HTTP target ${target}`, { cause: error });
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new NetworkError(`unsupported protocol ${url.protocol}`);
		}
		return url;
	}

	private parseTargetPort(url: URL, service?: V1Service): number {
		if (!url.port) {
			const ports = service?.spec?.ports ?? [];
			if (ports.length === 1) {
				return ports[0].port;
			}
			throw new NetworkError(`target ${url.hostname} must include a port`);
		}
		const port = Number(url.port);
		if (!Number.isInteger(port) || port <= 0 || port > 65535) {
			throw new NetworkError(`invalid port ${url.port}`);
		}
		return port;
	}

	private selectEndpoint(service: V1Service, port: V1ServicePort): NetworkEndpoint {
		const key = servicePortKey(service, port);
		const target = this.targetListsByServicePort.get(key)?.next();
		if (!target) {
			throw new NetworkError(
				`Service ${serviceNamespace(service)}/${serviceName(service)} has no ready endpoints`,
			);
		}
		return parseEndpointTarget(target);
	}

	private serviceHop(service: V1Service): NetworkHop {
		return { type: "service", service };
	}

	private podHopForIP(ip: string): NetworkHop | undefined {
		const pod = this.podsByIp.get(ip);
		if (!pod) {
			return undefined;
		}
		return { type: "pod", pod: pod.config.pod };
	}

	private nodeHopForIP(ip: string): NetworkHop | undefined {
		const nodeName = this.nodeNamesByIp.get(ip)?.values().next().value;
		const node = nodeName ? this.nodesByName.get(nodeName) : undefined;
		if (!node) {
			return undefined;
		}
		return { type: "node", node };
	}

	private originHop(origin: FetchOrigin): NetworkHop {
		if (isPodOrigin(origin)) {
			return { type: "pod", pod: origin };
		}
		return { type: "node", node: origin };
	}

	private async resolveHostname(origin: FetchOrigin, name: string): Promise<string | undefined> {
		const response = await this.resolveDns(origin, name, "A");
		// TODO(samwho): should we look for multiple A records and return one at
		// random? Or return all maybe?
		const answer = response.answers.find((value) => value.type === "A");
		return answer?.type === "A" ? answer.address : undefined;
	}

	private dnsConfigForOrigin(origin: FetchOrigin): DnsConfig | undefined {
		const uid = origin.metadata?.uid;
		if (uid) {
			const podDnsConfig = this.podDnsConfigsByUid.get(uid);
			if (podDnsConfig) {
				return podDnsConfig;
			}
		}
		const clusterDNS = this.options.clusterDNS ?? [];
		if (clusterDNS.length === 0) {
			return undefined;
		}
		return { servers: [...clusterDNS], searches: [], options: [] };
	}

	private originIP(origin: FetchOrigin): string | undefined {
		return this.podOriginIP(origin) ?? this.nodeOriginIP(origin);
	}

	private nodeIPForAlias(alias: string): string | undefined {
		return this.nodeIpsByAlias.get(alias)?.values().next().value;
	}

	private isClusterAddress(ip: string): boolean {
		return this.podsByIp.has(ip) || this.nodeNamesByIp.has(ip) || this.servicesByClusterIp.has(ip);
	}

	private podOriginIP(origin: FetchOrigin): string | undefined {
		if (!isPodOrigin(origin)) {
			return undefined;
		}
		const uid = origin.metadata?.uid;
		if (uid) {
			const sandbox = [...this.podsBySandboxId.values()].find((candidate) => candidate.uid === uid);
			if (sandbox) {
				return sandbox.ip;
			}
		}
		return origin.status?.podIP ?? origin.status?.podIPs?.[0]?.ip;
	}

	private nodeOriginIP(origin: FetchOrigin): string | undefined {
		if (!isNodeOrigin(origin)) {
			return undefined;
		}
		return (
			origin.status?.addresses?.find((address) => address.type === "InternalIP")?.address ??
			origin.status?.addresses?.find((address) => address.type === "ExternalIP")?.address
		);
	}

	private routeFetchEndpoint(endpoint: NetworkEndpoint, chain: NetworkHop[]): NetworkRoute {
		if (this.nodeNamesByIp.has(endpoint.ip)) {
			const nodeHop = this.nodeHopForIP(endpoint.ip);
			if (nodeHop) {
				chain.push(nodeHop);
			}
			const route = this.servicesByNodePort.get(endpoint.port);
			if (!route) {
				throw new NetworkError(`no Service for NodePort ${endpoint.port}`);
			}
			chain.push(this.serviceHop(route.service));
			const selected = this.selectEndpoint(route.service, route.port);
			const podHop = this.podHopForIP(selected.ip);
			if (podHop) {
				chain.push(podHop);
			}
			return { endpoint: selected, chain };
		}
		return this.routeEndpoint(endpoint, chain);
	}

	private routeEndpoint(endpoint: NetworkEndpoint, chain: NetworkHop[]): NetworkRoute {
		const service = this.servicesByClusterIp.get(endpoint.ip);
		if (!service) {
			const podHop = this.podHopForIP(endpoint.ip);
			if (podHop) {
				chain.push(podHop);
			}
			return { endpoint, chain };
		}
		chain.push(this.serviceHop(service));
		const port = service.spec?.ports?.find((candidate) => candidate.port === endpoint.port);
		if (!port) {
			throw new NetworkError(
				`Service ${serviceNamespace(service)}/${serviceName(service)} has no port ${endpoint.port}`,
			);
		}
		const selected = this.selectEndpoint(service, port);
		const podHop = this.podHopForIP(selected.ip);
		if (podHop) {
			chain.push(podHop);
		}
		return { endpoint: selected, chain };
	}

	private async emitRequestEvent(
		ctx: context.Context,
		event: Omit<NetworkRequestEvent, "latencyMs">,
	): Promise<void> {
		const latencyMs = getLatencyProvider(ctx).clusterNetworkRequestLatency(event.chain);
		this.emit("request", { ...event, latencyMs });
		await this.waitForLatency(ctx, latencyMs);
	}

	private async emitResponseEvent(
		ctx: context.Context,
		event: Omit<NetworkResponseEvent, "latencyMs">,
	): Promise<void> {
		const latencyMs = getLatencyProvider(ctx).clusterNetworkResponseLatency(event.chain);
		this.emit("response", { ...event, latencyMs });
		await this.waitForLatency(ctx, latencyMs);
	}

	private async waitForLatency(ctx: context.Context, latencyMs: number): Promise<void> {
		if (!(latencyMs > 0)) {
			return;
		}
		const selected = await select()
			.case(ctx.done(), () => ctx.err() ?? context.Canceled)
			.case(time.after(ctx, latencyMs), () => undefined);
		if (selected) {
			throw selected;
		}
	}

	private async dispatchResolvedHttp(
		ctx: context.Context,
		route: NetworkRoute,
		requestURL: URL,
		method: string | undefined,
		headers: http.Header,
		body: string | undefined,
		requestID: string,
	): Promise<http.Response> {
		const request = this.httpRequest(requestURL, method, headers, body);
		if (!this.httpListeners.has(listenerKey(route.endpoint.ip, route.endpoint.port))) {
			const error = new NetworkError(
				`dial tcp ${route.endpoint.ip}:${route.endpoint.port}: connect: connection refused`,
			);
			await this.emitRequestEvent(ctx, { request, chain: route.chain, error });
			throw error;
		}
		await this.emitRequestEvent(ctx, { request, chain: route.chain });
		let response: http.Response;
		try {
			response = await this.dispatchHttp(ctx, route.endpoint, request);
		} catch (error) {
			await this.emitResponseEvent(ctx, {
				request,
				error: errorFromUnknown(error),
				chain: route.chain.toReversed(),
			});
			throw error;
		}
		await this.emitResponseEvent(ctx, {
			request,
			response: withResponseIDHeader(response, requestID),
			chain: route.chain.toReversed(),
		});
		return response;
	}

	private async dispatchHttp(
		ctx: context.Context,
		endpoint: NetworkEndpoint,
		request: http.Request,
	): Promise<http.Response> {
		const handler = this.httpListeners.get(listenerKey(endpoint.ip, endpoint.port));
		if (!handler) {
			throw new NetworkError(
				`dial tcp ${endpoint.ip}:${endpoint.port}: connect: connection refused`,
			);
		}
		try {
			const responseCh = new Channel<http.Response>(1);
			void handler(ctx, request).then(
				(response) => responseCh.trySend(response),
				(error) => {
					responseCh.trySend({
						status: 500,
						body: error instanceof Error ? error.message : "handler error",
					});
				},
			);
			const selected = await select()
				.case(responseCh, ({ value }) => ({ type: "response" as const, response: value }))
				.case(ctx.done(), () => ({ type: "canceled" as const }));
			if (selected.type === "canceled") {
				throw ctx.err() ?? new Error("context canceled");
			}
			return selected.response ?? { status: 500, body: "handler error" };
		} catch (error) {
			if (ctx.err() && error === ctx.err()) {
				throw error;
			}
			return {
				status: 500,
				body: error instanceof Error ? error.message : "handler error",
			};
		}
	}

	private async fetchDefault(
		ctx: context.Context,
		target: http.FetchInput,
		method: string | undefined,
		headers: http.Header,
		body: string | undefined,
	): Promise<http.Response> {
		const abort = new AbortController();
		const responseCh = new Channel<FetchDefaultResult>(1);
		void globalThis
			.fetch(target.toString(), {
				method,
				headers: http.headerEntries(headers),
				body,
				signal: abort.signal,
			})
			.then(async (response) => {
				responseCh.trySend({
					type: "response",
					response: {
						status: response.status,
						header: responseHeaders(response.headers),
						body: await response.text(),
					},
				});
				return undefined;
			})
			.catch((error) => {
				responseCh.trySend({
					type: "error",
					error: new NetworkError(error instanceof Error ? error.message : "fetch failed", {
						cause: error,
					}),
				});
				return undefined;
			});
		const selected: FetchDefaultResult | { type: "canceled" } = await select()
			.case(responseCh, ({ ok, value }) =>
				ok
					? value
					: {
							type: "error" as const,
							error: new NetworkError("fetch failed"),
						},
			)
			.case(ctx.done(), () => ({ type: "canceled" as const }));
		if (selected.type === "canceled") {
			abort.abort();
			throw ctx.err() ?? new Error("context canceled");
		}
		if (selected.type === "error") {
			throw selected.error;
		}
		return selected.response;
	}

	private httpRequest(
		url: URL,
		method: string | undefined,
		headers: http.Header,
		body: string | undefined,
	): http.Request {
		const header = http.headerClone(headers);
		return {
			method: method ?? "GET",
			url,
			header,
			host: http.headerGet(header, "Host"),
			body,
		};
	}
}

function responseHeaders(headers: Headers): http.Header {
	const normalized: http.Header = {};
	headers.forEach((value, name) => {
		(normalized[name] ??= []).push(value);
	});
	return normalized;
}

function errorFromUnknown(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function withHostHeader(headers: http.Header, host: string): void {
	if (!http.hasHeader(headers, "Host")) {
		http.headerSet(headers, "Host", host);
	}
}

function withRequestIDHeader(headers: http.Header, requestID: string): void {
	http.headerSet(headers, networkRequestIDHeader, requestID);
}

function withoutRequestIDHeader(headers: http.Header): http.Header {
	const cloned = http.headerClone(headers);
	http.headerDel(cloned, networkRequestIDHeader);
	return cloned;
}

function withResponseIDHeader(response: http.Response, requestID: string): http.Response {
	const header = http.headerClone(response.header ?? {});
	http.headerSet(header, networkRequestIDHeader, requestID);
	return { ...response, header };
}

function dnsLookupCandidates(
	name: string,
	searches: readonly string[] = [],
	options: readonly string[] = [],
): string[] {
	const trimmedName = name.trim();
	if (trimmedName.endsWith(".")) {
		return [trimmedName.slice(0, -1)];
	}

	const ndots = dnsNdots(options);
	const absoluteFirst = dotCount(trimmedName) >= ndots;
	const searched = searches.map((search) => `${trimmedName}.${search.replace(/\.$/, "")}`);
	return uniqueStrings(absoluteFirst ? [trimmedName, ...searched] : [...searched, trimmedName]);
}

function dnsNdots(options: readonly string[]): number {
	for (const option of options) {
		const match = /^ndots:(\d+)$/.exec(option);
		if (match) {
			return Number(match[1]);
		}
	}
	return 1;
}

function dotCount(value: string): number {
	return [...value].filter((character) => character === ".").length;
}

function uniqueStrings(values: readonly string[]): string[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		if (seen.has(value)) {
			return false;
		}
		seen.add(value);
		return true;
	});
}

export class NetworkRegistration {
	constructor(
		private readonly network: ClusterNetwork,
		readonly podSandboxId: string,
		readonly podUid: string,
		readonly ip: string,
	) {}

	bindHttp(port: number, handler: http.Handler): http.Listener {
		return this.network.bindHttp(this.podSandboxId, this.ip, port, handler);
	}

	bindDns(port: number, handler: DnsHandler): DnsListener {
		return this.network.bindDns(this.podSandboxId, this.ip, port, handler);
	}

	unregister(): void {
		this.network.unregisterPod(this.podSandboxId);
	}
}

function parseEndpointTarget(target: string): NetworkEndpoint {
	const [ip, portValue, ...extra] = target.split(":");
	const port = Number(portValue);
	if (!ip || extra.length > 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new NetworkError(`invalid Service endpoint target ${target}`);
	}
	return { ip, port };
}
