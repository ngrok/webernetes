/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// oxlint-disable jest/valid-expect
import { expect, it } from "vitest";

import type { V1Pod } from "../../../../client";
import { select } from "../../../../go/channel";
import { browser } from "../../../../test/describe";
import { buildContainerID } from "../../container";
import type { ProbeUpdate } from "./results-manager";
import { ResultsManager } from "./results-manager";

// Models kubernetes/pkg/kubelet/prober/results/results_manager_test.go TestCacheOperations.
browser.describe("TestCacheOperations", () => {
	it("performs cache operations", async () => {
		const m = new ResultsManager();

		const unsetID = buildContainerID("test", "unset");
		const setID = buildContainerID("test", "set");

		expect(m.get(unsetID)).toBeUndefined();

		await m.set(setID, "success", {});
		expect(m.get(setID)).toBe("success");

		m.remove(setID);
		expect(m.get(setID)).toBeUndefined();
	});
});

// Models kubernetes/pkg/kubelet/prober/results/results_manager_test.go TestUpdates.
browser.describe("TestUpdates", () => {
	it("sends updates for new and changed results", async () => {
		const m = new ResultsManager();

		const pod: V1Pod = { metadata: { name: "test-pod" } };
		const fooID = buildContainerID("test", "foo");
		const barID = buildContainerID("test", "bar");

		const expectUpdate = async (expected: ProbeUpdate, msg: string) => {
			const received = await m.updates().receive();
			expect(received.ok, msg).toBe(true);
			expect(received.value, msg).toEqual(expected);
		};

		const expectNoUpdate = async (msg: string) => {
			const received = await select()
				.case(m.updates(), () => "update")
				.default(() => "empty");
			expect(received, msg).toBe("empty");
		};

		await m.set(fooID, "success", pod);
		await expectUpdate({ containerId: fooID, result: "success", podUid: "" }, "new success");

		await m.set(barID, "failure", pod);
		await expectUpdate({ containerId: barID, result: "failure", podUid: "" }, "new failure");

		await m.set(fooID, "success", pod);
		await expectNoUpdate("unchanged foo");

		await m.set(barID, "failure", pod);
		await expectNoUpdate("unchanged bar");

		await m.set(fooID, "failure", pod);
		await expectUpdate({ containerId: fooID, result: "failure", podUid: "" }, "changed foo");

		await m.set(barID, "success", pod);
		await expectUpdate({ containerId: barID, result: "success", podUid: "" }, "changed bar");
	});
});
