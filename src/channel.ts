export interface ReceiveResult<T> {
	ok: true;
	value: T;
}

export interface ReceiveClosed {
	ok: false;
}

export type ChannelReceive<T> = ReceiveResult<T> | ReceiveClosed;

interface PendingSender<T> {
	value: T;
	reject(error: Error): void;
	resolve(): void;
}

// Channel models Go-like channel semantics for JavaScript:
// - send waits until a receiver or buffer slot is available
// - receive waits until a value is available or the channel is closed
// - close drains buffered values before reporting ok=false to receivers
// - sending after close fails like Go's "send on closed channel" panic
// - multiple receivers, including multiple async iterators, compete for values
export class Channel<T> implements AsyncIterable<T> {
	private readonly values: T[] = [];
	private readonly receivers: Array<(result: ChannelReceive<T>) => void> = [];
	private readonly senders: Array<PendingSender<T>> = [];
	private closed = false;

	constructor(private readonly capacity = 0) {
		if (!Number.isInteger(capacity) || capacity < 0) {
			throw new Error("Channel capacity must be a non-negative integer");
		}
	}

	trySend(value: T): boolean {
		if (this.closed) {
			throw new Error("send on closed channel");
		}

		const receiver = this.receivers.shift();
		if (receiver) {
			receiver({ ok: true, value });
			return true;
		}

		if (this.values.length >= this.capacity) {
			return false;
		}

		this.values.push(value);
		return true;
	}

	async send(value: T): Promise<void> {
		if (this.trySend(value)) {
			return;
		}

		return await new Promise<void>((resolve, reject) => {
			this.senders.push({ value, reject, resolve });
		});
	}

	async receive(): Promise<ChannelReceive<T>> {
		if (this.values.length > 0) {
			const value = this.values.shift() as T;
			this.drainSender();
			return { ok: true, value };
		}

		const sender = this.senders.shift();
		if (sender) {
			sender.resolve();
			return { ok: true, value: sender.value };
		}

		if (this.closed) {
			return { ok: false };
		}

		return await new Promise<ChannelReceive<T>>((resolve) => {
			this.receivers.push(resolve);
		});
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;

		for (const sender of this.senders.splice(0)) {
			sender.reject(new Error("send on closed channel"));
		}
		for (const receiver of this.receivers.splice(0)) {
			if (this.values.length === 0) {
				receiver({ ok: false });
			} else {
				const value = this.values.shift() as T;
				receiver({ ok: true, value });
			}
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			const result = await this.receive();
			if (!result.ok) {
				return;
			}
			yield result.value;
		}
	}

	private drainSender(): void {
		if (this.closed) {
			return;
		}

		const sender = this.senders.shift();
		if (!sender) {
			return;
		}

		const receiver = this.receivers.shift();
		if (receiver) {
			sender.resolve();
			receiver({ ok: true, value: sender.value });
			return;
		}

		if (this.values.length < this.capacity) {
			this.values.push(sender.value);
			sender.resolve();
			return;
		}

		this.senders.unshift(sender);
	}
}
