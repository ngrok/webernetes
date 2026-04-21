import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

describe("browser compatibility", () => {
	it("bundles and runs Etcd in a browser-like environment", async () => {
		const resolveDir = fileURLToPath(new URL(".", import.meta.url));
		const result = await build({
			bundle: true,
			format: "iife",
			platform: "browser",
			target: "es2022",
			write: false,
			stdin: {
				resolveDir,
				sourcefile: "browser-smoke.ts",
				contents: `
					import { Buffer } from "buffer";
					import { Clock, Etcd } from "./index.ts";

					globalThis.__browserPromise = (async () => {
						const etcd = new Etcd(new Clock());
						const watcher = await etcd.watch().key("key").create();
						const putSeen = new Promise((resolve) => {
							watcher.once("put", (kv) => resolve(kv.value.toString()));
						});

						await etcd.put("key").value(Buffer.from("value")).exec();
						const current = await etcd.get("key").buffer();

						return {
							current: current?.toString() ?? null,
							putSeen: await putSeen,
							isBuffer: current != null && Buffer.isBuffer(current),
						};
					})();
				`,
			},
		});

		const bundled = result.outputFiles[0]?.text;
		expect(bundled).toBeDefined();

		const context: Record<string, unknown> = {
			console,
			setTimeout,
			clearTimeout,
			queueMicrotask,
			TextEncoder,
			TextDecoder,
			ArrayBuffer,
			Uint8Array,
			process: undefined,
			require: undefined,
			Buffer: undefined,
		};
		context.globalThis = context;
		context.window = context;
		context.self = context;

		vm.runInNewContext(bundled!, context, { timeout: 5_000 });

		const browserResult = await (context.__browserPromise as Promise<{
			current: string | null;
			putSeen: string;
			isBuffer: boolean;
		}>);

		expect(browserResult).toEqual({
			current: "value",
			putSeen: "value",
			isBuffer: true,
		});
	});
});
