import type { ProcessContext } from "../cri";
import { BaseImage } from "./base";

export class HttpEchoImage extends BaseImage {
	async start(context: ProcessContext, argv: readonly string[]): Promise<number> {
		const options = parseOptions(argv);
		const text = options.text ?? context.env.get("ECHO_TEXT");
		if (!text) {
			return 127;
		}

		context.listenHttp(options.port, async (_ctx, request) => {
			if (`${request.url.pathname}${request.url.search}` === "/health") {
				return {
					statusCode: 200,
					header: appHeaders(),
					body: '{"status":"ok"}\n',
				};
			}

			return {
				statusCode: options.statusCode,
				header: appHeaders(),
				body: `${text}\n`,
			};
		});
		return await context.waitUntilKilled();
	}
}

interface HttpEchoOptions {
	port: number;
	text?: string;
	statusCode: number;
}

function parseOptions(argv: readonly string[]): HttpEchoOptions {
	const options: HttpEchoOptions = {
		port: 5678,
		statusCode: 200,
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
				options.statusCode = Number(value);
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
