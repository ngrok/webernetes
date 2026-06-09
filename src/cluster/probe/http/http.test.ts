/*!
 * SPDX-License-Identifier: Apache-2.0
 * Derived from Kubernetes, translated and modified for Webernetes.
 */
// oxlint-disable jest/no-conditional-expect
import { expect, it } from "vitest";

import { Clock } from "../../../clock";
import * as context from "../../../go/context";
import { browser } from "../../../test/describe";
import { ClusterNetwork, type FetchOrigin } from "../../cni";
import * as http from "../../cni/http";
import { PodSandboxInstance } from "../../cri";
import type { ProbeResult } from "../probe";
import { doHTTPProbe, HTTPProber, type GetHTTPInterface } from "./http";
import { formatURL, newProbeRequest } from "./request";

const failureCode = -1;
const testOrigin: FetchOrigin = {
	apiVersion: "v1",
	kind: "Pod",
	metadata: { name: "test-pod", namespace: "default", uid: "test-pod-uid" },
};

type HTTPHandler = (w: ResponseRecorder, r: http.Request) => void | Promise<void>;

class ResponseRecorder {
	statusCode = 200;
	body = "";
	header: http.Header = {};

	writeHeader(statusCode: number): void {
		this.statusCode = statusCode;
	}

	write(chunk: string): void {
		this.body += chunk;
	}

	redirect(location: string, statusCode: number): void {
		this.statusCode = statusCode;
		this.header.Location = [location];
	}
}

class HandlerHTTPClient implements GetHTTPInterface {
	constructor(
		private readonly handler: HTTPHandler,
		private readonly followNonLocalRedirects = true,
	) {}

	async do(_ctx: context.Context, _origin: FetchOrigin, req: http.Request): Promise<http.Response> {
		let current = req;
		for (let redirects = 0; ; redirects++) {
			const res = await this.doOnce(current);
			const location = http.headerGet(res.header, "Location");
			if (res.statusCode < 300 || res.statusCode >= 400 || !location) {
				return { status: res.statusCode, body: res.body };
			}
			const nextURL = resolveURL(current.url, location);
			if (!this.followNonLocalRedirects && nextURL.hostname !== current.url.hostname) {
				return { status: res.statusCode, body: res.body };
			}
			if (redirects >= 9) {
				throw new Error("stopped after 10 redirects");
			}
			current = { ...current, url: nextURL };
		}
	}

	private async doOnce(req: http.Request): Promise<ResponseRecorder> {
		const recorder = new ResponseRecorder();
		await this.handler(recorder, withEffectiveHeaders(req));
		return recorder;
	}
}

function withEffectiveHeaders(req: http.Request): http.Request {
	const header: http.Header = {};
	for (const [key, values] of Object.entries(req.header)) {
		if (key.toLowerCase() === "user-agent" && values[0] === "") {
			continue;
		}
		header[key] = [...values];
	}
	if (!headerKey(header, "Connection")) {
		header.Connection = ["close"];
	}
	return { ...req, header };
}

function headerKey(headers: http.Header, name: string): string | undefined {
	const lowerName = name.toLowerCase();
	return Object.keys(headers).find((key) => key.toLowerCase() === lowerName);
}

function resolveURL(base: URL, location: string): URL {
	if (/^https?:\/\//.test(location)) {
		const url = new URL(location);
		return formatURL(
			url.protocol.replace(/:$/, ""),
			url.hostname,
			Number(url.port || (url.protocol === "https:" ? 443 : 80)),
			`${url.pathname}${url.search}`,
		);
	}
	if (location.startsWith("/")) {
		return formatURL(base.protocol.replace(/:$/, ""), base.hostname, Number(base.port), location);
	}
	const basePath = base.pathname.replace(/\/?[^/]*$/, "/");
	return formatURL(
		base.protocol.replace(/:$/, ""),
		base.hostname,
		Number(base.port),
		`${basePath}${location}`,
	);
}

function request(path = "/", headers: http.Header = {}): http.Request {
	const [req, err] = newProbeRequest(formatURL("http", "10.0.0.1", 8080, path), headers);
	if (err || !req) {
		throw err ?? new Error("request was not created");
	}
	return req;
}

function networkRequest(host: string, port: number, path = "/"): http.Request {
	const [req, err] = newProbeRequest(formatURL("http", host, port, path), {});
	if (err || !req) {
		throw err ?? new Error("request was not created");
	}
	return req;
}

function bindTestHTTP(network: ClusterNetwork, port: number, handler: http.Handler): string {
	const sandbox = new PodSandboxInstance(
		"sandbox-id",
		{
			metadata: { uid: "pod-uid", name: "pod", namespace: "default", attempt: 0 },
			dnsConfig: { servers: [], searches: [], options: [] },
		},
		0,
	);
	const registration = network.setupPodSandbox(sandbox, "10.0.0.0/24");
	sandbox.setNetworkRegistration(registration);
	registration.bindHttp(port, handler);
	return registration.ip;
}

function handleReq(s: number, body: string): HTTPHandler {
	return (w) => {
		w.writeHeader(s);
		w.write(body);
	};
}

browser.describe("HTTPProber cancellation", () => {
	it("cancels the request context when the probe times out", async () => {
		const clock = new Clock();
		clock.pause();
		const network = new ClusterNetwork();
		let handlerDone: Promise<unknown> | undefined;
		const host = bindTestHTTP(network, 8080, async (ctx) => {
			handlerDone = ctx.done().receive();
			await handlerDone;
			return { status: 200, body: "late" };
		});
		const prober = new HTTPProber(context.background(), clock, network);
		const probePromise = prober.probe(testOrigin, networkRequest(host, 8080), 1000);

		await Promise.resolve();
		clock.step(1000);

		await expect(probePromise).resolves.toEqual(["failure", "request timed out", undefined]);
		await expect(handlerDone).resolves.toMatchObject({ ok: false });
	});

	it("cancels the request context when the parent context is canceled", async () => {
		const clock = new Clock();
		clock.pause();
		const [parentCtx, cancel] = context.withCancel(context.background());
		const network = new ClusterNetwork();
		let handlerDone: Promise<unknown> | undefined;
		const host = bindTestHTTP(network, 8080, async (ctx) => {
			handlerDone = ctx.done().receive();
			await handlerDone;
			return { status: 200, body: "late" };
		});
		const prober = new HTTPProber(parentCtx, clock, network);
		const probePromise = prober.probe(testOrigin, networkRequest(host, 8080), 10_000);

		await Promise.resolve();
		cancel();

		await expect(probePromise).resolves.toEqual(["failure", "context canceled", undefined]);
		await expect(handlerDone).resolves.toMatchObject({ ok: false });
	});
});

// Models kubernetes/pkg/probe/http/http_test.go TestHTTPProbeChecker.
browser.describe("TestHTTPProbeChecker", () => {
	it("checks HTTP probe responses", async () => {
		const headerEchoHandler: HTTPHandler = (w, r) => {
			w.writeHeader(200);
			let output = "";
			for (const [key, values] of Object.entries(r.header)) {
				for (const value of values) {
					output += `${key}: ${value}\n`;
				}
			}
			w.write(output);
		};

		const headerCounterHandler: HTTPHandler = (w, r) => {
			w.writeHeader(200);
			w.write(String(Object.keys(r.header).length));
		};

		const headerKeysNamesHandler: HTTPHandler = (w, r) => {
			w.writeHeader(200);
			w.write(Object.keys(r.header).sort().join("\n"));
		};

		const redirectHandler = (s: number, bad: boolean): HTTPHandler => {
			return (w, r) => {
				if (r.url.pathname === "/") {
					w.redirect("/new", s);
				} else if (bad && r.url.pathname === "/new") {
					w.writeHeader(500);
					w.write("");
				}
			};
		};

		const redirectHandlerWithBody = (s: number, body: string): HTTPHandler => {
			return (w, r) => {
				if (r.url.pathname === "/") {
					w.redirect("/new", 308);
				} else if (r.url.pathname === "/new") {
					w.writeHeader(s);
					w.write(body);
				}
			};
		};

		const followNonLocalRedirects = true;
		const testCases: Array<{
			handler: HTTPHandler;
			reqHeaders?: http.Header;
			health: ProbeResult;
			accBody?: string;
			notBody?: string;
		}> = [
			{
				handler: handleReq(200, "ok body"),
				health: "success",
				accBody: "ok body",
			},
			{
				handler: headerCounterHandler,
				reqHeaders: {},
				health: "success",
				accBody: "3",
			},
			{
				handler: headerKeysNamesHandler,
				reqHeaders: {},
				health: "success",
				accBody: "Accept\nConnection\nUser-Agent",
			},
			{
				handler: headerEchoHandler,
				reqHeaders: {
					"Accept-Encoding": ["gzip"],
				},
				health: "success",
				accBody: "Accept-Encoding: gzip",
			},
			{
				handler: headerEchoHandler,
				reqHeaders: {
					"Accept-Encoding": ["foo"],
				},
				health: "success",
				accBody: "Accept-Encoding: foo",
			},
			{
				handler: headerEchoHandler,
				reqHeaders: {
					"Accept-Encoding": [""],
				},
				health: "success",
				accBody: "Accept-Encoding: \n",
			},
			{
				handler: headerEchoHandler,
				reqHeaders: {
					"X-Muffins-Or-Cupcakes": ["muffins"],
				},
				health: "success",
				accBody: "X-Muffins-Or-Cupcakes: muffins",
			},
			{
				handler: headerEchoHandler,
				reqHeaders: {
					"User-Agent": ["foo/1.0"],
				},
				health: "success",
				accBody: "User-Agent: foo/1.0",
			},
			{
				handler: headerEchoHandler,
				reqHeaders: {
					"User-Agent": [""],
				},
				health: "success",
				notBody: "User-Agent",
			},
			{
				handler: headerEchoHandler,
				reqHeaders: {},
				health: "success",
				accBody: "User-Agent: kube-probe/",
			},
			{
				handler: headerEchoHandler,
				reqHeaders: {
					"User-Agent": ["foo/1.0"],
					Accept: ["text/html"],
				},
				health: "success",
				accBody: "Accept: text/html",
			},
			{
				handler: headerEchoHandler,
				reqHeaders: {
					"User-Agent": ["foo/1.0"],
					Accept: ["foo/*"],
				},
				health: "success",
				accBody: "User-Agent: foo/1.0",
			},
			{
				handler: headerEchoHandler,
				reqHeaders: {
					"X-Muffins-Or-Cupcakes": ["muffins"],
					Accept: ["foo/*"],
				},
				health: "success",
				accBody: "X-Muffins-Or-Cupcakes: muffins",
			},
			{
				handler: headerEchoHandler,
				reqHeaders: {
					Accept: ["foo/*"],
				},
				health: "success",
				accBody: "Accept: foo/*",
			},
			{
				handler: headerEchoHandler,
				reqHeaders: {
					Accept: [""],
				},
				health: "success",
				notBody: "Accept:",
			},
			{
				handler: headerEchoHandler,
				reqHeaders: {
					"User-Agent": ["foo/1.0"],
					Accept: [""],
				},
				health: "success",
				notBody: "Accept:",
			},
			{
				handler: headerEchoHandler,
				reqHeaders: {},
				health: "success",
				accBody: "Accept: */*",
			},
			{
				handler: (w, r) => {
					w.writeHeader(200);
					w.write(r.host);
				},
				reqHeaders: {
					Host: ["muffins.cupcakes.org"],
				},
				health: "success",
				accBody: "muffins.cupcakes.org",
			},
			{
				handler: handleReq(failureCode, "fail body"),
				health: "failure",
			},
			{
				handler: handleReq(500, "fail body"),
				health: "failure",
			},
			{
				handler: () => {
					throw new Error("request timed out");
				},
				health: "failure",
			},
			{
				handler: redirectHandler(301, false),
				health: "success",
			},
			{
				handler: redirectHandler(301, true),
				health: "failure",
			},
			{
				handler: redirectHandler(302, false),
				health: "success",
			},
			{
				handler: redirectHandler(302, true),
				health: "failure",
			},
			{
				handler: redirectHandler(307, false),
				health: "success",
			},
			{
				handler: redirectHandler(307, true),
				health: "failure",
			},
			{
				handler: redirectHandler(308, false),
				health: "success",
			},
			{
				handler: redirectHandler(308, true),
				health: "failure",
			},
			{
				handler: redirectHandlerWithBody(308, ""),
				health: "warning",
				accBody: "Probe terminated redirects, Response body:",
			},
			{
				handler: redirectHandlerWithBody(308, "ok body"),
				health: "warning",
				accBody: "Probe terminated redirects, Response body: ok body",
			},
		];
		for (const test of testCases) {
			const req = request("/", test.reqHeaders);
			const [health, output, err] = await doHTTPProbe(
				context.background(),
				testOrigin,
				req,
				new HandlerHTTPClient(test.handler, followNonLocalRedirects),
			);
			if (test.health === "unknown") {
				expect(err).toBeDefined();
			}
			if (test.health !== "unknown") {
				expect(err).toBeUndefined();
			}
			expect(health).toBe(test.health);
			if (health !== "failure" && test.health !== "failure") {
				expect(output).toContain(test.accBody ?? "");
				if (test.notBody !== undefined) {
					expect(output).not.toContain(test.notBody);
				}
			}
		}
	});
});

// Models kubernetes/pkg/probe/http/http_test.go TestHTTPProbeChecker_NonLocalRedirects.
browser.describe("TestHTTPProbeChecker_NonLocalRedirects", () => {
	it("checks non-local redirect handling", async () => {
		const handler: HTTPHandler = (w, r) => {
			switch (r.url.pathname) {
				case "/redirect": {
					const loc = new URLSearchParams(r.url.search).get("loc") ?? "";
					w.redirect(loc, 302);
					break;
				}
				case "/loop":
					w.redirect("/loop", 302);
					break;
				case "/success":
					w.writeHeader(200);
					break;
				default:
					w.writeHeader(500);
					w.write("");
					break;
			}
		};

		const testCases: Record<
			string,
			{
				redirect: string;
				expectLocalResult: ProbeResult;
				expectNonLocalResult: ProbeResult;
			}
		> = {
			"local success": {
				redirect: "/success",
				expectLocalResult: "success",
				expectNonLocalResult: "success",
			},
			"local fail": {
				redirect: "/fail",
				expectLocalResult: "failure",
				expectNonLocalResult: "failure",
			},
			"newport success": {
				redirect: "http://10.0.0.1:9090/success",
				expectLocalResult: "success",
				expectNonLocalResult: "success",
			},
			"newport fail": {
				redirect: "http://10.0.0.1:9090/fail",
				expectLocalResult: "failure",
				expectNonLocalResult: "failure",
			},
			"bogus nonlocal": {
				redirect: "http://0.0.0.0/fail",
				expectLocalResult: "warning",
				expectNonLocalResult: "failure",
			},
			"redirect loop": {
				redirect: "/loop",
				expectLocalResult: "failure",
				expectNonLocalResult: "failure",
			},
		};
		for (const test of Object.values(testCases)) {
			let target = `/redirect?loc=${encodeURIComponent(test.redirect)}`;
			let req = request(target);
			let [result] = await doHTTPProbe(
				context.background(),
				testOrigin,
				req,
				new HandlerHTTPClient(handler, false),
			);
			expect(result).toBe(test.expectLocalResult);

			target = `/redirect?loc=${encodeURIComponent(test.redirect)}`;
			req = request(target);
			[result] = await doHTTPProbe(
				context.background(),
				testOrigin,
				req,
				new HandlerHTTPClient(handler, true),
			);
			expect(result).toBe(test.expectNonLocalResult);
		}
	});
});

// Models kubernetes/pkg/probe/http/http_test.go TestHTTPProbeChecker_HostHeaderPreservedAfterRedirect.
browser.describe("TestHTTPProbeChecker_HostHeaderPreservedAfterRedirect", () => {
	it("preserves Host header after redirect", async () => {
		const successHostHeader = "www.success.com";
		const failHostHeader = "www.fail.com";

		const handler: HTTPHandler = (w, r) => {
			switch (r.url.pathname) {
				case "/redirect":
					w.redirect("/success", 302);
					break;
				case "/success":
					if (r.host === successHostHeader) {
						w.writeHeader(200);
					} else {
						w.writeHeader(400);
					}
					break;
				default:
					w.writeHeader(500);
					break;
			}
		};

		const testCases: Record<string, { hostHeader: string; expectedResult: ProbeResult }> = {
			success: { hostHeader: successHostHeader, expectedResult: "success" },
			fail: { hostHeader: failHostHeader, expectedResult: "failure" },
		};
		for (const test of Object.values(testCases)) {
			const headers = { Host: [test.hostHeader] };
			let req = request("/redirect", headers);
			let [result] = await doHTTPProbe(
				context.background(),
				testOrigin,
				req,
				new HandlerHTTPClient(handler, false),
			);
			expect(result).toBe(test.expectedResult);

			req = request("/redirect", headers);
			[result] = await doHTTPProbe(
				context.background(),
				testOrigin,
				req,
				new HandlerHTTPClient(handler, true),
			);
			expect(result).toBe(test.expectedResult);
		}
	});
});

// Models kubernetes/pkg/probe/http/http_test.go TestHTTPProbeChecker_PayloadTruncated.
browser.describe("TestHTTPProbeChecker_PayloadTruncated", () => {
	it("truncates oversized payloads", async () => {
		const successHostHeader = "www.success.com";
		const oversizePayload = "a".repeat((10 << 10) + 1);
		const truncatedPayload = "a".repeat(10 << 10);

		const handler: HTTPHandler = (w, r) => {
			switch (r.url.pathname) {
				case "/success":
					if (r.host === successHostHeader) {
						w.writeHeader(200);
						w.write(oversizePayload);
					} else {
						w.writeHeader(400);
					}
					break;
				default:
					w.writeHeader(500);
					break;
			}
		};

		const req = request("/success", { Host: [successHostHeader] });
		const [result, body, err] = await doHTTPProbe(
			context.background(),
			testOrigin,
			req,
			new HandlerHTTPClient(handler, false),
		);
		expect(err).toBeUndefined();
		expect(result).toBe("success");
		expect(body).toBe(truncatedPayload);
	});
});

// Models kubernetes/pkg/probe/http/http_test.go TestHTTPProbeChecker_PayloadNormal.
browser.describe("TestHTTPProbeChecker_PayloadNormal", () => {
	it("returns normal payloads", async () => {
		const successHostHeader = "www.success.com";
		const normalPayload = "a".repeat((10 << 10) - 1);

		const handler: HTTPHandler = (w, r) => {
			switch (r.url.pathname) {
				case "/success":
					if (r.host === successHostHeader) {
						w.writeHeader(200);
						w.write(normalPayload);
					} else {
						w.writeHeader(400);
					}
					break;
				default:
					w.writeHeader(500);
					break;
			}
		};

		const req = request("/success", { Host: [successHostHeader] });
		const [result, body, err] = await doHTTPProbe(
			context.background(),
			testOrigin,
			req,
			new HandlerHTTPClient(handler, false),
		);
		expect(err).toBeUndefined();
		expect(result).toBe("success");
		expect(body).toBe(normalPayload);
	});
});
