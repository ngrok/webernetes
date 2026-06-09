import type { ImageDefinition, ProcessContext } from "../cri";

export abstract class BaseImage implements ImageDefinition {
	async exec(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		const command = argv[0];
		switch (command) {
			case undefined:
				return 0;
			case "cat":
				return this.cat(ctx, argv.slice(1));
			case "false":
				return 1;
			case "env":
				return this.env(ctx, argv.slice(1));
			case "printenv":
				return this.printenv(ctx, argv.slice(1));
			case "pause":
				return await ctx.waitUntilKilled();
			case "rm":
				return this.rm(ctx, argv.slice(1));
			case "sh":
				return await this.shell(ctx, argv.slice(1));
			case "sleep":
				return await this.sleep(ctx, argv.slice(1));
			case "test":
				return this.test(ctx, argv.slice(1));
			case "touch":
				return this.touch(ctx, argv.slice(1));
			case "true":
				return 0;
			default:
				ctx.writeStderr(`${command ?? ""}: not found\n`);
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

	private cat(ctx: ProcessContext, argv: readonly string[]): number {
		const path = argv[0];
		if (!path) {
			ctx.writeStderr("cat: missing operand\n");
			return 1;
		}
		const contents = ctx.fs.read(path);
		if (contents === undefined) {
			ctx.writeStderr(`cat: can't open '${path}': No such file or directory\n`);
			return 1;
		}
		ctx.writeStdout(contents);
		return 0;
	}

	private rm(ctx: ProcessContext, argv: readonly string[]): number {
		for (const path of argv.filter((arg) => arg !== "-f")) {
			ctx.fs.delete(path);
		}
		return 0;
	}

	private env(ctx: ProcessContext, argv: readonly string[]): number {
		if (argv.length > 0) {
			ctx.writeStderr("env: unsupported arguments\n");
			return 125;
		}
		this.writeEnvironment(ctx);
		return 0;
	}

	private printenv(ctx: ProcessContext, argv: readonly string[]): number {
		if (argv.length === 0) {
			this.writeEnvironment(ctx);
			return 0;
		}

		let missing = false;
		for (const name of argv) {
			const value = ctx.env.get(name);
			if (value === undefined) {
				missing = true;
				continue;
			}
			ctx.writeStdout(`${value}\n`);
		}
		return missing ? 1 : 0;
	}

	private writeEnvironment(ctx: ProcessContext): void {
		for (const [name, value] of ctx.env) {
			ctx.writeStdout(`${name}=${value}\n`);
		}
	}

	private async shell(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "-c" || argv[1] === undefined) {
			ctx.writeStderr("sh: unsupported arguments\n");
			return 2;
		}
		const parts = this.splitShellWords(argv[1]);
		if (parts.length === 0) {
			return 0;
		}
		return await this.exec(ctx, parts);
	}

	private async sleep(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		const seconds = Number(argv[0] ?? "0");
		if (!Number.isFinite(seconds)) {
			return 1;
		}
		await ctx.sleep(seconds * 1000);
		return 0;
	}

	private test(ctx: ProcessContext, argv: readonly string[]): number {
		if (argv[0] === "-f" && argv[1]) {
			return ctx.fs.has(argv[1]) ? 0 : 1;
		}
		return 2;
	}

	private touch(ctx: ProcessContext, argv: readonly string[]): number {
		for (const path of argv) {
			ctx.fs.write(path);
		}
		return 0;
	}
}
