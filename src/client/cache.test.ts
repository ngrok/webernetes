import { beforeEach, expect, it, vi } from "vitest";

import { ListWatch } from "./cache";
import { KubeConfig } from "./config";
import { Watch as ClientWatch } from "./watch";
import type { KubeList, KubernetesObject } from "./types";
import { browser } from "../test/describe";

interface TestPod extends KubernetesObject {
	metadata: {
		name: string;
		namespace: string;
		resourceVersion?: string;
		labels?: Record<string, string>;
	};
}

class FakeWatch extends ClientWatch {
	readonly calls: Array<{
		path: string;
		queryParams: Record<string, string | number | boolean | undefined>;
	}> = [];
	private callback: ((phase: string, apiObj: unknown, watchObj?: unknown) => void) | undefined;
	private done: ((err: unknown) => void) | undefined;

	constructor() {
		super({} as KubeConfig);
	}

	override async watch(
		path: string,
		queryParams: Record<string, string | number | boolean | undefined>,
		callback: (phase: string, apiObj: unknown, watchObj?: unknown) => void,
		done: (err: unknown) => void,
	): Promise<AbortController> {
		this.calls.push({ path, queryParams });
		this.callback = callback;
		this.done = done;
		return new AbortController();
	}

	emit(phase: "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK", object: TestPod): void {
		this.callback?.(phase, object, { type: phase, object });
	}

	fail(error: Error): void {
		this.done?.(error);
	}
}

browser.describe("ListWatch resourceVersion", () => {
	let watch: FakeWatch;
	let list: KubeList<TestPod>;

	beforeEach(() => {
		watch = new FakeWatch();
		list = {
			metadata: { resourceVersion: "10" },
			items: [
				pod({
					name: "cached",
					namespace: "default",
					resourceVersion: "9",
					labels: { state: "initial" },
				}),
			],
		};
	});

	it("makes stale watch event resourceVersions obvious by ignoring them as duplicate state", async () => {
		const updated = vi.fn<(object: TestPod) => void>();
		const informer = new ListWatch<TestPod>(
			"/api/v1/namespaces/default/pods",
			watch,
			async () => list,
			false,
		);
		informer.on("update", updated);

		await informer.start();
		watch.emit(
			"MODIFIED",
			pod({
				name: "cached",
				namespace: "default",
				resourceVersion: "9",
				labels: { state: "missed-update" },
			}),
		);

		expect(updated).not.toHaveBeenCalled();
		expect(informer.get("cached", "default")?.metadata.labels?.state).toBe("initial");
		expect(informer.latestResourceVersion()).toBe("10");
	});

	it("clears resourceVersion and relists the full state after a 410 Gone watch error", async () => {
		const connected = vi.fn<(err?: unknown) => void>();
		let currentList = list;
		const informer = new ListWatch<TestPod>(
			"/api/v1/namespaces/default/pods",
			watch,
			async () => currentList,
			false,
		);
		informer.on("connect", connected);

		await informer.start();
		currentList = {
			metadata: { resourceVersion: "20" },
			items: [
				pod({
					name: "relisted",
					namespace: "default",
					resourceVersion: "20",
					labels: { state: "fresh" },
				}),
			],
		};
		const gone = new Error("too old resource version");
		Object.assign(gone, { code: 410 });
		watch.fail(gone);

		await vi.waitFor(() => {
			expect(connected).toHaveBeenCalledTimes(2);
			expect(informer.get("cached", "default")).toBeUndefined();
			expect(informer.get("relisted", "default")?.metadata.labels?.state).toBe("fresh");
			expect(informer.latestResourceVersion()).toBe("20");
			expect(watch.calls.at(-1)?.queryParams).toEqual({ resourceVersion: "20" });
		});
	});

	it("clears resourceVersion and relists after compacted watch history", async () => {
		const connected = vi.fn<(err?: unknown) => void>();
		let currentList = list;
		const informer = new ListWatch<TestPod>(
			"/api/v1/namespaces/default/pods",
			watch,
			async () => currentList,
			false,
		);
		informer.on("connect", connected);

		await informer.start();
		currentList = {
			metadata: { resourceVersion: "30" },
			items: [
				pod({
					name: "after-compaction",
					namespace: "default",
					resourceVersion: "30",
					labels: { state: "fresh" },
				}),
			],
		};
		watch.fail(new Error("etcdserver: mvcc: required revision has been compacted"));

		await vi.waitFor(() => {
			expect(connected).toHaveBeenCalledTimes(2);
			expect(informer.get("cached", "default")).toBeUndefined();
			expect(informer.get("after-compaction", "default")?.metadata.labels?.state).toBe("fresh");
			expect(informer.latestResourceVersion()).toBe("30");
			expect(watch.calls.at(-1)?.queryParams).toEqual({ resourceVersion: "30" });
		});
	});
});

function pod(metadata: TestPod["metadata"]): TestPod {
	return {
		apiVersion: "v1",
		kind: "Pod",
		metadata,
	};
}
