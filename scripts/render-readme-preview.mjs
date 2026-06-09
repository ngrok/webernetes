import { watch } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { marked } from "marked";

const repoRoot = resolve(import.meta.dirname, "..");
const inputPath = resolve(repoRoot, "README.md");
const outputPath = resolve(repoRoot, "dist/readme-preview.html");
const shouldWatch = !process.argv.includes("--once");
let lastInputMtimeMs;

function escapeHtml(value) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

async function buildPreview() {
	const inputStat = await stat(inputPath);
	if (lastInputMtimeMs === inputStat.mtimeMs) {
		return;
	}
	const markdown = await readFile(inputPath, "utf8");
	const mermaidBlocks = [];
	const markdownWithPlaceholders = markdown.replace(
		/```mermaid\s*\n([\s\S]*?)```/g,
		(_match, diagram) => {
			const index = mermaidBlocks.length;
			mermaidBlocks.push(
				`<div class="mermaid-frame"><pre class="mermaid">${escapeHtml(diagram.trim())}</pre></div>`,
			);
			return `MERMAID_PREVIEW_BLOCK_${index}`;
		},
	);

	let body = await marked.parse(markdownWithPlaceholders, {
		gfm: true,
	});
	for (const [index, block] of mermaidBlocks.entries()) {
		body = body.replace(`<p>MERMAID_PREVIEW_BLOCK_${index}</p>`, block);
		body = body.replace(`MERMAID_PREVIEW_BLOCK_${index}`, block);
	}

	const html = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<base href="../" />
		<title>README preview</title>
		<style>
			:root {
				color-scheme: light;
				font-family:
					-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
				color: #1f2328;
				background: #ffffff;
			}

			body {
				margin: 0;
				padding: 32px;
			}

			main {
				max-width: 1280px;
				margin: 0 auto;
			}

			h1,
			h2,
			h3 {
				line-height: 1.25;
			}

			a {
				color: #0969da;
				text-decoration: none;
			}

			a:hover {
				text-decoration: underline;
			}

			code {
				font-family:
					ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo,
					monospace;
				font-size: 0.92em;
			}

			.mermaid-frame {
				overflow: auto;
				border: 1px solid #d0d7de;
				border-radius: 6px;
				padding: 16px;
				background: #f6f8fa;
			}

			.mermaid-frame svg {
				display: block;
				min-width: 960px;
			}

			.mermaid-error {
				white-space: pre-wrap;
				color: #cf222e;
				background: #ffebe9;
				border: 1px solid #ff8182;
				border-radius: 6px;
				padding: 12px;
			}
		</style>
		<script src="node_modules/mermaid/dist/mermaid.min.js"></script>
	</head>
	<body>
		<main>${body}</main>
		<script>
			mermaid.initialize({
				startOnLoad: false,
				securityLevel: "loose",
				htmlLabels: true,
				flowchart: {
					htmlLabels: true,
					useMaxWidth: false
				}
			});

			(async () => {
				try {
					await mermaid.run({
						nodes: document.querySelectorAll(".mermaid")
					});
				} catch (error) {
					const message = error instanceof Error ? error.stack || error.message : String(error);
					for (const frame of document.querySelectorAll(".mermaid-frame")) {
						if (frame.querySelector("svg")) {
							continue;
						}
						const block = document.createElement("pre");
						block.className = "mermaid-error";
						block.textContent = message;
						frame.append(block);
					}
					console.error(error);
				}
			})();
		</script>
	</body>
</html>
`;

	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, html);
	lastInputMtimeMs = inputStat.mtimeMs;
	console.log(`Wrote ${outputPath}`);
}

let buildInFlight = false;
let buildAgain = false;

async function buildQueued() {
	if (buildInFlight) {
		buildAgain = true;
		return;
	}
	buildInFlight = true;
	try {
		do {
			buildAgain = false;
			try {
				await buildPreview();
			} catch (error) {
				const message = error instanceof Error ? error.stack || error.message : String(error);
				console.error(message);
			}
		} while (buildAgain);
	} finally {
		buildInFlight = false;
	}
}

await buildQueued();

if (shouldWatch) {
	let debounce;
	const watcher = watch(inputPath, () => {
		clearTimeout(debounce);
		debounce = setTimeout(() => {
			void buildQueued();
		}, 300);
	});

	console.log(`Watching ${inputPath}`);

	process.on("SIGINT", () => {
		watcher.close();
		process.exit(0);
	});
}
