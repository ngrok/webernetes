type MaybePromise<T> = T | Promise<T>;

export type Release = () => void;

interface MutexWaiter {
	resolve(release: Release): void;
}

export class Mutex {
	private locked = false;
	private readonly waiters: MutexWaiter[] = [];

	async lock(): Promise<Release> {
		const release = this.tryLock();
		if (release) {
			return release;
		}

		return await new Promise<Release>((resolve) => {
			this.waiters.push({ resolve });
		});
	}

	tryLock(): Release | undefined {
		if (this.locked) {
			return undefined;
		}
		this.locked = true;
		return this.createRelease();
	}

	async withLock<T>(fn: () => MaybePromise<T>): Promise<T> {
		const release = await this.lock();
		try {
			return await fn();
		} finally {
			release();
		}
	}

	isLocked(): boolean {
		return this.locked;
	}

	pending(): number {
		return this.waiters.length;
	}

	private createRelease(): Release {
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			this.release();
		};
	}

	private release(): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter.resolve(this.createRelease());
			return;
		}
		this.locked = false;
	}
}

type RWMutexWaiter =
	| {
			kind: "read";
			resolve(release: Release): void;
	  }
	| {
			kind: "write";
			resolve(release: Release): void;
	  };

export class RWMutex {
	private activeReaders = 0;
	private writerActive = false;
	private waitingWriters = 0;
	private readonly waiters: RWMutexWaiter[] = [];

	async lock(): Promise<Release> {
		const release = this.tryLock();
		if (release) {
			return release;
		}

		return await new Promise<Release>((resolve) => {
			this.waitingWriters++;
			this.waiters.push({ kind: "write", resolve });
		});
	}

	async rLock(): Promise<Release> {
		const release = this.tryRLock();
		if (release) {
			return release;
		}

		return await new Promise<Release>((resolve) => {
			this.waiters.push({ kind: "read", resolve });
		});
	}

	tryLock(): Release | undefined {
		if (this.writerActive || this.activeReaders !== 0) {
			return undefined;
		}
		this.writerActive = true;
		return this.createWriteRelease();
	}

	tryRLock(): Release | undefined {
		if (this.writerActive || this.waitingWriters !== 0) {
			return undefined;
		}
		this.activeReaders++;
		return this.createReadRelease();
	}

	async withLock<T>(fn: () => MaybePromise<T>): Promise<T> {
		const release = await this.lock();
		try {
			return await fn();
		} finally {
			release();
		}
	}

	async withRLock<T>(fn: () => MaybePromise<T>): Promise<T> {
		const release = await this.rLock();
		try {
			return await fn();
		} finally {
			release();
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

	private createReadRelease(): Release {
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			this.activeReaders--;
			if (this.activeReaders === 0) {
				this.dispatch();
			}
		};
	}

	private createWriteRelease(): Release {
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			this.writerActive = false;
			this.dispatch();
		};
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
			first.resolve(this.createWriteRelease());
			return;
		}

		while (this.waiters[0]?.kind === "read") {
			const waiter = this.waiters.shift();
			if (!waiter || waiter.kind !== "read") {
				return;
			}
			this.activeReaders++;
			waiter.resolve(this.createReadRelease());
		}
	}
}
