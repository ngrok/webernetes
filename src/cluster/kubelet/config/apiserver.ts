/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { ListOptions } from "../../../apimachinery/pkg/apis/meta/v1/types";
import {
	type EventType,
	type Interface as WatchInterface,
} from "../../../apimachinery/pkg/watch/watch";
import * as k8s from "../../../client";
import type { V1Pod } from "../../../client";
import { Clock } from "../../../clock";
import { Channel, select, type ReadOnlyChannel, type SendChannel } from "../../../go/channel";
import * as context from "../../../go/context";
import { Mutex } from "../../../go/sync/mutex";
import * as time from "../../../go/time";
import { oneTermEqualSelector } from "../../../apimachinery/pkg/fields/selector";
import {
	type ListResult,
	newListWatchFromClient,
	type ListerWatcher,
	type ListWatchClient,
	type WatchResult,
} from "../../../client-go/tools/cache/listwatch";
import { newReflectorWithOptions } from "../../../client-go/tools/cache/reflector";
import { metaNamespaceKeyFunc } from "../../../client-go/tools/cache/store";
import { newUndeltaStore } from "../../../client-go/tools/cache/undelta_store";
import type { SourceUpdate } from "./config";

// Models kubernetes/pkg/kubelet/config/apiserver.go WaitForAPIServerSyncPeriod.
export const waitForAPIServerSyncPeriodMs = 1000;

// Simulator-specific adapter for NewSourceApiserver. Upstream passes
// c.CoreV1().RESTClient() to client-go's NewListWatchFromClient; the simulator
// has no copied REST request surface, so this adapter wraps the Node.js
// Kubernetes SDK-shaped fake client and watch API at the pod resource boundary.
export class PodListWatchClient implements ListWatchClient<V1Pod> {
	private readonly corev1: k8s.CoreV1Api;
	private readonly watcher: k8s.Watch;

	constructor(kubeConfig: k8s.KubeConfig) {
		this.corev1 = kubeConfig.makeApiClient(k8s.CoreV1Api);
		this.watcher = new k8s.Watch(kubeConfig);
	}

	list(
		resource: string,
		namespace: string,
		options: ListOptions,
	): Promise<ListResult<V1Pod>> | ListResult<V1Pod> {
		if (resource !== "pods") {
			return [undefined, new Error(`unsupported list resource: ${resource}`)];
		}
		return this.listPods(namespace, options);
	}

	watch(
		resource: string,
		namespace: string,
		options: ListOptions,
	): Promise<WatchResult<V1Pod>> | WatchResult<V1Pod> {
		if (resource !== "pods") {
			return [undefined, new Error(`unsupported watch resource: ${resource}`)];
		}
		return this.watchPods(namespace, options);
	}

	private async listPods(namespace: string, options: ListOptions): Promise<ListResult<V1Pod>> {
		try {
			if (namespace !== "") {
				return [await this.corev1.listNamespacedPod({ namespace, ...options }), undefined];
			}
			return [await this.corev1.listPodForAllNamespaces({ ...options }), undefined];
		} catch (error) {
			return [undefined, errorFromUnknown(error)];
		}
	}

	private async watchPods(namespace: string, options: ListOptions): Promise<WatchResult<V1Pod>> {
		try {
			const path =
				namespace === ""
					? "/api/v1/pods"
					: `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`;
			const watcher = new PodWatch(this.watcher, path, options);
			await watcher.start();
			return [watcher, undefined];
		} catch (error) {
			return [undefined, errorFromUnknown(error)];
		}
	}
}

class PodWatch implements WatchInterface<V1Pod> {
	private readonly result = new Channel<{
		type: EventType;
		object: V1Pod;
	}>(100);
	private controller: AbortController | undefined;
	private stopped = false;
	private readonly lock = new Mutex();

	constructor(
		private readonly watch: k8s.Watch,
		private readonly path: string,
		private readonly options: ListOptions,
	) {}

	async start(): Promise<void> {
		this.controller = await this.watch.watch(
			this.path,
			{ ...this.options },
			(phase, apiObj) => {
				void this.result
					.send({ type: phase as EventType, object: apiObj as V1Pod })
					.catch(() => {});
			},
			() => {
				void this.closeResult();
			},
		);
	}

	async stop(): Promise<void> {
		await this.lock.withLock(() => {
			if (this.stopped) {
				return;
			}
			this.stopped = true;
			this.controller?.abort();
			this.closeResultLocked();
		});
	}

	resultChan(): ReadOnlyChannel<{ type: EventType; object: V1Pod }> {
		return this.result.readOnly();
	}

	private async closeResult(): Promise<void> {
		await this.lock.withLock(() => {
			if (this.stopped) {
				return;
			}
			this.stopped = true;
			this.closeResultLocked();
		});
	}

	private closeResultLocked(): void {
		try {
			this.result.close();
		} catch {
			// The fake watch API can report completion at the same time Stop is called.
		}
	}
}

function errorFromUnknown(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}
	return new Error(String(error));
}

// Models kubernetes/pkg/kubelet/config/apiserver.go NewSourceApiserver.
export function newSourceApiserver(
	ctx: context.Context,
	client: ListWatchClient<V1Pod>,
	nodeName: string,
	nodeHasSynced: () => boolean,
	updates: SendChannel<SourceUpdate>,
	clock = new Clock(),
): void {
	const lw = newListWatchFromClient(
		client,
		"pods",
		"",
		oneTermEqualSelector("spec.nodeName", nodeName),
	);

	void (async () => {
		for (;;) {
			if (ctx.err()) {
				return;
			}
			if (nodeHasSynced()) {
				break;
			}
			const selected = await select()
				.case(ctx.done(), () => "done" as const)
				.case(time.after(clock, waitForAPIServerSyncPeriodMs), () => "timer" as const);
			if (selected === "done") {
				return;
			}
		}
		newSourceApiserverFromLW(ctx, lw, updates, clock);
	})();
}

// Models kubernetes/pkg/kubelet/config/apiserver.go newSourceApiserverFromLW.
export function newSourceApiserverFromLW(
	ctx: context.Context,
	lw: ListerWatcher<V1Pod>,
	updates: SendChannel<SourceUpdate>,
	clock = new Clock(),
): void {
	const send = async (objs: V1Pod[]) => {
		const pods: V1Pod[] = [];
		for (const obj of objs) {
			pods.push(obj);
		}
		await updates.send({ pods });
	};
	const store = newUndeltaStore(send, metaNamespaceKeyFunc);
	const r = newReflectorWithOptions(lw, emptyPod(), store, {
		resyncPeriodMs: 0,
		clock,
	});
	void r.runWithContext(ctx);
}

function emptyPod(): V1Pod {
	return {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {},
	};
}
