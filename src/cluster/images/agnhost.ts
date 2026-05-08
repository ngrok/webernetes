import type { ProcessContext } from "../cri";
import { BaseImage } from "./base";

export class AgnhostImage extends BaseImage {
	async start(context: ProcessContext, argv: readonly string[]): Promise<number> {
		const netexecIndex = argv.findIndex((arg) => arg.endsWith("agnhost") || arg === "netexec");
		const commandIndex = argv[netexecIndex] === "netexec" ? netexecIndex : netexecIndex + 1;
		if (argv[commandIndex] !== "netexec") {
			return await context.waitUntilKilled();
		}
		const port = parsePort(argv.slice(commandIndex + 1)) ?? 8080;
		context.listenHttp(port, async (request) => {
			const url = new URL(`http://localhost${request.path ?? "/"}`);
			switch (url.pathname) {
				case "/healthz":
				case "/readyz":
					return { status: 200, body: "ok\n" };
				case "/echo":
					return {
						status: Number(url.searchParams.get("code") ?? "200"),
						body: url.searchParams.get("msg") ?? "ok",
					};
				case "/redirect":
					return { status: 302, headers: { Location: "/echo" }, body: "" };
				case "/shell":
					return await this.shellResponse(context, url.searchParams.get("cmd") ?? "");
				default:
					return { status: 404, body: "not found\n" };
			}
		});
		return await context.waitUntilKilled();
	}

	private async shellResponse(
		context: ProcessContext,
		command: string,
	): Promise<{ status: number; body: string }> {
		let output = "";
		let error = "";
		const code = await this.execCommand(context, this.splitShellWords(command), {
			stdout: (chunk) => {
				output += chunk;
			},
			stderr: (chunk) => {
				error += chunk;
			},
		});
		return {
			status: 200,
			body: JSON.stringify({
				output,
				error,
				code,
			}),
		};
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
