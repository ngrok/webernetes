import { describe, expect, it } from "vitest";

import { Clock } from "../clock";
import { Etcd } from "./etcd";
import { withLock } from "./lock";

describe("withLock", () => {
	it("serializes many concurrent writers to shared state", async () => {
		const clock = new Clock();
		const etcd = new Etcd(clock);
		await etcd.put("counter").value(0);

		const writerCount = 50;
		const observed: number[] = [];

		await Promise.all(
			Array.from({ length: writerCount }, async () => {
				await withLock(etcd, "locks/counter", { timeoutMs: 5000 }, async () => {
					const current = await etcd.get("counter").number();
					if (current === null) {
						throw new Error("counter missing");
					}

					await clock.wait(1);
					const next = current + 1;
					observed.push(next);
					await etcd.put("counter").value(next);
				});
			}),
		);

		expect(await etcd.get("counter").number()).toBe(writerCount);
		expect(observed.toSorted((left, right) => left - right)).toEqual(
			Array.from({ length: writerCount }, (_, index) => index + 1),
		);
	});

	it("allows the next waiter to enter after the current holder releases", async () => {
		const clock = new Clock();
		const etcd = new Etcd(clock);
		const order: string[] = [];

		const first = withLock(etcd, "locks/order", { timeoutMs: 5000 }, async () => {
			order.push("first:start");
			await clock.wait(10);
			order.push("first:end");
		});

		await clock.wait(1);

		const second = withLock(etcd, "locks/order", { timeoutMs: 5000 }, async () => {
			order.push("second");
		});

		await Promise.all([first, second]);

		expect(order).toEqual(["first:start", "first:end", "second"]);
	});

	it("times out when the lock is not released before the deadline", async () => {
		const clock = new Clock();
		const etcd = new Etcd(clock);

		const held = withLock(etcd, "locks/timeout", { timeoutMs: 5000 }, async () => {
			await clock.wait(100);
		});

		await clock.wait(1);

		await expect(
			withLock(etcd, "locks/timeout", { timeoutMs: 10 }, async () => "unreachable"),
		).rejects.toThrow("timed out waiting for lock locks/timeout");

		await held;
	});

	it("does not miss a release that happens before the wait watch is installed", async () => {
		const clock = new Clock();
		const etcd = new Etcd(clock);
		const first = await etcd.lock("locks/missed-delete").ttl(5).acquire();
		const originalWatch = etcd.watch.bind(etcd);
		let releasedBeforeWatch = false;

		etcd.watch = () => {
			if (!releasedBeforeWatch) {
				releasedBeforeWatch = true;
				void first.release();
			}
			return originalWatch();
		};

		await expect(
			withLock(etcd, "locks/missed-delete", { timeoutMs: 50 }, async () => "acquired"),
		).resolves.toBe("acquired");
		expect(releasedBeforeWatch).toBe(true);
	});

	it("keeps the lock held while the callback runs longer than the acquisition timeout", async () => {
		const clock = new Clock();
		const etcd = new Etcd(clock);
		let inside = false;

		const held = withLock(etcd, "locks/long-callback", { timeoutMs: 10 }, async () => {
			inside = true;
			await clock.wait(1500);
			inside = false;
		});

		await clock.wait(500);

		expect(inside).toBe(true);
		await expect(etcd.lock("locks/long-callback").ttl(1).acquire()).rejects.toThrow(
			"Failed to acquire a lock on locks/long-callback",
		);

		await held;

		await expect(etcd.lock("locks/long-callback").ttl(1).acquire()).resolves.toBeDefined();
	});

	it("releases the lock when the callback throws", async () => {
		const clock = new Clock();
		const etcd = new Etcd(clock);

		await expect(
			withLock(etcd, "locks/throws", { timeoutMs: 5000 }, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		await expect(
			withLock(etcd, "locks/throws", { timeoutMs: 5000 }, async () => "acquired"),
		).resolves.toBe("acquired");
	});
});
