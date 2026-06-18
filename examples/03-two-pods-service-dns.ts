import { BaseImage, Cluster, type ProcessContext } from "../src";
import { waitForPodReady } from "./helpers";

class CallerImage extends BaseImage {
	static readonly imageName = "examples/caller";
	static readonly imageVersion = "1.0";
	readonly defaultCommand = ["server"];

	override async exec(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "server") {
			return await super.exec(ctx, argv);
		}

		const message = ctx.env.get("MESSAGE") ?? "hello";
		const target = ctx.env.get("TARGET_URL");

		ctx.listenHttp(8080, async (_ctx, request) => {
			if (request.url.pathname !== "/call" || !target) {
				return { status: 200, body: `${message}\n` };
			}
			const response = await ctx.fetch(target);
			return { status: 200, body: `${message}; ${response.body}` };
		});

		return await ctx.waitUntilKilled();
	}
}

const cluster = new Cluster();
cluster.registerImage(CallerImage);

try {
	await cluster.init();
	const [alpha, bravo] = await cluster.apply([
		{
			apiVersion: "v1",
			kind: "Pod",
			metadata: { name: "alpha", labels: { app: "alpha" } },
			spec: {
				containers: [
					{
						name: "alpha",
						image: "examples/caller:1.0",
						env: [
							{ name: "MESSAGE", value: "alpha called bravo" },
							{ name: "TARGET_URL", value: "http://bravo.default.svc.cluster.local/" },
						],
					},
				],
			},
		},
		{
			apiVersion: "v1",
			kind: "Pod",
			metadata: { name: "bravo", labels: { app: "bravo" } },
			spec: {
				containers: [
					{
						name: "bravo",
						image: "examples/caller:1.0",
						env: [{ name: "MESSAGE", value: "hello from bravo" }],
					},
				],
			},
		},
		{
			apiVersion: "v1",
			kind: "Service",
			metadata: { name: "alpha" },
			spec: {
				selector: { app: "alpha" },
				ports: [{ port: 80, targetPort: 8080 }],
			},
		},
		{
			apiVersion: "v1",
			kind: "Service",
			metadata: { name: "bravo" },
			spec: {
				selector: { app: "bravo" },
				ports: [{ port: 80, targetPort: 8080 }],
			},
		},
	]);

	const [readyAlpha] = await waitForPodReady(cluster, alpha, bravo);
	const alphaIP = readyAlpha?.status?.podIP;
	if (!alphaIP) {
		throw new Error("Alpha pod is ready but has no IP address");
	}

	const response = await cluster.fetch(`http://${alphaIP}:8080/call`);
	console.log(response.body.trim());
} finally {
	await cluster.close();
}
