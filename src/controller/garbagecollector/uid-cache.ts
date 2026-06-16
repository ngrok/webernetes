/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { newLRU, type Cache } from "../../lru";
import type { ObjectReference } from "./graph";

// Models kubernetes/pkg/controller/garbagecollector/uid_cache.go ReferenceCache.
export class ReferenceCache {
	private readonly cache: Cache<ObjectReference, undefined>;

	constructor(maxCacheEntries: number) {
		this.cache = newLRU(maxCacheEntries);
	}

	// Models kubernetes/pkg/controller/garbagecollector/uid_cache.go Add.
	add(reference: ObjectReference): void {
		this.cache.add(reference, undefined);
	}

	// Models kubernetes/pkg/controller/garbagecollector/uid_cache.go Has.
	has(reference: ObjectReference): boolean {
		const [, found] = this.cache.get(reference);
		return found;
	}

	// Webernetes test support for mirroring upstream garbagecollector_test.go assertState.
	keys(): ObjectReference[] {
		return [...this.cache.keys()];
	}
}

// Models kubernetes/pkg/controller/garbagecollector/uid_cache.go NewReferenceCache.
export function newReferenceCache(maxCacheEntries: number): ReferenceCache {
	return new ReferenceCache(maxCacheEntries);
}
