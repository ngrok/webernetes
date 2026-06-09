import type { ProcessContext } from "../cri";
import { BaseImage } from "./base";

export class HttpEchoImage extends BaseImage {
	static readonly imageName = "hashicorp/http-echo";
	static readonly imageVersion = "1.0";

	readonly defaultCommand = ["http-echo"];

	override async exec(ctx: ProcessContext, argv: readonly string[]): Promise<number> {
		if (argv[0] !== "http-echo") {
			return await super.exec(ctx, argv);
		}
		const options = parseOptions(argv.slice(1));
		const text = options.text ?? ctx.env.get("ECHO_TEXT");
		if (!text) {
			return 127;
		}

		ctx.listenHttp(options.port, async (_ctx, request) => {
			if (`${request.url.pathname}${request.url.search}` === "/health") {
				return {
					status: 200,
					header: appHeaders(),
					body: '{"status":"ok"}\n',
				};
			}

			return {
				status: options.status,
				header: appHeaders(),
				body: `${text}\n`,
			};
		});
		return await ctx.waitUntilKilled();
	}
}

interface HttpEchoOptions {
	port: number;
	text?: string;
	status: number;
}

function parseOptions(argv: readonly string[]): HttpEchoOptions {
	const options: HttpEchoOptions = {
		port: 5678,
		status: 200,
	};

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		const [name, inlineValue] = splitFlag(arg);
		if (!name) {
			continue;
		}

		const value = inlineValue ?? argv[++index];
		if (value === undefined) {
			continue;
		}

		switch (name) {
			case "listen":
				options.port = parseListenPort(value);
				break;
			case "text":
				options.text = unquote(value);
				break;
			case "status-code":
				options.status = Number(value);
				break;
		}
	}

	return options;
}

function splitFlag(arg: string): [string | undefined, string | undefined] {
	const match = /^-+([^=]+)(?:=(.*))?$/.exec(arg);
	if (!match) {
		return [undefined, undefined];
	}
	return [match[1], match[2]];
}

function parseListenPort(value: string): number {
	const port = Number(value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value);
	return Number.isFinite(port) ? port : 5678;
}

function unquote(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function appHeaders(): Record<string, string[]> {
	return {
		"X-App-Name": ["http-echo"],
		"X-App-Version": ["simulator"],
	};
}
