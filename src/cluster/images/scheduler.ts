import * as k8s from "../../client";
import type { ImageDefinition, ProcessContext } from "../cri";

function podKey(pod: V1Pod): string {
	return `${pod.metadata?.namespace ?? "default"}/${pod.metadata?.name ?? ""}`;
}

type V1Pod = k8s.V1Pod;

export class Scheduler implements ImageDefinition {
	private readonly api: k8s.CoreV1Api;
	private informer: k8s.Informer<V1Pod> | undefined;
	private nextServerIndex = 0;
	private readonly pending = new Set<string>();
	private stopped = false;

	constructor(
		private readonly kubeConfig: k8s.KubeConfig,
		private readonly nodeNames: readonly string[],
	) {
		this.api = kubeConfig.makeApiClient(k8s.CoreV1Api);
	}

	async start(context: ProcessContext, _argv: readonly string[]): Promise<number> {
		this.informer = k8s.makeInformer(
			this.kubeConfig,
			"/api/v1/pods",
			async () => await this.api.listPodForAllNamespaces(),
		);
		this.informer.on("add", (pod) => this.schedulePod(pod));
		this.informer.on("update", (pod) => this.schedulePod(pod));
		await this.informer.start();
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
		this.stopped = true;
		await this.informer?.stop();
	}

	private schedulePod(pod: V1Pod): void {
		if (this.stopped || pod.spec?.nodeName || !pod.metadata?.name) {
			return;
		}
		const key = podKey(pod);
		if (this.pending.has(key)) {
			return;
		}
		this.pending.add(key);
		void this.bindPod(pod)
			.catch(() => undefined)
			.finally(() => this.pending.delete(key));
	}

	private async bindPod(pod: V1Pod): Promise<void> {
		const server = this.nextServer();
		for (let attempt = 0; attempt < 5; attempt++) {
			const current = await this.api.readNamespacedPod({
				name: pod.metadata?.name ?? "",
				namespace: pod.metadata?.namespace ?? "default",
			});
			if (!current || current.spec?.nodeName) {
				return;
			}
			current.spec ??= { containers: [] };
			current.spec.nodeName = server.name;
			try {
				await this.api.replaceNamespacedPod({
					name: current.metadata?.name ?? "",
					namespace: current.metadata?.namespace ?? "default",
					body: current,
				});
				return;
			} catch (error) {
				if (error instanceof Error && error.message.includes("HTTP-Code: 409")) {
					continue;
				}
				throw error;
			}
		}
	}

	private nextServer() {
		if (this.nodeNames.length === 0) {
			throw new Error("no schedulable servers are configured");
		}
		const name = this.nodeNames[this.nextServerIndex % this.nodeNames.length];
		this.nextServerIndex += 1;
		return { name };
	}
}
