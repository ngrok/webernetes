import type { ProcessContext } from "../cri";
import { BaseImage } from "./base";

export class HelloWorldImage extends BaseImage {
	override async start(context: ProcessContext): Promise<number> {
		context.listenHttp(8000, async () => ({
			status: 200,
			body: "<xmp>\nHello World\n</xmp>\n",
		}));
		return await context.waitUntilKilled();
	}
}
