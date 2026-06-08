import { expect, it } from "vitest";
import { browser } from "../test/describe";
import { fieldSelectorMatches, filterByFields, parseFieldSelector } from "./fields";

browser.describe("field selectors", () => {
	it("treats empty selectors as matching everything", () => {
		const items = [pod("selected", "node-a"), pod("also-selected", "node-b")];

		expect(fieldSelectorMatches(items[0], parseFieldSelector(undefined))).toBe(true);
		expect(fieldSelectorMatches(items[0], parseFieldSelector(""))).toBe(true);
		expect(filterByFields(items, parseFieldSelector(undefined))).toEqual(items);
	});

	it("filters objects by dotted field paths", () => {
		const items = [
			pod("selected", "node-a", "default", "Running"),
			pod("wrong-node", "node-b", "default", "Running"),
			pod("wrong-phase", "node-a", "default", "Pending"),
		];

		expect(
			filterByFields(items, parseFieldSelector("spec.nodeName=node-a,status.phase=Running")).map(
				(item) => item.metadata.name,
			),
		).toEqual(["selected"]);
	});

	it("treats missing fields as empty strings", () => {
		expect(fieldSelectorMatches(pod("missing-node"), parseFieldSelector("spec.nodeName="))).toBe(
			true,
		);
	});

	it("rejects malformed selector terms", () => {
		expect(() => parseFieldSelector("metadata.name")).toThrow(
			"invalid selector: 'metadata.name'; can't understand 'metadata.name'",
		);
	});
});

function pod(name: string, nodeName?: string, namespace = "default", phase = "Running") {
	return {
		metadata: {
			name,
			namespace,
		},
		spec: {
			...(nodeName === undefined ? {} : { nodeName }),
		},
		status: {
			phase,
		},
	};
}
