/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";
import { Clock } from "../../../clock";
import * as context from "../../../go/context";
import { browser } from "../../../test/describe";
import { RuntimeCacheImpl } from "./runtime-cache";
import type { Pod } from "./runtime";

browser.describe("RuntimeCache", () => {
	// Models kubernetes/pkg/kubelet/container/runtime_cache_test.go TestGetPods.
	it("gets pods", async () => {
		const runtime = new FakeRuntime();
		const expected = [pod("1111"), pod("2222"), pod("3333")];
		runtime.podList = expected;
		const cache = newTestRuntimeCache(runtime);

		const [actual, err] = await cache.getPods(context.background());

		expect(err).toBeUndefined();
		comparePods(expected, actual);
	});

	// Models kubernetes/pkg/kubelet/container/runtime_cache_test.go TestForceUpdateIfOlder.
	it("force updates if older", async () => {
		const ctx = context.background();
		const clock = new Clock();
		const runtime = new FakeRuntime();
		const cache = newTestRuntimeCache(runtime);

		const oldPods = [pod("1111")];
		runtime.podList = oldPods;
		let err = await cache.updateCacheWithLock(ctx);
		expect(err).toBeUndefined();

		const newPods = [pod("1111"), pod("2222"), pod("3333")];
		runtime.podList = newPods;

		err = await cache.forceUpdateIfOlder(ctx, new Date(clock.nowMs() - 20 * 60 * 1000));
		expect(err).toBeUndefined();
		let actual = await cache.getCachedPods();
		comparePods(oldPods, actual);

		err = await cache.forceUpdateIfOlder(ctx, new Date(clock.nowMs() + 20 * 1000));
		expect(err).toBeUndefined();
		actual = await cache.getCachedPods();
		comparePods(newPods, actual);
	});
});

// Models kubernetes/pkg/kubelet/container/runtime_cache_test.go comparePods.
function comparePods(expected: Pod[], actual: Pod[]): void {
	expect(actual).toHaveLength(expected.length);
	for (const [index, expectedPod] of expected.entries()) {
		expect(actual[index]).toEqual(expectedPod);
	}
}

// Models kubernetes/pkg/kubelet/container/runtime_cache_test.go FakeRuntime usage.
class FakeRuntime {
	podList: Pod[] = [];

	async getPods(
		_ctx: context.Context,
		_all: boolean,
	): Promise<[pods: Pod[], err: Error | undefined]> {
		return [this.podList, undefined];
	}
}

// Models kubernetes/pkg/kubelet/container/runtime_cache_fake.go TestRuntimeCache.
class TestRuntimeCache extends RuntimeCacheImpl {
	// Models kubernetes/pkg/kubelet/container/runtime_cache_fake.go TestRuntimeCache.UpdateCacheWithLock.
	async updateCacheWithLock(ctx: context.Context): Promise<Error | undefined> {
		return await this.lock.withLock(async () => await this.updateCache(ctx));
	}

	// Models kubernetes/pkg/kubelet/container/runtime_cache_fake.go TestRuntimeCache.GetCachedPods.
	async getCachedPods(): Promise<Pod[]> {
		return await this.lock.withLock(() => this.pods);
	}
}

// Models kubernetes/pkg/kubelet/container/runtime_cache_fake.go NewTestRuntimeCache.
function newTestRuntimeCache(getter: FakeRuntime, clock: Clock = new Clock()): TestRuntimeCache {
	return new TestRuntimeCache({ getter, cachePeriodMs: 0, clock });
}

function pod(id: string): Pod {
	return {
		id,
		name: id,
		namespace: "default",
		createdAt: 0,
		containers: [],
		sandboxes: [],
		timestamp: new Date(0),
	};
}
