import { BaseImage, Cluster, newLatencyProvider, type ProcessContext } from "../src";
import { waitForPodReady } from "./helpers";

class CallerImage extends BaseImage {
	static readonly imageName = "examples/caller";
	static readonly imageVersion = "1.0";
	readonly defaultCommand = ["server"];

	override async exec(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "server") {
			return await super.exec(ctx, argv);
		}

		const target = ctx.env.get("TARGET_URL");
		const message = ctx.env.get("MESSAGE") ?? "hello";

		ctx.listenHttp(8080, async () => {
			if (!target) {
				return { status: 200, body: `${message}\n` };
			}
			const response = await ctx.fetch(target);
			return { status: 200, body: `${message}; ${response.body}` };
		});

		return await ctx.waitUntilKilled();
	}
}

const cluster = new Cluster({
	latencyProvider: newLatencyProvider({
		clusterNetworkRequestLatency: () => 25,
		clusterNetworkResponseLatency: () => 25,
	}),
});
cluster.registerImage(CallerImage);

try {
	await cluster.init();
	const [left, right] = await cluster.apply([
		{
			apiVersion: "v1",
			kind: "Pod",
			metadata: { name: "left", labels: { app: "left" } },
			spec: {
				containers: [
					{
						name: "left",
						image: "examples/caller:1.0",
						env: [
							{ name: "MESSAGE", value: "left called right" },
							{ name: "TARGET_URL", value: "http://right.default.svc.cluster.local/" },
						],
					},
				],
			},
		},
		{
			apiVersion: "v1",
			kind: "Pod",
			metadata: { name: "right", labels: { app: "right" } },
			spec: {
				containers: [
					{
						name: "right",
						image: "examples/caller:1.0",
						env: [{ name: "MESSAGE", value: "hello from right" }],
					},
				],
			},
		},
		{
			apiVersion: "v1",
			kind: "Service",
			metadata: { name: "right" },
			spec: {
				selector: { app: "right" },
				ports: [{ port: 80, targetPort: 8080 }],
			},
		},
		{
			apiVersion: "v1",
			kind: "Service",
			metadata: { name: "left-public" },
			spec: {
				type: "NodePort",
				selector: { app: "left" },
				ports: [{ port: 80, targetPort: 8080, nodePort: 31005 }],
			},
		},
	]);

	await waitForPodReady(cluster, left, right);

	cluster.on("request", (event) => {
		console.log(`request ${event.request.url} latency=${event.latencyMs}ms`);
	});
	cluster.on("response", (event) => {
		console.log(`response ${event.response?.status ?? "error"} latency=${event.latencyMs}ms`);
	});

	const response = await cluster.fetch("http://node-1:31005/");
	console.log(response.body.trim());
} finally {
	await cluster.close();
}
