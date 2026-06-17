/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import type { PassiveClock } from "../../../utils/clock/clock";
import { ExpirationCache, type ExpirationPolicy } from "./expiration-cache";
import type { KeyFunc, Store } from "./store";

// Models staging/src/k8s.io/client-go/tools/cache/expiration_cache_fakes.go NewFakeExpirationStore.
export function newFakeExpirationStore<T>(
	keyFunc: KeyFunc<T>,
	_deletedKeys: undefined,
	expirationPolicy: ExpirationPolicy<T>,
	cacheClock: PassiveClock,
): Store<T> {
	return new ExpirationCache(keyFunc, cacheClock, expirationPolicy);
}
