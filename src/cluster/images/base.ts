import type { ImageDefinition, ProcessContext } from "../cri";

export class BaseImage implements ImageDefinition {
	async start(context: ProcessContext, _argv: readonly string[]): Promise<number> {
		return await context.waitUntilKilled();
	}

	async exec(context: ProcessContext, argv: readonly string[]): Promise<number> {
		return await this.execCommand(context, argv, {
			stdout: (chunk) => context.writeStdout(chunk),
			stderr: (chunk) => context.writeStderr(chunk),
		});
	}

	protected async execCommand(
		context: ProcessContext,
		argv: readonly string[],
		output: CommandOutput,
	): Promise<number> {
		const command = argv[0];
		switch (command) {
			case "cat":
				return this.cat(context, argv.slice(1), output);
			case "false":
				return 1;
			case "env":
				return this.env(context, argv.slice(1), output);
			case "printenv":
				return this.printenv(context, argv.slice(1), output);
			case "rm":
				return this.rm(context, argv.slice(1));
			case "sh":
				return await this.shell(context, argv.slice(1), output);
			case "sleep":
				return await this.sleep(context, argv.slice(1));
			case "test":
				return this.test(context, argv.slice(1));
			case "touch":
				return this.touch(context, argv.slice(1));
			case "true":
				return 0;
			default:
				output.stderr(`${command ?? ""}: not found\n`);
				return 127;
		}
	}

	protected splitShellWords(command: string): string[] {
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

	private cat(context: ProcessContext, argv: readonly string[], output: CommandOutput): number {
		const path = argv[0];
		if (!path) {
			output.stderr("cat: missing operand\n");
			return 1;
		}
		const contents = context.fs.read(path);
		if (contents === undefined) {
			output.stderr(`cat: can't open '${path}': No such file or directory\n`);
			return 1;
		}
		output.stdout(contents);
		return 0;
	}

	private rm(context: ProcessContext, argv: readonly string[]): number {
		for (const path of argv.filter((arg) => arg !== "-f")) {
			context.fs.delete(path);
		}
		return 0;
	}

	private env(context: ProcessContext, argv: readonly string[], output: CommandOutput): number {
		if (argv.length > 0) {
			output.stderr("env: unsupported arguments\n");
			return 125;
		}
		this.writeEnvironment(context, output);
		return 0;
	}

	private printenv(
		context: ProcessContext,
		argv: readonly string[],
		output: CommandOutput,
	): number {
		if (argv.length === 0) {
			this.writeEnvironment(context, output);
			return 0;
		}

		let missing = false;
		for (const name of argv) {
			const value = context.env.get(name);
			if (value === undefined) {
				missing = true;
				continue;
			}
			output.stdout(`${value}\n`);
		}
		return missing ? 1 : 0;
	}

	private writeEnvironment(context: ProcessContext, output: CommandOutput): void {
		for (const [name, value] of context.env) {
			output.stdout(`${name}=${value}\n`);
		}
	}

	private async shell(
		context: ProcessContext,
		argv: readonly string[],
		output: CommandOutput,
	): Promise<number> {
		if (argv[0] !== "-c" || argv[1] === undefined) {
			output.stderr("sh: unsupported arguments\n");
			return 2;
		}
		const parts = this.splitShellWords(argv[1]);
		if (parts.length === 0) {
			return 0;
		}
		return await this.execCommand(context, parts, output);
	}

	private async sleep(context: ProcessContext, argv: readonly string[]): Promise<number> {
		const seconds = Number(argv[0] ?? "0");
		if (!Number.isFinite(seconds)) {
			return 1;
		}
		await context.sleep(seconds * 1000);
		return 0;
	}

	private test(context: ProcessContext, argv: readonly string[]): number {
		if (argv[0] === "-f" && argv[1]) {
			return context.fs.has(argv[1]) ? 0 : 1;
		}
		return 2;
	}

	private touch(context: ProcessContext, argv: readonly string[]): number {
		for (const path of argv) {
			context.fs.write(path);
		}
		return 0;
	}
}

export interface CommandOutput {
	stdout(chunk: string): void;
	stderr(chunk: string): void;
}
