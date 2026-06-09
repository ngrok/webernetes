import { ConsoleK3sSetupProgress } from "./kubernetes-k3s-progress";
import { setupK3sInfrastructure } from "./kubernetes-k3s-setup";

export default async function globalSetup(): Promise<void> {
	if (!shouldRunK3sGlobalSetup()) {
		return;
	}

	const progress = new ConsoleK3sSetupProgress();
	try {
		await setupK3sInfrastructure({ progress });
	} finally {
		progress.finish();
	}
}

function shouldRunK3sGlobalSetup(): boolean {
	if (process.env.WEBERNETES_K3S_GLOBAL_SETUP === "0") {
		return false;
	}
	if (process.env.WEBERNETES_K3S_GLOBAL_SETUP === "1") {
		return true;
	}

	const args = process.argv.slice(2);
	if (args.some((arg) => arg.includes("src/client/tests") || arg.includes("client/tests"))) {
		return true;
	}
	return !args.some((arg) => arg.endsWith(".test.ts") || arg.startsWith("src/"));
}
