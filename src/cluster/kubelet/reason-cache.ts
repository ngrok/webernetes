import { newLRU, type Cache } from "../../lru";
import type { PodSyncResult } from "./container";

// Models kubernetes/pkg/kubelet/reason_cache.go maxReasonCacheEntries.
const maxReasonCacheEntries = 1000;

// Models kubernetes/pkg/kubelet/reason_cache.go ReasonItem.
export interface ReasonItem {
	err: Error;
	message: string;
}

// Models kubernetes/pkg/kubelet/reason_cache.go ReasonCache.
export class ReasonCache {
	private readonly cache: Cache<string, ReasonItem>;

	constructor() {
		this.cache = newLRU<string, ReasonItem>(maxReasonCacheEntries);
	}

	// Models kubernetes/pkg/kubelet/reason_cache.go ReasonCache.composeKey.
	private composeKey(uid: string, name: string): string {
		return `${uid}_${name}`;
	}

	// Models kubernetes/pkg/kubelet/reason_cache.go ReasonCache.add.
	add(uid: string, name: string, reason: Error, message: string): void {
		this.cache.add(this.composeKey(uid, name), { err: reason, message });
	}

	// Models kubernetes/pkg/kubelet/reason_cache.go ReasonCache.Update.
	update(uid: string, result: PodSyncResult): void {
		for (const r of result.syncResults) {
			if (r.action !== "StartContainer") {
				continue;
			}
			const name = r.target as string;
			if (r.error) {
				this.add(uid, name, r.error, r.message);
			} else {
				this.remove(uid, name);
			}
		}
	}

	// Models kubernetes/pkg/kubelet/reason_cache.go ReasonCache.Remove.
	remove(uid: string, name: string): void {
		this.cache.remove(this.composeKey(uid, name));
	}

	// Models kubernetes/pkg/kubelet/reason_cache.go ReasonCache.Get.
	get(uid: string, name: string): [item: ReasonItem | undefined, ok: boolean] {
		return this.cache.get(this.composeKey(uid, name));
	}
}

// Models kubernetes/pkg/kubelet/reason_cache.go NewReasonCache.
export function newReasonCache(): ReasonCache {
	return new ReasonCache();
}
