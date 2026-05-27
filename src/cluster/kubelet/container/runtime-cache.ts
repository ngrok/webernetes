import type { Clock } from "../../../clock";
import type * as context from "../../../go/context";
import { Mutex } from "../../../mutex";
import type { Pod } from "./runtime";

// Models kubernetes/pkg/kubelet/container/runtime_cache.go podsGetter.
export interface PodsGetter {
	getPods(ctx: context.Context, all: boolean): Promise<[pods: Pod[], err: Error | undefined]>;
}

// Models kubernetes/pkg/kubelet/container/runtime_cache.go RuntimeCache.
export interface RuntimeCache {
	getPods(ctx: context.Context): Promise<[pods: Pod[], err: Error | undefined]>;
	forceUpdateIfOlder(ctx: context.Context, minExpectedCacheTime: Date): Promise<Error | undefined>;
}

export interface RuntimeCacheOptions {
	getter: PodsGetter;
	cachePeriodMs: number;
	clock: Clock;
}

// Models kubernetes/pkg/kubelet/container/runtime_cache.go runtimeCache.
export class RuntimeCacheImpl implements RuntimeCache {
	protected readonly lock = new Mutex();
	protected cacheTime = new Date(0);
	protected pods: Pod[] = [];
	private readonly getter: PodsGetter;
	private readonly cachePeriodMs: number;
	private readonly clock: Clock;

	constructor(options: RuntimeCacheOptions) {
		this.getter = options.getter;
		this.cachePeriodMs = options.cachePeriodMs;
		this.clock = options.clock;
	}

	// Models kubernetes/pkg/kubelet/container/runtime_cache.go runtimeCache.GetPods.
	async getPods(ctx: context.Context): Promise<[pods: Pod[], err: Error | undefined]> {
		return await this.lock.withLock(async () => {
			if (this.clock.nowMs() - this.cacheTime.getTime() > this.cachePeriodMs) {
				const err = await this.updateCache(ctx);
				if (err) {
					return [[], err];
				}
			}
			return [this.pods, undefined];
		});
	}

	// Models kubernetes/pkg/kubelet/container/runtime_cache.go runtimeCache.ForceUpdateIfOlder.
	async forceUpdateIfOlder(
		ctx: context.Context,
		minExpectedCacheTime: Date,
	): Promise<Error | undefined> {
		return await this.lock.withLock(async () => {
			if (this.cacheTime < minExpectedCacheTime) {
				return await this.updateCache(ctx);
			}
			return undefined;
		});
	}

	// Models kubernetes/pkg/kubelet/container/runtime_cache.go runtimeCache.updateCache.
	protected async updateCache(ctx: context.Context): Promise<Error | undefined> {
		const [pods, timestamp, err] = await this.getPodsWithTimestamp(ctx);
		if (err) {
			return err;
		}
		this.pods = pods;
		this.cacheTime = timestamp;
		return undefined;
	}

	// Models kubernetes/pkg/kubelet/container/runtime_cache.go runtimeCache.getPodsWithTimestamp.
	private async getPodsWithTimestamp(
		ctx: context.Context,
	): Promise<[pods: Pod[], timestamp: Date, err: Error | undefined]> {
		const timestamp = this.clock.now();
		const [pods, err] = await this.getter.getPods(ctx, false);
		return [pods, timestamp, err];
	}
}

// Models kubernetes/pkg/kubelet/container/runtime_cache.go NewRuntimeCache.
export function newRuntimeCache(
	getter: PodsGetter,
	cachePeriodMs: number,
	clock: Clock,
): RuntimeCache {
	return new RuntimeCacheImpl({ getter, cachePeriodMs, clock });
}
