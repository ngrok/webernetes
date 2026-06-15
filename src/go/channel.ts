import type { MaybePromise } from "../promise";

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

const channelSource = Symbol("channelSource");

export type ReceiveChannel<T> = Channel<T> | ReadOnlyChannel<T>;
export type SendChannel<T> = Channel<T> | WriteOnlyChannel<T>;
export type SelectHandler<T, R = unknown> = (result: ChannelReceive<T>) => MaybePromise<R>;
export type SelectDefault<R = unknown> = () => MaybePromise<R>;

interface ChannelSourced<T> {
	[channelSource](): Channel<T>;
}

export class SelectBuilder<T = never> implements PromiseLike<T> {
	private readonly cases: Array<
		| {
				type: "receive";
				channel: Channel<unknown> | undefined;
				handler: SelectHandler<unknown>;
		  }
		| {
				type: "send";
				channel: Channel<unknown> | undefined;
				value: unknown;
				handler: SelectDefault;
		  }
	> = [];

	case<V, R>(
		channel: ReceiveChannel<V> | undefined,
		handler: SelectHandler<V, R>,
	): SelectBuilder<T | Awaited<R>> {
		this.cases.push({
			type: "receive",
			channel: channel?.[channelSource]() as Channel<unknown> | undefined,
			handler: handler as unknown as SelectHandler<unknown>,
		});
		return this as unknown as SelectBuilder<T | Awaited<R>>;
	}

	receive<V, R>(
		channel: ReceiveChannel<V> | undefined,
		handler: SelectHandler<V, R>,
	): SelectBuilder<T | Awaited<R>> {
		return this.case(channel, handler);
	}

	send<V, R>(
		channel: SendChannel<V> | undefined,
		value: V,
		handler: SelectDefault<R>,
	): SelectBuilder<T | Awaited<R>> {
		this.cases.push({
			type: "send",
			channel: (channel as ChannelSourced<unknown> | undefined)?.[channelSource](),
			value,
			handler: handler as SelectDefault,
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

	readOnly(): ReadOnlyChannel<T> {
		return new ReadOnlyChannel(this);
	}

	writeOnly(): WriteOnlyChannel<T> {
		return new WriteOnlyChannel(this);
	}

	static select<R = never, D = never>(
		cases: readonly SelectCase[],
		defaultCase?: SelectDefault<D>,
	): Promise<R | Awaited<D>>;
	static async select<R = never, D = never>(
		cases: readonly SelectCase[],
		defaultCase?: SelectDefault<D>,
	): Promise<R | Awaited<D>> {
		const readyCases: SelectCase[] = [];
		for (const selectCase of cases) {
			if (selectCase.type === "receive" && selectCase.channel?.canReceive()) {
				readyCases.push(selectCase);
			}
			if (selectCase.type === "send" && selectCase.channel?.canSend()) {
				readyCases.push(selectCase);
			}
		}
		if (readyCases.length > 0) {
			const selected = readyCases[Math.floor(Math.random() * readyCases.length)] as SelectCase;
			if (selected.type === "receive") {
				const result = selected.channel?.tryReceive();
				if (!result) {
					throw new Error("selected channel was not ready");
				}
				return (await selected.handler(result)) as R;
			}
			selected.channel?.trySend(selected.value);
			return (await selected.handler()) as R;
		}

		if (defaultCase) {
			return await defaultCase();
		}

		return await new Promise<R>((resolve, reject) => {
			let selected = false;
			const cancelCases: Array<() => void> = [];

			const settle = (handler: SelectDefault<unknown>) => {
				if (selected) {
					return;
				}
				selected = true;
				for (const cancel of cancelCases) {
					cancel();
				}
				void Promise.resolve(handler()).then((value) => resolve(value as R), reject);
			};
			const fail = (error: Error) => {
				if (selected) {
					return;
				}
				selected = true;
				for (const cancel of cancelCases) {
					cancel();
				}
				reject(error);
			};

			for (const selectCase of cases) {
				const { channel } = selectCase;
				if (!channel) {
					continue;
				}
				if (selectCase.type === "receive") {
					cancelCases.push(
						channel.receiveWithCancel((result) => {
							settle(() => selectCase.handler(result));
						}),
					);
				} else {
					const sender: PendingSender<unknown> = {
						value: selectCase.value,
						reject: fail,
						resolve: () => {
							settle(selectCase.handler);
						},
					};
					cancelCases.push(() => {
						const index = channel.senders.indexOf(sender);
						if (index !== -1) {
							channel.senders.splice(index, 1);
						}
					});
					channel.senders.push(sender);
				}
			}
		});
	}

	[channelSource](): Channel<T> {
		return this;
	}

	constructor(
		private readonly capacity = 0,
		private readonly onReceive?: (result: ChannelReceive<T>) => void,
	) {
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
			const result: ChannelReceive<T> = { ok: true, value };
			this.notifyReceive(result);
			receiver(result);
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

	tryReceive(): ChannelReceive<T> | undefined {
		if (this.values.length > 0) {
			const value = this.values.shift() as T;
			this.drainSender();
			const result: ChannelReceive<T> = { ok: true, value };
			this.notifyReceive(result);
			return result;
		}

		const sender = this.senders.shift();
		if (sender) {
			sender.resolve();
			const result: ChannelReceive<T> = { ok: true, value: sender.value };
			this.notifyReceive(result);
			return result;
		}

		if (this.closed) {
			const result: ChannelReceive<T> = { ok: false, value: undefined };
			this.notifyReceive(result);
			return result;
		}

		return undefined;
	}

	private canReceive(): boolean {
		return this.values.length > 0 || this.senders.length > 0 || this.closed;
	}

	private canSend(): boolean {
		return !this.closed && (this.receivers.length > 0 || this.values.length < this.capacity);
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

	drainBuffered(): void {
		this.values.length = 0;
	}

	close(): void {
		if (this.closed) {
			throw new Error("close of closed channel");
		}
		this.closed = true;

		for (const sender of this.senders.splice(0)) {
			sender.reject(new Error("send on closed channel"));
		}
		for (const receiver of this.receivers.splice(0)) {
			if (this.values.length === 0) {
				const result: ChannelReceive<T> = { ok: false, value: undefined };
				this.notifyReceive(result);
				receiver(result);
			} else {
				const value = this.values.shift() as T;
				const result: ChannelReceive<T> = { ok: true, value };
				this.notifyReceive(result);
				receiver(result);
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
			const result: ChannelReceive<T> = { ok: true, value: sender.value };
			this.notifyReceive(result);
			receiver(result);
			return;
		}

		if (this.values.length < this.capacity) {
			this.values.push(sender.value);
			sender.resolve();
			return;
		}

		this.senders.unshift(sender);
	}

	private notifyReceive(result: ChannelReceive<T>): void {
		this.onReceive?.(result);
	}
}

export class ReadOnlyChannel<T> implements AsyncIterable<T> {
	constructor(private readonly channel: Channel<T>) {}

	receive(): Promise<ChannelReceive<T>> {
		return this.channel.receive();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		yield* this.channel;
	}

	[channelSource](): Channel<T> {
		return this.channel;
	}
}

export class WriteOnlyChannel<T> {
	constructor(private readonly channel: Channel<T>) {}

	trySend(value: T): boolean {
		return this.channel.trySend(value);
	}

	send(value: T): Promise<void> {
		return this.channel.send(value);
	}

	close(): void {
		this.channel.close();
	}
}

interface SelectReceiveCase {
	type: "receive";
	channel: Channel<unknown> | undefined;
	handler: SelectHandler<unknown>;
}

interface SelectSendCase {
	type: "send";
	channel: Channel<unknown> | undefined;
	value: unknown;
	handler: SelectDefault;
}

type SelectCase = SelectReceiveCase | SelectSendCase;

export function select(): SelectBuilder<never> {
	return new SelectBuilder();
}
