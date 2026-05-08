import type { ProcessContext } from "../cri";
import { BaseImage } from "./base";

export class PauseImage extends BaseImage {
	override async start(context: ProcessContext): Promise<number> {
		return await context.waitUntilKilled();
	}
}
