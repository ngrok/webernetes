/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// Models Go src/sync/waitgroup.go WaitGroup.
export class WaitGroup {
	private counter = 0;
	private readonly waiters: Array<() => void> = [];

	// Models Go src/sync/waitgroup.go WaitGroup.Add.
	add(delta: number): void {
		if (!Number.isInteger(delta)) {
			throw new Error("sync: WaitGroup delta must be an integer");
		}

		const next = this.counter + delta;
		if (next < 0) {
			throw new Error("sync: negative WaitGroup counter");
		}

		this.counter = next;
		if (this.counter === 0) {
			for (const waiter of this.waiters.splice(0)) {
				waiter();
			}
		}
	}

	// Models Go src/sync/waitgroup.go WaitGroup.Done.
	done(): void {
		this.add(-1);
	}

	// Models Go src/sync/waitgroup.go WaitGroup.Wait.
	wait(): Promise<void> {
		if (this.counter === 0) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve) => {
			this.waiters.push(resolve);
		});
	}
}
