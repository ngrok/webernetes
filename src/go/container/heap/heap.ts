/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type * as sort from "../../sort/sort";

// Models Go src/container/heap/heap.go Interface.
export interface Interface<T> extends sort.Interface {
	push(item: T): void;
	pop(): T;
}

// Models Go src/container/heap/heap.go Init.
export function init<T>(h: Interface<T>): void {
	const n = h.len();
	for (let i = Math.floor(n / 2) - 1; i >= 0; i--) {
		down(h, i, n);
	}
}

// Models Go src/container/heap/heap.go Push.
export function push<T>(h: Interface<T>, item: T): void {
	h.push(item);
	up(h, h.len() - 1);
}

// Models Go src/container/heap/heap.go Pop.
export function pop<T>(h: Interface<T>): T {
	const n = h.len() - 1;
	h.swap(0, n);
	down(h, 0, n);
	return h.pop();
}

// Models Go src/container/heap/heap.go Remove.
export function remove<T>(h: Interface<T>, i: number): T {
	const n = h.len() - 1;
	if (n !== i) {
		h.swap(i, n);
		if (!down(h, i, n)) {
			up(h, i);
		}
	}
	return h.pop();
}

// Models Go src/container/heap/heap.go Fix.
export function fix<T>(h: Interface<T>, i: number): void {
	if (!down(h, i, h.len())) {
		up(h, i);
	}
}

// Models Go src/container/heap/heap.go up.
function up(h: sort.Interface, j: number): void {
	for (;;) {
		const i = Math.trunc((j - 1) / 2);
		if (i === j || !h.less(j, i)) {
			break;
		}
		h.swap(i, j);
		j = i;
	}
}

// Models Go src/container/heap/heap.go down.
function down(h: sort.Interface, i0: number, n: number): boolean {
	let i = i0;
	for (;;) {
		const j1 = 2 * i + 1;
		if (j1 >= n || j1 < 0) {
			break;
		}
		let j = j1;
		const j2 = j1 + 1;
		if (j2 < n && h.less(j2, j1)) {
			j = j2;
		}
		if (!h.less(j, i)) {
			break;
		}
		h.swap(i, j);
		i = j;
	}
	return i > i0;
}
