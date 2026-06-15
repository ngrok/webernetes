/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Golang, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import { browser } from "../../../test/describe";
import * as heap from "./heap";

class NumberHeap implements heap.Interface<number> {
	readonly items: number[] = [];

	len(): number {
		return this.items.length;
	}

	less(i: number, j: number): boolean {
		return this.items[i] < this.items[j];
	}

	swap(i: number, j: number): void {
		const left = this.items[i] as number;
		const right = this.items[j] as number;
		this.items[i] = right;
		this.items[j] = left;
	}

	push(item: number): void {
		this.items.push(item);
	}

	pop(): number {
		const item = this.items.pop();
		if (item === undefined) {
			throw new Error("pop from empty heap");
		}
		return item;
	}
}

function verifyHeap(h: NumberHeap, i = 0): void {
	const n = h.len();
	const j1 = 2 * i + 1;
	const j2 = 2 * i + 2;
	if (j1 < n) {
		if (h.less(j1, i)) {
			throw new Error(`heap invariant invalidated at ${i} and ${j1}`);
		}
		verifyHeap(h, j1);
	}
	if (j2 < n) {
		if (h.less(j2, i)) {
			throw new Error(`heap invariant invalidated at ${i} and ${j2}`);
		}
		verifyHeap(h, j2);
	}
}

browser.describe("heap", () => {
	// Models Go src/container/heap/heap_test.go TestInit0.
	it("initializes and pops duplicate items", () => {
		const h = new NumberHeap();
		for (let i = 20; i > 0; i--) {
			h.push(0);
		}
		heap.init(h);
		verifyHeap(h);

		while (h.len() > 0) {
			const item = heap.pop(h);
			verifyHeap(h);
			expect(item).toBe(0);
		}
	});

	// Models Go src/container/heap/heap_test.go TestInit1.
	it("initializes and pops distinct items in order", () => {
		const h = new NumberHeap();
		for (let i = 20; i > 0; i--) {
			h.push(i);
		}
		heap.init(h);
		verifyHeap(h);

		for (let i = 1; h.len() > 0; i++) {
			const item = heap.pop(h);
			verifyHeap(h);
			expect(item).toBe(i);
		}
	});

	// Models Go src/container/heap/heap_test.go Test.
	it("preserves ordering across interleaved push and pop", () => {
		const h = new NumberHeap();
		verifyHeap(h);

		for (let i = 20; i > 10; i--) {
			h.push(i);
		}
		heap.init(h);
		verifyHeap(h);

		for (let i = 10; i > 0; i--) {
			heap.push(h, i);
			verifyHeap(h);
		}

		for (let i = 1; h.len() > 0; i++) {
			const item = heap.pop(h);
			if (i < 20) {
				heap.push(h, 20 + i);
			}
			verifyHeap(h);
			expect(item).toBe(i);
		}
	});

	// Models Go src/container/heap/heap_test.go TestRemove0.
	it("removes the last item in order", () => {
		const h = new NumberHeap();
		for (let i = 0; i < 10; i++) {
			h.push(i);
		}
		verifyHeap(h);

		while (h.len() > 0) {
			const i = h.len() - 1;
			const item = heap.remove(h, i);
			verifyHeap(h);
			expect(item).toBe(i);
		}
	});

	// Models Go src/container/heap/heap_test.go TestRemove1.
	it("removes the root item in order", () => {
		const h = new NumberHeap();
		for (let i = 0; i < 10; i++) {
			heap.push(h, i);
		}
		verifyHeap(h);

		for (let i = 0; h.len() > 0; i++) {
			const item = heap.remove(h, 0);
			verifyHeap(h);
			expect(item).toBe(i);
		}
	});

	// Models Go src/container/heap/heap_test.go TestRemove2.
	it("removes middle items without losing values", () => {
		const n = 10;
		const h = new NumberHeap();
		for (let i = 0; i < n; i++) {
			h.push(i);
		}
		verifyHeap(h);

		const values = new Set<number>();
		while (h.len() > 0) {
			values.add(heap.remove(h, Math.floor((h.len() - 1) / 2)));
			verifyHeap(h);
		}

		expect(values.size).toBe(n);
		for (let i = 0; i < values.size; i++) {
			expect(values.has(i)).toBe(true);
		}
	});

	// Models Go src/container/heap/heap_test.go TestFix.
	it("fixes ordering after item priority changes", () => {
		const h = new NumberHeap();
		verifyHeap(h);

		for (let i = 200; i > 0; i -= 10) {
			heap.push(h, i);
		}
		verifyHeap(h);
		expect(h.items[0]).toBe(10);

		h.items[0] = 210;
		heap.fix(h, 0);
		verifyHeap(h);
		expect(h.items[0]).toBe(20);

		const index = h.items.indexOf(100);
		h.items[index] = 5;
		heap.fix(h, index);
		verifyHeap(h);
		expect(h.items[0]).toBe(5);
	});
});
