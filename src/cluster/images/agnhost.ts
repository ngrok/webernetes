import type { ProcessContext } from "../cri";
import { BaseImage } from "./base";

export class AgnhostImage extends BaseImage {
	static readonly imageName = "registry.k8s.io/e2e-test-images/agnhost";
	static readonly imageVersion = "2.40";

	readonly defaultCommand = ["agnhost"];

	override async exec(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		const netexecIndex = argv.findIndex((arg) => arg.endsWith("agnhost") || arg === "netexec");
		const commandIndex = argv[netexecIndex] === "netexec" ? netexecIndex : netexecIndex + 1;
		if (argv[commandIndex] !== "netexec") {
			if (argv[0] === "agnhost") {
				return await ctx.waitUntilKilled();
			}
			return await super.exec(ctx, argv);
		}
		const port = parsePort(argv.slice(commandIndex + 1)) ?? 8080;
		ctx.listenHttp(port, async (_ctx, request) => {
			const url = request.url;
			switch (url.pathname) {
				case "/healthz":
				case "/readyz":
					return { statusCode: 200, body: "ok\n" };
				case "/exit":
					return this.exitResponse(ctx, url);
				case "/echo":
					return {
						statusCode: Number(url.searchParams.get("code") ?? "200"),
						body: url.searchParams.get("msg") ?? "ok",
					};
				case "/redirect":
					return { statusCode: 302, header: { Location: ["/echo"] }, body: "" };
				case "/shell":
					return await this.shellResponse(ctx, url.searchParams.get("cmd") ?? "");
				default:
					return { statusCode: 404, body: "not found\n" };
			}
		});
		return await ctx.waitUntilKilled();
	}

	private exitResponse(ctx: ProcessContext, url: URL): { statusCode: number; body: string } {
		const code = parseExitCode(url.searchParams.get("code"));
		const waitMs = parseDurationMs(url.searchParams.get("wait"));
		void (async () => {
			await ctx.sleep(waitMs);
			ctx.exit(code);
		})().catch(() => {});
		return { statusCode: 200, body: "" };
	}

	private async shellResponse(
		ctx: ProcessContext,
		command: string,
	): Promise<{ statusCode: number; body: string }> {
		const process = ctx.exec(this.splitShellWords(command));
		const code = await process.wait();
		return {
			statusCode: 200,
			body: JSON.stringify({
				output: process.stdout,
				error: process.stderr,
				code,
			}),
		};
	}
}

function parseExitCode(value: string | null): number {
	const code = Number(value ?? "0");
	if (!Number.isInteger(code) || code < 0 || code > 127) {
		return 0;
	}
	return code;
}

function parseDurationMs(value: string | null): number {
	if (!value) {
		return 0;
	}
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value);
	if (!match) {
		return 0;
	}
	const amount = Number(match[1]);
	switch (match[2] ?? "ns") {
		case "h":
			return amount * 60 * 60 * 1000;
		case "m":
			return amount * 60 * 1000;
		case "s":
			return amount * 1000;
		case "ms":
			return amount;
		default:
			return 0;
	}
}

function parsePort(argv: readonly string[]): number | undefined {
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		const [flag, inline] = arg.split("=", 2);
		if (flag !== "--http-port" && flag !== "-http-port") {
			continue;
		}
		const value = inline ?? argv[index + 1];
		const port = Number(value);
		return Number.isInteger(port) ? port : undefined;
	}
	return undefined;
}
