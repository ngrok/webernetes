import { expect, it } from "vitest";

import type { KubernetesObject } from "../../../client/types";
import { browser } from "../../../test/describe";
import { errFIFOClosed, newFIFO, type FIFO, type Queue } from "./fifo";
import { ExplicitKey } from "./store";

interface TestFifoObject extends KubernetesObject {
	name: string;
	val: number | bigint;
}

browser.describe("FIFO", () => {
	// Models staging/src/k8s.io/client-go/tools/cache/fifo_test.go TestFIFO_basic.
	it("keeps each producer's objects in order", async () => {
		const f = newFIFO(testFifoObjectKeyFunc);
		const amount = 500;
		const intProducer = async () => {
			for (let i = 0; i < amount; i++) {
				await f.add(mkFifoObj(`a${String.fromCodePoint(i)}`, i + 1));
			}
		};
		const uintProducer = async () => {
			for (let u = 0; u < amount; u++) {
				await f.add(mkFifoObj(`b${String.fromCodePoint(u)}`, BigInt(u + 1)));
			}
		};
		const producers = Promise.all([intProducer(), uintProducer()]);

		let lastInt = 0;
		let lastUint = 0n;
		for (let i = 0; i < amount * 2; i++) {
			const obj = await pop(f);
			if (typeof obj?.val === "number") {
				if (obj.val <= lastInt) {
					throw new Error(`got ${obj.val} (int) out of order, last was ${lastInt}`);
				}
				lastInt = obj.val;
				continue;
			}
			if (typeof obj?.val === "bigint") {
				if (obj.val <= lastUint) {
					throw new Error(`got ${obj.val} (uint) out of order, last was ${lastUint}`);
				}
				lastUint = obj.val;
				continue;
			}
			throw new Error(`unexpected type ${typeof obj?.val}`);
		}
		expect(lastInt).toBe(amount);
		expect(lastUint).toBe(BigInt(amount));
		await producers;
	});

	// Models staging/src/k8s.io/client-go/tools/cache/fifo_test.go TestFIFO_addUpdate.
	it("updates a queued item in place", async () => {
		const f = newFIFO(testFifoObjectKeyFunc);
		try {
			await f.add(mkFifoObj("foo", 10));
			await f.update(mkFifoObj("foo", 15));

			expect(f.list()).toEqual([mkFifoObj("foo", 15)]);
			expect(f.listKeys()).toEqual(["foo"]);

			const first = await pop(f);
			expect(first?.val).toBe(15);
			await expectPopBlocked(f);
			const [, exists] = await f.get(mkFifoObj("foo", 0));
			expect(exists).toBe(false);
		} finally {
			f.close();
		}
	});

	// Models staging/src/k8s.io/client-go/tools/cache/fifo_test.go TestFIFO_addReplace.
	it("replaces a queued item in place", async () => {
		const f = newFIFO(testFifoObjectKeyFunc);
		try {
			await f.add(mkFifoObj("foo", 10));
			await f.replace([mkFifoObj("foo", 15)], "15");

			const first = await pop(f);
			expect(first?.val).toBe(15);
			await expectPopBlocked(f);
			const [, exists] = await f.get(mkFifoObj("foo", 0));
			expect(exists).toBe(false);
		} finally {
			f.close();
		}
	});

	// Models staging/src/k8s.io/client-go/tools/cache/fifo_test.go TestFIFO_detectLineJumpers.
	it("does not let updated objects jump the queue", async () => {
		const f = newFIFO(testFifoObjectKeyFunc);

		await f.add(mkFifoObj("foo", 10));
		await f.add(mkFifoObj("bar", 1));
		await f.add(mkFifoObj("foo", 11));
		await f.add(mkFifoObj("foo", 13));
		await f.add(mkFifoObj("zab", 30));

		expect((await pop(f))?.val).toBe(13);

		await f.add(mkFifoObj("foo", 14));

		expect((await pop(f))?.val).toBe(1);
		expect((await pop(f))?.val).toBe(30);
		expect((await pop(f))?.val).toBe(14);
	});

	// Models staging/src/k8s.io/client-go/tools/cache/fifo_test.go TestFIFO_HasSynced.
	it("reports initial sync state", async () => {
		const tests: Array<{
			actions: Array<(f: FIFO<TestFifoObject>) => Promise<void>>;
			expectedSynced: boolean;
		}> = [
			{
				actions: [],
				expectedSynced: false,
			},
			{
				actions: [async (f) => void (await f.add(mkFifoObj("a", 1)))],
				expectedSynced: true,
			},
			{
				actions: [async (f) => void (await f.replace([], "0"))],
				expectedSynced: true,
			},
			{
				actions: [async (f) => void (await f.replace([mkFifoObj("a", 1), mkFifoObj("b", 2)], "0"))],
				expectedSynced: false,
			},
			{
				actions: [
					async (f) => void (await f.replace([mkFifoObj("a", 1), mkFifoObj("b", 2)], "0")),
					async (f) => void (await pop(f)),
				],
				expectedSynced: false,
			},
			{
				actions: [
					async (f) => void (await f.replace([mkFifoObj("a", 1), mkFifoObj("b", 2)], "0")),
					async (f) => void (await pop(f)),
					async (f) => void (await pop(f)),
				],
				expectedSynced: true,
			},
		];

		for (const test of tests) {
			const f = newFIFO(testFifoObjectKeyFunc);
			for (const action of test.actions) {
				await action(f);
			}
			expect(f.hasSynced()).toBe(test.expectedSynced);
		}
	});

	// Models staging/src/k8s.io/client-go/tools/cache/fifo_test.go TestFIFO_PopShouldUnblockWhenClosed.
	it("unblocks pending pops when closed", async () => {
		const f = newFIFO(testFifoObjectKeyFunc);
		const jobs = 10;
		const pops = Array.from({ length: jobs }, async () => {
			const [, err] = await f.pop(() => undefined);
			return err;
		});

		await Promise.resolve();
		f.close();

		await expect(Promise.all(pops)).resolves.toEqual(
			Array.from({ length: jobs }, () => errFIFOClosed),
		);
	});
});

// Models staging/src/k8s.io/client-go/tools/cache/fifo_test.go testFifoObjectKeyFunc.
function testFifoObjectKeyFunc(obj: TestFifoObject | ExplicitKey): [string, Error | undefined] {
	if (obj instanceof ExplicitKey) {
		return [obj.key, undefined];
	}
	return [obj.name, undefined];
}

// Models staging/src/k8s.io/client-go/tools/cache/fifo_test.go mkFifoObj.
function mkFifoObj(name: string, val: number | bigint): TestFifoObject {
	return {
		name,
		val,
	};
}

async function expectPopBlocked(f: FIFO<TestFifoObject>): Promise<void> {
	const sentinel = Symbol("blocked");
	const result = await Promise.race([pop(f), Promise.resolve().then(() => sentinel)]);
	expect(result).toBe(sentinel);
}

// Models staging/src/k8s.io/client-go/tools/cache/fifo_test.go Pop.
async function pop<T extends KubernetesObject>(queue: Queue<T>): Promise<T | undefined> {
	const [obj] = await queue.pop(() => undefined);
	return obj;
}
