import { BaseImage, Cluster, type ProcessContext } from "@ngrok/webernetes";
import { waitForPodReady } from "./helpers";

class ApiImage extends BaseImage {
	static readonly imageName = "examples/api";
	static readonly imageVersion = "1.0";
	readonly defaultCommand = ["server"];

	override async exec(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "server") {
			return await super.exec(ctx, argv);
		}

		ctx.listenHttp(8080, async () => ({
			status: 200,
			body: "hello from backend/api\n",
		}));
		return await ctx.waitUntilKilled();
	}
}

class FrontendImage extends BaseImage {
	static readonly imageName = "examples/frontend";
	static readonly imageVersion = "1.0";
	readonly defaultCommand = ["server"];

	override async exec(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "server") {
			return await super.exec(ctx, argv);
		}

		ctx.listenHttp(8080, async () => {
			const response = await ctx.fetch("http://api.backend.svc.cluster.local/");
			return { status: 200, body: `frontend received: ${response.body}` };
		});
		return await ctx.waitUntilKilled();
	}
}

const cluster = new Cluster();
cluster.registerImage(ApiImage);
cluster.registerImage(FrontendImage);

try {
	await cluster.init();
	await cluster.apply([
		{ apiVersion: "v1", kind: "Namespace", metadata: { name: "frontend" } },
		{ apiVersion: "v1", kind: "Namespace", metadata: { name: "backend" } },
	]);

	const [frontend, api] = await cluster.apply([
		{
			apiVersion: "v1",
			kind: "Pod",
			metadata: { name: "frontend", namespace: "frontend", labels: { app: "frontend" } },
			spec: {
				containers: [{ name: "frontend", image: "examples/frontend:1.0" }],
			},
		},
		{
			apiVersion: "v1",
			kind: "Pod",
			metadata: { name: "api", namespace: "backend", labels: { app: "api" } },
			spec: {
				containers: [{ name: "api", image: "examples/api:1.0" }],
			},
		},
		{
			apiVersion: "v1",
			kind: "Service",
			metadata: { name: "api", namespace: "backend" },
			spec: {
				selector: { app: "api" },
				ports: [{ port: 80, targetPort: 8080 }],
			},
		},
		{
			apiVersion: "v1",
			kind: "Service",
			metadata: { name: "frontend-public", namespace: "frontend" },
			spec: {
				type: "NodePort",
				selector: { app: "frontend" },
				ports: [{ port: 80, targetPort: 8080, nodePort: 31004 }],
			},
		},
	]);

	await waitForPodReady(cluster, frontend, api);

	const response = await cluster.fetch("http://node-1:31004/");
	console.log(response.body.trim());
} finally {
	await cluster.close();
}
