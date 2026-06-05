import { expect, it } from "vitest";

import type { KubernetesObject } from "../../../client/types";
import { browser } from "../../../test/describe";
import { ExplicitKey, KeyError, newStore, withTransformer, type Store } from "./store";

interface TestStoreObject extends KubernetesObject {
	id: string;
	val: string;
	nested?: {
		val: string;
	};
}

browser.describe("Store", () => {
	// Models staging/src/k8s.io/client-go/tools/cache/store_test.go TestCache.
	it("implements the public store interface", async () => {
		expect.hasAssertions();
		await doTestStore(newStore(testStoreKeyFunc));
	});

	// Models staging/src/k8s.io/client-go/tools/cache/store_test.go TestCacheWithTransformer.
	it("transforms objects before storing them", async () => {
		expect.hasAssertions();
		let transformerCalled = false;
		await doTestStore(
			newStore(
				testStoreKeyFunc,
				withTransformer((i) => {
					transformerCalled = true;
					if (!isTestStoreObject(i)) {
						return [i, new Error("wrong object type")];
					}
					return [i, undefined];
				}),
			),
		);
		expect(transformerCalled).toBe(true);
	});

	// Models staging/src/k8s.io/client-go/tools/cache/store_test.go TestKeyError.
	it("wraps key function errors", () => {
		const obj: TestStoreObject = { id: "100", val: "" };
		const err = new Error("error");
		const keyErr = new KeyError(obj, err);

		expect(keyErr.err).toBe(err);

		const nestedKeyErr = new KeyError(obj, keyErr);
		expect(keyErr.err).toBe(err);
		expect(nestedKeyErr.err).toBe(keyErr);
	});

	it("does not expose stored object references through reads", async () => {
		const store = newStore(testStoreKeyFunc);
		await store.add({ id: "foo", val: "stored", nested: { val: "nested" } });

		const [got] = await store.get({ id: "foo", val: "" });
		if (!got?.nested) {
			throw new Error("expected object with nested value");
		}
		got.val = "mutated";
		got.nested.val = "mutated";

		const [afterGet] = store.getByKey("foo");
		expect(afterGet).toEqual({ id: "foo", val: "stored", nested: { val: "nested" } });

		const [listed] = store.list();
		if (!listed?.nested) {
			throw new Error("expected listed object with nested value");
		}
		listed.val = "listed mutation";
		listed.nested.val = "listed mutation";

		const [afterList] = store.getByKey("foo");
		expect(afterList).toEqual({ id: "foo", val: "stored", nested: { val: "nested" } });
	});
});

// Models staging/src/k8s.io/client-go/tools/cache/store_test.go doTestStore.
async function doTestStore(store: Store<TestStoreObject>): Promise<void> {
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

// Models staging/src/k8s.io/client-go/tools/cache/store_test.go testStoreKeyFunc.
function testStoreKeyFunc(obj: TestStoreObject | ExplicitKey): [string, Error | undefined] {
	if (obj instanceof ExplicitKey) {
		return [obj.key, undefined];
	}
	return [obj.id, undefined];
}

function isTestStoreObject(obj: KubernetesObject | undefined): obj is TestStoreObject {
	return obj !== undefined && "id" in obj && "val" in obj;
}
