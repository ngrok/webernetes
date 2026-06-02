import type { PassiveClock } from "./utils/clock/clock";

interface Task {
	handle: number;
	callback: () => void;
	cancelled: boolean;
	delayMs: number;
	dueAtMs: number;
	intervalMs?: number;
	setTimeoutHandle?: ReturnType<typeof setTimeout>;
}

export class MockedDate extends Date {
	clock: Clock;

	constructor(clock: Clock, value: number | string | Date) {
		super(value);
		this.clock = clock;
	}
}

export class Clock implements PassiveClock {
	private nextHandle = 1;
	private readonly tasks = new Map<number, Task>();
	private readonly microtasks: Array<() => void> = [];
	private microtaskFlushScheduled = false;
	private flushingMicrotasks = false;
	private paused = false;
	private wallStartedAtMs = Date.now();
	private simulatedNowMs = Date.now();

	now(): MockedDate {
		return new MockedDate(this, this.nowMs());
	}

	since(ts: Date): number {
		return this.nowMs() - ts.getTime();
	}

	nowMs(): number {
		if (this.paused) {
			return this.simulatedNowMs;
		}
		return this.simulatedNowMs + (Date.now() - this.wallStartedAtMs);
	}

	isPaused(): boolean {
		return this.paused;
	}

	pause() {
		if (this.paused) {
			throw new Error("Clock is already paused");
		}
		this.simulatedNowMs = this.nowMs();
		this.paused = true;
		for (const task of this.tasks.values()) {
			this.pauseTask(task);
		}
	}

	resume() {
		if (!this.paused) {
			throw new Error("Clock is not paused");
		}
		this.paused = false;
		this.wallStartedAtMs = Date.now();
		for (const task of this.tasks.values()) {
			this.resumeTask(task);
		}
		this.scheduleMicrotaskFlush();
	}

	wait(ms: number): Promise<void> {
		return new Promise((resolve) => {
			this.setTimeout(resolve, ms);
		});
	}

	setTimeout(callback: () => void, delayMs: number): number {
		const handle = this.nextHandle++;
		const task: Task = {
			handle,
			callback,
			cancelled: false,
			delayMs: Math.max(0, delayMs),
			dueAtMs: this.nowMs() + Math.max(0, delayMs),
		};
		this.tasks.set(handle, task);
		this.scheduleTask(task);
		return handle;
	}

	setInterval(callback: () => void, intervalMs: number): number {
		if (intervalMs <= 0) {
			throw new Error("Interval must be greater than 0");
		}
		const handle = this.nextHandle++;
		const task: Task = {
			handle,
			callback,
			cancelled: false,
			delayMs: intervalMs,
			dueAtMs: this.nowMs() + intervalMs,
			intervalMs,
		};
		this.tasks.set(handle, task);
		this.scheduleTask(task);
		return handle;
	}

	queueMicrotask(callback: () => void): void {
		this.microtasks.push(callback);
		this.scheduleMicrotaskFlush();
	}

	public clearTimeout(handle: number) {
		const task = this.tasks.get(handle);
		if (task) {
			task.cancelled = true;
			if (task.setTimeoutHandle) {
				clearTimeout(task.setTimeoutHandle);
				task.setTimeoutHandle = undefined;
			}
			this.tasks.delete(task.handle);
		}
	}

	public clearInterval(handle: number) {
		this.clearTimeout(handle);
	}

	public clear() {
		for (const task of this.tasks.values()) {
			this.clearTimeout(task.handle);
		}
		this.tasks.clear();
		this.microtasks.length = 0;
	}

	public pendingTaskCount(): number {
		return this.tasks.size;
	}

	private scheduleMicrotaskFlush() {
		if (this.paused || this.microtaskFlushScheduled || this.flushingMicrotasks) {
			return;
		}

		this.microtaskFlushScheduled = true;
		queueMicrotask(() => {
			this.microtaskFlushScheduled = false;
			this.flushMicrotasks();
		});
	}

	private flushMicrotasks() {
		if (this.paused || this.flushingMicrotasks) {
			return;
		}

		this.flushingMicrotasks = true;
		try {
			while (!this.paused) {
				const callback = this.microtasks.shift();
				if (!callback) {
					return;
				}
				callback();
			}
		} finally {
			this.flushingMicrotasks = false;
			if (this.microtasks.length > 0) {
				this.scheduleMicrotaskFlush();
			}
		}
	}

	private scheduleTask(task: Task) {
		if (task.cancelled) {
			throw new Error("Tried to schedule a cancelled task");
		}

		const delayMs = Math.max(0, task.dueAtMs - this.nowMs());
		task.setTimeoutHandle = setTimeout(() => {
			task.setTimeoutHandle = undefined;
			if (task.cancelled) {
				return;
			}

			task.callback();

			if (task.cancelled || task.intervalMs == null) {
				this.tasks.delete(task.handle);
				return;
			}

			task.dueAtMs = this.nowMs() + task.intervalMs;
			this.scheduleTask(task);
		}, delayMs);
	}

	private pauseTask(task: Task) {
		if (!task.setTimeoutHandle) {
			throw new Error("Tried to pause a task that is not scheduled");
		}
		clearTimeout(task.setTimeoutHandle);
		task.setTimeoutHandle = undefined;
	}

	private resumeTask(task: Task) {
		if (task.setTimeoutHandle) {
			throw new Error("Tried to resume a task that is already scheduled");
		}
		this.scheduleTask(task);
	}

	[Symbol.dispose]() {
		this.clear();
	}
}
