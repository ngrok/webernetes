import type { KubernetesObject } from "../../../client/types";
import { Channel, type ReadOnlyChannel } from "../../../go/channel";
import { newCond } from "../../../go/sync/cond";
import { Mutex } from "../../../go/sync/mutex";
import type { MaybePromise } from "../../../promise";
import type { ReflectorStore } from "./reflector";
import { ExplicitKey, KeyError, type KeyFunc, type Store } from "./store";

// Models staging/src/k8s.io/client-go/tools/cache/fifo.go PopProcessFunc.
export type PopProcessFunc<T extends KubernetesObject> = (
	obj: T,
	isInInitialList: boolean,
) => MaybePromise<Error | undefined>;

// Models staging/src/k8s.io/client-go/tools/cache/fifo.go ErrFIFOClosed.
export const errFIFOClosed = new Error("DeltaFIFO: manipulating with closed queue");

// Models staging/src/k8s.io/client-go/tools/cache/fifo.go Queue.
export interface Queue<T extends KubernetesObject> extends ReflectorStore<T> {
	pop(process: PopProcessFunc<T>): Promise<[item: T | undefined, err: Error | undefined]>;
	hasSynced(): boolean;
	hasSyncedChecker(): DoneChecker;
	close(): Promise<void>;
}

// Models staging/src/k8s.io/client-go/tools/cache/fifo.go DoneChecker.
export interface DoneChecker {
	name(): string;
	done(): ReadOnlyChannel<void>;
}

// Models staging/src/k8s.io/client-go/tools/cache/fifo.go FIFO.
export class FIFO<T extends KubernetesObject> implements Queue<T>, Store<T> {
	private items = new Map<string, T>();
	private queue: string[] = [];
	private readonly synced = new Channel<void>();
	private populated = false;
	private initialPopulationCount = 0;
	private closed = false;
	private syncedClosed = false;
	private readonly lock = new Mutex();
	private readonly cond = newCond(this.lock);
	private lastSyncResourceVersion = "";

	constructor(private readonly keyFunc: KeyFunc<T>) {}

	// Models staging/src/k8s.io/client-go/tools/cache/fifo.go FIFO.Close.
	close(): Promise<void> {
		return this.lock.withLock(() => {
			this.closed = true;
			this.cond.broadcast();
		});
	}

	// Models staging/src/k8s.io/client-go/tools/cache/fifo.go FIFO.HasSynced.
	hasSynced(): boolean {
		return this.hasSyncedLocked();
	}

	// Models staging/src/k8s.io/client-go/tools/cache/fifo.go FIFO.HasSyncedChecker.
	hasSyncedChecker(): DoneChecker {
		return this;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/fifo.go FIFO.Name.
	name(): string {
		return "FIFO";
	}

	// Models staging/src/k8s.io/client-go/tools/cache/fifo.go FIFO.Done.
	done(): ReadOnlyChannel<void> {
		return this.synced.readOnly();
	}

	// Models staging/src/k8s.io/client-go/tools/cache/fifo.go FIFO.hasSynced_locked.
	private hasSyncedLocked(): boolean {
		return this.syncedClosed;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/fifo.go FIFO.checkSynced.
	private checkSynced(): void {
		const synced = this.populated && this.initialPopulationCount === 0;
		if (synced && !this.syncedClosed) {
			this.syncedClosed = true;
			this.synced.close();
		}
	}

	// Models staging/src/k8s.io/client-go/tools/cache/fifo.go FIFO.Add.
	async add(obj: T): Promise<Error | undefined> {
		const [id, err] = await this.keyFunc(obj);
		if (err) {
			return new KeyError(obj, err);
		}
		await this.lock.lock();
		try {
			this.populated = true;
			this.checkSynced();
			if (!this.items.has(id)) {
				this.queue.push(id);
			}
			this.items.set(id, structuredClone(obj));
			this.cond.broadcast();
		} finally {
			this.lock.unlock();
		}
		return undefined;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/fifo.go FIFO.Update.
	update(obj: T): Promise<Error | undefined> {
		return this.add(obj);
	}

	// Models staging/src/k8s.io/client-go/tools/cache/fifo.go FIFO.Delete.
	async delete(obj: T): Promise<Error | undefined> {
		const [id, err] = await this.keyFunc(obj);
		if (err) {
			return new KeyError(obj, err);
		}
		await this.lock.lock();
		try {
			this.populated = true;
			this.checkSynced();
			this.items.delete(id);
		} finally {
			this.lock.unlock();
		}
		return undefined;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/fifo.go FIFO.IsClosed.
	isClosed(): boolean {
		return this.closed;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/fifo.go FIFO.Pop.
	async pop(process: PopProcessFunc<T>): Promise<[item: T | undefined, err: Error | undefined]> {
		await this.lock.lock();
		try {
			for (;;) {
				while (this.queue.length === 0) {
					if (this.closed) {
						return [undefined, errFIFOClosed];
					}
					await this.cond.wait();
				}
				const isInInitialList = !this.hasSyncedLocked();
				const id = this.queue.shift() as string;
				let shouldCheckSynced = false;
				if (this.initialPopulationCount > 0) {
					this.initialPopulationCount--;
					shouldCheckSynced = true;
				}
				const item = this.items.get(id);
				if (!item) {
					if (shouldCheckSynced) {
						this.checkSynced();
					}
					continue;
				}
				this.items.delete(id);
				const poppedItem = structuredClone(item);
				const err = await process(poppedItem, isInInitialList);
				if (shouldCheckSynced) {
					this.checkSynced();
				}
				return [poppedItem, err];
			}
		} finally {
			this.lock.unlock();
		}
	}

	// Models staging/src/k8s.io/client-go/tools/cache/fifo.go FIFO.Replace.
	async replace(list: T[], resourceVersion: string): Promise<Error | undefined> {
		const items = new Map<string, T>();
		for (const item of list) {
			const [key, err] = await this.keyFunc(item);
			if (err) {
				return new KeyError(item, err);
			}
			items.set(key, structuredClone(item));
		}

		await this.lock.lock();
		try {
			if (!this.populated) {
				this.populated = true;
				this.initialPopulationCount = items.size;
				this.checkSynced();
			}

			this.items = items;
			this.queue = [...items.keys()];
			this.lastSyncResourceVersion = resourceVersion;
			if (this.queue.length > 0) {
				this.cond.broadcast();
			}
		} finally {
			this.lock.unlock();
		}
		return undefined;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/fifo.go FIFO.Resync.
	resync(): Promise<Error | undefined> {
		return this.lock.withLock(() => {
			const inQueue = new Set<string>(this.queue);
			for (const id of this.items.keys()) {
				if (!inQueue.has(id)) {
					this.queue.push(id);
				}
			}
			if (this.queue.length > 0) {
				this.cond.broadcast();
			}
			return undefined;
		});
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go Store.List.
	list(): T[] {
		return [...this.items.values()].map((item) => structuredClone(item));
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go Store.ListKeys.
	listKeys(): string[] {
		return [...this.items.keys()];
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go Store.LastStoreSyncResourceVersion.
	lastStoreSyncResourceVersion(): string {
		return this.lastSyncResourceVersion;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go Store.Bookmark.
	bookmark(resourceVersion: string): void {
		this.lastSyncResourceVersion = resourceVersion;
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go Store.Get.
	async get(
		obj: T | ExplicitKey,
	): Promise<[item: T | undefined, exists: boolean, err: Error | undefined]> {
		const [key, err] = await this.keyFunc(obj);
		if (err) {
			return [undefined, false, new KeyError(obj, err)];
		}
		return this.getByKey(key);
	}

	// Models staging/src/k8s.io/client-go/tools/cache/store.go Store.GetByKey.
	getByKey(key: string): [item: T | undefined, exists: boolean, err: Error | undefined] {
		const item = this.items.get(key);
		return [item === undefined ? undefined : structuredClone(item), item !== undefined, undefined];
	}
}

// Models staging/src/k8s.io/client-go/tools/cache/fifo.go NewFIFO.
export function newFIFO<T extends KubernetesObject>(keyFunc: KeyFunc<T>): FIFO<T> {
	return new FIFO(keyFunc);
}
