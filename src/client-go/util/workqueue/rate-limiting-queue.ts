/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import {
	newTypedDelayingQueueWithConfig,
	type TypedDelayingInterface,
	type TypedDelayingQueueConfig,
} from "./delaying-queue";
import type { TypedRateLimiter } from "./default-rate-limiters";

// Models staging/src/k8s.io/client-go/util/workqueue/rate_limiting_queue.go TypedRateLimitingInterface.
export interface TypedRateLimitingInterface<T> extends TypedDelayingInterface<T> {
	addRateLimited(item: T): Promise<void>;
	forget(item: T): void;
	numRequeues(item: T): number;
}

// Models staging/src/k8s.io/client-go/util/workqueue/rate_limiting_queue.go TypedRateLimitingQueueConfig.
export interface TypedRateLimitingQueueConfig<T> extends TypedDelayingQueueConfig<T> {
	delayingQueue?: TypedDelayingInterface<T>;
}

// Models staging/src/k8s.io/client-go/util/workqueue/rate_limiting_queue.go rateLimitingType.
class RateLimiting<T> implements TypedRateLimitingInterface<T> {
	constructor(
		private readonly delayingQueue: TypedDelayingInterface<T>,
		private readonly rateLimiter: TypedRateLimiter<T>,
	) {}

	add(item: T): void {
		this.delayingQueue.add(item);
	}

	async addAfter(item: T, durationMs: number): Promise<void> {
		await this.delayingQueue.addAfter(item, durationMs);
	}

	// Models staging/src/k8s.io/client-go/util/workqueue/rate_limiting_queue.go AddRateLimited.
	async addRateLimited(item: T): Promise<void> {
		await this.addAfter(item, this.rateLimiter.when(item));
	}

	// Models staging/src/k8s.io/client-go/util/workqueue/rate_limiting_queue.go Forget.
	forget(item: T): void {
		this.rateLimiter.forget(item);
	}

	// Models staging/src/k8s.io/client-go/util/workqueue/rate_limiting_queue.go NumRequeues.
	numRequeues(item: T): number {
		return this.rateLimiter.numRequeues(item);
	}

	len(): number {
		return this.delayingQueue.len();
	}

	async get(): Promise<[item: T | undefined, shutdown: boolean]> {
		return await this.delayingQueue.get();
	}

	done(item: T): void {
		this.delayingQueue.done(item);
	}

	async shutDown(): Promise<void> {
		await this.delayingQueue.shutDown();
	}

	async shutDownWithDrain(): Promise<void> {
		await this.delayingQueue.shutDownWithDrain();
	}

	shuttingDown(): boolean {
		return this.delayingQueue.shuttingDown();
	}
}

// Models staging/src/k8s.io/client-go/util/workqueue/rate_limiting_queue.go NewTypedRateLimitingQueueWithConfig.
export function newTypedRateLimitingQueueWithConfig<T>(
	rateLimiter: TypedRateLimiter<T>,
	config: TypedRateLimitingQueueConfig<T> = {},
): TypedRateLimitingInterface<T> {
	const delayingQueue = config.delayingQueue ?? newTypedDelayingQueueWithConfig<T>(config);
	return new RateLimiting(delayingQueue, rateLimiter);
}

// Models staging/src/k8s.io/client-go/util/workqueue/rate_limiting_queue.go NewTypedRateLimitingQueue.
export function newTypedRateLimitingQueue<T>(
	rateLimiter: TypedRateLimiter<T>,
): TypedRateLimitingInterface<T> {
	return newTypedRateLimitingQueueWithConfig(rateLimiter);
}
