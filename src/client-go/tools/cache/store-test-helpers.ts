import { expect } from "vitest";

import type { KubernetesObject } from "../../../client/types";
import type { Indexer } from "./index";
import { ExplicitKey, type Store } from "./store";

export interface TestStoreObject extends KubernetesObject {
	id: string;
	val: string;
	nested?: {
		val: string;
	};
}

// Models staging/src/k8s.io/client-go/tools/cache/store_test.go doTestStore.
export async function doTestStore(store: Store<TestStoreObject>): Promise<void> {
	const mkObj = (id: string, val: string): TestStoreObject => ({ id, val });

	await store.add(mkObj("foo", "bar"));
	let [item, ok] = await store.get(mkObj("foo", ""));
	expect(ok).toBe(true);
	expect(item?.val).toBe("bar");

	await store.update(mkObj("foo", "baz"));
	[item, ok] = await store.get(mkObj("foo", ""));
	expect(ok).toBe(true);
	expect(item?.val).toBe("baz");

	await store.delete(mkObj("foo", ""));
	[, ok] = await store.get(mkObj("foo", ""));
	expect(ok).toBe(false);

	await store.add(mkObj("a", "b"));
	await store.add(mkObj("c", "d"));
	await store.add(mkObj("e", "e"));
	let found = new Set(store.list().map((listItem) => listItem.val));
	expect(found).toEqual(new Set(["b", "d", "e"]));

	await store.replace([mkObj("foo", "foo"), mkObj("bar", "bar")], "0");

	found = new Set(store.list().map((listItem) => listItem.val));
	expect(found).toEqual(new Set(["foo", "bar"]));
}

// Models staging/src/k8s.io/client-go/tools/cache/store_test.go doTestIndex.
export async function doTestIndex(indexer: Indexer<TestStoreObject>): Promise<void> {
	const mkObj = (id: string, val: string): TestStoreObject => ({ id, val });

	const expected = new Map([
		["b", new Set(["a", "c"])],
		["f", new Set(["e"])],
		["h", new Set(["g"])],
	]);
	await indexer.add(mkObj("a", "b"));
	await indexer.add(mkObj("c", "b"));
	await indexer.add(mkObj("e", "f"));
	await indexer.add(mkObj("g", "h"));

	for (const [key, expectedIds] of expected) {
		const [indexResults, err] = await indexer.index("by_val", mkObj("", key));
		expect(err).toBeUndefined();
		expect(new Set(indexResults.map((item) => item.id))).toEqual(expectedIds);
	}
}

// Models staging/src/k8s.io/client-go/tools/cache/store_test.go testStoreKeyFunc.
export function testStoreKeyFunc(obj: TestStoreObject | ExplicitKey): [string, Error | undefined] {
	if (obj instanceof ExplicitKey) {
		return [obj.key, undefined];
	}
	return [obj.id, undefined];
}

// Models staging/src/k8s.io/client-go/tools/cache/store_test.go testStoreIndexFunc.
export function testStoreIndexFunc(obj: TestStoreObject): [string[], Error | undefined] {
	return [[obj.val], undefined];
}

// Models staging/src/k8s.io/client-go/tools/cache/store_test.go testStoreIndexers.
export function testStoreIndexers() {
	return { by_val: testStoreIndexFunc };
}

export function isTestStoreObject(obj: KubernetesObject | undefined): obj is TestStoreObject {
	return obj !== undefined && "id" in obj && "val" in obj;
}
