import { expect, it } from "vitest";

import { browser } from "./test/describe";
import { Clock } from "./clock";
import { Mutex, RWMutex } from "./mutex";

browser.describe("Mutex", () => {
	it("grants the lock immediately when it is free", async () => {
		const mutex = new Mutex();

		const release = await mutex.lock();

		expect(mutex.isLocked()).toBe(true);
		expect(mutex.pending()).toBe(0);
		release();
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

		const firstRelease = await mutex.lock();
		const second = mutex.withLock(() => {
			order.push("second");
		});
		const third = mutex.withLock(() => {
			order.push("third");
		});

		expect(mutex.pending()).toBe(2);
		firstRelease();
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

	it("makes release idempotent", async () => {
		const mutex = new Mutex();

		const release = await mutex.lock();
		release();
		release();

		expect(mutex.isLocked()).toBe(false);
		await expect(mutex.withLock(() => "next")).resolves.toBe("next");
	});

	it("tryLock only succeeds when the lock is free", async () => {
		const mutex = new Mutex();

		const release = mutex.tryLock();

		expect(release).toBeDefined();
		expect(mutex.tryLock()).toBeUndefined();
		release?.();
		expect(mutex.tryLock()).toBeDefined();
	});
});

browser.describe("RWMutex", () => {
	it("allows multiple readers to enter concurrently", async () => {
		const lock = new RWMutex();
		const first = await lock.rLock();
		const second = await lock.rLock();

		expect(lock.isLocked()).toBe(true);
		expect(lock.readerCount()).toBe(2);

		first();
		expect(lock.readerCount()).toBe(1);
		second();
		expect(lock.isLocked()).toBe(false);
	});

	it("makes writers wait for active readers", async () => {
		const lock = new RWMutex();
		const order: string[] = [];
		const readRelease = await lock.rLock();
		const writer = lock.withLock(() => {
			order.push("writer");
		});

		await Promise.resolve();
		expect(order).toEqual([]);
		expect(lock.pending()).toBe(1);

		readRelease();
		await writer;
		expect(order).toEqual(["writer"]);
	});

	it("makes readers wait for an active writer", async () => {
		const lock = new RWMutex();
		const order: string[] = [];
		const writeRelease = await lock.lock();
		const reader = lock.withRLock(() => {
			order.push("reader");
		});

		await Promise.resolve();
		expect(order).toEqual([]);
		expect(lock.pending()).toBe(1);

		writeRelease();
		await reader;
		expect(order).toEqual(["reader"]);
	});

	it("makes writers exclusive against other writers", async () => {
		const lock = new RWMutex();
		const order: string[] = [];
		const firstRelease = await lock.lock();
		const second = lock.withLock(() => {
			order.push("second");
		});

		await Promise.resolve();
		expect(order).toEqual([]);

		firstRelease();
		await second;
		expect(order).toEqual(["second"]);
	});

	it("blocks later readers behind a queued writer", async () => {
		const lock = new RWMutex();
		const order: string[] = [];
		const firstReaderRelease = await lock.rLock();
		const writer = lock.withLock(() => {
			order.push("writer");
		});
		const laterReader = lock.withRLock(() => {
			order.push("reader");
		});

		await Promise.resolve();
		expect(lock.pending()).toBe(2);
		expect(order).toEqual([]);

		firstReaderRelease();
		await Promise.all([writer, laterReader]);
		expect(order).toEqual(["writer", "reader"]);
	});

	it("batches consecutive queued readers before a writer", async () => {
		const lock = new RWMutex();
		const order: string[] = [];
		const writerRelease = await lock.lock();
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

		writerRelease();
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

	it("tryRLock fails while a writer is active or waiting", async () => {
		const lock = new RWMutex();

		const writerRelease = await lock.lock();
		expect(lock.tryRLock()).toBeUndefined();
		writerRelease();

		const readerRelease = await lock.rLock();
		const writer = lock.lock();
		expect(lock.tryRLock()).toBeUndefined();
		readerRelease();
		const queuedWriterRelease = await writer;
		queuedWriterRelease();
	});

	it("makes read and write releases idempotent", async () => {
		const lock = new RWMutex();

		const readRelease = await lock.rLock();
		readRelease();
		readRelease();
		expect(lock.readerCount()).toBe(0);

		const writeRelease = await lock.lock();
		writeRelease();
		writeRelease();
		expect(lock.isLocked()).toBe(false);
	});
});
