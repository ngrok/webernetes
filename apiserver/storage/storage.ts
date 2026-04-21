import type { Etcd } from "../../etcd";
import type { ObjectMeta, TypeMeta } from "../../types/meta/v1/types";

export interface StoreOpts {
	namespaced?: boolean;
	defaultQualifiedResource: string;
	singularQualifiedResource: string;
}

export interface WatchOpts {
	sendInitial?: boolean;
}

export type EventType = "added" | "modified" | "deleted" | "bookmark" | "error";

export class Event<T> {
	constructor(
		public readonly type: EventType,
		public readonly key: string,
		public readonly value: T | undefined,
	) {}
}

export class Watcher {
	constructor(public readonly cancel: () => void) {}
}

function generateName(prefix: string): string {
	return `${prefix}-${Math.random().toString(36).substring(2, 8)}`;
}

export class Store<T extends TypeMeta & ObjectMeta> {
	constructor(
		private readonly etcd: Etcd,
		private readonly opts: StoreOpts,
	) {}

	protected validateCreate(_: T): void {}

	protected validateUpdate(_: T): void {}

	private key(name: string, namespace?: string): string {
		let k = `/registry/${this.opts.defaultQualifiedResource}`;
		if (this.opts.namespaced) {
			k += `/${namespace ?? "default"}`;
		}
		return `${k}/${name}`;
	}

	async get(name: string, namespace?: string): Promise<T | undefined> {
		const k = this.key(name, namespace);
		const value = await this.etcd.get(k).json();
		return (value ?? undefined) as T | undefined;
	}

	async create(obj: T): Promise<T> {
		if (!obj.metadata) {
			throw new Error(`Object must have metadata`);
		}

		if (!obj.metadata.name && obj.metadata.generateName) {
			while (true) {
				obj.metadata.name = generateName(obj.metadata.generateName);
				if (await this.get(obj.metadata.name)) {
					continue;
				}
				break;
			}
		}

		if (!obj.metadata.name) {
			throw new Error(`Object must have a name`);
		}

		if (this.opts.namespaced && !obj.metadata.namespace) {
			obj.metadata.namespace = "default";
		}

		const existing = await this.get(obj.metadata.name, obj.metadata.namespace);
		if (existing) {
			throw new Error(`Object with name ${obj.metadata.name} already exists`);
		}

		this.validateCreate(obj);

		const k = this.key(obj.metadata.name, obj.metadata.namespace);
		await this.etcd.put(k).value(JSON.stringify(obj)).exec();
		return obj;
	}

	async update(name: string, obj: T): Promise<T> {
		if (!obj.metadata) {
			throw new Error(`Object must have metadata`);
		}

		if (!obj.metadata.name) {
			throw new Error(`Object must have a name`);
		}

		if (this.opts.namespaced && !obj.metadata.namespace) {
			obj.metadata.namespace = "default";
		}

		this.validateUpdate(obj);

		const k = this.key(name, obj.metadata.namespace);
		await this.etcd.put(k).value(JSON.stringify(obj)).exec();
		return obj;
	}

	async delete(name: string, namespace?: string): Promise<boolean> {
		const k = this.key(name, namespace);
		const response = await this.etcd.delete().key(k).getPrevious();
		return response.length > 0;
	}

	async watch(callback: (event: Event<T>) => Promise<void>, opts?: WatchOpts): Promise<Watcher> {
		const prefix = this.key("");
		let startRevision: string | undefined;

		if (opts?.sendInitial) {
			const initial = await this.etcd.getAll().prefix(prefix).exec();
			startRevision = String(Number(initial.header.revision) + 1);
			for (const kv of initial.kvs) {
				const value = JSON.parse(kv.value.toString()) as T;
				await callback(new Event("added", kv.key.toString(), value));
			}
			await callback(new Event<T>("bookmark", prefix, undefined));
		}

		const watchBuilder = this.etcd.watch().prefix(prefix).withPreviousKV();
		const watcher = await (startRevision ? watchBuilder.startRevision(startRevision) : watchBuilder).create();

		watcher.on("put", (kv, prev) => {
			const value = JSON.parse(kv.value.toString()) as T;
			const type: EventType = prev ? "modified" : "added";
			void callback(new Event(type, kv.key.toString(), value));
		});
		watcher.on("delete", (kv, prev) => {
			const value = prev ? (JSON.parse(prev.value.toString()) as T) : undefined;
			void callback(new Event("deleted", kv.key.toString(), value));
		});

		return new Watcher(() => {
			void watcher.cancel();
		});
	}
}
