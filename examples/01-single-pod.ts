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
			body: "hello from a single pod\n",
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
	]);

	const readyPod = await waitForPodReady(cluster, pod);
	const podIP = readyPod.status?.podIP;
	if (!podIP) {
		throw new Error("Pod is ready but has no IP address");
	}

	const response = await cluster.fetch(`http://${podIP}:8080/`);
	console.log(response.body.trim());
} finally {
	await cluster.close();
}
