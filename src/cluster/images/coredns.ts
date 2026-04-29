import * as k8s from "../../client";
import type { DnsRequest, DnsResponse } from "../cni";
import type { ImageDefinition, ProcessContext } from "../cri";

const SERVICE_TTL_SECONDS = 30;

export interface CoreDNSOptions {
	kubeConfig: k8s.KubeConfig;
}

export class CoreDNS implements ImageDefinition {
	private readonly api: k8s.CoreV1Api;
	private serviceInformer: k8s.Informer<k8s.V1Service> | undefined;
	private readonly services = new Map<string, k8s.V1Service>();

	constructor(private readonly options: CoreDNSOptions) {
		this.api = options.kubeConfig.makeApiClient(k8s.CoreV1Api);
	}

	async start(context: ProcessContext, _argv: readonly string[]): Promise<number> {
		await this.startInformer();
		context.listenDns(53, async (request) => this.resolve(request));
		try {
			return await context.waitUntilKilled();
		} finally {
			await this.close();
		}
	}

	async exec(_context: ProcessContext, _argv: readonly string[]): Promise<number> {
		return 0;
	}

	private async close(): Promise<void> {
		await this.serviceInformer?.stop();
	}

	private async startInformer(): Promise<void> {
		this.serviceInformer = k8s.makeInformer(
			this.options.kubeConfig,
			"/api/v1/services",
			async () => await this.api.listServiceForAllNamespaces(),
		);
		this.serviceInformer.on("add", (service) => this.upsertService(service));
		this.serviceInformer.on("update", (service) => this.upsertService(service));
		this.serviceInformer.on("delete", (service) => this.deleteService(service));
		await this.serviceInformer.start();
	}

	private upsertService(service: k8s.V1Service): void {
		this.services.set(serviceKey(service), service);
	}

	private deleteService(service: k8s.V1Service): void {
		this.services.delete(serviceKey(service));
	}

	private resolve(request: DnsRequest): DnsResponse {
		if (request.type !== "A") {
			return { rcode: "NXDOMAIN", answers: [] };
		}
		const parsed = parseServiceDnsName(request.name);
		if (!parsed) {
			return { rcode: "NXDOMAIN", answers: [] };
		}
		const service = this.services.get(namespacedNameKey(parsed.namespace, parsed.name));
		const clusterIp = service?.spec?.clusterIP;
		if (!clusterIp || clusterIp === "None") {
			return { rcode: "NXDOMAIN", answers: [] };
		}
		return {
			rcode: "NOERROR",
			answers: [
				{
					type: "A",
					name: request.name,
					address: clusterIp,
					ttl: SERVICE_TTL_SECONDS,
				},
			],
		};
	}
}

function parseServiceDnsName(value: string): { namespace: string; name: string } | undefined {
	const name = value.endsWith(".") ? value.slice(0, -1) : value;
	const parts = name.split(".");
	if (parts.length !== 5 || parts[2] !== "svc" || parts[3] !== "cluster" || parts[4] !== "local") {
		return undefined;
	}
	return {
		name: parts[0],
		namespace: parts[1],
	};
}

function serviceKey(service: k8s.V1Service): string {
	return namespacedNameKey(service.metadata?.namespace ?? "default", service.metadata?.name ?? "");
}

function namespacedNameKey(namespace: string, name: string): string {
	return `${namespace}/${name}`;
}
