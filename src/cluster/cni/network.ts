import { CIDR, ipToNumber } from "../../net";
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
import type { V1Node, V1Pod } from "../../client";
import type { DnsConfig } from "../cri/runtime/v1/api";
import type { ServiceInstance, ServicePort } from "./service";
import type { PodSandboxInstance } from "../cri/runtime";

interface NetworkEndpoint {
	ip: string;
	port: number;
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

interface PodCIDRAllocator {
	cidr: CIDR;
	cursor?: string;
}

export type FetchOrigin = V1Pod | V1Node;

export interface ClusterNetworkOptions {
	clusterDNS?: readonly string[];
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

function isLocalhost(host: string): boolean {
	return host === "localhost" || host === "127.0.0.1";
}

function nodeAliasKey(alias: string): string {
	return alias.toLowerCase();
}

function isPodOrigin(origin: FetchOrigin): origin is V1Pod {
	return origin.kind === "Pod" || (origin.spec !== undefined && "containers" in origin.spec);
}

function isNodeOrigin(origin: FetchOrigin): origin is V1Node {
	return origin.kind === "Node" || (origin.status !== undefined && "addresses" in origin.status);
}

export class ClusterNetwork {
	private podIpAllocators = new Map<string, PodCIDRAllocator>();
	private podsBySandboxId = new Map<string, PodSandboxInstance>();
	private podsByIp = new Map<string, PodSandboxInstance>();
	private podDnsConfigsByUid = new Map<string, DnsConfig>();
	private nodeIpsByName = new Map<string, Set<string>>();
	private nodeNamesByIp = new Map<string, Set<string>>();
	private nodeAliasesByName = new Map<string, Set<string>>();
	private nodeIpsByAlias = new Map<string, Set<string>>();
	private httpListeners = new Map<string, http.Handler>();
	private dnsListeners = new Map<string, DnsHandler>();
	private servicesByKey = new Map<string, ServiceInstance>();
	private servicesByClusterIp = new Map<string, ServiceInstance>();
	private servicesByNodePort = new Map<number, NodePortRoute>();
	private serviceEndpointRoutes = new Map<string, ServiceEndpointRoute>();
	private targetListsByServicePort = new Map<string, TargetList>();

	constructor(private readonly options: ClusterNetworkOptions = {}) {}

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

	registerNode(
		name: string,
		ipAddresses: readonly string[],
		aliases: readonly string[] = [],
	): void {
		this.unregisterNode(name);
		const ips = new Set(ipAddresses.filter((address) => isIpLiteral(address)));
		this.nodeIpsByName.set(name, ips);
		for (const ip of ips) {
			const nodeNames = this.nodeNamesByIp.get(ip) ?? new Set<string>();
			nodeNames.add(name);
			this.nodeNamesByIp.set(ip, nodeNames);
		}
		const firstIp = ips.values().next().value;
		const validAliases = new Set(
			aliases.filter((alias) => alias.length > 0).map((alias) => nodeAliasKey(alias)),
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

	async fetch(
		ctx: context.Context,
		origin: FetchOrigin,
		target: http.FetchInput,
		init: http.FetchInit = {},
	): Promise<http.Response> {
		const url = this.parseHttpTarget(target);
		if (isLocalhost(url.hostname)) {
			const originalHost = url.host;
			const resolved = this.originIP(origin);
			if (!resolved) {
				throw new NetworkError(`could not resolve ${url.hostname}`);
			}
			url.hostname = resolved;
			init = withHostHeader(init, originalHost);
		} else if (this.nodeIpsByAlias.has(url.hostname)) {
			const originalHost = url.host;
			const resolved = this.nodeIPForAlias(url.hostname);
			if (!resolved) {
				throw new NetworkError(`could not resolve ${url.hostname}`);
			}
			url.hostname = resolved;
			init = withHostHeader(init, originalHost);
		} else if (!isIpLiteral(url.hostname)) {
			const originalHost = url.host;
			const resolved = await this.resolveHostname(origin, url.hostname);
			if (!resolved) {
				throw new NetworkError(`could not resolve ${url.hostname}`);
			}
			url.hostname = resolved;
			init = withHostHeader(init, originalHost);
		}

		const service = this.servicesByClusterIp.get(url.hostname);
		const port = this.parseTargetPort(url, service);
		const endpoint = this.routeFetchEndpoint({ ip: url.hostname, port });
		return await this.dispatchHttp(ctx, endpoint, url, init);
	}

	canConnect(host: string, port: number): boolean {
		const endpoint = this.routeFetchEndpoint({ ip: host, port });
		return this.httpListeners.has(listenerKey(endpoint.ip, endpoint.port));
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

	private selectEndpoint(service: ServiceInstance, port: ServicePort): NetworkEndpoint {
		const key = servicePortKey(service, port);
		const target = this.targetListsByServicePort.get(key)?.next();
		if (!target) {
			throw new NetworkError(`Service ${service.namespace}/${service.name} has no ready endpoints`);
		}
		return parseEndpointTarget(target);
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

	private routeFetchEndpoint(endpoint: NetworkEndpoint): NetworkEndpoint {
		if (this.nodeNamesByIp.has(endpoint.ip)) {
			const route = this.servicesByNodePort.get(endpoint.port);
			if (!route) {
				throw new NetworkError(`no Service for NodePort ${endpoint.port}`);
			}
			return this.selectEndpoint(route.service, route.port);
		}
		return this.routeEndpoint(endpoint);
	}

	private routeEndpoint(endpoint: NetworkEndpoint): NetworkEndpoint {
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
		ctx: context.Context,
		endpoint: NetworkEndpoint,
		requestURL: URL,
		init: http.FetchInit,
	): Promise<http.Response> {
		const handler = this.httpListeners.get(listenerKey(endpoint.ip, endpoint.port));
		if (!handler) {
			throw new NetworkError(
				`dial tcp ${endpoint.ip}:${endpoint.port}: connect: connection refused`,
			);
		}
		try {
			const responseCh = new Channel<http.Response>(1);
			void handler(ctx, this.httpRequest(requestURL, init)).then(
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

	private httpRequest(url: URL, init: http.FetchInit): http.Request {
		const header = normalizeHeaders(init.headers);
		return {
			method: init.method ?? "GET",
			url,
			header,
			host: http.headerGet(header, "Host"),
			body: init.body,
		};
	}
}

function normalizeHeaders(headers: http.HeadersInit | undefined): http.Header {
	const normalized: http.Header = {};
	if (!headers) {
		return normalized;
	}
	const append = (name: string, value: string) => {
		(normalized[name] ??= []).push(value);
	};
	if (Symbol.iterator in Object(headers)) {
		for (const [name, value] of headers as Iterable<readonly [string, string]>) {
			append(name, value);
		}
		return normalized;
	}
	if (
		typeof headers === "object" &&
		"forEach" in headers &&
		typeof headers.forEach === "function"
	) {
		headers.forEach((value, name) => append(name, value));
		return normalized;
	}
	for (const [name, value] of Object.entries(headers)) {
		append(name, value);
	}
	return normalized;
}

function withHostHeader(init: http.FetchInit, host: string): http.FetchInit {
	const headers = headerEntries(init.headers);
	if (!headers.some(([key]) => key.toLowerCase() === "host")) {
		headers.push(["Host", host]);
	}
	return { ...init, headers };
}

function headerEntries(headers: http.HeadersInit | undefined): Array<[string, string]> {
	const entries: Array<[string, string]> = [];
	if (!headers) {
		return entries;
	}
	if (Symbol.iterator in Object(headers)) {
		for (const [name, value] of headers as Iterable<readonly [string, string]>) {
			entries.push([name, value]);
		}
		return entries;
	}
	if (
		typeof headers === "object" &&
		"forEach" in headers &&
		typeof headers.forEach === "function"
	) {
		headers.forEach((value, name) => entries.push([name, value]));
		return entries;
	}
	for (const [name, value] of Object.entries(headers)) {
		entries.push([name, value]);
	}
	return entries;
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
