import { expect, it } from "vitest";

import { select } from "../../../../go/channel";
import { browser } from "../../../../test/describe";
import { buildContainerID } from "../../container";
import { ResultsManager } from "./results-manager";

browser.describe("Probe results manager", () => {
	it("sends only changed results, backpressures when full, and has no close behavior", async () => {
		const manager = new ResultsManager();
		const pod = { metadata: { uid: "pod-1" } };
		const containerId = buildContainerID("simulator", "container-1");

		await manager.set(containerId, "success", pod);
		await manager.set(containerId, "success", pod);

		await expect(manager.updates().receive()).resolves.toMatchObject({
			ok: true,
			value: { containerId, result: "success", podUid: "pod-1" },
		});
		await expect(
			select()
				.case(manager.updates(), () => "update")
				.default(() => "empty"),
		).resolves.toBe("empty");

		for (let i = 0; i < 20; i++) {
			await manager.set(buildContainerID("simulator", `buffered-${i}`), "failure", pod);
		}

		let blockedSetCompleted = false;
		const blockedSet = manager
			.set(buildContainerID("simulator", "blocked"), "failure", pod)
			.then(() => {
				blockedSetCompleted = true;
				return undefined;
			});
		await Promise.resolve();

		expect(blockedSetCompleted).toBe(false);
		await manager.updates().receive();
		await blockedSet;
		expect(blockedSetCompleted).toBe(true);
		expect("close" in manager).toBe(false);
	});
});
