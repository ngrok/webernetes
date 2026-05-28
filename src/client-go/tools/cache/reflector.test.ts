import { expect, it, vi } from "vitest";

import type { ListOptions } from "../../../apimachinery/pkg/apis/meta/v1/types";
import { GroupVersionKind } from "../../../apimachinery/pkg/runtime/schema/group_version";
import type { Event, Interface } from "../../../apimachinery/pkg/watch/watch";
import { Clock } from "../../../clock";
import type { KubernetesObject, KubeList } from "../../../client/types";
import { Channel, type ReadOnlyChannel } from "../../../go/channel";
import * as context from "../../../go/context";
import { browser } from "../../../test/describe";
import { newFIFO, type Queue } from "./fifo";
import { ListWatch, type WatchResult } from "./listwatch";
import {
	errorStopRequested,
	handleWatch,
	newReflector,
	newReflectorWithOptions,
	type ReflectorStore,
	VeryShortWatchError,
} from "./reflector";
import { metaNamespaceKeyFunc } from "./store";

interface TestPod extends KubernetesObject {
	metadata: {
		name: string;
		namespace?: string;
		resourceVersion?: string;
		annotations?: Record<string, string>;
	};
}

browser.describe("Reflector", () => {
	// Models staging/src/k8s.io/client-go/tools/cache/reflector_test.go TestReflectorWatchStoppedBefore.
	it("does not start watch when context is canceled before watch", async () => {
		const store = new TestStore<TestPod>();
		const [ctx, cancel] = context.withCancelCause(context.background());
		cancel(new Error("don't run"));
		let listCalled = false;
		let watchCalled = false;
		const lw = new ListWatch<TestPod>({
			listFunc: () => {
				listCalled = true;
				return [{ metadata: {}, items: [] }, undefined];
			},
			watchFunc: (): WatchResult<TestPod> => {
				watchCalled = true;
				return [new FakeWatcher<TestPod>(), undefined];
			},
		});
		const reflector = newReflector(lw, mkPod("expected", ""), store, 0);

		const err = await reflector.watch(ctx, undefined, undefined);

		expect(err).toBeUndefined();
		expect(listCalled).toBe(false);
		expect(watchCalled).toBe(false);
	});

	// Models staging/src/k8s.io/client-go/tools/cache/reflector_test.go TestReflectorWatchStoppedAfter.
	it("stops watcher when context is canceled after watch starts", async () => {
		const store = new TestStore<TestPod>();
		const [ctx, cancel] = context.withCancelCause(context.background());
		const clock = new Clock();
		const watchers: Array<FakeWatcher<TestPod>> = [];
		const lw = new ListWatch<TestPod>({
			listFunc: () => {
				throw new Error("ListFunc called unexpectedly");
			},
			watchFunc: (): WatchResult<TestPod> => {
				clock.setTimeout(() => cancel(new Error("10ms timeout reached")), 10);
				const watcher = new FakeWatcher<TestPod>();
				watchers.push(watcher);
				return [watcher, undefined];
			},
		});
		const reflector = newReflector(lw, mkPod("expected", ""), store, 0);

		const watchPromise = reflector.watch(ctx, undefined, undefined);
		const err = await watchPromise;

		expect(err).toBeUndefined();
		expect(watchers).toHaveLength(1);
		expect(watchers[0]?.stopped).toBe(true);
	});

	// Models staging/src/k8s.io/client-go/tools/cache/reflector_test.go TestReflectorWatchHandler.
	it("handles watch events by updating the store and resourceVersion", async () => {
		const store = new TestStore<TestPod>();
		const reflector = newReflector(new ListWatch<TestPod>(), mkPod("expected", ""), store, 0);
		const [ctx, cancel] = context.withCancelCause(context.background());
		const watcher = new FakeWatcher<TestPod>();

		await store.add(mkPod("foo", ""));
		await store.add(mkPod("bar", ""));

		const watchPromise = handleWatch(
			ctx,
			new Date(0),
			watcher,
			store,
			mkPod("expected", ""),
			undefined,
			"test-reflector",
			"v1, Kind=Pod",
			(_rv) => {
				reflector.setLastSyncResourceVersion(_rv);
				if (_rv === "32") {
					cancel(new Error("LastSyncResourceVersion is 32"));
				}
			},
			new Clock(),
		);
		await watcher.add(service("rejected", "") as TestPod);
		await watcher.delete(mkPod("foo", ""));
		await watcher.modify(mkPod("bar", "55"));
		await watcher.add(mkPod("baz", "32"));

		const err = await watchPromise;

		expect(err).toBe(errorStopRequested);
		expect(store.get("foo")).toBeUndefined();
		expect(store.get("rejected")).toBeUndefined();
		expect(store.get("bar")?.metadata.resourceVersion).toBe("55");
		expect(store.get("baz")?.metadata.resourceVersion).toBe("32");
		expect(reflector.lastSyncResourceVersion()).toBe("32");
	});

	// Models staging/src/k8s.io/client-go/tools/cache/reflector_test.go TestReflectorHandleWatchStoppedBefore.
	it("stops the watcher when context is already canceled before handleWatch", async () => {
		const store = new TestStore<TestPod>();
		const [ctx, cancel] = context.withCancelCause(context.background());
		cancel(new Error("don't run"));
		const watcher = new FakeWatcher<TestPod>();

		const clock = new Clock();
		const err = await handleWatch(
			ctx,
			clock.now(),
			watcher,
			store,
			undefined,
			undefined,
			"test-reflector",
			"<unspecified>",
			() => {},
			clock,
		);

		expect(err).toBe(errorStopRequested);
		expect(watcher.stopped).toBe(true);
		expect(watcher.calls).toEqual(["ResultChan", "Stop"]);
	});

	// Models staging/src/k8s.io/client-go/tools/cache/reflector_test.go TestReflectorHandleWatchStoppedAfter.
	it("stops the watcher when context is canceled after handleWatch starts", async () => {
		const store = new TestStore<TestPod>();
		const [ctx, cancel] = context.withCancelCause(context.background());
		const clock = new Clock();
		const resultCh = new Channel<Event<TestPod>>(10);
		const watcher = new FakeWatcher<TestPod>({
			resultChan: (): ReadOnlyChannel<Event<TestPod>> => {
				clock.setTimeout(() => cancel(new Error("10ms timeout reached")), 10);
				return resultCh.readOnly();
			},
		});

		const watchPromise = handleWatch(
			ctx,
			clock.now(),
			watcher,
			store,
			undefined,
			undefined,
			"test-reflector",
			"<unspecified>",
			() => {},
			clock,
		);

		const err = await watchPromise;

		expect(err).toBe(errorStopRequested);
		expect(watcher.stopped).toBe(true);
		expect(watcher.calls).toEqual(["ResultChan", "Stop"]);
	});

	// Models staging/src/k8s.io/client-go/tools/cache/reflector_test.go TestReflectorHandleWatchResultChanClosedBefore.
	it("returns a very short watch error when the result channel closes without events", async () => {
		const store = new TestStore<TestPod>();
		const watcher = new FakeWatcher<TestPod>();
		watcher.close();

		const err = await handleWatch(
			context.background(),
			new Date(Date.now()),
			watcher,
			store,
			undefined,
			undefined,
			"test-reflector",
			"<unspecified>",
			() => {},
			new Clock(),
		);

		expect(err).toBeInstanceOf(VeryShortWatchError);
		expect(watcher.stopped).toBe(true);
		expect(watcher.calls).toEqual(["ResultChan", "Stop"]);
	});

	// Models staging/src/k8s.io/client-go/tools/cache/reflector_test.go TestReflectorHandleWatchResultChanClosedAfter.
	it("returns a very short watch error when the result channel closes after handleWatch starts", async () => {
		const store = new TestStore<TestPod>();
		const clock = new Clock();
		const resultCh = new Channel<Event<TestPod>>(10);
		const watcher = new FakeWatcher<TestPod>({
			resultChan: (): ReadOnlyChannel<Event<TestPod>> => {
				clock.setTimeout(() => resultCh.close(), 10);
				return resultCh.readOnly();
			},
		});

		const watchPromise = handleWatch(
			context.background(),
			clock.now(),
			watcher,
			store,
			undefined,
			undefined,
			"test-reflector",
			"<unspecified>",
			() => {},
			clock,
		);

		const err = await watchPromise;

		expect(err).toBeInstanceOf(VeryShortWatchError);
		expect(watcher.stopped).toBe(true);
		expect(watcher.calls).toEqual(["ResultChan", "Stop"]);
	});

	// Models staging/src/k8s.io/client-go/tools/cache/reflector_test.go TestReflectorStopWatch.
	it("stops watch when context is canceled before handleWatch", async () => {
		const store = new TestStore<TestPod>();
		const [ctx, cancel] = context.withCancelCause(context.background());
		cancel(new Error("don't run"));
		const watcher = new FakeWatcher<TestPod>();

		const err = await handleWatch(
			ctx,
			new Date(0),
			watcher,
			store,
			undefined,
			undefined,
			"test-reflector",
			"<unspecified>",
			() => {},
			new Clock(),
		);

		expect(err).toBe(errorStopRequested);
	});

	// Models staging/src/k8s.io/client-go/tools/cache/reflector_test.go TestReflectorListAndWatch.
	it.each([
		{
			name: "UseWatchList enabled",
			useWatchList: true,
			listResults: [],
			watchEvents: [
				watchEvent("ADDED", mkPod("foo", "1")),
				watchEvent("BOOKMARK", mkPod("foo", "1", { "k8s.io/initial-events-end": "true" })),
				watchEvent("MODIFIED", mkPod("foo", "2")),
				watchEvent("ADDED", mkPod("bar", "3")),
				watchEvent("ADDED", mkPod("baz", "4")),
				watchEvent("ADDED", mkPod("qux", "5")),
				watchEvent("ADDED", mkPod("zoo", "6")),
			],
			expectedListOptions: [],
			expectedWatchOptions: [],
			expectedStore: [],
			// We don't support this, for now.
			expectedError: "watch-list reflector mode is not implemented",
		},
		{
			name: "UseWatchList disabled",
			useWatchList: false,
			listResults: [
				{
					object: mkList("1", mkPod("foo", "1")),
					error: undefined,
				},
			],
			watchEvents: [
				watchEvent("MODIFIED", mkPod("foo", "2")),
				watchEvent("ADDED", mkPod("bar", "3")),
				watchEvent("ADDED", mkPod("baz", "4")),
				watchEvent("ADDED", mkPod("qux", "5")),
				watchEvent("ADDED", mkPod("zoo", "6")),
			],
			expectedListOptions: [
				{
					allowWatchBookmarks: false,
					resourceVersion: "0",
					limit: 500,
				},
			],
			expectedWatchOptions: [
				{
					allowWatchBookmarks: true,
					resourceVersion: "1",
				},
			],
			expectedStore: [
				mkPod("foo", "2"),
				mkPod("bar", "3"),
				mkPod("baz", "4"),
				mkPod("qux", "5"),
				mkPod("zoo", "6"),
			],
			expectedError: undefined,
		},
	])("$name", async (tc) => {
		const store = newFIFO<TestPod>(metaNamespaceKeyFunc);
		let watcherResolve: (watcher: FakeWatcher<TestPod>) => void = () => {};
		const watcherPromise = new Promise<FakeWatcher<TestPod>>((resolve) => {
			watcherResolve = resolve;
		});
		const listOptions: ListOptions[] = [];
		const watchOptions: ListOptions[] = [];
		const lw = new ListWatch<TestPod>({
			listFunc: (options) => {
				listOptions.push(options);
				if (listOptions.length > tc.listResults.length) {
					return [
						undefined,
						new Error(
							`Expected ListerWatcher.List to only be called ${tc.listResults.length} times`,
						),
					];
				}
				const listResult = tc.listResults[listOptions.length - 1];
				return [listResult?.object, listResult?.error];
			},
			watchFunc: (options): WatchResult<TestPod> => {
				watchOptions.push(options);
				if (watchOptions.length > tc.expectedWatchOptions.length) {
					return [
						undefined,
						new Error(
							`Expected ListerWatcher.Watch to only be called ${tc.expectedWatchOptions.length} times`,
						),
					];
				}
				const watcher = new FakeWatcher<TestPod>();
				watcherResolve(watcher);
				return [watcher, undefined];
			},
		});
		const reflector = newReflectorWithOptions(lw, mkPod("expected", ""), store, {
			useWatchList: tc.useWatchList,
		});
		const [ctx, cancel] = context.withCancel(context.background());

		const errPromise = reflector.listAndWatchWithContext(ctx);
		if (!tc.expectedError) {
			const watcher = await watcherPromise;
			for (const event of tc.watchEvents) {
				await watcher.action(event);
			}
			await vi.waitFor(() => {
				if (store.list().length !== tc.expectedStore.length) {
					throw new Error(
						`expected store size ${tc.expectedStore.length}, got ${store.list().length}`,
					);
				}
			});
			cancel();
		}

		const err = await errPromise;

		expect(err?.message).toBe(tc.expectedError);
		expect(listOptions).toEqual(tc.expectedListOptions);
		expect(stripTimeoutSeconds(watchOptions)).toEqual(tc.expectedWatchOptions);
		for (const expectedObj of tc.expectedStore) {
			const storeObj = await pop(store);
			expect(storeObj?.metadata.name).toBe(expectedObj.metadata.name);
			expect(storeObj?.metadata.resourceVersion).toBe(expectedObj.metadata.resourceVersion);
		}
	});

	// Models staging/src/k8s.io/client-go/tools/cache/reflector_test.go TestReflectorListAndWatchWithErrors.
	it("lists and watches across errors", async () => {
		const listError = new Error("a list error");
		const watchError = new Error("a watch error");
		const table: Array<{
			list?: KubeList<TestPod>;
			listErr?: Error;
			events?: Array<Event<TestPod>>;
			watchErr?: Error;
		}> = [
			{
				list: mkList("1"),
				events: [watchEvent("ADDED", mkPod("foo", "2")), watchEvent("ADDED", mkPod("bar", "3"))],
			},
			{
				list: mkList("3", mkPod("foo", "2"), mkPod("bar", "3")),
				events: [watchEvent("DELETED", mkPod("foo", "4")), watchEvent("ADDED", mkPod("qux", "5"))],
			},
			{
				listErr: listError,
			},
			{
				list: mkList("5", mkPod("bar", "3"), mkPod("qux", "5")),
				watchErr: watchError,
			},
			{
				list: mkList("5", mkPod("bar", "3"), mkPod("qux", "5")),
				events: [watchEvent("ADDED", mkPod("baz", "6"))],
			},
			{
				list: mkList("6", mkPod("bar", "3"), mkPod("qux", "5"), mkPod("baz", "6")),
			},
		];

		const store = newFIFO<TestPod>(metaNamespaceKeyFunc);
		for (const [line, item] of table.entries()) {
			expectStoreMatchesList(store, item.list, line);
			let watchErr = item.watchErr;
			const [ctx, cancel] = context.withCancelCause(context.background());
			const lw = new ListWatch<TestPod>({
				watchFunc: (): WatchResult<TestPod> => {
					if (watchErr) {
						return [undefined, watchErr];
					}
					watchErr = new Error("second watch");
					const watcher = new FakeWatcher<TestPod>({}, 0);
					void (async () => {
						for (const event of item.events ?? []) {
							await watcher.action(event);
						}
						cancel(new Error("done"));
					})();
					return [watcher, undefined];
				},
				listFunc: () => [item.list, item.listErr],
			});
			const reflector = newReflector(lw, mkPod("expected", ""), store, 0);

			const err = await reflector.listAndWatchWithContext(ctx);

			expect(err).toBe(item.listErr ?? item.watchErr);
		}
	});
});

browser.describe("Reflector simulator behavior", () => {
	it("skips watch events with an unexpected group version kind", async () => {
		const store = new TestStore<TestPod>();
		const [ctx, cancel] = context.withCancel(context.background());
		const watcher = new FakeWatcher<TestPod>();

		const watchPromise = handleWatch(
			ctx,
			new Date(0),
			watcher,
			store,
			undefined,
			new GroupVersionKind("", "v1", "Pod"),
			"test-reflector",
			"/v1, Kind=Pod",
			(rv) => {
				if (rv === "2") {
					cancel();
				}
			},
			new Clock(),
		);
		await watcher.add({
			apiVersion: "apps/v1",
			kind: "Pod",
			metadata: { name: "wrong", resourceVersion: "1" },
		});
		await watcher.add(mkPod("right", "2"));

		const err = await watchPromise;

		expect(err).toBe(errorStopRequested);
		expect(store.get("wrong")).toBeUndefined();
		expect(store.get("right")).toBeDefined();
	});

	it("forwards resync errors into the watch loop", async () => {
		const clock = new Clock();
		clock.pause();
		const store = new TestStore<TestPod>();
		const expectedError = new Error("resync failed");
		store.resyncError = expectedError;
		const watcher = new FakeWatcher<TestPod>();
		const lw = new ListWatch<TestPod>({
			watchFunc: (): WatchResult<TestPod> => [watcher, undefined],
		});
		const reflector = newReflectorWithOptions(lw, mkPod("expected", ""), store, {
			clock,
			resyncPeriodMs: 10,
		});

		const watchPromise = reflector.watchWithResync(context.background(), watcher);
		await Promise.resolve();
		await clock.wait(10);

		const err = await watchPromise;

		expect(err).toBeUndefined();
		expect(store.resyncCalls).toBe(1);
		expect(watcher.stopped).toBe(true);
	});

	it("returns an explicit error when watch-list mode is enabled", async () => {
		const store = new TestStore<TestPod>();
		const lw = new ListWatch<TestPod>();
		const reflector = newReflectorWithOptions(lw, mkPod("expected", ""), store, {
			useWatchList: true,
		});

		const err = await reflector.listAndWatchWithContext(context.background());

		expect(err?.message).toBe("watch-list reflector mode is not implemented");
	});
});

class TestStore<T extends KubernetesObject> implements ReflectorStore<T> {
	private objects = new Map<string, T>();
	resyncCalls = 0;
	resyncError: Error | undefined;

	async add(obj: T): Promise<Error | undefined> {
		this.objects.set(key(obj), obj);
		return undefined;
	}

	async update(obj: T): Promise<Error | undefined> {
		this.objects.set(key(obj), obj);
		return undefined;
	}

	async delete(obj: T): Promise<Error | undefined> {
		this.objects.delete(key(obj));
		return undefined;
	}

	async replace(list: T[], _resourceVersion: string): Promise<Error | undefined> {
		this.objects = new Map(list.map((obj) => [key(obj), obj]));
		return undefined;
	}

	async resync(): Promise<Error | undefined> {
		this.resyncCalls++;
		return this.resyncError;
	}

	get(name: string, namespace = ""): T | undefined {
		return this.objects.get(`${namespace}/${name}`);
	}

	size(): number {
		return this.objects.size;
	}

	list(): T[] {
		return [...this.objects.values()];
	}
}

class FakeWatcher<T extends KubernetesObject> implements Interface<T> {
	readonly ch: Channel<Event<T>>;
	readonly calls: string[] = [];
	stopped = false;

	constructor(
		private readonly overrides: {
			stop?: () => void;
			resultChan?: () => ReadOnlyChannel<Event<T>>;
		} = {},
		capacity = 10,
	) {
		this.ch = new Channel<Event<T>>(capacity);
	}

	stop(): void {
		if (this.stopped) {
			return;
		}
		this.calls.push("Stop");
		if (this.overrides.stop) {
			this.overrides.stop();
			return;
		}
		this.stopped = true;
		try {
			this.ch.close();
		} catch {
			// Tests may close the result channel first, then assert stop was called.
		}
	}

	resultChan(): ReadOnlyChannel<Event<T>> {
		this.calls.push("ResultChan");
		if (this.overrides.resultChan) {
			return this.overrides.resultChan();
		}
		return this.ch.readOnly();
	}

	async add(object: T): Promise<void> {
		await this.ch.send({ type: "ADDED", object });
	}

	async modify(object: T): Promise<void> {
		await this.ch.send({ type: "MODIFIED", object });
	}

	async delete(object: T): Promise<void> {
		await this.ch.send({ type: "DELETED", object });
	}

	async action(event: Event<T>): Promise<void> {
		await this.ch.send(event);
	}

	close(): void {
		this.ch.close();
	}
}

function mkPod(
	name: string,
	resourceVersion: string,
	annotations?: Record<string, string>,
): TestPod {
	return {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			name,
			resourceVersion,
			annotations,
		},
	};
}

function service(name: string, resourceVersion: string): KubernetesObject {
	return {
		apiVersion: "v1",
		kind: "Service",
		metadata: {
			name,
			resourceVersion,
		},
	};
}

function mkList(resourceVersion: string, ...items: TestPod[]): KubeList<TestPod> {
	return {
		metadata: { resourceVersion },
		items,
	};
}

function watchEvent(type: Event<TestPod>["type"], object: TestPod): Event<TestPod> {
	return { type, object };
}

function stripTimeoutSeconds(options: ListOptions[]): ListOptions[] {
	return options.map(({ timeoutSeconds: _timeoutSeconds, ...option }) => option);
}

function expectStoreMatchesList<T extends KubernetesObject>(
	store: { list(): T[] },
	list: KubeList<T> | undefined,
	line: number,
): void {
	if (!list) {
		return;
	}
	const checkMap = new Map(
		store.list().map((pod) => [pod.metadata?.name ?? "", pod.metadata?.resourceVersion ?? ""]),
	);
	for (const pod of list.items ?? []) {
		const resourceVersion = checkMap.get(pod.metadata?.name ?? "");
		if (resourceVersion !== pod.metadata?.resourceVersion) {
			throw new Error(
				`${line}: expected ${pod.metadata?.resourceVersion}, got ${resourceVersion} for pod ${pod.metadata?.name}`,
			);
		}
	}
	if ((list.items ?? []).length !== checkMap.size) {
		throw new Error(`${line}: expected ${(list.items ?? []).length}, got ${checkMap.size}`);
	}
}

function key(obj: KubernetesObject): string {
	return `${obj.metadata?.namespace ?? ""}/${obj.metadata?.name ?? ""}`;
}

async function pop<T extends KubernetesObject>(queue: Queue<T>): Promise<T | undefined> {
	const [obj] = await queue.pop(() => undefined);
	return obj;
}
