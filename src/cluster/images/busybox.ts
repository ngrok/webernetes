import type { ImageDefinition, ProcessContext } from "../cri";

export class BusyBoxImage implements ImageDefinition {
	async start(context: ProcessContext, _argv: readonly string[]): Promise<number> {
		return await context.waitUntilKilled();
	}

	async exec(context: ProcessContext, argv: readonly string[]): Promise<number> {
		const command = argv[0];
		switch (command) {
			case "wget":
				return await wget(context, argv.slice(1));
			case "sh":
				return await shell(context, argv.slice(1));
			default:
				context.writeStderr(`${command ?? ""}: not found\n`);
				return 127;
		}
	}
}

async function shell(context: ProcessContext, argv: readonly string[]): Promise<number> {
	if (argv[0] !== "-c" || argv[1] === undefined) {
		context.writeStderr("sh: unsupported arguments\n");
		return 2;
	}
	return await runShellCommand(context, argv[1]);
}

async function runShellCommand(context: ProcessContext, command: string): Promise<number> {
	const parts = splitShellWords(command);
	if (parts.length === 0) {
		return 0;
	}
	return await new BusyBoxImage().exec(context, parts);
}

async function wget(context: ProcessContext, argv: readonly string[]): Promise<number> {
	const target = argv.find((arg) => !arg.startsWith("-"));
	if (!target) {
		context.writeStderr("wget: missing URL\n");
		return 1;
	}
	try {
		const response = await context.fetch(target);
		if (response.status < 200 || response.status >= 300) {
			context.writeStderr(`wget: server returned status ${response.status}\n`);
			return 1;
		}
		context.writeStdout(response.body ?? "");
		return 0;
	} catch (error) {
		context.writeStderr(error instanceof Error ? `${error.message}\n` : "wget failed\n");
		return 1;
	}
}

function splitShellWords(command: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (const character of command) {
		if (quote) {
			if (character === quote) {
				quote = undefined;
			} else {
				current += character;
			}
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			if (current) {
				words.push(current);
				current = "";
			}
			continue;
		}
		current += character;
	}
	if (current) {
		words.push(current);
	}
	return words;
}
