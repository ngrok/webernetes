/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import {
	GroupResource,
	parseGroupResource,
} from "../../../apimachinery/pkg/runtime/schema/group_version";
import {
	type NamespacedName,
	namespacedNameString,
} from "../../../apimachinery/pkg/types/namespacedname";
import { compareResourceVersion } from "../../../apimachinery/pkg/util/resourceversion/resourceversion";

// Models kubernetes/pkg/controller/util/consistency/consistency.go ConsistencyStore.
export interface ConsistencyStore {
	wroteAt(owner: NamespacedName, ownerUID: string, resource: GroupResource, rv: string): void;
	clear(owner: NamespacedName, ownerUID: string): void;
	ensureReady(owner: NamespacedName): Error | undefined;
}

// Models kubernetes/pkg/controller/util/consistency/consistency.go ConsistencyError.
export class ConsistencyError extends Error {
	constructor(
		readonly readRV: string,
		readonly wroteRV: string,
		readonly groupResource: GroupResource,
	) {
		super(
			`read version: ${readRV} is not as new as written version: ${wroteRV} for group resource ${groupResource.toString()}`,
		);
	}
}

// Models kubernetes/pkg/controller/util/consistency/consistency.go LastSyncRVGetter.
export interface LastSyncRVGetter {
	lastStoreSyncResourceVersion(): string;
}

// Models kubernetes/pkg/controller/util/consistency/consistency.go RealConsistencyStore.
export class RealConsistencyStore implements ConsistencyStore {
	private readonly writes = new Map<string, OwnerRecord>();

	constructor(private readonly stores: Map<string, LastSyncRVGetter>) {}

	// Models kubernetes/pkg/controller/util/consistency/consistency.go getWrittenRecord.
	getWrittenRecord(owner: NamespacedName): OwnerRecord | undefined {
		return this.writes.get(namespacedNameString(owner));
	}

	// Models kubernetes/pkg/controller/util/consistency/consistency.go ensureWrittenRecord.
	ensureWrittenRecord(owner: NamespacedName, ownerUID: string): OwnerRecord {
		const existing = this.getWrittenRecord(owner);
		if (existing && existing.ownerUID === ownerUID) {
			return existing;
		}
		const record = newOwnerRecord(ownerUID);
		this.writes.set(namespacedNameString(owner), record);
		return record;
	}

	// Models kubernetes/pkg/controller/util/consistency/consistency.go WroteAt.
	wroteAt(owner: NamespacedName, ownerUID: string, resource: GroupResource, rv: string): void {
		this.ensureWrittenRecord(owner, ownerUID).wroteAt(resource, rv);
	}

	// Models kubernetes/pkg/controller/util/consistency/consistency.go Clear.
	clear(owner: NamespacedName, ownerUID: string): void {
		const key = namespacedNameString(owner);
		const record = this.writes.get(key);
		if (record && (ownerUID.length === 0 || record.ownerUID === ownerUID)) {
			this.writes.delete(key);
		}
	}

	// Models kubernetes/pkg/controller/util/consistency/consistency.go EnsureReady.
	ensureReady(owner: NamespacedName): Error | undefined {
		const record = this.getWrittenRecord(owner);
		if (!record) {
			return undefined;
		}
		const err = record.ensureReady(this);
		if (!err) {
			this.clear(owner, record.ownerUID);
			return undefined;
		}
		return err;
	}

	// Models kubernetes/pkg/controller/util/consistency/consistency.go stores.
	store(resource: GroupResource): LastSyncRVGetter | undefined {
		return this.stores.get(resource.toString());
	}
}

// Models kubernetes/pkg/controller/util/consistency/consistency.go NewConsistencyStore.
export function newConsistencyStore(stores: Map<string, LastSyncRVGetter>): RealConsistencyStore {
	return new RealConsistencyStore(stores);
}

// Models kubernetes/pkg/controller/util/consistency/consistency.go ownerRecord.
class OwnerRecord {
	readonly versions = new Map<string, string>();

	constructor(readonly ownerUID: string) {}

	// Models kubernetes/pkg/controller/util/consistency/consistency.go WroteAt.
	wroteAt(resource: GroupResource, rv: string): void {
		const key = resource.toString();
		const current = this.versions.get(key);
		if (current === undefined) {
			this.versions.set(key, rv);
			return;
		}
		const [cmp, err] = compareResourceVersion(current, rv);
		if (!err && cmp >= 0) {
			return;
		}
		this.versions.set(key, rv);
	}

	// Models kubernetes/pkg/controller/util/consistency/consistency.go EnsureReady.
	ensureReady(c: RealConsistencyStore): Error | undefined {
		for (const [gr, wroteRV] of this.versions) {
			const resource = parseGroupResource(gr);
			const store = c.store(resource);
			if (!store) {
				continue;
			}
			const readRV = store.lastStoreSyncResourceVersion();
			if (readRV === "") {
				continue;
			}
			const [i, err] = compareResourceVersion(wroteRV, readRV);
			if (err) {
				continue;
			}
			if (i > 0) {
				return new ConsistencyError(readRV, wroteRV, resource);
			}
		}
		return undefined;
	}
}

// Models kubernetes/pkg/controller/util/consistency/consistency.go newOwnerRecord.
function newOwnerRecord(ownerUID: string): OwnerRecord {
	return new OwnerRecord(ownerUID);
}

// Models kubernetes/pkg/controller/util/consistency/consistency.go NoopConsistencyStore.
export class NoopConsistencyStore implements ConsistencyStore {
	wroteAt(_owner: NamespacedName, _ownerUID: string, _resource: GroupResource, _rv: string): void {}
	clear(_owner: NamespacedName, _ownerUID: string): void {}
	ensureReady(_owner: NamespacedName): Error | undefined {
		return undefined;
	}
}

// Models kubernetes/pkg/controller/util/consistency/consistency.go NewNoopConsistencyStore.
export function newNoopConsistencyStore(): NoopConsistencyStore {
	return new NoopConsistencyStore();
}
