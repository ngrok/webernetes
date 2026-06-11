/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it, vi } from "vitest";

import type { ListOptions } from "../../../apimachinery/pkg/apis/meta/v1/types";
import type { Interface } from "../../../apimachinery/pkg/watch/watch";
import { newFake } from "../../../apimachinery/pkg/watch/watch";
import type { V1Pod } from "../../../client";
import type { KubeList } from "../../../client/types";
import { Channel } from "../../../go/channel";
import * as context from "../../../go/context";
import { deepEqual } from "../../../deep-equal";
import { browser } from "../../../test/describe";
import type {
	ListResult,
	ListWatchClient,
	WatchResult,
} from "../../../client-go/tools/cache/listwatch";
import type { SourceUpdate } from "./config";
import {
	newSourceApiserver,
	newSourceApiserverFromLW,
	waitForAPIServerSyncPeriodMs,
} from "./apiserver";

browser.describe("apiserver source", ({ ctx }) => {
	// Models kubernetes/pkg/kubelet/config/apiserver_test.go TestNewSourceApiserver_UpdatesAndMultiplePods.
	it("updates and multiple pods", async () => {
		const pod1v1 = pod("p", "", "image/one");
		const pod1v2 = pod("p", "", "image/two");
		const pod2 = pod("q", "", "image/blah");

		const [childCtx, cancel] = context.withCancel(ctx);
		try {
			const fakeWatch = newFake<V1Pod>();
			const lw = new FakePodLW({
				listResp: podList(pod1v1),
				watchResp: fakeWatch,
			});

			const ch = new Channel<SourceUpdate>();

			newSourceApiserverFromLW(childCtx, lw, ch.writeOnly());

			let update = await receiveSourceUpdate(ch);
			let expected = createSourceUpdate(pod1v1);
			expect(deepEqual(expected, update)).toBe(true);

			await fakeWatch.add(pod2);
			update = await receiveSourceUpdate(ch);
			let expectedA = createSourceUpdate(pod1v1, pod2);
			let expectedB = createSourceUpdate(pod2, pod1v1);
			expect(deepEqual(expectedA, update) || deepEqual(expectedB, update)).toBe(true);

			await fakeWatch.modify(pod1v2);
			update = await receiveSourceUpdate(ch);
			expectedA = createSourceUpdate(pod1v2, pod2);
			expectedB = createSourceUpdate(pod2, pod1v2);
			expect(deepEqual(expectedA, update) || deepEqual(expectedB, update)).toBe(true);

			await fakeWatch.delete(pod1v2);
			update = await receiveSourceUpdate(ch);
			expected = createSourceUpdate(pod2);
			expect(deepEqual(expected, update)).toBe(true);

			await fakeWatch.delete(pod2);
			update = await receiveSourceUpdate(ch);
			expected = createSourceUpdate();
			expect(deepEqual(expected, update)).toBe(true);
		} finally {
			cancel();
		}
	});

	// Models kubernetes/pkg/kubelet/config/apiserver_test.go TestNewSourceApiserver_TwoNamespacesSameName.
	it("keeps pods with the same name in different namespaces", async () => {
		const pod1 = pod("p", "one", "image/one");
		const pod2 = pod("p", "two", "image/blah");

		const [childCtx, cancel] = context.withCancel(ctx);
		try {
			const fakeWatch = newFake<V1Pod>();
			const lw = new FakePodLW({
				listResp: podList(pod1, pod2),
				watchResp: fakeWatch,
			});

			const ch = new Channel<SourceUpdate>();

			newSourceApiserverFromLW(childCtx, lw, ch.writeOnly());

			let update = await receiveSourceUpdate(ch);
			expect(update.pods).toHaveLength(2);

			await fakeWatch.delete(pod1);
			update = await receiveSourceUpdate(ch);
			expect(update.pods).toHaveLength(1);
		} finally {
			cancel();
		}
	});

	// Models kubernetes/pkg/kubelet/config/apiserver_test.go TestNewSourceApiserverInitialEmptySendsEmptyPodUpdate.
	it("sends empty pod update for initial empty list", async () => {
		const [childCtx, cancel] = context.withCancel(ctx);
		try {
			const fakeWatch = newFake<V1Pod>();
			const lw = new FakePodLW({
				listResp: podList(),
				watchResp: fakeWatch,
			});

			const ch = new Channel<SourceUpdate>();

			newSourceApiserverFromLW(childCtx, lw, ch.writeOnly());

			const update = await receiveSourceUpdate(ch);
			const expected = createSourceUpdate();
			expect(deepEqual(expected, update)).toBe(true);
		} finally {
			cancel();
		}
	});

	it("waits for node sync before watching apiserver pods", async () => {
		vi.useFakeTimers();
		const [childCtx, cancel] = context.withCancel(ctx);
		try {
			let synced = false;
			const fakeWatch = newFake<V1Pod>();
			const lw = new FakePodListWatchClient({
				listResp: podList(pod("p", "", "image/one")),
				watchResp: fakeWatch,
			});
			const ch = new Channel<SourceUpdate>(10);

			newSourceApiserver(childCtx, lw, "node-1", () => synced, ch.writeOnly());

			await Promise.resolve();
			expect(lw.listOptions).toEqual([]);
			expect(lw.watchOptions).toEqual([]);

			synced = true;
			await vi.advanceTimersByTimeAsync(waitForAPIServerSyncPeriodMs);

			const update = await receiveSourceUpdate(ch);
			await Promise.resolve();
			expect(update.pods).toHaveLength(1);
			expect(lw.listOptions).toHaveLength(1);
			expect(lw.watchOptions).toHaveLength(1);
		} finally {
			cancel();
			vi.useRealTimers();
		}
	});

	it("sets a field selector for the node name", async () => {
		const [childCtx, cancel] = context.withCancel(ctx);
		try {
			const fakeWatch = newFake<V1Pod>();
			const lw = new FakePodListWatchClient({
				listResp: podList(pod("p", "", "image/one")),
				watchResp: fakeWatch,
			});
			const ch = new Channel<SourceUpdate>(10);

			newSourceApiserver(childCtx, lw, "node-1", () => true, ch.writeOnly());

			await receiveSourceUpdate(ch);
			await Promise.resolve();
			expect(lw.listOptions).toHaveLength(1);
			expect(lw.listOptions[0]).toMatchObject({
				resourceVersion: "0",
				fieldSelector: "spec.nodeName=node-1",
			});
			await vi.waitFor(() => {
				expect(lw.watchOptions).toHaveLength(1);
			});
			expect(lw.watchOptions[0]).toMatchObject({
				resourceVersion: lw.listResp.metadata?.resourceVersion,
				allowWatchBookmarks: true,
				timeoutSeconds: 300,
				watch: true,
				fieldSelector: "spec.nodeName=node-1",
			});
		} finally {
			cancel();
		}
	});

	it("stops waiting for node sync when the context is canceled", async () => {
		vi.useFakeTimers();
		const [childCtx, cancel] = context.withCancel(ctx);
		try {
			const fakeWatch = newFake<V1Pod>();
			const lw = new FakePodListWatchClient({
				listResp: podList(pod("p", "", "image/one")),
				watchResp: fakeWatch,
			});
			const ch = new Channel<SourceUpdate>(10);

			newSourceApiserver(childCtx, lw, "node-1", () => false, ch.writeOnly());
			cancel();
			await vi.advanceTimersByTimeAsync(waitForAPIServerSyncPeriodMs);
			await Promise.resolve();

			expect(lw.listOptions).toEqual([]);
			expect(lw.watchOptions).toEqual([]);
		} finally {
			cancel();
			vi.useRealTimers();
		}
	});
});

// Models kubernetes/pkg/kubelet/config/apiserver_test.go fakePodLW.
class FakePodLW {
	constructor(
		private readonly options: {
			listResp: KubeList<V1Pod>;
			watchResp: Interface<V1Pod>;
		},
	) {}

	// Models kubernetes/pkg/kubelet/config/apiserver_test.go fakePodLW.List.
	async list(_options: ListOptions): Promise<ListResult<V1Pod>> {
		return [this.options.listResp, undefined];
	}

	// Models kubernetes/pkg/kubelet/config/apiserver_test.go fakePodLW.Watch.
	async watch(_options: ListOptions): Promise<WatchResult<V1Pod>> {
		return [this.options.watchResp, undefined];
	}

	// Models kubernetes/pkg/kubelet/config/apiserver_test.go fakePodLW.IsWatchListSemanticsUnSupported.
	isWatchListSemanticsUnsupported(): boolean {
		return true;
	}
}

class FakePodListWatchClient implements ListWatchClient<V1Pod> {
	readonly listOptions: ListOptions[] = [];
	readonly watchOptions: ListOptions[] = [];
	readonly listResp: KubeList<V1Pod>;

	constructor(
		private readonly options: {
			listResp: KubeList<V1Pod>;
			watchResp: Interface<V1Pod>;
		},
	) {
		this.listResp = options.listResp;
	}

	async list(
		_resource: string,
		_namespace: string,
		options: ListOptions,
	): Promise<ListResult<V1Pod>> {
		this.listOptions.push(options);
		return [this.options.listResp, undefined];
	}

	async watch(
		_resource: string,
		_namespace: string,
		options: ListOptions,
	): Promise<WatchResult<V1Pod>> {
		this.watchOptions.push(options);
		return [this.options.watchResp, undefined];
	}
}

function pod(name: string, namespace: string, image: string): V1Pod {
	return {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			name,
			namespace,
			resourceVersion: nextResourceVersion(),
		},
		spec: {
			containers: [{ name: "container", image }],
		},
	};
}

function podList(...items: V1Pod[]): KubeList<V1Pod> {
	return {
		metadata: {
			resourceVersion: nextResourceVersion(),
		},
		items,
	};
}

function createSourceUpdate(...pods: V1Pod[]): SourceUpdate {
	return { pods };
}

async function receiveSourceUpdate(ch: Channel<SourceUpdate>): Promise<SourceUpdate> {
	const result = await ch.receive();
	if (!result.ok) {
		throw new Error("source update channel closed");
	}
	return result.value;
}

let resourceVersion = 0;

function nextResourceVersion(): string {
	resourceVersion++;
	return String(resourceVersion);
}
