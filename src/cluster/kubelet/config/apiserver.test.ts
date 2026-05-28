import { expect, it } from "vitest";

import type { ListOptions } from "../../../apimachinery/pkg/apis/meta/v1/types";
import type { Interface } from "../../../apimachinery/pkg/watch/watch";
import { newFake } from "../../../apimachinery/pkg/watch/watch";
import type { V1Pod } from "../../../client";
import type { KubeList } from "../../../client/types";
import { Channel } from "../../../go/channel";
import * as context from "../../../go/context";
import { deepEqual } from "../../../deep-equal";
import { browser } from "../../../test/describe";
import type { ListResult, WatchResult } from "../../../client-go/tools/cache/listwatch";
import type { SourceUpdate } from "./config";
import { newSourceApiserverFromLW } from "./apiserver";

browser.describe("apiserver source", () => {
	// Models kubernetes/pkg/kubelet/config/apiserver_test.go TestNewSourceApiserver_UpdatesAndMultiplePods.
	it("updates and multiple pods", async () => {
		const pod1v1 = pod("p", "", "image/one");
		const pod1v2 = pod("p", "", "image/two");
		const pod2 = pod("q", "", "image/blah");

		const [ctx, cancel] = context.withCancel(context.background());
		try {
			const fakeWatch = newFake<V1Pod>();
			const lw = new FakePodLW({
				listResp: podList(pod1v1),
				watchResp: fakeWatch,
			});

			const ch = new Channel<SourceUpdate>();

			newSourceApiserverFromLW(ctx, lw, ch.writeOnly());

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

		const [ctx, cancel] = context.withCancel(context.background());
		try {
			const fakeWatch = newFake<V1Pod>();
			const lw = new FakePodLW({
				listResp: podList(pod1, pod2),
				watchResp: fakeWatch,
			});

			const ch = new Channel<SourceUpdate>();

			newSourceApiserverFromLW(ctx, lw, ch.writeOnly());

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
		const [ctx, cancel] = context.withCancel(context.background());
		try {
			const fakeWatch = newFake<V1Pod>();
			const lw = new FakePodLW({
				listResp: podList(),
				watchResp: fakeWatch,
			});

			const ch = new Channel<SourceUpdate>();

			newSourceApiserverFromLW(ctx, lw, ch.writeOnly());

			const update = await receiveSourceUpdate(ch);
			const expected = createSourceUpdate();
			expect(deepEqual(expected, update)).toBe(true);
		} finally {
			cancel();
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
