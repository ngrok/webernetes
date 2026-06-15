/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */

// Models staging/src/k8s.io/client-go/util/workqueue/default_rate_limiters.go TypedRateLimiter.
export interface TypedRateLimiter<T> {
	when(item: T): number;
	forget(item: T): void;
	numRequeues(item: T): number;
}

// Models staging/src/k8s.io/client-go/util/workqueue/default_rate_limiters.go TypedItemExponentialFailureRateLimiter.
export class TypedItemExponentialFailureRateLimiter<T> implements TypedRateLimiter<T> {
	private readonly failures = new Map<T, number>();

	constructor(
		private readonly baseDelayMs: number,
		private readonly maxDelayMs: number,
	) {}

	// Models staging/src/k8s.io/client-go/util/workqueue/default_rate_limiters.go When.
	when(item: T): number {
		const exp = this.failures.get(item) ?? 0;
		this.failures.set(item, exp + 1);
		const backoff = this.baseDelayMs * 2 ** exp;
		return Math.min(backoff, this.maxDelayMs);
	}

	// Models staging/src/k8s.io/client-go/util/workqueue/default_rate_limiters.go Forget.
	forget(item: T): void {
		this.failures.delete(item);
	}

	// Models staging/src/k8s.io/client-go/util/workqueue/default_rate_limiters.go NumRequeues.
	numRequeues(item: T): number {
		return this.failures.get(item) ?? 0;
	}
}

// Models staging/src/k8s.io/client-go/util/workqueue/default_rate_limiters.go TypedMaxOfRateLimiter.
export class TypedMaxOfRateLimiter<T> implements TypedRateLimiter<T> {
	constructor(private readonly limiters: Array<TypedRateLimiter<T>>) {}

	// Models staging/src/k8s.io/client-go/util/workqueue/default_rate_limiters.go When.
	when(item: T): number {
		let ret = 0;
		for (const limiter of this.limiters) {
			ret = Math.max(ret, limiter.when(item));
		}
		return ret;
	}

	// Models staging/src/k8s.io/client-go/util/workqueue/default_rate_limiters.go Forget.
	forget(item: T): void {
		for (const limiter of this.limiters) {
			limiter.forget(item);
		}
	}

	// Models staging/src/k8s.io/client-go/util/workqueue/default_rate_limiters.go NumRequeues.
	numRequeues(item: T): number {
		let ret = 0;
		for (const limiter of this.limiters) {
			ret = Math.max(ret, limiter.numRequeues(item));
		}
		return ret;
	}
}

class NoopRateLimiter<T> implements TypedRateLimiter<T> {
	when(_item: T): number {
		return 0;
	}

	forget(_item: T): void {}

	numRequeues(_item: T): number {
		return 0;
	}
}

// Models staging/src/k8s.io/client-go/util/workqueue/default_rate_limiters.go NewTypedItemExponentialFailureRateLimiter.
export function newTypedItemExponentialFailureRateLimiter<T>(
	baseDelayMs: number,
	maxDelayMs: number,
): TypedRateLimiter<T> {
	return new TypedItemExponentialFailureRateLimiter<T>(baseDelayMs, maxDelayMs);
}

// Models staging/src/k8s.io/client-go/util/workqueue/default_rate_limiters.go NewTypedMaxOfRateLimiter.
export function newTypedMaxOfRateLimiter<T>(
	...limiters: Array<TypedRateLimiter<T>>
): TypedRateLimiter<T> {
	return new TypedMaxOfRateLimiter(limiters);
}

// Models staging/src/k8s.io/client-go/util/workqueue/default_rate_limiters.go DefaultTypedControllerRateLimiter.
export function defaultTypedControllerRateLimiter<T>(): TypedRateLimiter<T> {
	return newTypedMaxOfRateLimiter(
		newTypedItemExponentialFailureRateLimiter<T>(5, 1_000_000),
		new NoopRateLimiter<T>(),
	);
}
