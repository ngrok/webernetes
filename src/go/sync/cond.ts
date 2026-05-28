import type { Locker } from "./mutex";

// Models Go src/sync/cond.go Cond.
export class Cond {
	private readonly waiters: Array<() => void> = [];

	constructor(readonly l: Locker) {}

	// Models Go src/sync/cond.go Cond.Wait.
	async wait(): Promise<void> {
		let notify: () => void = () => {};
		const notified = new Promise<void>((resolve) => {
			notify = resolve;
		});
		this.waiters.push(notify);
		await this.l.unlock();
		await notified;
		await this.l.lock();
	}

	// Models Go src/sync/cond.go Cond.Signal.
	signal(): void {
		const waiter = this.waiters.shift();
		waiter?.();
	}

	// Models Go src/sync/cond.go Cond.Broadcast.
	broadcast(): void {
		const waiters = this.waiters.splice(0);
		for (const waiter of waiters) {
			waiter();
		}
	}
}

// Models Go src/sync/cond.go NewCond.
export function newCond(l: Locker): Cond {
	return new Cond(l);
}

export type { Locker };
