import { GarbageCollector as GarbageCollectorController } from "../../controller/garbagecollector/garbage-collector";
import type { ProcessContext } from "../cri";
import { BaseImage } from "./base";

export class GarbageCollector extends BaseImage {
	static readonly imageName = "webernetes/garbage-collector";
	static readonly imageVersion = "1.0";

	readonly defaultCommand = ["garbage-collector"];

	override async exec(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "garbage-collector") {
			return await super.exec(ctx, argv);
		}
		const controller = new GarbageCollectorController();
		await controller.run(ctx);
		try {
			return await ctx.waitUntilKilled();
		} finally {
			await controller.stop();
		}
	}
}
