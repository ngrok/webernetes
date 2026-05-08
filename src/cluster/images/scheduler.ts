import * as k8s from "../../client";
import { retryConflicts } from "../../retry-update";
import type { ProcessContext } from "../cri";
import { BaseImage } from "./base";

function podKey(pod: V1Pod): string {
	return `${pod.metadata?.namespace ?? "default"}/${pod.metadata?.name ?? ""}`;
}

type V1Pod = k8s.V1Pod;

export class Scheduler extends BaseImage {
	private readonly api: k8s.CoreV1Api;
	private informer: k8s.Informer<V1Pod> | undefined;
	private nextServerIndex = 0;
	private readonly pending = new Set<string>();
	private stopped = false;

	constructor(
		private readonly kubeConfig: k8s.KubeConfig,
		private readonly nodeNames: readonly string[],
	) {
		super();
		this.api = kubeConfig.makeApiClient(k8s.CoreV1Api);
	}

	async start(context: ProcessContext, _argv: readonly string[]): Promise<number> {
		this.informer = k8s.makeInformer(
			this.kubeConfig,
			"/api/v1/pods",
			async () => await this.api.listPodForAllNamespaces(),
		);
		this.informer.on("add", (pod) => this.schedulePod(pod, context));
		this.informer.on("update", (pod) => this.schedulePod(pod, context));
		await this.informer.start();
		try {
			return await context.waitUntilKilled();
		} finally {
			await this.close();
		}
	}

	private async close(): Promise<void> {
		this.stopped = true;
		await this.informer?.stop();
	}

	private schedulePod(pod: V1Pod, context: ProcessContext): void {
		if (this.stopped || pod.spec?.nodeName || !pod.metadata?.name) {
			return;
		}
		const key = podKey(pod);
		if (this.pending.has(key)) {
			return;
		}
		this.pending.add(key);
		void this.bindPod(pod, context)
			.catch(() => undefined)
			.finally(() => this.pending.delete(key));
	}

	private async bindPod(pod: V1Pod, context: ProcessContext): Promise<void> {
		const server = this.nextServer();
		await retryConflicts(
			async () => {
				const current = await this.api.readNamespacedPod({
					name: pod.metadata?.name ?? "",
					namespace: pod.metadata?.namespace ?? "default",
				});
				if (current.spec?.nodeName) {
					return;
				}
				current.spec ??= { containers: [] };
				current.spec.nodeName = server.name;
				await this.api.replaceNamespacedPod({
					name: current.metadata?.name ?? "",
					namespace: current.metadata?.namespace ?? "default",
					body: current,
				});
			},
			{
				clock: context.clock,
			},
		);
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
