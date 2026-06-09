import * as k8s from "../../client";
import type { DnsRequest, DnsResponse } from "../cni";
import type { ProcessContext } from "../cri";
import { BaseImage } from "./base";

const SERVICE_TTL_SECONDS = 30;

export class CoreDNS extends BaseImage {
	static readonly imageName = "webernetes/coredns";
	static readonly imageVersion = "1.0";

	readonly defaultCommand = ["coredns"];
	private serviceInformer: k8s.Informer<k8s.V1Service> | undefined;
	private readonly services = new Map<string, k8s.V1Service>();

	override async exec(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "coredns") {
			return await super.exec(ctx, argv);
		}
		await this.startInformer(ctx);
		ctx.listenDns(53, async (request) => this.resolve(request));
		try {
			return await ctx.waitUntilKilled();
		} finally {
			await this.close();
		}
	}

	private async close(): Promise<void> {
		await this.serviceInformer?.stop();
	}

	private async startInformer(ctx: ProcessContext): Promise<void> {
		this.serviceInformer = k8s.makeInformer(
			ctx.kubeConfig,
			"/api/v1/services",
			async () => await ctx.api.corev1.listServiceForAllNamespaces(),
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
