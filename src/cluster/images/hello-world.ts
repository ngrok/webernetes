import type { ProcessContext } from "../cri";
import { BaseImage } from "./base";

export class HelloWorldImage extends BaseImage {
	static readonly imageName = "crccheck/hello-world";
	static readonly imageVersion = "1.0";

	readonly defaultCommand = ["hello-world"];

	override async exec(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "hello-world") {
			return await super.exec(ctx, argv);
		}
		ctx.listenHttp(8000, async () => ({
			status: 200,
			body: "<xmp>\nHello World\n</xmp>\n",
		}));
		return await ctx.waitUntilKilled();
	}
}
