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

export interface NamespaceControllerOptions {
	kubeConfig: k8s.KubeConfig;
}

interface NamespacedResourceDeleter<T extends k8s.KubernetesObject> {
	list(namespace: string): Promise<T[]>;
	delete(name: string, namespace: string): Promise<unknown>;
}

// Models kubernetes/pkg/controller/namespace/namespace_controller.go NamespaceController.
export class NamespaceController extends BaseImage {
	private readonly core: k8s.CoreV1Api;
	private readonly discovery: k8s.DiscoveryV1Api;
	private readonly namespacedResourceDeleters: Array<
		NamespacedResourceDeleter<k8s.KubernetesObject>
	>;
	private readonly queue = new Channel<string>(100);
	private readonly queued = new Set<string>();

	constructor(private readonly options: NamespaceControllerOptions) {
		super();
		this.core = options.kubeConfig.makeApiClient(k8s.CoreV1Api);
		this.discovery = options.kubeConfig.makeApiClient(k8s.DiscoveryV1Api);
		this.namespacedResourceDeleters = [
			{
				list: async (namespace) => (await this.core.listNamespacedPod({ namespace })).items,
				delete: async (name, namespace) =>
					await this.core.deleteNamespacedPod({ name, namespace, gracePeriodSeconds: 0 }),
			},
			{
				list: async (namespace) => (await this.core.listNamespacedService({ namespace })).items,
				delete: async (name, namespace) =>
					await this.core.deleteNamespacedService({ name, namespace }),
			},
			{
				list: async (namespace) =>
					(await this.discovery.listNamespacedEndpointSlice({ namespace })).items,
				delete: async (name, namespace) =>
					await this.discovery.deleteNamespacedEndpointSlice({ name, namespace }),
			},
			{
				list: async (namespace) => (await this.core.listNamespacedEvent({ namespace })).items,
				delete: async (name, namespace) =>
					await this.core.deleteNamespacedEvent({ name, namespace }),
			},
		];
	}

	async start(context: ProcessContext, _argv: readonly string[]): Promise<number> {
		const informer = k8s.makeInformer(
			this.options.kubeConfig,
			"/api/v1/namespaces",
			async () => await this.core.listNamespace(),
		);
		informer.on("add", (namespace) => this.handleNamespace(namespace));
		informer.on("update", (namespace) => this.handleNamespace(namespace));

		await informer.start();

		const worker = this.worker(context);
		try {
			const result = await context.waitUntilKilled();
			return result;
		} finally {
			await informer.stop();
			await worker;
		}
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
	private async syncNamespace(context: ProcessContext, namespaceName: string): Promise<void> {
		const namespace = await this.readNamespace(namespaceName);
		if (!namespace?.metadata?.deletionTimestamp || namespace.spec?.finalizers?.length === 0) {
			return;
		}

		const remaining = await this.deleteAllContent(namespaceName);
		if (remaining) {
			throw new Error(`namespace ${namespaceName} still has content`);
		}
		await retryConflicts(
			async () => {
				const latest = await this.readNamespace(namespaceName);
				if (!latest?.metadata?.deletionTimestamp) {
					return;
				}
				latest.spec ??= {};
				latest.spec.finalizers = (latest.spec.finalizers ?? []).filter(
					(finalizer) => finalizer !== finalizerKubernetes,
				);
				await this.core.replaceNamespace({ name: namespaceName, body: latest });
				await this.core.deleteNamespace({ name: namespaceName });
			},
			{ clock: context.clock },
		);
	}

	// Models kubernetes/pkg/controller/namespace/deletion/namespaced_resources_deleter.go deleteAllContent.
	private async deleteAllContent(namespace: string): Promise<boolean> {
		let remaining = false;
		for (const deleter of this.namespacedResourceDeleters) {
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

	private async readNamespace(name: string): Promise<k8s.V1Namespace | undefined> {
		return await this.ignoreNotFound(() => this.core.readNamespace({ name }));
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
