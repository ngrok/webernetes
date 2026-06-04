// oxlint-disable jest/expect-expect
import { expect, it } from "vitest";
import { Clock } from "../../../../clock";
import { browser } from "../../../../test/describe";
import { BasicWorkQueue } from "./work-queue";

const minute = 60_000;
const hour = 60 * minute;

function newTestBasicWorkQueue(): [BasicWorkQueue, Clock] {
	const clock = new Clock();
	clock.pause();
	const wq = new BasicWorkQueue(clock);
	return [wq, clock];
}

function compareResults(expected: string[], actual: string[]): void {
	const expectedSet = new Set<string>();
	for (const u of expected) {
		expectedSet.add(u);
	}
	const actualSet = new Set<string>();
	for (const u of actual) {
		actualSet.add(u);
	}
	expect(actualSet).toEqual(expectedSet);
}

// Models kubernetes/pkg/kubelet/util/queue/work_queue_test.go TestGetWork.
browser.describe("TestGetWork", () => {
	it("returns due work and removes it from the queue", () => {
		const [q, clock] = newTestBasicWorkQueue();
		q.enqueue("foo1", -1 * minute);
		q.enqueue("foo2", -1 * minute);
		q.enqueue("foo3", 1 * minute);
		q.enqueue("foo4", 1 * minute);
		let expected = ["foo1", "foo2"];
		compareResults(expected, q.getWork());
		compareResults([], q.getWork());
		clock.step(hour);
		expected = ["foo3", "foo4"];
		compareResults(expected, q.getWork());
		compareResults([], q.getWork());
	});
});
