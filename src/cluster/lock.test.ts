import { expect, it } from "vitest";

import { browser } from "../test/describe";
import { getClock } from "../clock-context";
import * as context from "../go/context";
import { Etcd } from "./etcd";

browser.describe("Etcd.withLock", ({ ctx }) => {
	it("serializes many concurrent writers to shared state", async () => {
		const clock = getClock(ctx);
		const etcd = newTestEtcd(ctx);
		await etcd.put("counter").value(0);

		const writerCount = 50;
		const observed: number[] = [];

		await Promise.all(
			Array.from({ length: writerCount }, async () => {
				await etcd.withLock(ctx, "locks/counter", { timeoutMs: 5000 }, async () => {
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
		const clock = getClock(ctx);
		const etcd = newTestEtcd(ctx);
		const order: string[] = [];

		const first = etcd.withLock(ctx, "locks/order", { timeoutMs: 5000 }, async () => {
			order.push("first:start");
			await clock.wait(10);
			order.push("first:end");
		});

		await clock.wait(1);

		const second = etcd.withLock(ctx, "locks/order", { timeoutMs: 5000 }, async () => {
			order.push("second");
		});

		await Promise.all([first, second]);

		expect(order).toEqual(["first:start", "first:end", "second"]);
	});

	it("times out when the lock is not released before the deadline", async () => {
		const clock = getClock(ctx);
		const etcd = newTestEtcd(ctx);

		const held = etcd.withLock(ctx, "locks/timeout", { timeoutMs: 5000 }, async () => {
			await clock.wait(100);
		});

		await clock.wait(1);

		await expect(
			etcd.withLock(ctx, "locks/timeout", { timeoutMs: 10 }, async () => "unreachable"),
		).rejects.toThrow("timed out waiting for lock locks/timeout");

		await held;
	});

	it("does not miss a release that happens before the wait watch is installed", async () => {
		const etcd = newTestEtcd(ctx);
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
			etcd.withLock(ctx, "locks/missed-delete", { timeoutMs: 50 }, async () => "acquired"),
		).resolves.toBe("acquired");
		expect(releasedBeforeWatch).toBe(true);
	});

	it("keeps the lock held while the callback runs longer than the acquisition timeout", async () => {
		const clock = getClock(ctx);
		const etcd = newTestEtcd(ctx);
		let inside = false;

		const held = etcd.withLock(ctx, "locks/long-callback", { timeoutMs: 10 }, async () => {
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

	it("stops waiting when the context is canceled", async () => {
		const etcd = newTestEtcd(ctx);
		const held = await etcd.lock("locks/canceled").ttl(5).acquire();
		const [childCtx, cancel] = context.withCancel(ctx);

		const waiting = etcd.withLock(
			childCtx,
			"locks/canceled",
			{ timeoutMs: 5000 },
			async () => "unreachable",
		);
		await Promise.resolve();
		cancel();

		await expect(waiting).rejects.toBe(context.Canceled);
		await held.release();
	});

	it("releases the lock when the callback throws", async () => {
		const etcd = newTestEtcd(ctx);

		await expect(
			etcd.withLock(ctx, "locks/throws", { timeoutMs: 5000 }, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		await expect(
			etcd.withLock(ctx, "locks/throws", { timeoutMs: 5000 }, async () => "acquired"),
		).resolves.toBe("acquired");
	});
});

function newTestEtcd(ctx: context.Context): Etcd {
	return new Etcd(ctx);
}
