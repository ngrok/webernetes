import { Buffer } from "buffer";
import type { Etcd3 } from "etcd3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { etcd } from "../test/harnesses/etcd";
import { wait } from "../promise";
import { Etcd } from "./etcd";

// Waits for the next occurrence of `event` on `emitter`, rejecting after `timeout` ms.
// Set up the promise BEFORE the operation that triggers the event.
function nextEvent<T = unknown>(
	emitter: { once(event: string, listener: (...args: unknown[]) => void): unknown },
	event: string,
	timeout = 2000,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Timed out after ${timeout}ms waiting for "${event}"`)),
			timeout,
		);
		emitter.once(event, (value: unknown) => {
			clearTimeout(timer);
			resolve(value as T);
		});
	});
}

etcd.describe("etcd", ({ createEtcd }) => {
	let client: Etcd | Etcd3;
	let startingRevision: number;

	function revision(r: number): string {
		return String(startingRevision + r);
	}

	beforeAll(async () => {
		client = await createEtcd();
	});

	afterAll(() => {
		client.close();
	});

	beforeEach(async () => {
		const res = await client.delete().all().exec();
		startingRevision = Number(res.header.revision);
	});

	it("stores values at keys", async () => {
		await client.put("key").value("value");

		expect(await client.get("key").exists()).toBe(true);
		expect(await client.get("key").string()).toBe("value");
	});

	it("returns null for non-existent keys", async () => {
		expect(await client.get("non-existent-key").string()).toBeNull();
		expect(await client.get("non-existent-key").exists()).toBe(false);
	});

	it("supports put/get builders and historical exec metadata", async () => {
		await client.put("foo").value("v1");
		const previous = await client.put("foo").value("v2").getPrevious();
		const current = await client.get("foo").string();
		const firstRevision = await client.get("foo").revision(revision(1)).string();
		const raw = await client.get("foo").exec();

		expect(previous).toMatchObject({
			create_revision: revision(1),
			mod_revision: revision(1),
			version: "1",
		});
		expect(previous?.value.toString()).toBe("v1");
		expect(current).toBe("v2");
		expect(firstRevision).toBe("v1");
		expect(raw.kvs).toHaveLength(1);
		expect(raw.kvs[0]?.mod_revision).toBe(revision(2));
	});

	it("supports getAll prefix queries and namespace()", async () => {
		const pods = client.namespace("/registry/pods/");

		await pods.put("default/pod-1").value("one");
		await pods.put("default/pod-2").value("two");
		await client.put("/registry/nodes/node-1").value("node");

		expect(await pods.getAll().prefix("default/").strings()).toEqual({
			"default/pod-1": "one",
			"default/pod-2": "two",
		});
		expect(await pods.getAll().prefix("default/").keys()).toEqual([
			"default/pod-1",
			"default/pod-2",
		]);
		expect(await client.getAll().prefix("/registry/pods/").count()).toBe(2);
	});

	it("supports json", async () => {
		await client.put("foo/1").value(JSON.stringify({ hello: "world" }));
		const str = await client.get("foo/1").string();
		expect(str).toBe('{"hello":"world"}');

		const json = await client.get("foo/1").json();
		expect(json).toEqual({ hello: "world" });
	});

	it("supports delete builders and previous values", async () => {
		await client.put("foo/1").value("one");
		await client.put("foo/2").value("two");

		const previous = await client.delete().prefix("foo/").getPrevious();

		expect(
			previous.map((kv) => ({ key: kv.key.toString(), value: kv.value.toString() })),
		).toMatchObject([
			{ key: "foo/1", value: "one" },
			{ key: "foo/2", value: "two" },
		]);
		expect(await client.get("foo/1").exists()).toBe(false);
		expect(await client.getAll().prefix("foo/").count()).toBe(0);
	});

	it("does not error when deleting a non-existent key", async () => {
		const response = await client.delete().key("non-existent-key").exec();

		expect(response.deleted).toBe("0");
		expect(response.prev_kvs).toEqual([]);
	});

	it("watches an exact key", async () => {
		const seen: string[] = [];
		const watcher = await client.watch().key("key").create();
		watcher.on("put", (kv) => seen.push(kv.value.toString()));

		const putReceived = nextEvent(watcher, "put");
		await client.put("key").value("value");
		await putReceived;
		expect(seen).toEqual(["value"]);
	});

	it("does not replay existing values by default", async () => {
		const seen: string[] = [];

		await client.put("key").value("value");
		const watcher = await client.watch().key("key").create();
		watcher.on("put", (kv) => seen.push(kv.value.toString()));

		expect(seen).toEqual([]);

		const putReceived = nextEvent(watcher, "put");
		await client.put("key").value("updated");
		await putReceived;
		expect(seen).toEqual(["updated"]);
	});

	it("can replay existing values with startRevision", async () => {
		const seen: string[] = [];

		await client.put("key").value("value");
		const watcher = client.watch().key("key").startRevision(revision(1)).watcher();
		watcher.on("put", (kv) => seen.push(kv.value.toString()));

		await nextEvent(watcher, "put");
		expect(seen).toEqual(["value"]);
	});

	it("exact key matches the same key", async () => {
		let seen = false;
		const watcher = await client.watch().key("key").create();
		watcher.on("put", () => {
			seen = true;
		});

		const putReceived = nextEvent(watcher, "put");
		await client.put("key").value("value");
		await putReceived;
		expect(seen).toBe(true);
	});

	it("exact key does not match nested key", async () => {
		let seen = false;
		const watcher = await client.watch().key("key").create();
		watcher.on("put", () => {
			seen = true;
		});
		await client.put("key/foo").value("value");
		expect(seen).toBe(false);
	});

	it("prefix key/ matches nested key", async () => {
		let seen = false;
		const watcher = await client.watch().prefix("key/").create();
		watcher.on("put", () => {
			seen = true;
		});

		const putReceived = nextEvent(watcher, "put");
		await client.put("key/foo").value("value");
		await putReceived;
		expect(seen).toBe(true);
	});

	it("prefix key matches nested key", async () => {
		let seen = false;
		const watcher = await client.watch().prefix("key").create();
		watcher.on("put", () => {
			seen = true;
		});

		const putReceived = nextEvent(watcher, "put");
		await client.put("key/foo").value("value");
		await putReceived;
		expect(seen).toBe(true);
	});

	it("emits etcd3-style watch events", async () => {
		const watcher = await client.watch().prefix("pods/").withPreviousKV().create();
		const events: string[] = [];

		watcher.on("put", (kv, previous) => {
			events.push(`put:${kv.key.toString()}:${previous?.value.toString() ?? "-"}`);
		});
		watcher.on("delete", (kv, previous) => {
			events.push(`delete:${kv.key.toString()}:${previous?.value.toString() ?? "-"}`);
		});

		// delete is the last event — awaiting it ensures the two preceding puts have also arrived
		const deleteReceived = nextEvent(watcher, "delete");
		await client.put("pods/a").value("one");
		await client.put("pods/a").value("two");
		await client.delete().key("pods/a").exec();
		await deleteReceived;

		expect(events).toEqual(["put:pods/a:-", "put:pods/a:one", "delete:pods/a:two"]);
	});

	it("watcher emits put events", async () => {
		const watcher = await client.watch().key("key").create();
		const putEvents: string[] = [];
		watcher.on("put", () => putEvents.push("put"));

		const putReceived = nextEvent(watcher, "put");
		await client.put("key").value("v1");
		await putReceived;
		expect(putEvents).toEqual(["put"]);
	});

	it("watcher emits connected event on creation", async () => {
		const watcher = client.watch().key("key").watcher();
		const response = await nextEvent<{ created: boolean }>(watcher, "connected");
		expect(response.created).toBe(true);
	});

	it("filters watch events to only puts", async () => {
		// etcd delivers events on a single watch in revision order, so we can
		// sandwich a delete between two puts: once the second put event arrives,
		// any unfiltered event for the delete (which happened before it) would
		// already have been delivered.
		const events: string[] = [];
		const watcher = await client.watch().prefix("pods/").only("put").create();
		watcher.on("delete", () => events.push("delete"));

		const secondPut = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Timed out waiting for second put")), 2000);
			watcher.on("put", (kv) => {
				events.push(`put:${kv.key.toString()}:${kv.value.toString()}`);
				if (events.filter((e) => e.startsWith("put:")).length === 2) {
					clearTimeout(timer);
					resolve();
				}
			});
		});

		await client.put("pods/a").value("one");
		await client.delete().key("pods/a").exec();
		await client.put("pods/a").value("two");
		await secondPut;

		expect(events).toEqual(["put:pods/a:one", "put:pods/a:two"]);
	});

	it("filters watch events to only deletes", async () => {
		const events: string[] = [];
		const watcher = await client.watch().prefix("pods/").only("delete").withPreviousKV().create();
		watcher.on("put", () => events.push("put"));
		watcher.on("delete", (kv, previous) => {
			events.push(`delete:${kv.key.toString()}:${previous?.value.toString() ?? "-"}`);
		});

		await client.put("pods/a").value("one");
		const deleteReceived = nextEvent(watcher, "delete");
		await client.delete().key("pods/a").exec();
		await deleteReceived;
		expect(events).toEqual(["delete:pods/a:one"]);
	});

	it("only() with no args receives all events, matching etcd3 semantics", async () => {
		// In real etcd3, only() sends an empty filter list to the server, which
		// means no filtering — all events pass through.
		const events: string[] = [];
		const watcher = await client.watch().prefix("k/").only().create();
		watcher.on("put", () => events.push("put"));
		watcher.on("delete", () => events.push("delete"));

		const deleteReceived = nextEvent(watcher, "delete");
		await client.put("k/a").value("1");
		await client.delete().key("k/a").exec();
		await deleteReceived;
		expect(events).toEqual(["put", "delete"]);
	});

	it("only('put', 'delete') creates a watcher that never fires", async () => {
		// Both filter types combined → [NODELETE, NOPUT] → no events pass through,
		// matching real etcd3 behaviour.
		const watcher = await client.watch().prefix("k/").only("put", "delete").create();
		let fired = false;
		watcher.on("put", () => {
			fired = true;
		});
		watcher.on("delete", () => {
			fired = true;
		});

		await client.put("k/a").value("1");
		await client.delete().key("k/a").exec();
		await wait(50);
		expect(fired).toBe(false);
	});

	it("only() replaces filters on repeated calls — last call wins", async () => {
		const events: string[] = [];
		// First call says "only puts", second replaces to "only deletes"
		const watcher = await client.watch().prefix("k/").only("put").only("delete").create();
		watcher.on("put", () => events.push("put"));
		watcher.on("delete", () => events.push("delete"));

		await client.put("k/a").value("1");
		const deleteReceived = nextEvent(watcher, "delete");
		await client.delete().key("k/a").exec();
		await deleteReceived;
		expect(events).toEqual(["delete"]);
	});

	it("two watchers on the same prefix with different filters each receive their subset", async () => {
		const putsOnly = await client.watch().prefix("k/").only("put").create();
		const deletesOnly = await client.watch().prefix("k/").only("delete").create();
		const putEvents: string[] = [];
		const deleteEvents: string[] = [];

		putsOnly.on("put", (kv) => putEvents.push(`put:${kv.key.toString()}`));
		putsOnly.on("delete", () => putEvents.push("delete"));
		deletesOnly.on("put", () => deleteEvents.push("put"));
		deletesOnly.on("delete", (kv) => deleteEvents.push(`delete:${kv.key.toString()}`));

		const putReceived = nextEvent(putsOnly, "put");
		await client.put("k/a").value("1");
		await putReceived;

		const deleteReceived = nextEvent(deletesOnly, "delete");
		await client.delete().key("k/a").exec();
		await deleteReceived;

		expect(putEvents).toEqual(["put:k/a"]);
		expect(deleteEvents).toEqual(["delete:k/a"]);
	});

	it("createRevision is stable across updates, version increments", async () => {
		await client.put("key").value("v1");
		await client.put("key").value("v2");
		await client.put("key").value("v3");

		const kv = (await client.get("key").exec()).kvs[0];
		expect(kv?.create_revision).toBe(revision(1));
		expect(kv?.mod_revision).toBe(revision(3));
		expect(kv?.version).toBe("3");
	});

	it("transaction success branch applies put operations when comparisons pass", async () => {
		const result = await client
			.if("lock", "Version", "==", 0)
			.then(client.put("lock").value("owner-1"))
			.else(client.get("lock"))
			.commit();

		expect(result.succeeded).toBe(true);
		expect(result.responses).toHaveLength(1);
		expect(result.responses[0]?.response_put).toBeDefined();
		expect(await client.get("lock").string()).toBe("owner-1");

		const kv = (await client.get("lock").exec()).kvs[0];
		expect(kv?.create_revision).toBe(revision(1));
		expect(kv?.mod_revision).toBe(revision(1));
		expect(kv?.version).toBe("1");
	});

	it("transaction failure branch returns range responses when comparisons fail", async () => {
		await client.put("lock").value("owner-1");

		const result = await client
			.if("lock", "Version", "==", 0)
			.then(client.put("lock").value("owner-2"))
			.else(client.get("lock"))
			.commit();

		expect(result.succeeded).toBe(false);
		expect(result.responses).toHaveLength(1);
		const range = result.responses[0]?.response_range;
		expect(range?.kvs).toHaveLength(1);
		expect(range?.kvs[0]?.key.toString()).toBe("lock");
		expect(range?.kvs[0]?.value.toString()).toBe("owner-1");
		expect(await client.get("lock").string()).toBe("owner-1");
	});

	it("transaction supports chained comparisons against value, create revision, and mod revision", async () => {
		await client.put("item").value("v1");
		await client.put("item").value("v2");

		const result = await client
			.if("item", "Value", "==", "v2")
			.and("item", "Create", "==", Number(revision(1)))
			.and("item", "Mod", "==", Number(revision(2)))
			.then(client.put("item").value("v3"))
			.else(client.get("item"))
			.commit();

		expect(result.succeeded).toBe(true);
		expect(await client.get("item").string()).toBe("v3");
		const kv = (await client.get("item").exec()).kvs[0];
		expect(kv?.create_revision).toBe(revision(1));
		expect(kv?.mod_revision).toBe(revision(3));
		expect(kv?.version).toBe("3");
	});

	it("transaction applies multiple write operations at one shared revision", async () => {
		await client.put("txn/delete-me").value("old");

		// oxlint-disable-next-line promise/valid-params
		const result = await client
			.if("txn/a", "Version", "==", 0)
			.then(
				client.put("txn/a").value("one"),
				client.put("txn/b").value("two"),
				client.delete().key("txn/delete-me"),
			)
			.commit();

		expect(result.succeeded).toBe(true);
		expect(result.header.revision).toBe(revision(2));
		expect(result.responses).toHaveLength(3);
		expect(result.responses[0]?.response_put?.header.revision).toBe(result.header.revision);
		expect(result.responses[1]?.response_put?.header.revision).toBe(result.header.revision);
		expect(result.responses[2]?.response_delete_range?.header.revision).toBe(
			result.header.revision,
		);

		const a = (await client.get("txn/a").exec()).kvs[0];
		const b = (await client.get("txn/b").exec()).kvs[0];
		expect(a?.mod_revision).toBe(result.header.revision);
		expect(b?.mod_revision).toBe(result.header.revision);
		expect(await client.get("txn/delete-me").exists()).toBe(false);
	});

	it("transaction can return range responses for multi-key operations", async () => {
		await client.put("pods/a").value("one");
		await client.put("pods/b").value("two");
		await client.put("nodes/a").value("node");

		const result = await client
			.if("ready", "Version", "==", 0)
			.then(client.getAll().prefix("pods/"))
			.commit();

		expect(result.succeeded).toBe(true);
		const response = result.responses[0]?.response_range;
		expect(response?.kvs.map((kv) => kv.key.toString())).toEqual(["pods/a", "pods/b"]);
		expect(response?.kvs.map((kv) => kv.value.toString())).toEqual(["one", "two"]);
	});

	it("transaction operations respect namespaces", async () => {
		const ns = client.namespace("ns/");

		const result = await ns
			.if("key", "Version", "==", 0)
			.then(ns.put("key").value("value"))
			.commit();

		expect(result.succeeded).toBe(true);
		expect(await ns.get("key").string()).toBe("value");
		expect(await client.get("ns/key").string()).toBe("value");
		expect(await client.get("key").string()).toBeNull();
	});

	it("transaction watch data contains all events at the same revision", async () => {
		const watcher = await client.watch().prefix("watch-txn/").create();
		const dataReceived = nextEvent<{
			header: { revision: string };
			events: { kv: { key: Buffer; mod_revision: string } }[];
		}>(watcher, "data");

		await client
			.if("watch-txn/a", "Version", "==", 0)
			.then(client.put("watch-txn/a").value("one"), client.put("watch-txn/b").value("two"))
			.commit();

		const response = await dataReceived;
		expect(response.events).toHaveLength(2);
		expect(response.events.map((event) => event.kv.key.toString())).toEqual([
			"watch-txn/a",
			"watch-txn/b",
		]);
		expect(
			response.events.every((event) => event.kv.mod_revision === response.header.revision),
		).toBe(true);
	});

	it("transaction rejects multiple writes to the same key", async () => {
		await expect(
			client
				.if("dup", "Version", "==", 0)
				.then(client.put("dup").value("one"), client.put("dup").value("two"))
				.commit(),
		).rejects.toThrow(/duplicate key|multiple times/i);
	});

	it("transaction serializes concurrent create-if-missing contenders", async () => {
		const contenderIds = Array.from({ length: 20 }, (_, index) => `owner-${index}`);

		const results = await Promise.all(
			contenderIds.map(async (id) => {
				return await client
					.if("singleton", "Version", "==", 0)
					.then(client.put("singleton").value(id))
					.else(client.get("singleton"))
					.commit();
			}),
		);

		const succeeded = results.filter((result) => result.succeeded);
		expect(succeeded).toHaveLength(1);

		const storedOwner = await client.get("singleton").string();
		expect(contenderIds).toContain(storedOwner);
		expect(succeeded[0]?.responses[0]?.response_put).toBeDefined();

		for (const result of results.filter((r) => !r.succeeded)) {
			const kv = result.responses[0]?.response_range?.kvs[0];
			expect(kv?.value.toString()).toBe(storedOwner);
		}
	});

	it("transaction supports compare-and-swap loops for concurrent increments", async () => {
		const incrementCount = 25;

		async function incrementCounter(): Promise<number> {
			for (;;) {
				const response = await client.get("counter").exec();
				const kv = response.kvs[0];
				const current = kv ? Number(kv.value.toString()) : 0;
				const next = current + 1;
				const transaction = kv
					? client.if("counter", "Mod", "==", Number(kv.mod_revision))
					: client.if("counter", "Version", "==", 0);

				const result = await transaction.then(client.put("counter").value(next)).commit();
				if (result.succeeded) {
					return next;
				}
			}
		}

		const increments = await Promise.all(
			Array.from({ length: incrementCount }, () => incrementCounter()),
		);

		expect(await client.get("counter").number()).toBe(incrementCount);
		expect(new Set(increments).size).toBe(incrementCount);
		expect(increments.toSorted((left, right) => left - right)).toEqual(
			Array.from({ length: incrementCount }, (_, index) => index + 1),
		);
	});

	it("lock().do() runs the callback while holding a lock and releases it afterward", async () => {
		const events: string[] = [];

		const value = await client
			.lock("locks/do")
			.ttl(5)
			.do(async () => {
				events.push("inside");
				await client.put("locks/do/value").value("written");
				return "result";
			});

		expect(value).toBe("result");
		expect(events).toEqual(["inside"]);
		expect(await client.get("locks/do/value").string()).toBe("written");
		await expect(client.lock("locks/do").ttl(5).acquire()).resolves.toBeDefined();
	});

	it("lock acquire rejects while another holder owns the same lock", async () => {
		const first = await client.lock("locks/contended").ttl(5).acquire();

		try {
			await expect(client.lock("locks/contended").ttl(5).acquire()).rejects.toThrow(
				/Failed to acquire a lock/,
			);
		} finally {
			await first.release();
		}
	});

	it("lock release allows another holder to acquire the same lock", async () => {
		const first = await client.lock("locks/reacquire").ttl(5).acquire();
		await first.release();

		const second = await client.lock("locks/reacquire").ttl(5).acquire();
		expect(second).toBeDefined();
		await second.release();
	});

	it("lock().do() releases the lock when the callback throws", async () => {
		await expect(
			client
				.lock("locks/throwing")
				.ttl(5)
				.do(async () => {
					await client.put("locks/throwing/value").value("before-error");
					throw new Error("boom");
				}),
		).rejects.toThrow("boom");

		const next = await client.lock("locks/throwing").ttl(5).acquire();
		await next.release();
	});

	it("locks are isolated by namespace", async () => {
		const ns1 = client.namespace("ns1/");
		const ns2 = client.namespace("ns2/");
		const first = await ns1.lock("same-name").ttl(5).acquire();

		try {
			const second = await ns2.lock("same-name").ttl(5).acquire();
			expect(second).toBeDefined();
			await second.release();
		} finally {
			await first.release();
		}
	});

	it("lock ttl expiry allows another holder to acquire the same lock", async () => {
		const first = await client.lock("locks/expires").ttl(1).acquire();
		const lease = await first.leaseId();
		expect(lease).not.toBeNull();

		// etcd3 keeps lock leases alive automatically. Stop the keepalive loop
		// without revoking the lease so this test exercises server-side TTL expiry.
		(first as unknown as { lease?: { release(): void } }).lease?.release();
		await wait(2500);

		const next = await client.lock("locks/expires").ttl(5).acquire();
		expect(next).toBeDefined();
		await next.release();
	});

	it("delete and recreate resets version and assigns a new createRevision", async () => {
		await client.put("key").value("v1");
		await client.put("key").value("v2");
		await client.delete().key("key").exec();
		await client.put("key").value("v3");

		const kv = (await client.get("key").exec()).kvs[0];
		expect(kv?.version).toBe("1");
		expect(kv?.create_revision).toBe(revision(4));
		expect(kv?.mod_revision).toBe(revision(4));
	});

	it("touch updates modRevision and version without changing value", async () => {
		await client.put("key").value("original");

		await client.put("key").touch();

		const kv = (await client.get("key").exec()).kvs[0];
		expect(kv?.value.toString()).toBe("original");
		expect(kv?.mod_revision).toBe(revision(2));
		expect(kv?.version).toBe("2");
	});

	it("touch throws on a non-existent key", async () => {
		await expect(client.put("missing").touch()).rejects.toThrow("etcdserver: key not found");
	});

	it("put().value('') stores an empty string", async () => {
		await client.put("key").value("").exec();

		expect(await client.get("key").string()).toBe("");
		expect(await client.get("key").exists()).toBe(true);
	});

	it("put().value() last call wins", async () => {
		await client.put("key").value("a").value("b").exec();

		expect(await client.get("key").string()).toBe("b");
	});

	it("limit truncates results and sets more when results are available beyond the limit", async () => {
		await client.put("a").value("1");
		await client.put("b").value("2");
		await client.put("c").value("3");

		const response = await client.getAll().limit(2).exec();

		expect(response.kvs).toHaveLength(2);
		expect(response.count).toBe("3");
		expect(response.more).toBe(true);
	});

	it("more is false when all results fit within the limit", async () => {
		await client.put("a").value("1");
		await client.put("b").value("2");

		const response = await client.getAll().limit(5).exec();

		expect(response.more).toBe(false);
	});

	it("sort returns keys in descending order", async () => {
		await client.put("a").value("1");
		await client.put("b").value("2");
		await client.put("c").value("3");

		const keys = await client.getAll().sort("Key", "Descend").keys();

		expect(keys).toEqual(["c", "b", "a"]);
	});

	it("sort by version descend returns most-written keys first", async () => {
		await client.put("a").value("1");
		await client.put("b").value("1");
		await client.put("b").value("2");
		await client.put("b").value("3");

		const keys = await client.getAll().sort("Version", "Descend").keys();

		expect(keys[0]).toBe("b");
	});

	it("sort ties on primary break by key ascending regardless of sort direction", async () => {
		// b and c both end up at version 2; tie-break should be key ascending
		await client.put("c").value("1");
		await client.put("c").value("2"); // c version 2
		await client.put("b").value("1");
		await client.put("b").value("2"); // b version 2
		await client.put("a").value("1"); // a version 1

		const keys = await client.getAll().sort("Version", "Descend").keys();

		expect(keys[0]).toBe("b");
		expect(keys[1]).toBe("c");
		expect(keys[2]).toBe("a");
	});

	it("namespace isolates reads and writes", async () => {
		const ns1 = client.namespace("ns1/");
		const ns2 = client.namespace("ns2/");

		await ns1.put("key").value("from-ns1");

		expect(await ns1.get("key").string()).toBe("from-ns1");
		expect(await ns2.get("key").string()).toBeNull();
		expect(await client.get("key").string()).toBeNull();
		expect(await client.get("ns1/key").string()).toBe("from-ns1");
	});

	it("nested namespaces compose correctly", async () => {
		const a = client.namespace("a/");
		const b = a.namespace("b/");

		await b.put("key").value("value");

		expect(await b.get("key").string()).toBe("value");
		expect(await a.get("b/key").string()).toBe("value");
		expect(await client.get("a/b/key").string()).toBe("value");
		expect(await a.get("key").string()).toBeNull();
	});

	it("namespaced put is visible as an absolute key through the root client", async () => {
		const ns = client.namespace("ns/");
		await ns.put("key").value("value");

		const result = await client.getAll().prefix("ns/").exec();

		expect(result.kvs).toHaveLength(1);
		expect(result.kvs[0]?.key.toString()).toBe("ns/key");
	});

	it("puts across namespaces increment a shared global revision counter", async () => {
		const ns1 = client.namespace("ns1/");
		const ns2 = client.namespace("ns2/");

		await ns1.put("a").value("1"); // global rev 1
		await ns2.put("b").value("2"); // global rev 2
		await ns1.put("c").value("3"); // global rev 3

		const kv1 = (await client.get("ns1/a").exec()).kvs[0];
		const kv2 = (await client.get("ns2/b").exec()).kvs[0];
		const kv3 = (await client.get("ns1/c").exec()).kvs[0];

		expect(kv1?.mod_revision).toBe(revision(1));
		expect(kv2?.mod_revision).toBe(revision(2));
		expect(kv3?.mod_revision).toBe(revision(3));
	});

	it("root client watch receives the absolute key for events written via a namespace", async () => {
		const ns = client.namespace("ns/");
		const watcher = await client.watch().prefix("ns/").create();
		const seen: string[] = [];
		watcher.on("put", (kv) => seen.push(kv.key.toString()));
		watcher.on("delete", (kv) => seen.push(`delete:${kv.key.toString()}`));

		// delete is the last event — awaiting it ensures the two puts have also arrived
		const deleteReceived = nextEvent(watcher, "delete");
		await ns.put("a").value("1");
		await ns.put("b").value("2");
		await ns.delete().key("a").exec();
		await deleteReceived;

		expect(seen).toEqual(["ns/a", "ns/b", "delete:ns/a"]);
	});

	it("root client watch withPreviousKV shows absolute keys", async () => {
		const ns = client.namespace("ns/");
		await ns.put("key").value("old");

		const watcher = await client.watch().prefix("ns/").withPreviousKV().create();
		let prevKey: string | undefined;
		watcher.on("put", (_, prev) => {
			prevKey = prev?.key.toString();
		});

		const putReceived = nextEvent(watcher, "put");
		await ns.put("key").value("new");
		await putReceived;
		expect(prevKey).toBe("ns/key");
	});

	it("namespaced watch receives relative keys for events written via another namespaced client with the same prefix", async () => {
		const writer = client.namespace("ns/");
		const watcher = await client.namespace("ns/").watch().prefix("").create();
		const seen: string[] = [];
		watcher.on("put", (kv) => seen.push(kv.key.toString()));

		const put1Received = nextEvent(watcher, "put");
		await writer.put("a").value("1");
		await put1Received;

		const put2Received = nextEvent(watcher, "put");
		await writer.put("b").value("2");
		await put2Received;

		expect(seen).toEqual(["a", "b"]);
	});

	it("namespace watch does not receive events from a different namespace", async () => {
		const ns1 = client.namespace("ns1/");
		const ns2 = client.namespace("ns2/");
		const watcher = await ns2.watch().prefix("key/").create();
		const seen: string[] = [];
		watcher.on("put", (kv) => seen.push(kv.key.toString()));

		await ns1.put("key/foo").value("v");

		expect(seen).toEqual([]);
	});

	it("cancelling a watcher stops events and emits end", async () => {
		const watcher = await client.watch().key("key").create();
		let ended = false;
		let seen = false;

		watcher.on("end", () => {
			ended = true;
		});
		watcher.on("put", () => {
			seen = true;
		});

		await watcher.cancel();
		await client.put("key").value("value");

		expect(ended).toBe(true);
		expect(seen).toBe(false);
	});

	it("cancelling one watcher does not affect another watching the same key", async () => {
		const w1 = await client.watch().key("key").create();
		const w2 = await client.watch().key("key").create();
		const seen1: string[] = [];
		const seen2: string[] = [];

		w1.on("put", (kv) => seen1.push(kv.value.toString()));
		w2.on("put", (kv) => seen2.push(kv.value.toString()));

		const bothGotFirst = Promise.all([nextEvent(w1, "put"), nextEvent(w2, "put")]);
		await client.put("key").value("first");
		await bothGotFirst;

		await w1.cancel();

		const w2GotSecond = nextEvent(w2, "put");
		await client.put("key").value("second");
		await w2GotSecond;

		expect(seen1).toEqual(["first"]);
		expect(seen2).toEqual(["first", "second"]);
	});

	it("range delete emits a delete event per deleted key", async () => {
		const watcher = await client.watch().prefix("foo/").create();
		const deleted: string[] = [];

		const bothDeleted = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for 2 delete events")),
				2000,
			);
			watcher.on("delete", (kv) => {
				deleted.push(kv.key.toString());
				if (deleted.length === 2) {
					clearTimeout(timer);
					resolve();
				}
			});
		});

		await client.put("foo/1").value("one");
		await client.put("foo/2").value("two");
		await client.delete().prefix("foo/");
		await bothDeleted;

		expect(deleted.toSorted()).toEqual(["foo/1", "foo/2"]);
	});

	it("rejects reads at a future revision", async () => {
		await expect(client.get("key").revision(revision(999)).string()).rejects.toThrow(
			"etcdserver: mvcc: required revision is a future revision",
		);
	});

	it("rejects puts with an empty key", async () => {
		await expect(client.put("").value("value").exec()).rejects.toThrow(
			"etcdserver: key is not provided",
		);
	});

	it("get() with an empty key throws", async () => {
		await expect(client.get("").string()).rejects.toThrow("etcdserver: key is not provided");
	});

	it("minModRevision filters out keys modified before the threshold", async () => {
		await client.put("a").value("1"); // rev 1
		await client.put("b").value("2"); // rev 2
		await client.put("c").value("3"); // rev 3

		const result = await client.getAll().minModRevision(revision(2)).strings();

		expect(result).toEqual({ b: "2", c: "3" });
	});

	it("maxModRevision filters out keys modified after the threshold", async () => {
		await client.put("a").value("1"); // rev 1
		await client.put("b").value("2"); // rev 2
		await client.put("c").value("3"); // rev 3

		const result = await client.getAll().maxModRevision(revision(2)).strings();

		expect(result).toEqual({ a: "1", b: "2" });
	});

	it("minCreateRevision filters out keys created before the threshold", async () => {
		await client.put("a").value("1"); // createRevision 1
		await client.put("b").value("2"); // createRevision 2
		await client.put("a").value("updated"); // modifies a, createRevision stays 1

		const result = await client.getAll().minCreateRevision(revision(2)).strings();

		expect(result).toEqual({ b: "2" });
	});

	it("maxCreateRevision filters out keys created after the threshold", async () => {
		await client.put("a").value("1"); // createRevision 1
		await client.put("b").value("2"); // createRevision 2
		await client.put("a").value("updated"); // modifies a, createRevision stays 1

		const result = await client.getAll().maxCreateRevision(revision(1)).strings();

		expect(result).toEqual({ a: "updated" });
	});

	it("get().json() returns null for a missing key", async () => {
		expect(await client.get("missing").json()).toBeNull();
	});

	it("get().json() throws SyntaxError for invalid JSON", async () => {
		await client.put("bad").value("not-json");

		await expect(client.get("bad").json()).rejects.toThrow(SyntaxError);
	});

	it("get().number() returns a parsed number", async () => {
		await client.put("count").value("42");

		expect(await client.get("count").number()).toBe(42);
	});

	it("get().number() returns null for a missing key", async () => {
		expect(await client.get("missing").number()).toBeNull();
	});

	it("get().number() returns NaN for a non-numeric value", async () => {
		await client.put("key").value("not-a-number");

		expect(await client.get("key").number()).toBeNaN();
	});

	it("getAll().json() returns parsed objects for all matching keys", async () => {
		await client.put("a").value(JSON.stringify({ x: 1 }));
		await client.put("b").value(JSON.stringify({ x: 2 }));

		const result = await client.getAll().json();

		expect(result).toEqual({ a: { x: 1 }, b: { x: 2 } });
	});

	it("getAll().numbers() returns parsed numbers for all matching keys", async () => {
		await client.put("a").value("1");
		await client.put("b").value("2");

		const result = await client.getAll().numbers();

		expect(result).toEqual({ a: 1, b: 2 });
	});

	it("getAll().numbers() returns NaN for non-numeric values", async () => {
		await client.put("a").value("42");
		await client.put("b").value("not-a-number");

		const result = await client.getAll().numbers();

		expect(result["a"]).toBe(42);
		expect(result["b"]).toBeNaN();
	});

	it("put().value(number) coerces the number to a string", async () => {
		await client.put("zero").value(0);
		await client.put("int").value(42);

		expect(await client.get("zero").string()).toBe("0");
		expect(await client.get("int").string()).toBe("42");
	});

	it("put().getPrevious() returns the previous value merged with the response header", async () => {
		await client.put("key").value("v1");

		const prev = await client.put("key").value("v2").getPrevious();

		expect(prev).toBeDefined();
		expect(prev?.value.toString()).toBe("v1");
		expect(prev?.header).toBeDefined();
		// header.revision is the revision created by the put, not the previous
		// revision. etcd builds the response header after the transaction
		// commits by calling s.KV().Rev(), which returns the post-increment
		// value. See https://github.com/etcd-io/etcd/blob/3401a41e51e0b3a58309fd3422016831e529248a/server/etcdserver/v3_server.go#L586-L593
		expect(prev?.header.revision).toBe(revision(2));
	});

	it("getAll().limit(0) returns all results without truncation", async () => {
		await client.put("a").value("1");
		await client.put("b").value("2");
		await client.put("c").value("3");

		const response = await client.getAll().limit(0).exec();

		expect(response.kvs).toHaveLength(3);
		expect(response.more).toBe(false);
	});

	it("getAll().limit(Infinity) returns all results without truncation", async () => {
		await client.put("a").value("1");
		await client.put("b").value("2");
		await client.put("c").value("3");

		const response = await client.getAll().limit(Infinity).exec();

		expect(response.kvs).toHaveLength(3);
		expect(response.more).toBe(false);
	});

	it("getAll().all() returns every key regardless of prefix", async () => {
		await client.put("x").value("1");
		await client.put("y/z").value("2");

		const result = await client.getAll().strings();

		expect(result).toEqual({ x: "1", "y/z": "2" });
	});

	it("getAll().inRange() queries a bounded [start, end) range", async () => {
		await client.put("a").value("1");
		await client.put("b").value("2");
		await client.put("c").value("3");
		await client.put("d").value("4");

		const result = await client.getAll().inRange({ start: "b", end: "d" }).strings();

		expect(result).toEqual({ b: "2", c: "3" });
	});

	it("sort is applied before limit", async () => {
		await client.put("a").value("1");
		await client.put("b").value("2");
		await client.put("c").value("3");

		const keys = await client.getAll().sort("Key", "Descend").limit(2).keys();
		expect(keys).toEqual(["c", "b"]);

		const keys2 = await client.getAll().limit(2).sort("Key", "Descend").keys();
		expect(keys2).toEqual(["c", "b"]);
	});

	it("sort by mod descend returns most-recently-modified keys first", async () => {
		await client.put("a").value("1"); // modRevision 1
		await client.put("b").value("1"); // modRevision 2
		await client.put("a").value("2"); // modRevision 3

		const keys = await client.getAll().sort("Mod", "Descend").keys();

		expect(keys[0]).toBe("a");
		expect(keys[1]).toBe("b");
	});

	it("sort by create ascend returns earliest-created keys first", async () => {
		await client.put("b").value("1"); // createRevision 1
		await client.put("a").value("1"); // createRevision 2

		const keys = await client.getAll().sort("Create", "Ascend").keys();

		expect(keys).toEqual(["b", "a"]);
	});

	it("sort by value ascend returns keys in lexicographic value order", async () => {
		await client.put("z").value("alpha");
		await client.put("a").value("beta");

		const keys = await client.getAll().sort("Value", "Ascend").keys();

		expect(keys).toEqual(["z", "a"]);
	});

	it("delete().all() removes every key", async () => {
		await client.put("a").value("1");
		await client.put("b").value("2");
		await client.put("c").value("3");

		const response = await client.delete().all().exec();

		expect(response.deleted).toBe("3");
		expect(await client.getAll().all().count()).toBe(0);
	});

	it("delete().key().getPrevious() returns the deleted value for a single key", async () => {
		await client.put("key").value("original");

		const prev = await client.delete().key("key").getPrevious();

		expect(prev).toHaveLength(1);
		expect(prev[0]?.key.toString()).toBe("key");
		expect(prev[0]?.value.toString()).toBe("original");
	});

	it("delete().inRange() deletes a bounded [start, end) range", async () => {
		await client.put("a").value("1");
		await client.put("b").value("2");
		await client.put("c").value("3");
		await client.put("d").value("4");

		const response = await client.delete().inRange({ start: "b", end: "d" }).exec();

		expect(response.deleted).toBe("2");
		expect(await client.getAll().strings()).toEqual({ a: "1", d: "4" });
	});

	it("delete().range() accepts a Range instance", async () => {
		await client.put("a").value("1");
		await client.put("b").value("2");
		await client.put("c").value("3");

		// [a, c) — includes a and b, excludes c
		const range = client.range({ start: "a", end: "c" });
		const response = await client.delete().range(range).exec();

		expect(response.deleted).toBe("2");
		expect(await client.getAll().strings()).toEqual({ c: "3" });
	});

	it("reading a key at the revision before its deletion returns the stored value", async () => {
		await client.put("key").value("original"); // rev 1
		await client.delete().key("key").exec(); // rev 2

		expect(await client.get("key").revision(revision(1)).string()).toBe("original");
		expect(await client.get("key").string()).toBeNull();
	});

	it("startRevision(0) behaves like unset and does not replay history", async () => {
		await client.put("key").value("before"); // rev 1

		const seen: string[] = [];
		const watcher = client.watch().key("key").startRevision("0").watcher();
		watcher.on("put", (kv) => seen.push(kv.value.toString()));

		await nextEvent(watcher, "connected");
		expect(seen).toEqual([]); // no replay

		const putReceived = nextEvent(watcher, "put");
		await client.put("key").value("after");
		await putReceived;
		expect(seen).toEqual(["after"]);
	});

	it("startRevision ahead of current connects without replaying history", async () => {
		await client.put("key").value("v1"); // rev 1

		const seen: string[] = [];
		const watcher = client.watch().key("key").startRevision(revision(2)).watcher();
		watcher.on("put", (kv) => seen.push(kv.value.toString()));

		await nextEvent(watcher, "connected");
		expect(seen).toEqual([]);

		const putReceived = nextEvent(watcher, "put");
		await client.put("key").value("v2"); // rev 2
		await putReceived;
		expect(seen).toEqual(["v2"]);
	});

	it("withPreviousKV on first-time put has no prevKv", async () => {
		const watcher = await client.watch().key("key").withPreviousKV().create();
		let prevReceived: unknown = "NOT_CALLED";
		watcher.on("put", (_, prev) => {
			prevReceived = prev;
		});

		const putReceived = nextEvent(watcher, "put");
		await client.put("key").value("first");
		await putReceived;
		expect(prevReceived).toBeNull();
	});

	it("withPreviousKV after delete-recreate has no prevKv on the recreation put", async () => {
		await client.put("key").value("v1");
		await client.delete().key("key").exec();

		const watcher = await client.watch().key("key").withPreviousKV().create();
		let prevReceived: unknown = "NOT_CALLED";
		watcher.on("put", (_, prev) => {
			prevReceived = prev;
		});

		const putReceived = nextEvent(watcher, "put");
		await client.put("key").value("v3"); // first put after delete
		await putReceived;
		expect(prevReceived).toBeNull();
	});

	it("accepts Buffer keys and values through put/get/delete", async () => {
		const keyBuf = Buffer.from("buffer-key");
		const valBuf = Buffer.from("buffer-value");

		await client.put(keyBuf).value(valBuf);

		const buffered = await client.get(keyBuf).buffer();
		expect(buffered).not.toBeNull();
		expect(Buffer.isBuffer(buffered)).toBe(true);
		expect(buffered?.toString()).toBe("buffer-value");
		expect(await client.get(keyBuf).string()).toBe("buffer-value");

		const response = await client.delete().key(keyBuf).exec();
		expect(response.deleted).toBe("1");
		expect(await client.get(keyBuf).exists()).toBe(false);
	});

	it("getAll().buffers() returns Buffer values keyed by their string names", async () => {
		await client.put("a").value("one");
		await client.put("b").value("two");

		const buffers = await client.getAll().buffers();

		expect(Object.keys(buffers).toSorted()).toEqual(["a", "b"]);
		expect(Buffer.isBuffer(buffers["a"])).toBe(true);
		expect(buffers["a"]?.toString()).toBe("one");
		expect(buffers["b"]?.toString()).toBe("two");
	});

	it("mutating a buffer returned by get().buffer() does not mutate stored data", async () => {
		await client.put("binary").value(Buffer.from([0, 1, 2, 255]));

		const first = await client.get("binary").buffer();
		expect(first).not.toBeNull();
		if (!first) {
			throw new Error("expected binary value");
		}
		first[0] = 99;
		first[3] = 100;

		const second = await client.get("binary").buffer();
		expect([...Buffer.from(second ?? [])]).toEqual([0, 1, 2, 255]);
	});

	it("mutating buffers returned by getAll().buffers() does not mutate stored data", async () => {
		await client.put("binary/a").value(Buffer.from([1, 2, 3]));
		await client.put("binary/b").value(Buffer.from([4, 5, 6]));

		const first = await client.getAll().prefix("binary/").buffers();
		first["binary/a"]?.fill(9);
		first["binary/b"]?.fill(8);

		const second = await client.getAll().prefix("binary/").buffers();
		expect([...Buffer.from(second["binary/a"] ?? [])]).toEqual([1, 2, 3]);
		expect([...Buffer.from(second["binary/b"] ?? [])]).toEqual([4, 5, 6]);
	});

	it("mutating previous key buffers does not mutate stored historical or current data", async () => {
		await client.put("binary").value(Buffer.from([1, 2, 3]));

		const previous = await client
			.put("binary")
			.value(Buffer.from([4, 5, 6]))
			.getPrevious();
		expect(previous).toBeDefined();
		previous?.value.fill(9);

		expect([...((await client.get("binary").revision(revision(1)).buffer()) ?? [])]).toEqual([
			1, 2, 3,
		]);
		expect([...((await client.get("binary").buffer()) ?? [])]).toEqual([4, 5, 6]);
	});

	it("mutating transaction response buffers does not mutate stored data", async () => {
		await client.put("binary/a").value(Buffer.from([7, 8, 9]));

		const result = await client
			.if("binary/ready", "Version", "==", 0)
			.then(client.get("binary/a"))
			.commit();
		const kv = result.responses[0]?.response_range?.kvs[0];
		expect(kv).toBeDefined();
		kv?.value.fill(0);

		expect([...((await client.get("binary/a").buffer()) ?? [])]).toEqual([7, 8, 9]);
	});

	it("mutating key buffers returned by exec() does not mutate stored keys", async () => {
		await client.put("binary/a").value("value");

		const first = await client.getAll().prefix("binary/").exec();
		const kv = first.kvs[0];
		expect(kv).toBeDefined();
		kv?.key.fill(120);

		const second = await client.getAll().prefix("binary/").exec();
		expect(second.kvs.map((entry) => entry.key.toString())).toEqual(["binary/a"]);
		expect(await client.get("binary/a").string()).toBe("value");
	});

	it("getAll().keyBuffers() returns keys as Buffers", async () => {
		await client.put("a").value("1");
		await client.put("b").value("2");

		const keys = await client.getAll().keyBuffers();

		expect(keys.every((k) => Buffer.isBuffer(k))).toBe(true);
		expect(keys.map((k) => k.toString()).toSorted()).toEqual(["a", "b"]);
	});

	it("mutating buffers returned by getAll().keyBuffers() does not mutate stored keys", async () => {
		await client.put("binary/a").value("one");
		await client.put("binary/b").value("two");

		const first = await client.getAll().prefix("binary/").keyBuffers();
		for (const key of first) {
			key.fill(120);
		}

		const second = await client.getAll().prefix("binary/").keyBuffers();
		expect(second.map((key) => key.toString()).toSorted()).toEqual(["binary/a", "binary/b"]);
	});

	it("get().buffer() returns null for a missing key", async () => {
		expect(await client.get("missing").buffer()).toBeNull();
	});

	it("watch().inRange() matches keys within the bounded range", async () => {
		const seen: string[] = [];
		const watcher = await client.watch().inRange({ start: "b", end: "d" }).create();
		watcher.on("put", (kv) => seen.push(kv.key.toString()));

		// "a" is outside the range and must not fire; subsequent awaited events
		// guarantee earlier events have also been processed.
		const bReceived = nextEvent(watcher, "put");
		await client.put("a").value("1");
		await client.put("b").value("2");
		await bReceived;

		const cReceived = nextEvent(watcher, "put");
		await client.put("c").value("3");
		await cReceived;

		// "d" is the exclusive end — should not fire. Write to an in-range key
		// afterwards and wait for its event; per-watch in-order delivery means
		// any event for "d" (if unexpectedly fired) would already have arrived.
		const syncReceived = nextEvent(watcher, "put");
		await client.put("d").value("4");
		await client.put("bb").value("sync");
		await syncReceived;

		expect(seen).toEqual(["b", "c", "bb"]);
	});

	it("touch emits a put event with prev_kv equal to the unchanged value", async () => {
		await client.put("key").value("original");

		const watcher = await client.watch().key("key").withPreviousKV().create();
		const events: { value: string; prev: string | undefined }[] = [];
		watcher.on("put", (kv, previous) => {
			events.push({
				value: kv.value.toString(),
				prev: previous?.value.toString(),
			});
		});

		const putReceived = nextEvent(watcher, "put");
		await client.put("key").touch();
		await putReceived;

		expect(events).toEqual([{ value: "original", prev: "original" }]);
	});

	it("startRevision replay respects only() filter", async () => {
		await client.put("a").value("1"); // rev 1
		await client.delete().key("a").exec(); // rev 2
		await client.put("a").value("2"); // rev 3
		await client.delete().key("a").exec(); // rev 4

		// Start at rev 2: the 4 writes above put revisions 1-4 on the server;
		// rev 2 is safely replayable in both the fake and real etcd.
		const seen: string[] = [];
		const watcher = client.watch().key("a").startRevision(revision(2)).only("delete").watcher();
		watcher.on("put", () => seen.push("put"));

		const twoDeletes = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("timed out waiting for 2 delete events")),
				2000,
			);
			let count = 0;
			watcher.on("delete", () => {
				seen.push("delete");
				count += 1;
				if (count === 2) {
					clearTimeout(timer);
					resolve();
				}
			});
		});

		await twoDeletes;

		expect(seen).toEqual(["delete", "delete"]);
	});

	it("startRevision replay includes prev_kv when withPreviousKV is set", async () => {
		await client.put("key").value("v1"); // rev 1
		await client.put("key").value("v2"); // rev 2

		const events: { value: string; prev: string | null }[] = [];
		const watcher = client.watch().key("key").startRevision(revision(1)).withPreviousKV().watcher();

		const twoEvents = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out waiting for 2 put events")), 2000);
			watcher.on("put", (kv, previous) => {
				events.push({
					value: kv.value.toString(),
					prev: previous ? previous.value.toString() : null,
				});
				if (events.length === 2) {
					clearTimeout(timer);
					resolve();
				}
			});
		});

		await twoEvents;

		expect(events).toEqual([
			{ value: "v1", prev: null },
			{ value: "v2", prev: "v1" },
		]);
	});

	it("startRevision replay emits delete then put across a delete-recreate", async () => {
		await client.put("key").value("v1"); // rev 1
		await client.delete().key("key").exec(); // rev 2
		await client.put("key").value("v2"); // rev 3

		const events: string[] = [];
		const watcher = client.watch().key("key").startRevision(revision(1)).watcher();

		const allEvents = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out waiting for 3 events")), 2000);
			const bump = () => {
				if (events.length === 3) {
					clearTimeout(timer);
					resolve();
				}
			};
			watcher.on("put", (kv) => {
				events.push(`put:${kv.value.toString()}`);
				bump();
			});
			watcher.on("delete", () => {
				events.push("delete");
				bump();
			});
		});

		await allEvents;

		expect(events).toEqual(["put:v1", "delete", "put:v2"]);
	});

	it("startRevision replay emits one delete per key for range delete", async () => {
		await client.put("pods/a").value("1"); // rev 1
		await client.put("pods/b").value("2"); // rev 2
		await client.delete().prefix("pods/").exec(); // two delete events

		const deleted: string[] = [];
		const watcher = client.watch().prefix("pods/").startRevision(revision(1)).watcher();

		const allEvents = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out waiting for replay")), 2000);
			let putCount = 0;
			let deleteCount = 0;
			const check = () => {
				if (putCount === 2 && deleteCount === 2) {
					clearTimeout(timer);
					resolve();
				}
			};
			watcher.on("put", () => {
				putCount += 1;
				check();
			});
			watcher.on("delete", (kv) => {
				deleted.push(kv.key.toString());
				deleteCount += 1;
				check();
			});
		});

		await allEvents;

		expect(deleted.toSorted()).toEqual(["pods/a", "pods/b"]);
	});

	it("Range.includes() returns true for keys within the range", () => {
		const r = client.range({ start: "a", end: "c" });
		expect(r.includes("a")).toBe(true);
		expect(r.includes("b")).toBe(true);
		// end is exclusive
		expect(r.includes("c")).toBe(false);
		expect(r.includes("d")).toBe(false);
	});

	it("Range.includes() treats an empty end as unbounded, matching etcd3", () => {
		// etcd3's Range.includes() treats an empty end as +infinity, so a
		// Range constructed from a single key behaves as [key, ∞). This differs
		// from etcd's wire protocol, where an empty range_end is a point match —
		// that wire semantic is preserved inside internal read/watch handling.
		const r = client.range("key");
		expect(r.includes("key")).toBe(true);
		expect(r.includes("other")).toBe(true);
		expect(r.includes("aaa")).toBe(false);
	});

	it("Range.compare() returns -1 when this range ends before the other starts", () => {
		const a = client.range({ start: "a", end: "c" });
		const b = client.range({ start: "c", end: "e" });
		expect(a.compare(b)).toBe(-1);
	});

	it("Range.compare() returns 1 when this range starts after the other ends", () => {
		const a = client.range({ start: "c", end: "e" });
		const b = client.range({ start: "a", end: "c" });
		expect(a.compare(b)).toBe(1);
	});

	it("Range.compare() returns 0 when ranges overlap", () => {
		const a = client.range({ start: "a", end: "d" });
		const b = client.range({ start: "c", end: "f" });
		expect(a.compare(b)).toBe(0);
	});

	it("ignore() is a deprecated alias for only() with identical semantics", async () => {
		// The fake and etcd3 both document ignore() as an alias for only();
		// ignore('put') therefore behaves like only('put') — receives only puts.
		// Sandwich a delete between two puts and wait for the second put: by
		// per-watch in-order delivery, any unfiltered delete event would have
		// already been delivered first.
		const events: string[] = [];
		const watcher = await client.watch().prefix("k/").ignore("put").create();
		watcher.on("delete", () => events.push("delete"));

		const secondPut = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Timed out waiting for second put")), 2000);
			watcher.on("put", () => {
				events.push("put");
				if (events.filter((e) => e === "put").length === 2) {
					clearTimeout(timer);
					resolve();
				}
			});
		});

		await client.put("k/a").value("1");
		await client.delete().key("k/a").exec();
		await client.put("k/a").value("2");
		await secondPut;

		expect(events).toEqual(["put", "put"]);
	});

	it("get().revision(N) returns null for a key that did not exist at revision N", async () => {
		await client.put("first").value("v1"); // rev 1 — creates a revision boundary
		await client.put("second").value("v2"); // rev 2 — "second" is created here

		// At rev 1, "second" did not yet exist.
		expect(await client.get("second").revision(revision(1)).string()).toBeNull();
	});

	it("get().revision(0) behaves like unset and returns the latest value", async () => {
		await client.put("key").value("v1");
		await client.put("key").value("v2");

		expect(await client.get("key").revision(0).string()).toBe("v2");
	});

	it("sort by Key Ascend returns keys in ascending lex order", async () => {
		await client.put("c").value("1");
		await client.put("a").value("2");
		await client.put("b").value("3");

		const keys = await client.getAll().sort("Key", "Ascend").keys();
		expect(keys).toEqual(["a", "b", "c"]);
	});

	it("sort by Version Ascend returns least-written keys first", async () => {
		await client.put("a").value("1"); // version 1
		await client.put("b").value("1");
		await client.put("b").value("2"); // version 2

		const keys = await client.getAll().sort("Version", "Ascend").keys();
		expect(keys[0]).toBe("a");
		expect(keys[1]).toBe("b");
	});

	it("sort by Mod Ascend returns oldest-modified keys first", async () => {
		await client.put("a").value("1"); // modRev 1
		await client.put("b").value("1"); // modRev 2
		await client.put("a").value("2"); // modRev 3

		const keys = await client.getAll().sort("Mod", "Ascend").keys();
		expect(keys).toEqual(["b", "a"]);
	});

	it("sort by Value Descend returns keys in reverse lex value order", async () => {
		await client.put("a").value("alpha");
		await client.put("b").value("zebra");
		await client.put("c").value("mango");

		const keys = await client.getAll().sort("Value", "Descend").keys();
		expect(keys).toEqual(["b", "c", "a"]);
	});

	it("watcher.id is null before connect and a string after", async () => {
		const watcher = client.watch().key("key").watcher();
		expect(watcher.id).toBeNull();

		await nextEvent(watcher, "connected");
		expect(watcher.id).not.toBeNull();
		expect(typeof watcher.id).toBe("string");
	});
	describe("compaction", () => {
		let client: Etcd | Etcd3;
		let startingRevision: number;

		function revision(r: number): string {
			return String(startingRevision + r);
		}

		beforeEach(async () => {
			client = await createEtcd();
			const res = await client.delete().all().exec();
			startingRevision = Number(res.header.revision);

			await client.put("key").value("v1"); // rev 1 for this test
			await client.put("key").value("v2"); // rev 2 for this test

			await client.kv.compact({ revision: revision(2), physical: true });
		});

		afterEach(() => {
			client.close();
		});

		it("rejects reads at a compacted revision", async () => {
			await expect(client.get("key").revision(revision(1)).string()).rejects.toThrow(/compacted/i);
		});

		it("rejects watches started behind the compaction boundary", async () => {
			const watcher = await client.watch().key("key").startRevision(revision(1)).create();
			await expect(nextEvent<Error>(watcher, "error")).resolves.toMatchObject({
				message: expect.stringMatching(/^Watcher canceled:/),
			});
		});

		it("rejects reads at a compacted revision even on an empty range", async () => {
			await expect(
				client.getAll().prefix("nonexistent/").revision(revision(1)).exec(),
			).rejects.toThrow(/compacted/i);
		});

		it("rejects watches on an empty range at a compacted revision", async () => {
			const watcher = await client
				.watch()
				.prefix("nonexistent/")
				.startRevision(revision(1))
				.create();
			await expect(nextEvent<Error>(watcher, "error")).resolves.toMatchObject({
				message: expect.stringMatching(/^Watcher canceled:/),
			});
		});

		it("rejects getAll at a compacted revision", async () => {
			await expect(client.getAll().prefix("key").revision(revision(1)).exec()).rejects.toThrow(
				/compacted/i,
			);
		});
	});
});
