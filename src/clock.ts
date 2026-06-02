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

	step(ms: number): void {
		if (ms < 0) {
			throw new Error("Step duration must be non-negative");
		}
		const wasPaused = this.paused;
		const targetMs = this.nowMs() + ms;
		if (!wasPaused) {
			this.simulatedNowMs = this.nowMs();
			this.paused = true;
		}
		for (const task of this.tasks.values()) {
			this.unscheduleTask(task);
		}

		try {
			for (;;) {
				const task = this.nextDueTask(targetMs);
				if (!task) {
					break;
				}

				this.simulatedNowMs = task.dueAtMs;
				if (task.cancelled) {
					this.tasks.delete(task.handle);
					continue;
				}

				try {
					task.callback();
					// A stepped timer callback is one simulated task; flush queued clock
					// microtasks before running the next due timer task.
					this.flushMicrotasks(true);
				} catch {
					// Match timer behavior: callback failures do not stop clock advancement.
				} finally {
					if (task.cancelled || task.intervalMs == null) {
						this.tasks.delete(task.handle);
					} else {
						task.dueAtMs += task.intervalMs;
					}
				}
			}
			this.simulatedNowMs = targetMs;
			// If no timer task ran, or if callers queued clock microtasks before
			// stepping, still complete the simulated microtask checkpoint.
			this.flushMicrotasks(true);
		} finally {
			if (!wasPaused) {
				this.paused = false;
				this.wallStartedAtMs = Date.now();
				for (const task of this.tasks.values()) {
					this.scheduleTask(task);
				}
				this.scheduleMicrotaskFlush();
			}
		}
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

	private flushMicrotasks(force = false) {
		if ((!force && this.paused) || this.flushingMicrotasks) {
			return;
		}

		this.flushingMicrotasks = true;
		try {
			for (;;) {
				if (!force && this.paused) {
					return;
				}
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
		if (this.paused) {
			return;
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
		this.unscheduleTask(task);
	}

	private resumeTask(task: Task) {
		if (task.setTimeoutHandle) {
			throw new Error("Tried to resume a task that is already scheduled");
		}
		this.scheduleTask(task);
	}

	private unscheduleTask(task: Task): void {
		if (task.setTimeoutHandle) {
			clearTimeout(task.setTimeoutHandle);
			task.setTimeoutHandle = undefined;
		}
	}

	private nextDueTask(targetMs: number): Task | undefined {
		let next: Task | undefined;
		for (const task of this.tasks.values()) {
			if (task.cancelled || task.dueAtMs > targetMs) {
				continue;
			}
			if (
				!next ||
				task.dueAtMs < next.dueAtMs ||
				(task.dueAtMs === next.dueAtMs && task.handle < next.handle)
			) {
				next = task;
			}
		}
		return next;
	}

	[Symbol.dispose]() {
		this.clear();
	}
}
