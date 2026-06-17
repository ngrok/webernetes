/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import { newString } from "../../../apimachinery/pkg/util/sets/string";
import { Clock } from "../../../clock";
import { Channel } from "../../../go/channel";
import { browser } from "../../../test/describe";
import { newFakePassiveClock } from "../../../utils/clock/testing/fake-clock";
import { TimestampedEntry, TTLPolicy } from "./expiration-cache";
import { FakeExpirationPolicy, newFakeExpirationStore } from "./expiration-cache-fakes";
import { testStoreKeyFunc, type TestStoreObject } from "./store-test-helpers";

function retrieveTestStoreObjectKey(
	obj: TimestampedEntry<TestStoreObject>,
): [string, Error | undefined] {
	return [obj.obj.id, undefined];
}

async function expectDeletedKey(deleteChan: Channel<string>, key: string): Promise<void> {
	const result = await deleteChan.receive();
	expect(result.ok).toBe(true);
	const delKey = result.value;
	expect(delKey).toEqual(key);
}

browser.describe("expiration cache", () => {
	// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache_test.go TestTTLExpirationBasic.
	it("TTLExpirationBasic", async () => {
		const testObj: TestStoreObject = { id: "foo", val: "bar" };
		const deleteChan = new Channel<string>(1);
		const ttlStore = newFakeExpirationStore(
			testStoreKeyFunc,
			deleteChan,
			new FakeExpirationPolicy(newString(), retrieveTestStoreObjectKey),
			new Clock(),
		);
		const err = await ttlStore.add(testObj);
		expect(err).toBeUndefined();
		const [item, exists, getErr] = await ttlStore.get(testObj);
		expect(getErr).toBeUndefined();
		expect(exists).toBe(false);
		expect(item).toBeUndefined();
		const [key] = testStoreKeyFunc(testObj);
		await expectDeletedKey(deleteChan, key);
		deleteChan.close();
	});

	// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache_test.go TestReAddExpiredItem.
	it("ReAddExpiredItem", async () => {
		const deleteChan = new Channel<string>(1);
		const exp = new FakeExpirationPolicy(newString(), retrieveTestStoreObjectKey);
		const ttlStore = newFakeExpirationStore(testStoreKeyFunc, deleteChan, exp, new Clock());
		const testKey = "foo";
		const testObj: TestStoreObject = { id: testKey, val: "bar" };
		let err = await ttlStore.add(testObj);
		expect(err).toBeUndefined();

		// This get will expire the item.
		let [item, exists, getErr] = await ttlStore.get(testObj);
		expect(getErr).toBeUndefined();
		expect(exists).toBe(false);
		expect(item).toBeUndefined();

		const [key] = testStoreKeyFunc(testObj);
		const differentValue = "different_bar";
		err = await ttlStore.add({ id: testKey, val: differentValue });
		expect(err).toBeUndefined();

		await expectDeletedKey(deleteChan, key);
		exp.neverExpire.clear();
		exp.neverExpire.add(testKey);
		[item, exists, getErr] = ttlStore.getByKey(testKey);
		expect(getErr).toBeUndefined();
		expect(exists).toBe(true);
		expect(item?.val).toEqual(differentValue);
		deleteChan.close();
	});

	// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache_test.go TestTTLList.
	it("TTLList", async () => {
		const testObjs: TestStoreObject[] = [
			{ id: "foo", val: "bar" },
			{ id: "foo1", val: "bar1" },
			{ id: "foo2", val: "bar2" },
		];
		const expireKeys = newString(testObjs[0].id, testObjs[2].id);
		const deleteChan = new Channel<string>(testObjs.length);

		const ttlStore = newFakeExpirationStore(
			testStoreKeyFunc,
			deleteChan,
			new FakeExpirationPolicy(newString(testObjs[1].id), retrieveTestStoreObjectKey),
			new Clock(),
		);
		for (const obj of testObjs) {
			const err = await ttlStore.add(obj);
			expect(err).toBeUndefined();
		}
		const listObjs = ttlStore.list();
		expect(listObjs).toEqual([testObjs[1]]);

		// Make sure all our deletes come through in an acceptable rate (1/100ms)
		while (expireKeys.len() !== 0) {
			const result = await deleteChan.receive();
			expect(result.ok).toBe(true);
			const delKey = result.value;
			if (!delKey) {
				throw new Error("deleteChan closed before all deletes were received");
			}
			expect(expireKeys.has(delKey)).toBe(true);
			expireKeys.delete(delKey);
		}
		deleteChan.close();
	});

	// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache_test.go TestTTLPolicy.
	it("TTLPolicy", () => {
		const fakeTime = new Date(Date.UTC(2009, 10, 10, 23, 0, 0, 0));
		let ttl = 30 * 1000;
		const exactlyOnTTL = new Date(fakeTime.getTime() - ttl);
		const expiredTime = new Date(fakeTime.getTime() - (ttl + 1));

		const policy = new TTLPolicy(ttl, newFakePassiveClock(fakeTime));
		const item: TestStoreObject = { id: "foo", val: "bar" };
		const [itemkey] = testStoreKeyFunc(item);
		let fakeTimestampedEntry = new TimestampedEntry(item, exactlyOnTTL, itemkey);
		expect(policy.isExpired(fakeTimestampedEntry)).toBe(false);
		fakeTimestampedEntry = new TimestampedEntry(item, fakeTime, itemkey);
		expect(policy.isExpired(fakeTimestampedEntry)).toBe(false);
		fakeTimestampedEntry = new TimestampedEntry(item, expiredTime, itemkey);
		expect(policy.isExpired(fakeTimestampedEntry)).toBe(true);
		for (ttl of [0, -1]) {
			policy.ttl = ttl;
			expect(policy.isExpired(fakeTimestampedEntry)).toBe(false);
		}
	});
});
