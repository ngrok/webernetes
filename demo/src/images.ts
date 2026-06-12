import * as w8s from "webernetes";

export class DemoApiImage extends w8s.BaseImage {
	static readonly imageName = "demo/api";
	static readonly imageVersion = "1.0";

	readonly defaultCommand = ["api-server"];

	override async exec(ctx: w8s.ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "api-server") {
			return await super.exec(ctx, argv);
		}

		ctx.listenHttp(8080, async (_ctx, request) => {
			if (request.url.pathname === "/readyz") {
				return jsonResponse(200, { status: "ok" });
			}

			const [databaseResponse, redisResponse] = await Promise.all([
				ctx.fetch("http://database.default.svc.cluster.local:5432/query", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ operation: "select-user", requestPath: request.url.pathname }),
				}),
				ctx.fetch("http://redis.default.svc.cluster.local:6379/get", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ key: "feature-flags" }),
				}),
			]);

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

export class DemoDatabaseImage extends w8s.BaseImage {
	static readonly imageName = "demo/database";
	static readonly imageVersion = "1.0";

	readonly defaultCommand = ["database-server"];

	override async exec(ctx: w8s.ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "database-server") {
			return await super.exec(ctx, argv);
		}

		ctx.listenHttp(5432, async (_ctx, request) => {
			if (request.url.pathname === "/readyz") {
				return jsonResponse(200, { status: "ok" });
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

export class DemoRedisImage extends w8s.BaseImage {
	static readonly imageName = "demo/redis";
	static readonly imageVersion = "1.0";

	readonly defaultCommand = ["redis-server"];

	override async exec(ctx: w8s.ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "redis-server") {
			return await super.exec(ctx, argv);
		}

		ctx.listenHttp(6379, async (_ctx, request) => {
			if (request.url.pathname === "/readyz") {
				return jsonResponse(200, { status: "ok" });
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

function jsonResponse(status: number, body: unknown): w8s.HttpResponse {
	return {
		status,
		header: { "Content-Type": ["application/json"] },
		body: `${JSON.stringify(body)}\n`,
	};
}

function parseJsonBody(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
}
