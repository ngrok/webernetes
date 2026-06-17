/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import { GroupResource } from "../../../apimachinery/pkg/runtime/schema/group_version";
import type { NamespacedName } from "../../../apimachinery/pkg/types/namespacedname";
import { namespacedNameString } from "../../../apimachinery/pkg/types/namespacedname";
import type { KubernetesObject } from "../../../client";
import { metaNamespaceKeyFunc, newStore } from "../../../client-go/tools/cache/store";
import { Once } from "../../../go/sync/once";
import { WaitGroup } from "../../../go/sync/wait-group";
import { browser } from "../../../test/describe";
import {
	newConsistencyStore,
	newOwnerRecord,
	type LastSyncRVGetter,
	type OwnerRecord,
} from "./consistency";

interface TestPod extends KubernetesObject {}

browser.describe("controller consistency store", () => {
	// Models kubernetes/pkg/controller/util/consistency/consistency_test.go TestOwnerRecord_WroteAt.
	it("OwnerRecord_WroteAt", () => {
		const uid = "owner-uid-1";
		const or = newOwnerRecord(uid);
		expect(or.ownerUID).toEqual(uid);
		expect(or.versions).toBeDefined();

		const grPod = new GroupResource("", "pods");
		const grDs = new GroupResource("apps", "daemonsets");

		// First write
		or.wroteAt(grPod, "5");
		expect(or.versions.get(grPod.toString())).toEqual("5");

		// Second write (higher)
		or.wroteAt(grPod, "10");
		expect(or.versions.get(grPod.toString())).toEqual("10");

		// Third write (lower)
		or.wroteAt(grPod, "8");
		expect(or.versions.get(grPod.toString())).toEqual("10");

		// Write to different resource
		or.wroteAt(grDs, "1");
		expect(or.versions.get(grDs.toString())).toEqual("1");
		expect(or.versions.get(grPod.toString())).toEqual("10");
	});

	// Models kubernetes/pkg/controller/util/consistency/consistency_test.go TestOwnerRecord_IsReady.
	it("OwnerRecord_IsReady", () => {
		const uid = "owner-uid-1";
		const or = newOwnerRecord(uid);
		const grPod = new GroupResource("", "pods");
		const grDs = new GroupResource("apps", "daemonsets");
		const podStore = newStore<TestPod>(metaNamespaceKeyFunc);
		const dsStore = newStore<TestPod>(metaNamespaceKeyFunc);
		const resourceStores = new Map<GroupResource, LastSyncRVGetter>([
			[grPod, podStore],
			[grDs, dsStore],
		]);

		const store = newConsistencyStore(resourceStores);

		// Case 1: No writes. Should be ready.
		expect(or.ensureReady(store)).toBeUndefined();

		// Add a write
		or.wroteAt(grPod, "10");

		// Case 2: Write exists, but no reads. Should stay ready.
		expect(or.ensureReady(store)).toBeUndefined();

		// Add a read, but it's lower
		podStore.bookmark("5");

		// Case 3: Write exists, read is lower. Not ready.
		expect(or.ensureReady(store)).toBeInstanceOf(Error);

		// Add a read, equal
		podStore.bookmark("10");

		// Case 4: Write exists, read is equal. Ready.
		expect(or.ensureReady(store)).toBeUndefined();

		// Add a read, higher
		podStore.bookmark("15");

		// Case 5: Write exists, read is higher. Ready.
		expect(or.ensureReady(store)).toBeUndefined();

		// Add a second write and read
		or.wroteAt(grDs, "100");
		dsStore.bookmark("50");

		// Case 6: One resource ready, one not. Not ready.
		expect(or.ensureReady(store)).toBeInstanceOf(Error);

		// Make the second one ready
		dsStore.bookmark("100");

		// Case 7: All resources ready. Ready.
		expect(or.ensureReady(store)).toBeUndefined();
	});

	// Models kubernetes/pkg/controller/util/consistency/consistency_test.go TestConsistencyStore_New.
	it("ConsistencyStore_New", () => {
		const store = newConsistencyStore();
		expect(store).toBeDefined();
		expect(store.writes).toBeDefined();
		expect(store.writes.size).toEqual(0);
	});

	// Models kubernetes/pkg/controller/util/consistency/consistency_test.go TestConsistencyStore_EnsureWrittenRecord.
	it("ConsistencyStore_EnsureWrittenRecord", () => {
		const store = newConsistencyStore();
		const owner: NamespacedName = { name: "owner1", namespace: "" };
		const uid1 = "uid-1";
		const uid2 = "uid-2";

		// Create new
		const r1 = store.ensureWrittenRecord(owner, uid1);
		expect(r1).toBeDefined();
		expect(r1.ownerUID).toEqual(uid1);
		expect(store.writes.get(namespacedNameString(owner))).toBe(r1);

		// Get existing with same UID
		const r2 = store.ensureWrittenRecord(owner, uid1);
		expect(r2).toBe(r1);

		// Get existing with different UID (should replace)
		const r3 = store.ensureWrittenRecord(owner, uid2);
		expect(r3).toBeDefined();
		expect(r3).not.toBe(r1);
		expect(r3.ownerUID).toEqual(uid2);
		expect(store.writes.get(namespacedNameString(owner))).toBe(r3);
		expect(r3.versions.size).toEqual(0);

		// Check that old record is detached
		const grPod = new GroupResource("", "pods");
		r1.wroteAt(grPod, "10");
		expect(r3.versions.size).toEqual(0);
	});

	// Models kubernetes/pkg/controller/util/consistency/consistency_test.go TestConsistencyStore_EnsureWrittenRecord_Concurrent.
	it("ConsistencyStore_EnsureWrittenRecord_Concurrent", async () => {
		const store = newConsistencyStore();
		const owner: NamespacedName = { name: "owner1", namespace: "" };
		const uid1 = "uid-1";
		const uid2 = "uid-2";

		const wg = new WaitGroup();
		const numGoroutines = 50;
		const errors: unknown[] = [];

		// Concurrent creation with same UID
		let firstRecord: OwnerRecord | undefined;
		const once = new Once();
		for (let i = 0; i < numGoroutines; i++) {
			wg.add(1);
			queueMicrotask(() => {
				try {
					const r = store.ensureWrittenRecord(owner, uid1);
					expect(r.ownerUID).toEqual(uid1);
					once.do(() => {
						firstRecord = r;
					});
					expect(r).toBe(firstRecord);
				} catch (error) {
					errors.push(error);
				} finally {
					wg.done();
				}
			});
		}
		await wg.wait();
		if (errors.length > 0) {
			throw errors[0];
		}
		expect(firstRecord).toBeDefined();
		expect(store.writes.size).toEqual(1);

		// Concurrent replacement with new UID
		let replacementRecord: OwnerRecord | undefined;
		const replaceOnce = new Once();
		for (let i = 0; i < numGoroutines; i++) {
			wg.add(1);
			queueMicrotask(() => {
				try {
					const r = store.ensureWrittenRecord(owner, uid2);
					expect(r.ownerUID).toEqual(uid2);
					replaceOnce.do(() => {
						replacementRecord = r;
					});
					expect(r).toBe(replacementRecord);
				} catch (error) {
					errors.push(error);
				} finally {
					wg.done();
				}
			});
		}
		await wg.wait();
		if (errors.length > 0) {
			throw errors[0];
		}
		expect(replacementRecord).toBeDefined();
		expect(store.writes.size).toEqual(1);
		expect(store.writes.get(namespacedNameString(owner))).toBe(replacementRecord);
		expect(replacementRecord).not.toBe(firstRecord);
	});

	// Models kubernetes/pkg/controller/util/consistency/consistency_test.go TestConsistencyStore_WroteAt.
	it("ConsistencyStore_WroteAt", () => {
		const store = newConsistencyStore();
		const owner: NamespacedName = { name: "owner1", namespace: "" };
		const uid1 = "uid-1";
		const grPod = new GroupResource("", "pods");

		store.wroteAt(owner, uid1, grPod, "10");

		const record = store.getWrittenRecord(owner);
		expect(record).toBeDefined();
		expect(record?.ownerUID).toEqual(uid1);

		expect(record?.versions.get(grPod.toString())).toEqual("10");

		// Write again
		store.wroteAt(owner, uid1, grPod, "20");
		expect(record?.versions.get(grPod.toString())).toEqual("20");
	});

	// Models kubernetes/pkg/controller/util/consistency/consistency_test.go TestConsistencyStore_Clear.
	it("ConsistencyStore_Clear", () => {
		const store = newConsistencyStore();
		const owner1: NamespacedName = { name: "owner1", namespace: "" };
		const owner2: NamespacedName = { name: "owner2", namespace: "" };
		const uid1 = "uid-1";
		const uid2 = "uid-2";

		// Setup
		const r1 = store.ensureWrittenRecord(owner1, uid1);
		const r2 = store.ensureWrittenRecord(owner2, uid2);
		expect(store.writes.size).toEqual(2);

		// Clear non-existent
		store.clear({ name: "non-existent", namespace: "" }, uid1);
		expect(store.writes.size).toEqual(2);

		// Clear with wrong UID
		store.clear(owner1, uid2);
		expect(store.writes.size).toEqual(2);
		expect(store.writes.get(namespacedNameString(owner1))).toBe(r1);

		// Clear with correct UID
		store.clear(owner1, uid1);
		expect(store.writes.size).toEqual(1);
		expect(store.writes.get(namespacedNameString(owner1))).toBeUndefined();
		expect(store.writes.get(namespacedNameString(owner2))).toBe(r2);

		// Re-add r1
		store.ensureWrittenRecord(owner1, uid1);
		expect(store.writes.size).toEqual(2);

		// Clear with empty UID
		store.clear(owner1, "");
		expect(store.writes.size).toEqual(1);
		expect(store.writes.get(namespacedNameString(owner1))).toBeUndefined();
		expect(store.writes.get(namespacedNameString(owner2))).toBe(r2);
	});

	// Models kubernetes/pkg/controller/util/consistency/consistency_test.go TestConsistencyStore_IsReady.
	it("ConsistencyStore_IsReady", () => {
		const owner1: NamespacedName = { name: "owner1", namespace: "" };
		const uid1 = "uid-1";
		const grPod = new GroupResource("", "pods");
		const podStore = newStore<TestPod>(metaNamespaceKeyFunc);
		const resourceStores = new Map<GroupResource, LastSyncRVGetter>([[grPod, podStore]]);

		const store = newConsistencyStore(resourceStores);

		// Case 1: No record. Ready.
		expect(store.ensureReady(owner1)).toBeUndefined();

		// Add a write and initial read rv
		podStore.bookmark("5");
		store.wroteAt(owner1, uid1, grPod, "10");

		// Case 2: Record exists, read < write. Not ready.
		expect(store.ensureReady(owner1)).toBeInstanceOf(Error);

		// Add read, equal
		podStore.bookmark("10");

		// Case 3: Record exists, read == write. Ready.
		expect(store.ensureReady(owner1)).toBeUndefined();

		// Add read, higher
		podStore.bookmark("15");

		// Case 4: Record exists, read > write. Ready.
		expect(store.ensureReady(owner1)).toBeUndefined();

		// Assert that the record no longer exists, we no longer need to track the
		// reads as long as the read has been higher than the latest write.
		expect(store.getWrittenRecord(owner1)).toBeUndefined();
	});
});
