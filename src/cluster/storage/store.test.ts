import { afterEach, beforeEach, expect, it } from "vitest";

import { fakeEtcd } from "../../test/harnesses/etcd";
import type { Etcd } from "../etcd";
import { Store, type Storable } from "./store";
import type { Watcher } from "./watch";

interface TestObject extends Storable {
	metadata: {
		name: string;
		resourceVersion?: string;
		uid?: string;
	};
	value?: string;
}

type StoreEvent = {
	phase: "ADDED" | "MODIFIED" | "DELETED";
	object: TestObject;
};

fakeEtcd.describe("Store resourceVersion", ({ createEtcd }) => {
	let etcd: Etcd;
	let store: Store<TestObject>;

	beforeEach(async () => {
		etcd = (await createEtcd()) as Etcd;
		await etcd.delete().all().exec();
		store = new Store<TestObject>(etcd, {
			defaultQualifiedResource: "tests",
			singularQualifiedResource: "test",
			apiVersion: "test.k8s.io/v1",
			kind: "Test",
		});
	});

	afterEach(() => {
		etcd.close();
	});

	it("returns a list resourceVersion at least as new as every listed item", async () => {
		const first = await store.create({ metadata: { name: "first" }, value: "one" });
		const second = await store.create({ metadata: { name: "second" }, value: "two" });

		const list = await store.listWithResourceVersion();

		expect(list.items).toHaveLength(2);
		expect(Number(list.resourceVersion)).toBeGreaterThanOrEqual(
			Number(first.metadata.resourceVersion),
		);
		expect(Number(list.resourceVersion)).toBeGreaterThanOrEqual(
			Number(second.metadata.resourceVersion),
		);
		expect(list.items.map((item) => item.metadata.resourceVersion)).toEqual([
			first.metadata.resourceVersion,
			second.metadata.resourceVersion,
		]);
	});

	it("starts watches from the revision after the supplied list resourceVersion", async () => {
		await store.create({ metadata: { name: "watched" }, value: "initial" });
		const list = await store.listWithResourceVersion();

		const watcher = await store.watch(undefined, Number(list.resourceVersion) + 1);
		const event = nextStoreEvent(watcher);
		const updated = await store.update("watched", {
			metadata: { name: "watched" },
			value: "updated",
		});

		await expect(event).resolves.toEqual({
			phase: "MODIFIED",
			object: expect.objectContaining({
				metadata: expect.objectContaining({
					name: "watched",
					resourceVersion: updated.metadata.resourceVersion,
				}),
				value: "updated",
			}),
		});
		await watcher.cancel();
	});

	it("stamps watch events with the event revision instead of the stored object revision", async () => {
		const created = await store.create({ metadata: { name: "stamped" }, value: "initial" });
		const list = await store.listWithResourceVersion();
		const staleObjectRevision = created.metadata.resourceVersion;

		const watcher = await store.watch(undefined, Number(list.resourceVersion) + 1);
		const event = nextStoreEvent(watcher);
		const updated = await store.update("stamped", {
			metadata: { name: "stamped", resourceVersion: staleObjectRevision },
			value: "updated",
		});

		await expect(event).resolves.toEqual({
			phase: "MODIFIED",
			object: expect.objectContaining({
				metadata: expect.objectContaining({
					name: "stamped",
					resourceVersion: updated.metadata.resourceVersion,
				}),
				value: "updated",
			}),
		});
		expect(updated.metadata.resourceVersion).not.toBe(staleObjectRevision);
		await watcher.cancel();
	});
});

function nextStoreEvent(watcher: Watcher<TestObject>) {
	return new Promise<StoreEvent>((resolve) => {
		watcher.once("event", (phase, object) => resolve({ phase, object }));
	});
}
