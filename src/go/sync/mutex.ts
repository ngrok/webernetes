import type { MaybePromise } from "../../promise";

interface MutexWaiter {
	resolve(): void;
}

// Models Go src/sync/mutex.go Locker.
export interface Locker {
	lock(): MaybePromise<void>;
	unlock(): MaybePromise<void>;
}

// Models Go src/sync/mutex.go Mutex.
export class Mutex implements Locker {
	private locked = false;
	private readonly waiters: MutexWaiter[] = [];

	// Models Go src/sync/mutex.go Mutex.Lock.
	lock(): Promise<void> {
		if (this.tryLock()) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve) => {
			this.waiters.push({ resolve });
		});
	}

	// Models Go src/sync/mutex.go Mutex.TryLock.
	tryLock(): boolean {
		if (this.locked) {
			return false;
		}
		this.locked = true;
		return true;
	}

	// Models Go src/sync/mutex.go Mutex.Unlock.
	unlock(): void {
		if (!this.locked) {
			throw new Error("sync: unlock of unlocked mutex");
		}
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter.resolve();
			return;
		}
		this.locked = false;
	}

	async withLock<T>(fn: () => MaybePromise<T>): Promise<T> {
		await this.lock();
		try {
			return await fn();
		} finally {
			this.unlock();
		}
	}

	isLocked(): boolean {
		return this.locked;
	}

	pending(): number {
		return this.waiters.length;
	}
}

type RWMutexWaiter =
	| {
			kind: "read";
			resolve(): void;
	  }
	| {
			kind: "write";
			resolve(): void;
	  };

// Models Go src/sync/rwmutex.go RWMutex.
export class RWMutex implements Locker {
	private activeReaders = 0;
	private writerActive = false;
	private waitingWriters = 0;
	private readonly waiters: RWMutexWaiter[] = [];

	// Models Go src/sync/rwmutex.go RWMutex.Lock.
	lock(): Promise<void> {
		if (this.tryLock()) {
			return Promise.resolve();
		}

		this.waitingWriters++;
		return new Promise<void>((resolve) => {
			this.waiters.push({ kind: "write", resolve });
		});
	}

	// Models Go src/sync/rwmutex.go RWMutex.RLock.
	rLock(): Promise<void> {
		if (this.tryRLock()) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve) => {
			this.waiters.push({ kind: "read", resolve });
		});
	}

	// Models Go src/sync/rwmutex.go RWMutex.TryLock.
	tryLock(): boolean {
		if (this.writerActive || this.activeReaders !== 0) {
			return false;
		}
		this.writerActive = true;
		return true;
	}

	// Models Go src/sync/rwmutex.go RWMutex.TryRLock.
	tryRLock(): boolean {
		if (this.writerActive || this.waitingWriters !== 0) {
			return false;
		}
		this.activeReaders++;
		return true;
	}

	// Models Go src/sync/rwmutex.go RWMutex.Unlock.
	unlock(): void {
		if (!this.writerActive) {
			throw new Error("sync: Unlock of unlocked RWMutex");
		}
		this.writerActive = false;
		this.dispatch();
	}

	// Models Go src/sync/rwmutex.go RWMutex.RUnlock.
	rUnlock(): void {
		if (this.activeReaders <= 0) {
			throw new Error("sync: RUnlock of unlocked RWMutex");
		}
		this.activeReaders--;
		if (this.activeReaders === 0) {
			this.dispatch();
		}
	}

	async withLock<T>(fn: () => MaybePromise<T>): Promise<T> {
		await this.lock();
		try {
			return await fn();
		} finally {
			this.unlock();
		}
	}

	async withRLock<T>(fn: () => MaybePromise<T>): Promise<T> {
		await this.rLock();
		try {
			return await fn();
		} finally {
			this.rUnlock();
		}
	}

	isLocked(): boolean {
		return this.writerActive || this.activeReaders !== 0;
	}

	readerCount(): number {
		return this.activeReaders;
	}

	pending(): number {
		return this.waiters.length;
	}

	private dispatch(): void {
		if (this.writerActive || this.activeReaders !== 0) {
			return;
		}

		const first = this.waiters[0];
		if (!first) {
			return;
		}

		if (first.kind === "write") {
			this.waiters.shift();
			this.waitingWriters--;
			this.writerActive = true;
			first.resolve();
			return;
		}

		while (this.waiters[0]?.kind === "read") {
			const waiter = this.waiters.shift();
			if (!waiter || waiter.kind !== "read") {
				return;
			}
			this.activeReaders++;
			waiter.resolve();
		}
	}
}
