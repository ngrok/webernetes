/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import { browser } from "../../../test/describe";
import {
	newThreadSafeStore,
	ThreadSafeMap,
	type ThreadSafeIndexers,
	type ThreadSafeStoreTransaction,
} from "./thread-safe-store";

browser.describe("ThreadSafeStore", () => {
	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store_test.go TestThreadSafeStoreDeleteRemovesEmptySetsFromIndex.
	it("TestThreadSafeStoreDeleteRemovesEmptySetsFromIndex", () => {
		const testIndexer = "testIndexer";

		const indexers: ThreadSafeIndexers<string> = {
			[testIndexer]: (obj) => {
				const indexes = [obj];
				return [indexes, undefined];
			},
		};

		const indices = new Map();
		const store = newThreadSafeStore<string>(indexers, indices) as ThreadSafeMap<string>;

		const testKey = "testKey";

		store.add(testKey, testKey);

		const set = store.storeIndex.indices.get(testIndexer)?.get(testKey);

		if (set?.size !== 1) {
			throw new Error(
				`Initial assumption of index backing string set having 1 element failed. Actual elements: ${set?.size ?? 0}`,
			);
		}

		store.delete(testKey);
		const present = store.storeIndex.indices.get(testIndexer)?.has(testKey) ?? false;

		expect(present).toBe(false);
	});

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store_test.go TestThreadSafeStoreAddKeepsNonEmptySetPostDeleteFromIndex.
	it("TestThreadSafeStoreAddKeepsNonEmptySetPostDeleteFromIndex", () => {
		const testIndexer = "testIndexer";
		const testIndex = "testIndex";

		const indexers: ThreadSafeIndexers<string> = {
			[testIndexer]: () => {
				const indexes = [testIndex];
				return [indexes, undefined];
			},
		};

		const indices = new Map();
		const store = newThreadSafeStore<string>(indexers, indices) as ThreadSafeMap<string>;

		store.add("retain", "retain");
		store.add("delete", "delete");

		let set = store.storeIndex.indices.get(testIndexer)?.get(testIndex);

		if (set?.size !== 2) {
			throw new Error(
				`Initial assumption of index backing string set having 2 elements failed. Actual elements: ${set?.size ?? 0}`,
			);
		}

		store.delete("delete");
		set = store.storeIndex.indices.get(testIndexer)?.get(testIndex);

		expect(set).not.toBeUndefined();
		expect(set?.size).toBe(1);
	});

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store_test.go TestThreadSafeStoreIndexingFunctionsWithMultipleValues.
	it("TestThreadSafeStoreIndexingFunctionsWithMultipleValues", () => {
		const testIndexer = "testIndexer";

		const indexers: ThreadSafeIndexers<string> = {
			[testIndexer]: (obj) => {
				return [obj.split(","), undefined];
			},
		};

		const indices = new Map();
		const store = newThreadSafeStore<string>(indexers, indices) as ThreadSafeMap<string>;

		store.add("key1", "foo");
		store.add("key2", "bar");

		const compare = (key: string, expected: string[]) => {
			const values = sortedValues(store.storeIndex.indices.get(testIndexer)?.get(key));
			expect({ key, values }).toEqual({ key, values: expected });
		};

		compare("foo", ["key1"]);
		compare("bar", ["key2"]);

		store.update("key2", "foo,bar");

		compare("foo", ["key1", "key2"]);
		compare("bar", ["key2"]);

		store.update("key1", "foo,bar");

		compare("foo", ["key1", "key2"]);
		compare("bar", ["key1", "key2"]);

		store.add("key3", "foo,bar,baz");

		compare("foo", ["key1", "key2", "key3"]);
		compare("bar", ["key1", "key2", "key3"]);
		compare("baz", ["key3"]);

		store.update("key1", "foo");

		compare("foo", ["key1", "key2", "key3"]);
		compare("bar", ["key2", "key3"]);
		compare("baz", ["key3"]);

		store.update("key2", "bar");

		compare("foo", ["key1", "key3"]);
		compare("bar", ["key2", "key3"]);
		compare("baz", ["key3"]);

		store.delete("key1");

		compare("foo", ["key3"]);
		compare("bar", ["key2", "key3"]);
		compare("baz", ["key3"]);

		store.delete("key3");

		compare("foo", []);
		compare("bar", ["key2"]);
		compare("baz", []);
	});

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store_test.go TestThreadSafeStoreRV.
	it("TestThreadSafeStoreRV Initial state", () => {
		const store = newThreadSafeStore<object>({}, new Map()) as ThreadSafeMap<object>;
		expect(store.lastStoreSyncResourceVersion()).toBe("");
	});

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store_test.go TestThreadSafeStoreRV.
	it("TestThreadSafeStoreRV Add Update and Delete", () => {
		const store = newThreadSafeStore<unknown>({}, new Map()) as ThreadSafeMap<unknown>;

		store.add("key1", { resourceVersion: "10" });
		expect(store.lastStoreSyncResourceVersion()).toBe("10");

		store.add("key3", { resourceVersion: "10" });
		expect(store.lastStoreSyncResourceVersion()).toBe("10");

		store.add("key4", { resourceVersion: "20" });
		expect(store.lastStoreSyncResourceVersion()).toBe("20");

		store.deleteWithObject("key4", { resourceVersion: "30" });
		expect(store.lastStoreSyncResourceVersion()).toBe("30");

		store.add("key5", "just a string");
		expect(store.lastStoreSyncResourceVersion()).toBe("30");

		store.add("key6", { resourceVersion: "40" });
		expect(store.lastStoreSyncResourceVersion()).toBe("40");

		store.delete("key6");
		expect(store.lastStoreSyncResourceVersion()).toBe("40");

		const txns: Array<ThreadSafeStoreTransaction<object>> = [
			{
				object: { resourceVersion: "40" },
				type: "update",
				key: "key9",
			},
			{
				object: { resourceVersion: "30" },
				type: "update",
				key: "key10",
			},
			{
				object: { resourceVersion: "50" },
				type: "update",
				key: "key11",
			},
		];
		store.transaction(...txns);
		expect(store.lastStoreSyncResourceVersion()).toBe("50");
	});

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store_test.go TestThreadSafeStoreRV.
	it("TestThreadSafeStoreRV Replace", () => {
		const store = newThreadSafeStore<object>({}, new Map()) as ThreadSafeMap<object>;
		store.add("key1", { resourceVersion: "10" });

		expect(store.lastStoreSyncResourceVersion()).toBe("10");

		const items = new Map<string, object>([
			["key3", { resourceVersion: "40" }],
			["key2", { resourceVersion: "30" }],
		]);

		store.replace(items, "50");

		expect(store.lastStoreSyncResourceVersion()).toBe("50");
	});

	// Models staging/src/k8s.io/client-go/tools/cache/thread_safe_store_test.go TestThreadSafeStoreRV.
	it("TestThreadSafeStoreRV Delete", () => {
		const store = newThreadSafeStore<object>({}, new Map()) as ThreadSafeMap<object>;
		store.add("key1", { resourceVersion: "10" });

		expect(store.lastStoreSyncResourceVersion()).toBe("10");

		store.deleteWithObject("key1", { resourceVersion: "20" });

		expect(store.lastStoreSyncResourceVersion()).toBe("20");
	});
});

function sortedValues(set: Set<string> | undefined): string[] {
	return [...(set ?? [])].sort((left, right) => left.localeCompare(right));
}
