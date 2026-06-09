import type { ProcessContext } from "../cri";
import { BaseImage } from "./base";

export class BusyBoxImage extends BaseImage {
	static readonly imageName = "busybox";
	static readonly imageVersion = "1.36";

	override async exec(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		const command = argv[0];
		switch (command) {
			case "wget":
				return await wget(ctx, argv.slice(1));
			default:
				return await super.exec(ctx, argv);
		}
	}
}

async function wget(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
	const target = argv.find((arg) => !arg.startsWith("-"));
	if (!target) {
		ctx.writeStderr("wget: missing URL\n");
		return 1;
	}
	try {
		const response = await ctx.fetch(target);
		if (response.status < 200 || response.status >= 300) {
			ctx.writeStderr(`wget: server returned status ${response.status}\n`);
			return 1;
		}
		ctx.writeStdout(response.body ?? "");
		return 0;
	} catch (error) {
		ctx.writeStderr(error instanceof Error ? `${error.message}\n` : "wget failed\n");
		return 1;
	}
}
