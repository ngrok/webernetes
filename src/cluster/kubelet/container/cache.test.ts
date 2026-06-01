import { expect, it } from "vitest";
import * as context from "../../../go/context";
import { browser } from "../../../test/describe";
import { PodStatusCache } from "./cache";
import type { PodStatus as PodRuntimeStatus } from "./runtime";

browser.describe("PodStatusCache", () => {
	it("returns empty status for missing pods once the cache is globally fresh", async () => {
		const cache = new PodStatusCache();
		const pending = cache.getNewerThan(context.background(), "pod-1", new Date(1000));

		cache.updateTime(new Date(2000));

		await expect(pending).resolves.toEqual([
			expect.objectContaining({
				id: "pod-1",
				containerStatuses: [],
				sandboxStatuses: [],
				ips: [],
			}),
			undefined,
		]);
	});

	it("blocks getNewerThan until set, observed time, or global time is fresh enough", async () => {
		const cache = new PodStatusCache();
		const status = podStatus("pod-1");
		let completed = false;
		const pending = cache
			.getNewerThan(context.background(), "pod-1", new Date(1000))
			.then((result) => {
				completed = true;
				return result;
			});

		await Promise.resolve();
		expect(completed).toBe(false);

		cache.set("pod-1", status, undefined, new Date(2000));

		await expect(pending).resolves.toEqual([status, undefined]);
		expect(completed).toBe(true);

		const observed = cache.getNewerThan(context.background(), "pod-1", new Date(3000));
		cache.setObservedTime("pod-1", new Date(3000));
		await expect(observed).resolves.toEqual([status, undefined]);

		const globallyFresh = cache.getNewerThan(context.background(), "pod-2", new Date(4000));
		cache.updateTime(new Date(5000));
		await expect(globallyFresh).resolves.toEqual([
			expect.objectContaining({
				id: "pod-2",
				containerStatuses: [],
				sandboxStatuses: [],
				ips: [],
			}),
			undefined,
		]);
	});

	it("delete removes pod status while global freshness can still return empty status", async () => {
		const cache = new PodStatusCache();
		cache.set("pod-1", podStatus("pod-1"), undefined, new Date(2000));
		cache.delete("pod-1");
		cache.updateTime(new Date(3000));

		await expect(
			cache.getNewerThan(context.background(), "pod-1", new Date(2500)),
		).resolves.toEqual([
			expect.objectContaining({
				id: "pod-1",
				containerStatuses: [],
				sandboxStatuses: [],
				ips: [],
			}),
			undefined,
		]);
	});
});

function podStatus(id: string): PodRuntimeStatus {
	return {
		id,
		name: "",
		namespace: "default",
		ips: ["10.0.0.1"],
		timestamp: new Date(0),
		containerStatuses: [],
		sandboxStatuses: [],
	};
}
