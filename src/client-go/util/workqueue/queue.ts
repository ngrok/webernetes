/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { Clock } from "../../../clock";
import { Channel } from "../../../go/channel";
import { newCond } from "../../../go/sync/cond";
import { Mutex } from "../../../go/sync/mutex";
import { Once } from "../../../go/sync/once";
import { WaitGroup } from "../../../go/sync/wait-group";

// Models staging/src/k8s.io/client-go/util/workqueue/queue.go TypedInterface.
export interface TypedInterface<T> {
	add(item: T): void;
	len(): number;
	get(): Promise<[item: T | undefined, shutdown: boolean]>;
	done(item: T): void;
	shutDown(): Promise<void>;
	shutDownWithDrain(): Promise<void>;
}

// Models staging/src/k8s.io/client-go/util/workqueue/queue.go Interface.
export type Interface = TypedInterface<unknown>;

// Models staging/src/k8s.io/client-go/util/workqueue/queue.go Queue.
export interface Queue<T> {
	touch(item: T): void;
	push(item: T): void;
	len(): number;
	pop(): T;
}

// Models staging/src/k8s.io/client-go/util/workqueue/queue.go queue.
class DefaultQueue<T> implements Queue<T> {
	private readonly items: T[] = [];

	touch(_item: T): void {}

	push(item: T): void {
		this.items.push(item);
	}

	len(): number {
		return this.items.length;
	}

	pop(): T {
		return this.items.shift() as T;
	}
}

// Models staging/src/k8s.io/client-go/util/workqueue/queue.go DefaultQueue.
export function defaultQueue<T>(): Queue<T> {
	return new DefaultQueue<T>();
}

// Models staging/src/k8s.io/client-go/util/workqueue/queue.go TypedQueueConfig.
export interface TypedQueueConfig<T> {
	name: string;
	clock?: Clock;
	queue?: Queue<T>;
}

// Models staging/src/k8s.io/client-go/util/workqueue/queue.go Typed.
export class Typed<T> implements TypedInterface<T> {
	private readonly queue: Queue<T>;
	private readonly dirty = new Set<T>();
	private readonly processing = new Set<T>();
	private readonly cond = newCond(new Mutex());
	private shuttingDown = false;
	private drain = false;
	private readonly wg = new WaitGroup();
	private readonly stopCh = new Channel<void>();
	private readonly stopOnce = new Once();

	constructor(queue: Queue<T> = defaultQueue<T>()) {
		this.queue = queue;
	}

	add(item: T): void {
		if (this.shuttingDown) {
			return;
		}
		if (this.dirty.has(item)) {
			if (!this.processing.has(item)) {
				this.queue.touch(item);
			}
			return;
		}
		this.dirty.add(item);
		if (this.processing.has(item)) {
			return;
		}
		this.queue.push(item);
		this.cond.signal();
	}

	len(): number {
		return this.queue.len();
	}

	async get(): Promise<[item: T | undefined, shutdown: boolean]> {
		await this.cond.l.lock();
		try {
			while (this.queue.len() === 0 && !this.shuttingDown) {
				await this.cond.wait();
			}
			if (this.queue.len() === 0) {
				return [undefined, true];
			}

			const item = this.queue.pop();
			this.processing.add(item);
			this.dirty.delete(item);
			return [item, false];
		} finally {
			await this.cond.l.unlock();
		}
	}

	done(item: T): void {
		this.processing.delete(item);
		if (this.dirty.has(item)) {
			this.queue.push(item);
			this.cond.signal();
		} else if (this.processing.size === 0) {
			this.cond.signal();
		}
	}

	async shutDown(): Promise<void> {
		await this.stopOnce.do(() => {
			this.stopCh.close();
		});
		await this.cond.l.lock();
		try {
			this.drain = false;
			this.shuttingDown = true;
			this.cond.broadcast();
		} finally {
			await this.cond.l.unlock();
		}
		await this.wg.wait();
	}

	async shutDownWithDrain(): Promise<void> {
		await this.stopOnce.do(() => {
			this.stopCh.close();
		});
		await this.cond.l.lock();
		try {
			this.drain = true;
			this.shuttingDown = true;
			this.cond.broadcast();

			while (this.processing.size !== 0 && this.drain) {
				await this.cond.wait();
			}
		} finally {
			await this.cond.l.unlock();
		}
		await this.wg.wait();
	}
}

// Models staging/src/k8s.io/client-go/util/workqueue/queue.go Type.
export type Type = Typed<unknown>;

// Models staging/src/k8s.io/client-go/util/workqueue/queue.go NewTyped.
export function newTyped<T>(): TypedInterface<T> {
	return new Typed<T>();
}

// Models staging/src/k8s.io/client-go/util/workqueue/queue.go NewTypedWithConfig.
export function newTypedWithConfig<T>(config: TypedQueueConfig<T>): TypedInterface<T> {
	return new Typed<T>(config.queue);
}

// Models staging/src/k8s.io/client-go/util/workqueue/queue.go NewWithConfig.
export function newWithConfig(config: TypedQueueConfig<unknown>): Interface {
	return newTypedWithConfig(config);
}

// Models staging/src/k8s.io/client-go/util/workqueue/queue.go NewNamed.
export function newNamed(name: string): Interface {
	return newWithConfig({ name });
}

export { newTyped as new };
