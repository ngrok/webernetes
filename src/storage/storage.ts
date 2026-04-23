import { V1ObjectMeta } from "../client";
import type { Etcd } from "../cluster/etcd";

export interface StoreOpts {
	namespaced?: boolean;
	defaultQualifiedResource: string;
	singularQualifiedResource: string;
}

function generateName(prefix: string): string {
	return `${prefix}-${Math.random().toString(36).substring(2, 8)}`;
}

interface Storable {
	metadata?: V1ObjectMeta;
}

export class Store<T extends Storable> {
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
}
