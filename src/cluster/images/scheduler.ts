import * as k8s from "../../client";
import { retryConflicts } from "../../retry";
import type { EventRecorder } from "../../client-go/tools/record/event";
import { EventRecorderImpl } from "../events";
import type { ProcessContext } from "../cri";
import { BaseImage } from "./base";

function podKey(pod: V1Pod): string {
	return `${pod.metadata?.namespace ?? "default"}/${pod.metadata?.name ?? ""}`;
}

type V1Pod = k8s.V1Pod;

export class Scheduler extends BaseImage {
	static readonly imageName = "webernetes/kube-scheduler";
	static readonly imageVersion = "1.0";

	readonly defaultCommand = ["kube-scheduler"];
	private events: EventRecorder | undefined;
	private informer: k8s.Informer<V1Pod> | undefined;
	private nextServerIndex = 0;
	private readonly pending = new Set<string>();

	override async exec(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "kube-scheduler") {
			return await super.exec(ctx, argv);
		}
		this.events = new EventRecorderImpl({
			ctx,
			api: ctx.api.corev1,
			component: "default-scheduler",
		});
		this.informer = k8s.makeInformer(
			ctx.kubeConfig,
			"/api/v1/pods",
			async () => await ctx.api.corev1.listPodForAllNamespaces(),
		);
		this.informer.on("add", (pod) => this.schedulePod(ctx, pod));
		this.informer.on("update", (pod) => this.schedulePod(ctx, pod));
		await this.informer.start();
		try {
			return await ctx.waitUntilKilled();
		} finally {
			await this.close();
		}
	}

	private async close(): Promise<void> {
		await this.informer?.stop();
	}

	private schedulePod(ctx: ProcessContext, pod: V1Pod): void {
		const schedulerName = pod.spec?.schedulerName ?? "default-scheduler";
		if (pod.spec?.nodeName || schedulerName !== "default-scheduler" || !pod.metadata?.name) {
			return;
		}
		const key = podKey(pod);
		if (this.pending.has(key)) {
			return;
		}
		this.pending.add(key);
		void this.bindPod(ctx, pod)
			.catch(() => undefined)
			.finally(() => this.pending.delete(key));
	}

	private async bindPod(ctx: ProcessContext, pod: V1Pod): Promise<void> {
		const server = await this.nextServer(ctx);
		let bound: V1Pod | undefined;
		await retryConflicts(ctx, async () => {
			const name = pod.metadata?.name ?? "";
			const namespace = pod.metadata?.namespace ?? "default";
			const current = await ctx.api.corev1.readNamespacedPod({ name, namespace });
			if (current.spec?.nodeName) {
				return;
			}
			await ctx.api.corev1.createNamespacedPodBinding({
				name,
				namespace,
				body: {
					apiVersion: "v1",
					kind: "Binding",
					metadata: { name, namespace },
					target: {
						apiVersion: "v1",
						kind: "Node",
						name: server.name,
					},
				},
			});
			bound = await ctx.api.corev1.readNamespacedPod({ name, namespace });
		});
		if (bound) {
			await this.events?.event(
				bound,
				"Normal",
				"Scheduled",
				`Successfully assigned ${bound.metadata?.namespace ?? "default"}/${bound.metadata?.name ?? ""} to ${server.name}`,
			);
		}
	}

	private async nextServer(ctx: ProcessContext): Promise<{ name: string }> {
		const nodeNames = (await ctx.api.corev1.listNode()).items
			.map((node) => node.metadata?.name)
			.filter((name) => name !== undefined);
		if (nodeNames.length === 0) {
			throw new Error("no schedulable servers are configured");
		}
		const name = nodeNames[this.nextServerIndex % nodeNames.length];
		this.nextServerIndex += 1;
		return { name };
	}
}
