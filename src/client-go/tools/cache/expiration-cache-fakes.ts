/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { PassiveClock } from "../../../utils/clock/clock";
import type { SendChannel } from "../../../go/channel";
import { ExpirationCache, type ExpirationPolicy, type TimestampedEntry } from "./expiration-cache";
import type { KeyFunc, Store } from "./store";

// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache_fakes.go FakeExpirationPolicy.
export class FakeExpirationPolicy<T> implements ExpirationPolicy<T> {
	constructor(
		readonly neverExpire: Set<string>,
		readonly retrieveKeyFunc: (obj: TimestampedEntry<T>) => [string, Error | undefined],
	) {}

	// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache_fakes.go FakeExpirationPolicy.IsExpired.
	isExpired(obj: TimestampedEntry<T>): boolean {
		const [key] = this.retrieveKeyFunc(obj);
		return !this.neverExpire.has(key);
	}
}

// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache_fakes.go NewFakeExpirationStore.
export function newFakeExpirationStore<T>(
	keyFunc: KeyFunc<T>,
	deletedKeys: SendChannel<string> | undefined,
	expirationPolicy: ExpirationPolicy<T>,
	cacheClock: PassiveClock,
): Store<T> {
	return new ExpirationCache(keyFunc, cacheClock, expirationPolicy, deletedKeys);
}
