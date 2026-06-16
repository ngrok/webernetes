import * as w8s from "webernetes";

import {
	demoControlPort,
	demoHealthPort,
	demoRequestIdHeader,
	demoRequestTypeHeader,
	demoRequestTypeTrafficGenerator,
	getHeader,
} from "./helpers";

const readyFile = "/health/ready";
const liveFile = "/health/live";

abstract class DemoBaseImage extends w8s.BaseImage {
	protected startHealthControl(ctx: w8s.ProcessContext): void {
		ctx.fs.write(readyFile);
		ctx.fs.write(liveFile);

		ctx.listenHttp(demoHealthPort, async (_ctx, request) => {
			switch (request.url.pathname) {
				case "/health":
				case "/readyz":
					return healthResponse(ctx, readyFile, "ready");
				case "/live":
				case "/healthz":
					return healthResponse(ctx, liveFile, "live");
				default:
					return jsonResponse(404, { status: "not_found" });
			}
		});

		ctx.listenHttp(demoControlPort, async (_ctx, request) => {
			if (request.method === "GET" && request.url.pathname === "/state") {
				return healthStateResponse(ctx);
			}
			if (request.method !== "POST") {
				return jsonResponse(405, { status: "method_not_allowed" });
			}
			switch (request.url.pathname) {
				case "/ready":
					ctx.fs.write(readyFile);
					return healthStateResponse(ctx);
				case "/not-ready":
					ctx.fs.delete(readyFile);
					return healthStateResponse(ctx);
				case "/live":
					ctx.fs.write(liveFile);
					return healthStateResponse(ctx);
				case "/not-live":
					ctx.fs.delete(liveFile);
					return healthStateResponse(ctx);
				default:
					return jsonResponse(404, { status: "not_found" });
			}
		});
	}
}

export class DemoApiImage extends DemoBaseImage {
	static readonly imageName = "demo/api";
	static readonly imageVersion = "1.0";

	readonly defaultCommand = ["api-server"];

	override async exec(ctx: w8s.ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "api-server") {
			return await super.exec(ctx, argv);
		}

		this.startHealthControl(ctx);
		ctx.listenHttp(8080, async (_ctx, request) => {
			const [databaseResponse, redisResponse] = await Promise.all([
				ctx.fetch("http://database/query", {
					method: "POST",
					headers: demoRequestHeaders(request),
					body: JSON.stringify({ operation: "select-user", requestPath: request.url.pathname }),
				}),
				ctx.fetch("http://redis/get", {
					method: "POST",
					headers: demoRequestHeaders(request),
					body: JSON.stringify({ key: "feature-flags" }),
				}),
			]);
			const upstreamFailure = [databaseResponse, redisResponse].find(
				(response) => response.status >= 400,
			);
			if (upstreamFailure) {
				return jsonResponse(502, {
					status: "error",
					service: "api",
					message: "upstream request failed",
					upstream: {
						database: parseJsonBody(databaseResponse.body),
						redis: parseJsonBody(redisResponse.body),
					},
				});
			}

			return jsonResponse(200, {
				status: "ok",
				service: "api",
				upstream: {
					database: parseJsonBody(databaseResponse.body),
					redis: parseJsonBody(redisResponse.body),
				},
			});
		});

		return await ctx.waitUntilKilled();
	}
}

export class DemoDatabaseImage extends DemoBaseImage {
	static readonly imageName = "demo/database";
	static readonly imageVersion = "1.0";

	readonly defaultCommand = ["database-server"];

	override async exec(ctx: w8s.ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "database-server") {
			return await super.exec(ctx, argv);
		}

		this.startHealthControl(ctx);
		ctx.listenHttp(5432, async (_ctx, _request) => {
			if (randomFailure()) {
				return jsonResponse(500, {
					status: "error",
					service: "database",
					message: "query failed",
				});
			}

			return jsonResponse(200, {
				status: "ok",
				service: "database",
				rows: [{ id: "user-1", plan: "pro" }],
			});
		});

		return await ctx.waitUntilKilled();
	}
}

export class DemoRedisImage extends DemoBaseImage {
	static readonly imageName = "demo/redis";
	static readonly imageVersion = "1.0";

	readonly defaultCommand = ["redis-server"];

	override async exec(ctx: w8s.ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "redis-server") {
			return await super.exec(ctx, argv);
		}

		this.startHealthControl(ctx);
		ctx.listenHttp(6379, async (_ctx, _request) => {
			if (randomFailure()) {
				return jsonResponse(500, {
					status: "error",
					service: "redis",
					message: "cache read failed",
				});
			}

			return jsonResponse(200, {
				status: "ok",
				service: "redis",
				hit: true,
				value: { betaCheckout: true },
			});
		});

		return await ctx.waitUntilKilled();
	}
}

export class DemoTrafficGeneratorImage extends DemoBaseImage {
	static readonly imageName = "demo/traffic-generator";
	static readonly imageVersion = "1.0";

	readonly defaultCommand = ["traffic-generator"];

	override async exec(ctx: w8s.ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "traffic-generator") {
			return await super.exec(ctx, argv);
		}

		this.startHealthControl(ctx);
		for (;;) {
			try {
				await ctx.fetch("http://api/checkout", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						[demoRequestIdHeader]: demoRequestId(),
						[demoRequestTypeHeader]: demoRequestTypeTrafficGenerator,
					},
					body: JSON.stringify({ source: "traffic-generator" }),
				});
			} catch (error) {
				ctx.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
			}
			await ctx.sleep(5000);
		}
	}
}

function healthResponse(
	ctx: w8s.ProcessContext,
	path: string,
	check: "ready" | "live",
): w8s.HttpResponse {
	const healthy = ctx.fs.has(path);
	return jsonResponse(healthy ? 200 : 503, {
		status: healthy ? "ok" : "unhealthy",
		check,
	});
}

function healthStateResponse(ctx: w8s.ProcessContext): w8s.HttpResponse {
	return jsonResponse(200, {
		ready: ctx.fs.has(readyFile),
		live: ctx.fs.has(liveFile),
	});
}

function demoRequestHeaders(request: w8s.HttpRequest): w8s.HttpHeader {
	const headers: w8s.HttpHeader = { "Content-Type": ["application/json"] };
	for (const name of [demoRequestIdHeader, demoRequestTypeHeader]) {
		const value = getHeader(request.header, name);
		if (value !== undefined) {
			headers[name] = [value];
		}
	}
	return headers;
}

function demoRequestId(): string {
	return crypto.randomUUID();
}

function jsonResponse(status: number, body: unknown): w8s.HttpResponse {
	return {
		status,
		header: { "Content-Type": ["application/json"] },
		body: `${JSON.stringify(body)}\n`,
	};
}

function randomFailure(): boolean {
	return Math.random() < 0.5;
}

function parseJsonBody(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
}
