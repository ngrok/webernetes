import { expect, it } from "vitest";

import { Clock } from "../../clock";
import { browser } from "../../test/describe";
import { Mutex, RWMutex } from "./mutex";

browser.describe("Mutex", () => {
	// Models Go src/sync/mutex.go Mutex.Lock.
	it("grants the lock immediately when it is free", async () => {
		const mutex = new Mutex();

		await mutex.lock();

		expect(mutex.isLocked()).toBe(true);
		expect(mutex.pending()).toBe(0);
		mutex.unlock();
		expect(mutex.isLocked()).toBe(false);
	});

	it("serializes concurrent writers to shared state", async () => {
		const clock = new Clock();
		const mutex = new Mutex();
		let counter = 0;

		await Promise.all(
			Array.from({ length: 50 }, () =>
				mutex.withLock(async () => {
					const current = counter;
					await clock.wait(1);
					counter = current + 1;
				}),
			),
		);

		expect(counter).toBe(50);
	});

	it("grants queued waiters in FIFO order", async () => {
		const mutex = new Mutex();
		const order: string[] = [];

		await mutex.lock();
		const second = mutex.withLock(() => {
			order.push("second");
		});
		const third = mutex.withLock(() => {
			order.push("third");
		});

		expect(mutex.pending()).toBe(2);
		mutex.unlock();
		await Promise.all([second, third]);

		expect(order).toEqual(["second", "third"]);
	});

	it("releases the lock when the callback throws", async () => {
		const mutex = new Mutex();

		await expect(
			mutex.withLock(() => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		await expect(mutex.withLock(() => "next")).resolves.toBe("next");
	});

	// Models Go src/sync/mutex.go Mutex.Unlock.
	it("throws when unlocking an unlocked mutex", async () => {
		const mutex = new Mutex();

		expect(() => mutex.unlock()).toThrow("sync: unlock of unlocked mutex");

		await mutex.lock();
		mutex.unlock();
		expect(() => mutex.unlock()).toThrow("sync: unlock of unlocked mutex");
	});

	// Models Go src/sync/mutex.go Mutex.TryLock.
	it("tryLock only succeeds when the lock is free", () => {
		const mutex = new Mutex();

		expect(mutex.tryLock()).toBe(true);
		expect(mutex.tryLock()).toBe(false);
		mutex.unlock();
		expect(mutex.tryLock()).toBe(true);
		mutex.unlock();
	});
});

browser.describe("RWMutex", () => {
	// Models Go src/sync/rwmutex.go RWMutex.RLock.
	it("allows multiple readers to enter concurrently", async () => {
		const lock = new RWMutex();
		await lock.rLock();
		await lock.rLock();

		expect(lock.isLocked()).toBe(true);
		expect(lock.readerCount()).toBe(2);

		lock.rUnlock();
		expect(lock.readerCount()).toBe(1);
		lock.rUnlock();
		expect(lock.isLocked()).toBe(false);
	});

	it("makes writers wait for active readers", async () => {
		const lock = new RWMutex();
		const order: string[] = [];
		await lock.rLock();
		const writer = lock.withLock(() => {
			order.push("writer");
		});

		await Promise.resolve();
		expect(order).toEqual([]);
		expect(lock.pending()).toBe(1);

		lock.rUnlock();
		await writer;
		expect(order).toEqual(["writer"]);
	});

	it("makes readers wait for an active writer", async () => {
		const lock = new RWMutex();
		const order: string[] = [];
		await lock.lock();
		const reader = lock.withRLock(() => {
			order.push("reader");
		});

		await Promise.resolve();
		expect(order).toEqual([]);
		expect(lock.pending()).toBe(1);

		lock.unlock();
		await reader;
		expect(order).toEqual(["reader"]);
	});

	it("makes writers exclusive against other writers", async () => {
		const lock = new RWMutex();
		const order: string[] = [];
		await lock.lock();
		const second = lock.withLock(() => {
			order.push("second");
		});

		await Promise.resolve();
		expect(order).toEqual([]);

		lock.unlock();
		await second;
		expect(order).toEqual(["second"]);
	});

	it("blocks later readers behind a queued writer", async () => {
		const lock = new RWMutex();
		const order: string[] = [];
		await lock.rLock();
		const writer = lock.withLock(() => {
			order.push("writer");
		});
		const laterReader = lock.withRLock(() => {
			order.push("reader");
		});

		await Promise.resolve();
		expect(lock.pending()).toBe(2);
		expect(order).toEqual([]);

		lock.rUnlock();
		await Promise.all([writer, laterReader]);
		expect(order).toEqual(["writer", "reader"]);
	});

	it("batches consecutive queued readers before a writer", async () => {
		const lock = new RWMutex();
		const order: string[] = [];
		await lock.lock();
		const firstReader = lock.withRLock(() => {
			order.push("first-reader");
		});
		const secondReader = lock.withRLock(() => {
			order.push("second-reader");
		});
		const writer = lock.withLock(() => {
			order.push("writer");
		});

		await Promise.resolve();
		expect(lock.pending()).toBe(3);

		lock.unlock();
		await Promise.all([firstReader, secondReader, writer]);
		expect(order).toEqual(["first-reader", "second-reader", "writer"]);
	});

	it("releases read and write locks when callbacks throw", async () => {
		const lock = new RWMutex();

		await expect(
			lock.withRLock(() => {
				throw new Error("read boom");
			}),
		).rejects.toThrow("read boom");
		await expect(lock.withLock(() => "writer")).resolves.toBe("writer");

		await expect(
			lock.withLock(() => {
				throw new Error("write boom");
			}),
		).rejects.toThrow("write boom");
		await expect(lock.withRLock(() => "reader")).resolves.toBe("reader");
	});

	// Models Go src/sync/rwmutex.go RWMutex.TryRLock.
	it("tryRLock fails while a writer is active or waiting", async () => {
		const lock = new RWMutex();

		await lock.lock();
		expect(lock.tryRLock()).toBe(false);
		lock.unlock();

		await lock.rLock();
		const writer = lock.lock();
		expect(lock.tryRLock()).toBe(false);
		lock.rUnlock();
		await writer;
		lock.unlock();
	});

	// Models Go src/sync/rwmutex.go RWMutex.Unlock.
	it("throws when unlocking an unlocked RWMutex", async () => {
		const lock = new RWMutex();

		expect(() => lock.unlock()).toThrow("sync: Unlock of unlocked RWMutex");
		await lock.lock();
		lock.unlock();
		expect(() => lock.unlock()).toThrow("sync: Unlock of unlocked RWMutex");
	});

	// Models Go src/sync/rwmutex.go RWMutex.RUnlock.
	it("throws when runlocking an unlocked RWMutex", async () => {
		const lock = new RWMutex();

		expect(() => lock.rUnlock()).toThrow("sync: RUnlock of unlocked RWMutex");
		await lock.rLock();
		lock.rUnlock();
		expect(() => lock.rUnlock()).toThrow("sync: RUnlock of unlocked RWMutex");
	});
});
