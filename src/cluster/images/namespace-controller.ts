/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import * as k8s from "../../client";
import { isNotFoundError } from "../../client/errors";
import { retryConflicts } from "../../retry";
import { Channel, select } from "../../go/channel";
import type { ProcessContext } from "../cri";
import { BaseImage } from "./base";

// Models kubernetes/staging/src/k8s.io/api/core/v1/types.go FinalizerKubernetes.
const finalizerKubernetes = "kubernetes";

interface NamespacedResourceDeleter<T extends k8s.KubernetesObject> {
	list(namespace: string): Promise<T[]>;
	delete(name: string, namespace: string): Promise<unknown>;
}

// Models kubernetes/pkg/controller/namespace/namespace_controller.go NamespaceController.
export class NamespaceController extends BaseImage {
	static readonly imageName = "webernetes/namespace-controller";
	static readonly imageVersion = "1.0";

	readonly defaultCommand = ["namespace-controller"];
	private readonly queue = new Channel<string>(100);
	private readonly queued = new Set<string>();

	override async exec(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "namespace-controller") {
			return await super.exec(ctx, argv);
		}
		const informer = k8s.makeInformer(
			ctx.kubeConfig,
			"/api/v1/namespaces",
			async () => await ctx.api.corev1.listNamespace(),
		);
		informer.on("add", (namespace) => this.handleNamespace(namespace));
		informer.on("update", (namespace) => this.handleNamespace(namespace));

		await informer.start();

		const worker = this.worker(ctx);
		try {
			const result = await ctx.waitUntilKilled();
			return result;
		} finally {
			await informer.stop();
			await worker;
		}
	}

	private newNamespacedResourceDeleters(
		ctx: ProcessContext,
	): Array<NamespacedResourceDeleter<k8s.KubernetesObject>> {
		return [
			{
				list: async (namespace) => (await ctx.api.corev1.listNamespacedPod({ namespace })).items,
				delete: async (name, namespace) =>
					await ctx.api.corev1.deleteNamespacedPod({
						name,
						namespace,
						gracePeriodSeconds: 0,
					}),
			},
			{
				list: async (namespace) =>
					(await ctx.api.corev1.listNamespacedService({ namespace })).items,
				delete: async (name, namespace) =>
					await ctx.api.corev1.deleteNamespacedService({ name, namespace }),
			},
			{
				list: async (namespace) =>
					(await ctx.api.discoveryv1.listNamespacedEndpointSlice({ namespace })).items,
				delete: async (name, namespace) =>
					await ctx.api.discoveryv1.deleteNamespacedEndpointSlice({ name, namespace }),
			},
			{
				list: async (namespace) => (await ctx.api.corev1.listNamespacedEvent({ namespace })).items,
				delete: async (name, namespace) =>
					await ctx.api.corev1.deleteNamespacedEvent({ name, namespace }),
			},
		];
	}

	private async handleNamespace(namespace: k8s.V1Namespace): Promise<void> {
		if (!namespace.metadata?.deletionTimestamp) {
			return;
		}

		const name = namespace.metadata?.name;
		if (!name || this.queued.has(name)) {
			return;
		}

		this.queued.add(name);
		await this.queue.send(name);
	}

	private async worker(ctx: ProcessContext): Promise<void> {
		while (true) {
			const selected = await select()
				.case(ctx.done(), () => undefined)
				.case(this.queue, ({ value }) => value);
			if (!selected) {
				return;
			}
			this.queued.delete(selected);
			try {
				await this.syncNamespace(ctx, selected);
			} catch {
				if (!ctx.err()) {
					await ctx.sleep(1000);
					this.queued.add(selected);
					await this.queue.send(selected);
				}
			}
		}
	}

	// Models kubernetes/pkg/controller/namespace/deletion/namespaced_resources_deleter.go Delete.
	private async syncNamespace(ctx: ProcessContext, namespaceName: string): Promise<void> {
		const namespace = await this.readNamespace(ctx, namespaceName);
		if (!namespace?.metadata?.deletionTimestamp || namespace.spec?.finalizers?.length === 0) {
			return;
		}

		const remaining = await this.deleteAllContent(ctx, namespaceName);
		if (remaining) {
			throw new Error(`namespace ${namespaceName} still has content`);
		}
		await retryConflicts(
			async () => {
				const latest = await this.readNamespace(ctx, namespaceName);
				if (!latest?.metadata?.deletionTimestamp) {
					return;
				}
				latest.spec ??= {};
				latest.spec.finalizers = (latest.spec.finalizers ?? []).filter(
					(finalizer) => finalizer !== finalizerKubernetes,
				);
				await ctx.api.corev1.replaceNamespace({ name: namespaceName, body: latest });
				await ctx.api.corev1.deleteNamespace({ name: namespaceName });
			},
			{ clock: ctx.clock },
		);
	}

	// Models kubernetes/pkg/controller/namespace/deletion/namespaced_resources_deleter.go deleteAllContent.
	private async deleteAllContent(ctx: ProcessContext, namespace: string): Promise<boolean> {
		let remaining = false;
		for (const deleter of this.newNamespacedResourceDeleters(ctx)) {
			remaining = (await this.deleteAllContentForResource(deleter, namespace)) || remaining;
		}
		return remaining;
	}

	// Models kubernetes/pkg/controller/namespace/deletion/namespaced_resources_deleter.go deleteAllContentForGroupVersionResource.
	private async deleteAllContentForResource<T extends k8s.KubernetesObject>(
		deleter: NamespacedResourceDeleter<T>,
		namespace: string,
	): Promise<boolean> {
		const items = await deleter.list(namespace);
		await Promise.all(
			items.map(async (item) => {
				const name = item.metadata?.name;
				if (!name) {
					return;
				}
				await this.ignoreNotFound(() => deleter.delete(name, namespace));
			}),
		);
		return (await deleter.list(namespace)).length > 0;
	}

	private async readNamespace(
		ctx: ProcessContext,
		name: string,
	): Promise<k8s.V1Namespace | undefined> {
		return await this.ignoreNotFound(() => ctx.api.corev1.readNamespace({ name }));
	}

	private async ignoreNotFound<T>(operation: () => Promise<T>): Promise<T | undefined> {
		try {
			return await operation();
		} catch (error) {
			if (isNotFoundError(error)) {
				return undefined;
			}
			throw error;
		}
	}
}
