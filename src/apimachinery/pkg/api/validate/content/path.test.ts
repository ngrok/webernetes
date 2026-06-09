/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// oxlint-disable jest/no-conditional-expect
import { expect, it } from "vitest";
import { browser } from "../../../../../test/describe";
import { isPathSegmentName, isPathSegmentPrefix } from "./path";

browser.describe("content path validation", () => {
	// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/path_test.go TestIsPathSegmentPrefix.
	it("validates path segment prefixes", () => {
		const testcases = new Map([
			["empty", { name: "", expectedMsg: "" }],
			["valid short", { name: "foo", expectedMsg: "" }],
			["valid long", { name: "foo.bar.baz", expectedMsg: "" }],
			["valid complex", { name: "sha256:ABCDEF012345@ABCDEF012345", expectedMsg: "" }],
			["valid extended charset", { name: "Iñtërnâtiônàlizætiøn", expectedMsg: "" }],
			["dot", { name: ".", expectedMsg: "" }],
			["dot leading", { name: ".test", expectedMsg: "" }],
			["dot dot", { name: "..", expectedMsg: "" }],
			["dot dot leading", { name: "..test", expectedMsg: "" }],
			["slash", { name: "foo/bar", expectedMsg: "/" }],
			["percent", { name: "foo%bar", expectedMsg: "%" }],
		]);

		for (const [_, tc] of testcases) {
			const msgs = isPathSegmentPrefix(tc.name);
			if (tc.expectedMsg.length === 0) {
				expect(msgs).toHaveLength(0);
			}
			if (tc.expectedMsg.length > 0) {
				expect(msgs.length).not.toBe(0);
				expect(msgs[0] ?? "").toContain(tc.expectedMsg);
			}
		}
	});

	// Models staging/src/k8s.io/apimachinery/pkg/api/validate/content/path_test.go TestIsPathSegmentName.
	it("validates path segment names", () => {
		const testcases = new Map([
			["empty", { name: "", expectedMsg: "" }],
			["valid short", { name: "foo", expectedMsg: "" }],
			["valid long", { name: "foo.bar.baz", expectedMsg: "" }],
			["valid complex", { name: "sha256:ABCDEF012345@ABCDEF012345", expectedMsg: "" }],
			["valid extended charset", { name: "Iñtërnâtiônàlizætiøn", expectedMsg: "" }],
			["dot", { name: ".", expectedMsg: "." }],
			["dot leading", { name: ".test", expectedMsg: "" }],
			["dot dot", { name: "..", expectedMsg: ".." }],
			["dot dot leading", { name: "..test", expectedMsg: "" }],
			["slash", { name: "foo/bar", expectedMsg: "/" }],
			["percent", { name: "foo%bar", expectedMsg: "%" }],
		]);

		for (const [_, tc] of testcases) {
			const msgs = isPathSegmentName(tc.name);
			if (tc.expectedMsg.length === 0) {
				expect(msgs).toHaveLength(0);
			}
			if (tc.expectedMsg.length > 0) {
				expect(msgs.length).not.toBe(0);
				expect(msgs[0] ?? "").toContain(tc.expectedMsg);
			}
		}
	});
});
