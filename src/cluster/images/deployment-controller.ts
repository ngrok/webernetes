import { DeploymentController as Controller } from "../../controller/deployment/deployment-controller";
import type { ProcessContext } from "../cri";
import { BaseImage } from "./base";

export class DeploymentController extends BaseImage {
	static readonly imageName = "webernetes/deployment-controller";
	static readonly imageVersion = "1.0";

	readonly defaultCommand = ["deployment-controller"];

	override async exec(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "deployment-controller") {
			return await super.exec(ctx, argv);
		}
		const controller = new Controller(ctx.api, ctx.kubeConfig);
		await controller.run(ctx);
		try {
			return await ctx.waitUntilKilled();
		} finally {
			await controller.stop();
		}
	}
}
