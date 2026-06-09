/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import { browser } from "../../test/describe";
import { Channel, select } from "../channel";
import { newCond } from "./cond";
import { Mutex } from "./mutex";

browser.describe("Cond", () => {
	// Models Go src/sync/cond_test.go TestCondSignal.
	it("signal wakes one waiter", async () => {
		const c = newCond(new Mutex());
		let n = 2;
		const running = new Channel<boolean>(n);
		const awake = new Channel<boolean>(n);
		for (let i = 0; i < n; i++) {
			void (async () => {
				await c.l.lock();
				await running.send(true);
				await c.wait();
				await awake.send(true);
				await c.l.unlock();
			})();
		}
		for (let i = 0; i < n; i++) {
			await running.receive();
		}
		while (n > 0) {
			expect(await channelIsReady(awake)).toBe(false);
			await c.l.lock();
			c.signal();
			await c.l.unlock();
			await awake.receive();
			expect(await channelIsReady(awake)).toBe(false);
			n--;
		}
		c.signal();
	});

	// Models Go src/sync/cond_test.go TestCondSignalGenerations.
	it("signal wakes waiters by generation", async () => {
		const c = newCond(new Mutex());
		const n = 100;
		const running = new Channel<boolean>(n);
		const awake = new Channel<number>(n);
		for (let i = 0; i < n; i++) {
			void (async (i) => {
				await c.l.lock();
				await running.send(true);
				await c.wait();
				await awake.send(i);
				await c.l.unlock();
			})(i);
			if (i > 0) {
				const a = await awake.receive();
				if (!a.ok || a.value !== i - 1) {
					throw new Error(
						`wrong goroutine woke up: want ${i - 1}, got ${a.ok ? a.value : "<closed>"}`,
					);
				}
			}
			await running.receive();
			await c.l.lock();
			c.signal();
			await c.l.unlock();
		}
		const last = await awake.receive();
		expect(last.ok ? last.value : undefined).toBe(n - 1);
	});

	// Models Go src/sync/cond_test.go TestCondBroadcast.
	it("broadcast wakes all waiters", async () => {
		const c = newCond(new Mutex());
		const n = 200;
		const running = new Channel<number>(n);
		const awake = new Channel<number>(n);
		let exit = false;
		for (let i = 0; i < n; i++) {
			void (async (g) => {
				await c.l.lock();
				for (;;) {
					if (exit) {
						break;
					}
					await running.send(g);
					await c.wait();
					await awake.send(g);
				}
				await c.l.unlock();
			})(i);
		}
		for (let i = 0; i < n; i++) {
			for (let j = 0; j < n; j++) {
				await running.receive();
			}
			if (i === n - 1) {
				await c.l.lock();
				exit = true;
				await c.l.unlock();
			}
			expect(await channelIsReady(awake)).toBe(false);
			await c.l.lock();
			c.broadcast();
			await c.l.unlock();
			const seen = new Set<number>();
			for (let j = 0; j < n; j++) {
				const g = await awake.receive();
				if (!g.ok) {
					throw new Error("awake channel closed");
				}
				if (seen.has(g.value)) {
					throw new Error("goroutine woke up twice");
				}
				seen.add(g.value);
			}
		}
		expect(await channelIsReady(running)).toBe(false);
		c.broadcast();
	});

	// Models Go src/sync/cond_test.go TestRace.
	it("coordinates state changes across waiters", async () => {
		let x = 0;
		const c = newCond(new Mutex());
		const done = new Channel<Error | undefined>();

		void (async () => {
			try {
				await c.l.lock();
				x = 1;
				await c.wait();
				if (x !== 2) {
					throw new Error("want 2");
				}
				x = 3;
				c.signal();
				await c.l.unlock();
				await done.send(undefined);
			} catch (err) {
				await done.send(err instanceof Error ? err : new Error(String(err)));
			}
		})();
		void (async () => {
			try {
				await c.l.lock();
				for (;;) {
					if (x === 1) {
						x = 2;
						c.signal();
						break;
					}
					await c.l.unlock();
					await gosched();
					await c.l.lock();
				}
				await c.l.unlock();
				await done.send(undefined);
			} catch (err) {
				await done.send(err instanceof Error ? err : new Error(String(err)));
			}
		})();
		void (async () => {
			try {
				await c.l.lock();
				for (;;) {
					if (x === 2) {
						await c.wait();
						if ((x as number) !== 3) {
							throw new Error("want 3");
						}
						break;
					}
					if (x === 3) {
						break;
					}
					await c.l.unlock();
					await gosched();
					await c.l.lock();
				}
				await c.l.unlock();
				await done.send(undefined);
			} catch (err) {
				await done.send(err instanceof Error ? err : new Error(String(err)));
			}
		})();

		for (let i = 0; i < 3; i++) {
			const result = await done.receive();
			expect(result.ok ? result.value : new Error("done channel closed")).toBeUndefined();
		}
	});
});

async function channelIsReady<T>(channel: Channel<T>): Promise<boolean> {
	return await select()
		.case(channel, () => true)
		.default(() => false);
}

async function gosched(): Promise<void> {
	await Promise.resolve();
}
