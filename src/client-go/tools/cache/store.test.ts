/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import { browser } from "../../../test/describe";
import { newIndexer } from "./store";
import { KeyError, newStore, withTransformer } from "./store";
import {
	doTestIndex,
	doTestStore,
	isTestStoreObject,
	testStoreIndexers,
	testStoreKeyFunc,
	type TestStoreObject,
} from "./store-test-helpers";

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

	// Models staging/src/k8s.io/client-go/tools/cache/store_test.go TestIndex.
	it("implements the public indexer interface", async () => {
		await doTestIndex(newIndexer(testStoreKeyFunc, testStoreIndexers()));
	});
});
