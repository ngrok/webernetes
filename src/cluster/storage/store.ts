import { V1ObjectMeta } from "../../client";
import { Conflict, NotFound } from "../../client/errors";
import type { Etcd } from "../etcd";
import { Watcher } from "./watch";

export interface StoreOpts {
	namespaced?: boolean;
	defaultQualifiedResource: string;
	singularQualifiedResource: string;
	apiVersion?: string;
	kind?: string;
}

function generateName(prefix: string): string {
	return `${prefix}-${Math.random().toString(36).substring(2, 8)}`;
}

function generateUid(): string {
	return `${Math.random().toString(36).substring(2)}${Math.random().toString(36).substring(2)}`;
}

export interface Storable {
	apiVersion?: string;
	kind?: string;
	metadata?: V1ObjectMeta;
}

export interface StoreUpdateOptions {
	skipValidateUpdate?: boolean;
}

export interface StoreListOptions {
	resourceVersion?: string;
}

export type FinishFunc = (success: boolean) => void | Promise<void>;

const finishNothing: FinishFunc = () => undefined;

// This is _sort of_ based off of the storage interface in
// kubernetes/staging/src/k8s.io/apiserver/pkg/storage/interfaces.go. It's not
// an exact replica in the same way that a lot of the kubelet code was written
// to be, but it's designed to serve the same purpose: be the bridge between k8s
// and etcd.
export class Store<T extends Storable> {
	constructor(
		protected readonly etcd: Etcd,
		private readonly opts: StoreOpts,
	) {}

	protected async validateCreate(_: T): Promise<void> {}

	protected async validateUpdate(_: T, _existing: T): Promise<void> {}

	protected async prepareCreate(_: T): Promise<void> {}

	protected async prepareUpdate(_: T, _existing: T): Promise<void> {}

	protected async prepareDelete(_: T): Promise<void> {}

	protected async beginCreate(obj: T): Promise<FinishFunc> {
		await this.prepareCreate(obj);
		return finishNothing;
	}

	protected async beginUpdate(obj: T, existing: T): Promise<FinishFunc> {
		await this.prepareUpdate(obj, existing);
		return finishNothing;
	}

	protected async afterDelete(_: T): Promise<void> {}

	private key(name: string, namespace?: string): string {
		let k = `/registry/${this.opts.defaultQualifiedResource}`;
		if (this.opts.namespaced) {
			k += `/${namespace ?? "default"}`;
		}
		return `${k}/${name}`;
	}

	private listPrefix(namespace?: string): string {
		if (!this.opts.namespaced || namespace !== undefined) {
			return this.key("", namespace);
		}

		return `/registry/${this.opts.defaultQualifiedResource}/`;
	}

	private async namespaceExists(namespace: string): Promise<boolean> {
		const k = `/registry/namespaces/${namespace}`;
		const value = await this.etcd.get(k).json();
		return !!value && !hasDeletionTimestamp(value);
	}

	private withResourceVersion(obj: T, resourceVersion: string): T {
		const withResourceVersion = structuredClone(obj);
		withResourceVersion.metadata ??= {};
		withResourceVersion.metadata.resourceVersion = resourceVersion;
		return withResourceVersion;
	}

	private defaultTypeMeta(obj: T): void {
		obj.apiVersion ??= this.opts.apiVersion;
		obj.kind ??= this.opts.kind;
	}

	private validateTypeMeta(obj: T): void {
		if (this.opts.apiVersion !== undefined && obj.apiVersion !== this.opts.apiVersion) {
			throw new Error(
				`${this.opts.singularQualifiedResource} apiVersion must be ${this.opts.apiVersion}`,
			);
		}

		if (this.opts.kind !== undefined && obj.kind !== this.opts.kind) {
			throw new Error(`${this.opts.singularQualifiedResource} kind must be ${this.opts.kind}`);
		}
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

	async create(input: T): Promise<T> {
		const obj = structuredClone(input);
		if (!obj.metadata) {
			throw new Error(`Object must have metadata`);
		}
		if (obj.metadata.resourceVersion) {
			throw new Error("resourceVersion should not be set on objects to be created");
		}
		this.defaultTypeMeta(obj);
		this.validateTypeMeta(obj);

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
		obj.metadata.uid ??= generateUid();

		const existing = await this.get(obj.metadata.name, obj.metadata.namespace);
		if (existing) {
			throw new Error(`Object with name ${obj.metadata.name} already exists`);
		}

		const k = this.key(obj.metadata.name, obj.metadata.namespace);
		let finishCreate = finishNothing;
		try {
			finishCreate = await this.beginCreate(obj);
			await this.validateCreate(obj);

			const response = await this.etcd
				.if(k, "Version", "==", 0)
				.then(this.etcd.put(k).value(JSON.stringify(obj)))
				.commit();
			if (!response.succeeded) {
				throw new Error(`Object with name ${obj.metadata.name} already exists`);
			}

			const finish = finishCreate;
			finishCreate = finishNothing;
			await finish(true);

			return this.withResourceVersion(obj, response.header.revision);
		} finally {
			await finishCreate(false);
		}
	}

	async update(name: string, input: T, options: StoreUpdateOptions = {}): Promise<T> {
		const obj = structuredClone(input);
		if (!obj.metadata) {
			throw new Error(`Object must have metadata`);
		}
		this.defaultTypeMeta(obj);
		this.validateTypeMeta(obj);

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

		const k = this.key(name, obj.metadata.namespace);
		let finishUpdate = finishNothing;
		try {
			finishUpdate = await this.beginUpdate(obj, existing.obj);
			if (!options.skipValidateUpdate) {
				await this.validateUpdate(obj, existing.obj);
			}

			const response = await this.etcd
				.if(k, "Mod", "==", Number(existing.resourceVersion))
				.then(this.etcd.put(k).value(JSON.stringify(obj)))
				.commit();
			if (!response.succeeded) {
				throw new Conflict(
					`${this.opts.singularQualifiedResource} "${name}" was modified; please apply your changes to the latest version and try again`,
				);
			}

			const finish = finishUpdate;
			finishUpdate = finishNothing;
			await finish(true);

			return this.withResourceVersion(obj, response.header.revision);
		} finally {
			await finishUpdate(false);
		}
	}

	async delete(name: string, namespace?: string): Promise<boolean> {
		const k = this.key(name, namespace);
		while (true) {
			const existing = await this.readStored(name, namespace);
			if (!existing) {
				return false;
			}

			await this.prepareDelete(existing.obj);

			const response = await this.etcd
				.if(k, "Mod", "==", Number(existing.resourceVersion))
				.then(this.etcd.delete().key(k))
				.commit();
			if (!response.succeeded) {
				continue;
			}

			await this.afterDelete(existing.obj);
			return true;
		}
	}

	async list(namespace?: string): Promise<T[]> {
		return (await this.listWithResourceVersion(namespace)).items;
	}

	async listWithResourceVersion(
		namespace?: string,
		options: StoreListOptions = {},
	): Promise<{ items: T[]; resourceVersion: string }> {
		const k = this.listPrefix(namespace);
		let builder = this.etcd.getAll().prefix(k);
		if (options.resourceVersion !== undefined && options.resourceVersion !== "") {
			builder = builder.revision(options.resourceVersion);
		}
		const response = await builder.exec();
		return {
			resourceVersion: response.header.revision,
			items: response.kvs.map((kv) => {
				const obj = JSON.parse(kv.value.toString()) as T;
				return this.withResourceVersion(obj, kv.mod_revision);
			}),
		};
	}

	watch(namespace?: string, startRevision?: number): Watcher<T> {
		const k = this.listPrefix(namespace);
		let builder = this.etcd.watch().prefix(k).withPreviousKV();
		if (startRevision !== undefined) {
			builder = builder.startRevision(String(startRevision));
		}
		return new Watcher<T>(builder.watcher());
	}
}

function hasDeletionTimestamp(value: unknown): boolean {
	if (typeof value !== "object" || value === null || !("metadata" in value)) {
		return false;
	}
	const metadata = value.metadata;
	return (
		typeof metadata === "object" &&
		metadata !== null &&
		"deletionTimestamp" in metadata &&
		metadata.deletionTimestamp !== undefined
	);
}
