/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import { browser } from "../../../test/describe";
import { type IndexFunc } from "./index";
import { metaNamespaceKeyFunc, newIndexer } from "./store";

interface TestPod {
	metadata?: {
		name?: string;
		namespace?: string;
		labels?: Record<string, string>;
		annotations?: Record<string, string>;
	};
}

browser.describe("Indexer", () => {
	// Models staging/src/k8s.io/client-go/tools/cache/index_test.go TestGetIndexFuncValues.
	it("lists indexed values for an index function", async () => {
		const index = newIndexer<TestPod>(metaNamespaceKeyFunc, { testmodes: testIndexFunc });

		const pod1: TestPod = { metadata: { name: "one", labels: { foo: "bar" } } };
		const pod2: TestPod = { metadata: { name: "two", labels: { foo: "bar" } } };
		const pod3: TestPod = { metadata: { name: "tre", labels: { foo: "biz" } } };

		await index.add(pod1);
		await index.add(pod2);
		await index.add(pod3);

		const keys = index.listIndexFuncValues("testmodes");
		expect(new Set(keys)).toEqual(new Set(["bar", "biz"]));
	});

	// Models staging/src/k8s.io/client-go/tools/cache/index_test.go TestMultiIndexKeys.
	it("keeps multi-value index keys current across add delete and update", async () => {
		const index = newIndexer<TestPod>(metaNamespaceKeyFunc, { byUser: testUsersIndexFunc });

		const pod1: TestPod = { metadata: { name: "one", annotations: { users: "ernie,bert" } } };
		const pod2: TestPod = { metadata: { name: "two", annotations: { users: "bert,oscar" } } };
		const pod3: TestPod = { metadata: { name: "tre", annotations: { users: "ernie,elmo" } } };

		await index.add(pod1);
		await index.add(pod2);
		await index.add(pod3);

		const expected = new Map([
			["ernie", new Set(["one", "tre"])],
			["bert", new Set(["one", "two"])],
			["elmo", new Set(["tre"])],
			["oscar", new Set(["two"])],
			["elmo1", new Set<string>()],
		]);

		for (const [key, expectedNames] of expected) {
			const [indexResults, err] = index.byIndex("byUser", key);
			expect(err).toBeUndefined();
			expect(new Set(indexResults.map((pod) => pod.metadata?.name ?? ""))).toEqual(expectedNames);
		}

		await index.delete(pod3);
		let [erniePods, err] = index.byIndex("byUser", "ernie");
		expect(err).toBeUndefined();
		expect(erniePods.map((pod) => pod.metadata?.name)).toEqual(["one"]);

		let [elmoPods, elmoErr] = index.byIndex("byUser", "elmo");
		expect(elmoErr).toBeUndefined();
		expect(elmoPods).toHaveLength(0);

		const copyOfPod2 = structuredClone(pod2);
		copyOfPod2.metadata ??= {};
		copyOfPod2.metadata.annotations = { users: "oscar" };
		await index.update(copyOfPod2);

		const [bertPods, bertErr] = index.byIndex("byUser", "bert");
		expect(bertErr).toBeUndefined();
		expect(bertPods.map((pod) => pod.metadata?.name)).toEqual(["one"]);

		[erniePods, err] = index.index("byUser", {
			metadata: { name: "lookup", annotations: { users: "ernie" } },
		});
		expect(err).toBeUndefined();
		expect(erniePods.map((pod) => pod.metadata?.name)).toEqual(["one"]);

		[elmoPods, elmoErr] = index.index("missing", pod1);
		expect(elmoPods).toEqual([]);
		expect(elmoErr?.message).toBe("Index with name missing does not exist");
	});
});

// Models staging/src/k8s.io/client-go/tools/cache/index_test.go testIndexFunc.
const testIndexFunc: IndexFunc<TestPod> = (obj) => {
	return [[obj.metadata?.labels?.foo ?? ""], undefined];
};

// Models staging/src/k8s.io/client-go/tools/cache/index_test.go testUsersIndexFunc.
const testUsersIndexFunc: IndexFunc<TestPod> = (obj) => {
	return [(obj.metadata?.annotations?.users ?? "").split(","), undefined];
};
