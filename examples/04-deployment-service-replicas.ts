import { BaseImage, Cluster, type ProcessContext } from "@ngrok/webernetes";
import { waitForDeploymentReady } from "./helpers";

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
			body: `hello from ${ctx.env.get("POD_NAME") ?? "a replica"}\n`,
		}));
		return await ctx.waitUntilKilled();
	}
}

const cluster = new Cluster();
cluster.registerImage(HelloImage);

try {
	await cluster.init();
	const [deployment] = await cluster.apply([
		{
			apiVersion: "apps/v1",
			kind: "Deployment",
			metadata: { name: "web" },
			spec: {
				replicas: 3,
				selector: { matchLabels: { app: "web" } },
				template: {
					metadata: { labels: { app: "web" } },
					spec: {
						containers: [
							{
								name: "web",
								image: "examples/hello:1.0",
								env: [
									{
										name: "POD_NAME",
										valueFrom: {
											fieldRef: {
												apiVersion: "v1",
												fieldPath: "metadata.name",
											},
										},
									},
								],
							},
						],
					},
				},
			},
		},
		{
			apiVersion: "v1",
			kind: "Service",
			metadata: { name: "web" },
			spec: {
				type: "NodePort",
				selector: { app: "web" },
				ports: [{ port: 80, targetPort: 8080, nodePort: 31003 }],
			},
		},
	]);

	await waitForDeploymentReady(cluster, deployment);

	for (let i = 0; i < 5; i++) {
		const response = await cluster.fetch("http://node-1:31003/");
		console.log(response.body.trim());
	}
} finally {
	await cluster.close();
}
