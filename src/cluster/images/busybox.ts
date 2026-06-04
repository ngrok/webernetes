import type { ProcessContext } from "../cri";
import { BaseImage, type CommandOutput } from "./base";

export class BusyBoxImage extends BaseImage {
	protected override async execCommand(
		context: ProcessContext,
		argv: readonly string[],
		output: CommandOutput,
	): Promise<number> {
		const command = argv[0];
		switch (command) {
			case "wget":
				return await wget(context, argv.slice(1));
			default:
				return await super.execCommand(context, argv, output);
		}
	}
}

async function wget(context: ProcessContext, argv: readonly string[]): Promise<number> {
	const target = argv.find((arg) => !arg.startsWith("-"));
	if (!target) {
		context.writeStderr("wget: missing URL\n");
		return 1;
	}
	try {
		const response = await context.fetch(target);
		if (response.statusCode < 200 || response.statusCode >= 300) {
			context.writeStderr(`wget: server returned status ${response.statusCode}\n`);
			return 1;
		}
		context.writeStdout(response.body ?? "");
		return 0;
	} catch (error) {
		context.writeStderr(error instanceof Error ? `${error.message}\n` : "wget failed\n");
		return 1;
	}
}
