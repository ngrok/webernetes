// oxlint-disable jest/expect-expect
// oxlint-disable jest/no-conditional-expect
import { expect, it } from "vitest";
import { browser } from "../../../test/describe";
import { conflicts, convertSelectorToLabelsMap, equals, merge, Set } from "./labels";

// Models staging/src/k8s.io/apimachinery/pkg/labels/labels_test.go matches.
function matches(ls: Set, want: string): void {
	expect(ls.string()).toBe(want);
}

browser.describe("labels", () => {
	// Models staging/src/k8s.io/apimachinery/pkg/labels/labels_test.go TestSetString.
	it("TestSetString", () => {
		matches(new Set({ x: "y" }), "x=y");
		matches(new Set({ foo: "bar" }), "foo=bar");
		matches(new Set({ foo: "bar", baz: "qup" }), "baz=qup,foo=bar");
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/labels_test.go TestLabelHas.
	it("TestLabelHas", () => {
		const labelHasTests = [
			{ ls: new Set({ x: "y" }), key: "x", has: true },
			{ ls: new Set({ x: "" }), key: "x", has: true },
			{ ls: new Set({ x: "y" }), key: "foo", has: false },
		];
		for (const lh of labelHasTests) {
			expect(lh.ls.has(lh.key)).toBe(lh.has);
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/labels_test.go TestLabelGet.
	it("TestLabelGet", () => {
		const ls = new Set({ x: "y" });
		expect(ls.get("x")).toBe("y");
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/labels_test.go TestLabelConflict.
	it("TestLabelConflict", () => {
		const tests: Array<{
			labels1: Record<string, string>;
			labels2: Record<string, string>;
			conflict: boolean;
		}> = [
			{ labels1: {}, labels2: {}, conflict: false },
			{ labels1: { env: "test" }, labels2: { infra: "true" }, conflict: false },
			{
				labels1: { env: "test" },
				labels2: { infra: "true", env: "test" },
				conflict: false,
			},
			{ labels1: { env: "test" }, labels2: { env: "dev" }, conflict: true },
			{
				labels1: { env: "test", infra: "false" },
				labels2: { infra: "true", color: "blue" },
				conflict: true,
			},
		];
		for (const test of tests) {
			const conflict = conflicts(new Set(test.labels1), new Set(test.labels2));
			expect(conflict).toBe(test.conflict);
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/labels_test.go TestLabelMerge.
	it("TestLabelMerge", () => {
		const tests: Array<{
			labels1: Record<string, string>;
			labels2: Record<string, string>;
			mergedLabels: Record<string, string>;
		}> = [
			{ labels1: {}, labels2: {}, mergedLabels: {} },
			{ labels1: { infra: "true" }, labels2: {}, mergedLabels: { infra: "true" } },
			{
				labels1: { infra: "true" },
				labels2: { env: "test", color: "blue" },
				mergedLabels: { infra: "true", env: "test", color: "blue" },
			},
		];
		for (const test of tests) {
			const mergedLabels = merge(new Set(test.labels1), new Set(test.labels2));
			expect(equals(mergedLabels, new Set(test.mergedLabels))).toBe(true);
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/labels/labels_test.go TestLabelSelectorParse.
	it("TestLabelSelectorParse", () => {
		const tests: Array<{
			selector: string;
			labels: Record<string, string>;
			valid: boolean;
		}> = [
			{ selector: "", labels: {}, valid: true },
			{ selector: "x=a", labels: { x: "a" }, valid: true },
			{ selector: "x=a,y=b,z=c", labels: { x: "a", y: "b", z: "c" }, valid: true },
			{ selector: " x = a , y = b , z = c ", labels: { x: "a", y: "b", z: "c" }, valid: true },
			{
				selector: "color=green,env=test,service=front",
				labels: { color: "green", env: "test", service: "front" },
				valid: true,
			},
			{
				selector: "color=green, env=test, service=front",
				labels: { color: "green", env: "test", service: "front" },
				valid: true,
			},
			{ selector: ",", labels: {}, valid: false },
			{ selector: "x", labels: {}, valid: false },
			{ selector: "x,y", labels: {}, valid: false },
			{ selector: "x=$y", labels: {}, valid: false },
			{ selector: "x!=y", labels: {}, valid: false },
			{ selector: "x==y", labels: {}, valid: false },
			{ selector: "x=a||y=b", labels: {}, valid: false },
			{ selector: "x in (y)", labels: {}, valid: false },
			{ selector: "x notin (y)", labels: {}, valid: false },
			{ selector: "x y", labels: {}, valid: false },
		];
		for (const test of tests) {
			const [labels, err] = convertSelectorToLabelsMap(test.selector);
			if (test.valid && err) {
				expect.fail(`selector: ${test.selector}, expected no error but got: ${err.message}`);
			} else if (!test.valid && !err) {
				expect.fail(`selector: ${test.selector}, expected an error`);
			}

			expect(equals(labels, new Set(test.labels))).toBe(true);
		}
	});
});
