import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const examples = [
	"01-single-pod.ts",
	"02-node-port-service.ts",
	"03-two-pods-service-dns.ts",
	"04-deployment-service-replicas.ts",
	"05-cross-namespace-service-dns.ts",
	"06-network-events-and-latency.ts",
];

const examplesDirectory = fileURLToPath(new URL(".", import.meta.url));

for (const example of examples) {
	console.log(`\n> ${example}`);
	await runExample(example);
}

async function runExample(example: string): Promise<void> {
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", example], {
			cwd: examplesDirectory,
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("exit", resolve);
	});

	if (exitCode !== 0) {
		throw new Error(`${example} exited with status ${exitCode}`);
	}
}
