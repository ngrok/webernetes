import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

for (const script of ["test:node", "test:browser"]) {
	const result = spawnSync("pnpm", [script, ...args], {
		stdio: "inherit",
		shell: false,
	});

	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}
