/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
import { expect, it } from "vitest";

import { browser } from "../../../test/describe";
import { formatURL, v1HeaderToHTTPHeader } from "./request";

// Models kubernetes/pkg/probe/http/request_test.go TestFormatURL.
browser.describe("TestFormatURL", () => {
	it("formats probe URLs", () => {
		const tests = [
			{ scheme: "http", host: "localhost", port: 93, path: "", result: "http://localhost:93" },
			{
				scheme: "https",
				host: "localhost",
				port: 93,
				path: "/path",
				result: "https://localhost:93/path",
			},
			{
				scheme: "https",
				host: "localhost",
				port: 93,
				path: "path",
				result: "https://localhost:93/path",
			},
			{
				scheme: "http",
				host: "localhost",
				port: 93,
				path: "?foo",
				result: "http://localhost:93?foo",
			},
			{
				scheme: "https",
				host: "localhost",
				port: 93,
				path: "/path?bar",
				result: "https://localhost:93/path?bar",
			},
		];

		for (const test of tests) {
			const url = formatURL(test.scheme, test.host, test.port, test.path);
			expect(url.toString()).toBe(test.result);
		}
	});
});

// Models kubernetes/pkg/probe/http/request_test.go Test_v1HeaderToHTTPHeader.
browser.describe("Test_v1HeaderToHTTPHeader", () => {
	it("converts v1 headers to HTTP headers", () => {
		const tests = [
			{
				name: "not empty input",
				headerList: [
					{ name: "Connection", value: "Keep-Alive" },
					{ name: "Content-Type", value: "text/html" },
					{ name: "Accept-Ranges", value: "bytes" },
				],
				want: {
					Connection: ["Keep-Alive"],
					"Content-Type": ["text/html"],
					"Accept-Ranges": ["bytes"],
				},
			},
			{
				name: "case insensitive",
				headerList: [
					{ name: "HOST", value: "example.com" },
					{ name: "FOO-bAR", value: "value" },
				],
				want: {
					Host: ["example.com"],
					"Foo-Bar": ["value"],
				},
			},
			{
				name: "empty input",
				headerList: [],
				want: {},
			},
		];

		for (const tt of tests) {
			expect(v1HeaderToHTTPHeader(tt.headerList)).toEqual(tt.want);
		}
	});
});

// Models kubernetes/pkg/probe/http/request_test.go TestHeaderConversion.
browser.describe("TestHeaderConversion", () => {
	it("canonicalizes and combines HTTP headers", () => {
		const testCases = [
			{
				headers: [
					{
						name: "Accept",
						value: "application/json",
					},
				],
				expected: {
					Accept: ["application/json"],
				},
			},
			{
				headers: [{ name: "accept", value: "application/json" }],
				expected: {
					Accept: ["application/json"],
				},
			},
			{
				headers: [
					{ name: "accept", value: "application/json" },
					{ name: "Accept", value: "*/*" },
					{ name: "pragma", value: "no-cache" },
					{ name: "X-forwarded-for", value: "username" },
				],
				expected: {
					Accept: ["application/json", "*/*"],
					Pragma: ["no-cache"],
					"X-Forwarded-For": ["username"],
				},
			},
		];

		for (const test of testCases) {
			const headers = v1HeaderToHTTPHeader(test.headers);
			expect(headers).toEqual(test.expected);
		}
	});
});
