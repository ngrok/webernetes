import { BaseImage, Cluster, type ProcessContext } from "@ngrok/webernetes";
import { waitForPodReady } from "./helpers";

class HelloImage extends BaseImage {
	static readonly imageName = "examples/hello";
	static readonly imageVersion = "1.0";
	readonly defaultCommand = ["server"];

	override async exec(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "server") {
			return await super.exec(ctx, argv);
		}

		ctx.listenHttp(8080, async () => ({
			status: 200,
			body: "hello through a NodePort service\n",
		}));
		return await ctx.waitUntilKilled();
	}
}

const cluster = new Cluster();
cluster.registerImage(HelloImage);

try {
	await cluster.init();
	const [pod] = await cluster.apply([
		{
			apiVersion: "v1",
			kind: "Pod",
			metadata: { name: "hello", labels: { app: "hello" } },
			spec: {
				containers: [{ name: "hello", image: "examples/hello:1.0" }],
			},
		},
		{
			apiVersion: "v1",
			kind: "Service",
			metadata: { name: "hello" },
			spec: {
				type: "NodePort",
				selector: { app: "hello" },
				ports: [{ port: 80, targetPort: 8080, nodePort: 31002 }],
			},
		},
	]);

	await waitForPodReady(cluster, pod);

	const response = await cluster.fetch("http://node-1:31002/");
	console.log(response.body.trim());
} finally {
	await cluster.close();
}
