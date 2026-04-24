import { V1ObjectMeta } from "../../client";
import { Conflict, NotFound } from "../../client/errors";
import type { Etcd } from "../etcd";
import { Watcher } from "./watch";

export interface StoreOpts {
	namespaced?: boolean;
	defaultQualifiedResource: string;
	singularQualifiedResource: string;
}

function generateName(prefix: string): string {
	return `${prefix}-${Math.random().toString(36).substring(2, 8)}`;
}

export interface Storable {
	metadata?: V1ObjectMeta;
}

export class Store<T extends Storable> {
	constructor(
		private readonly etcd: Etcd,
		private readonly opts: StoreOpts,
	) {}

	protected async validateCreate(_: T): Promise<void> {}

	protected async validateUpdate(_: T): Promise<void> {}

	private key(name: string, namespace?: string): string {
		let k = `/registry/${this.opts.defaultQualifiedResource}`;
		if (this.opts.namespaced) {
			k += `/${namespace ?? "default"}`;
		}
		return `${k}/${name}`;
	}

	private async namespaceExists(namespace: string): Promise<boolean> {
		const k = `/registry/namespaces/${namespace}`;
		const value = await this.etcd.get(k).json();
		return !!value;
	}

	private withResourceVersion(obj: T, resourceVersion: string): T {
		obj.metadata ??= {};
		obj.metadata.resourceVersion = resourceVersion;
		return obj;
	}

	private async readStored(
		name: string,
		namespace?: string,
	): Promise<{ obj: T; resourceVersion: string } | undefined> {
		const response = await this.etcd.get(this.key(name, namespace)).exec();
		const kv = response.kvs[0];
		if (!kv) {
			return undefined;
		}

		const obj = JSON.parse(kv.value.toString()) as T;
		return {
			obj: this.withResourceVersion(obj, kv.mod_revision),
			resourceVersion: kv.mod_revision,
		};
	}

	async get(name: string, namespace?: string): Promise<T | undefined> {
		return (await this.readStored(name, namespace))?.obj;
	}

	async create(obj: T): Promise<T> {
		if (!obj.metadata) {
			throw new Error(`Object must have metadata`);
		}

		if (this.opts.namespaced) {
			if (!obj.metadata.namespace) {
				obj.metadata.namespace = "default";
			}

			if (!(await this.namespaceExists(obj.metadata.namespace))) {
				throw new NotFound(`"${obj.metadata.namespace}" does not exist`);
			}
		} else {
			if (obj.metadata.namespace) {
				throw new Error(
					`Resource ${this.opts.defaultQualifiedResource} is not namespaced, found namespace ${obj.metadata.namespace} in metadata`,
				);
			}
		}

		if (!obj.metadata.name && obj.metadata.generateName) {
			while (true) {
				obj.metadata.name = generateName(obj.metadata.generateName);
				if (await this.get(obj.metadata.name, obj.metadata.namespace)) {
					continue;
				}
				break;
			}
		}

		if (!obj.metadata.name) {
			throw new Error(`Object must have a name`);
		}

		const existing = await this.get(obj.metadata.name, obj.metadata.namespace);
		if (existing) {
			throw new Error(`Object with name ${obj.metadata.name} already exists`);
		}

		this.validateCreate(obj);

		const k = this.key(obj.metadata.name, obj.metadata.namespace);
		const response = await this.etcd.put(k).value(JSON.stringify(obj)).exec();
		return this.withResourceVersion(obj, response.header.revision);
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

		const existing = await this.readStored(name, obj.metadata.namespace);
		if (!existing) {
			throw new NotFound(`${this.opts.singularQualifiedResource} "${name}" not found`);
		}

		if (obj.metadata.resourceVersion && obj.metadata.resourceVersion !== existing.resourceVersion) {
			throw new Conflict(
				`${this.opts.singularQualifiedResource} "${name}" was modified; please apply your changes to the latest version and try again`,
			);
		}

		this.validateUpdate(obj);

		const k = this.key(name, obj.metadata.namespace);
		const response = await this.etcd.put(k).value(JSON.stringify(obj)).exec();
		return this.withResourceVersion(obj, response.header.revision);
	}

	async delete(name: string, namespace?: string): Promise<boolean> {
		const k = this.key(name, namespace);
		const response = await this.etcd.delete().key(k).getPrevious();
		return response.length > 0;
	}

	async list(namespace?: string): Promise<T[]> {
		const k = this.key("", namespace);
		const response = await this.etcd.getAll().prefix(k).exec();
		return response.kvs.map((kv) => {
			const obj = JSON.parse(kv.value.toString()) as T;
			return this.withResourceVersion(obj, kv.mod_revision);
		});
	}

	async watch(namespace?: string): Promise<Watcher<T>> {
		const k = this.key("", namespace);
		const watcher = await this.etcd.watch().prefix(k).withPreviousKV().create();
		return new Watcher<T>(watcher);
	}
}
