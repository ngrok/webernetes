import type { ImageDefinition, ProcessContext } from "../cri";

export class PauseImage implements ImageDefinition {
	async start(context: ProcessContext): Promise<number> {
		return await context.waitUntilKilled();
	}

	async exec(): Promise<number> {
		return 0;
	}
}
