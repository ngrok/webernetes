export interface ReceiveResult<T> {
	ok: true;
	value: T;
}

export interface ReceiveClosed {
	ok: false;
	value: undefined;
}

export type ChannelReceive<T> = ReceiveResult<T> | ReceiveClosed;

interface PendingSender<T> {
	value: T;
	reject(error: Error): void;
	resolve(): void;
}

type MaybePromise<T> = T | Promise<T>;

export type SelectHandler<T, R = unknown> = (result: ChannelReceive<T>) => MaybePromise<R>;
export type SelectDefault<R = unknown> = () => MaybePromise<R>;

export class SelectBuilder<T = never> implements PromiseLike<T> {
	private readonly cases: Array<{
		channel: Channel<unknown>;
		handler: SelectHandler<unknown>;
	}> = [];

	case<V, R>(channel: Channel<V>, handler: SelectHandler<V, R>): SelectBuilder<T | Awaited<R>> {
		this.cases.push({
			channel: channel as unknown as Channel<unknown>,
			handler: handler as unknown as SelectHandler<unknown>,
		});
		return this as unknown as SelectBuilder<T | Awaited<R>>;
	}

	default<R>(handler: SelectDefault<R>): Promise<T | Awaited<R>> {
		return Channel.select(this.cases, handler);
	}

	then<TResult1 = T, TResult2 = never>(
		onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): PromiseLike<TResult1 | TResult2> {
		return Channel.select(this.cases).then(onfulfilled, onrejected);
	}
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

	static select<R = never, D = never>(
		cases: readonly SelectReceiveCase[],
		defaultCase?: SelectDefault<D>,
	): Promise<R | Awaited<D>>;
	static async select<R = never, D = never>(
		cases: readonly SelectReceiveCase[],
		defaultCase?: SelectDefault<D>,
	): Promise<R | Awaited<D>> {
		// TODO(samwho): should we copy Go's pseudo-random channel selection when
		// multiple channels are ready?
		for (const { channel, handler } of cases) {
			const result = channel.tryReceive();
			if (result) {
				return (await handler(result)) as R;
			}
		}

		if (defaultCase) {
			return await defaultCase();
		}

		return await new Promise<R>((resolve, reject) => {
			let selected = false;
			const cancelReceivers: Array<() => void> = [];

			const settle = (handler: SelectHandler<unknown>, result: ChannelReceive<unknown>) => {
				if (selected) {
					return;
				}
				selected = true;
				for (const cancel of cancelReceivers) {
					cancel();
				}
				void Promise.resolve(handler(result)).then((value) => resolve(value as R), reject);
			};

			for (const { channel, handler } of cases) {
				cancelReceivers.push(
					channel.receiveWithCancel((result) => {
						settle(handler, result);
					}),
				);
			}
		});
	}

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

	private tryReceive(): ChannelReceive<T> | undefined {
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
			return { ok: false, value: undefined };
		}

		return undefined;
	}

	async receive(): Promise<ChannelReceive<T>> {
		const result = this.tryReceive();
		if (result) {
			return result;
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
				receiver({ ok: false, value: undefined });
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

	private receiveWithCancel(receiver: (result: ChannelReceive<T>) => void): () => void {
		this.receivers.push(receiver);
		return () => {
			const index = this.receivers.indexOf(receiver);
			if (index !== -1) {
				this.receivers.splice(index, 1);
			}
		};
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

interface SelectReceiveCase {
	channel: Channel<unknown>;
	handler: SelectHandler<unknown>;
}

export function select(): SelectBuilder<never> {
	return new SelectBuilder();
}
