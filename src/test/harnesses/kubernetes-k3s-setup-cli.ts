import { ConsoleK3sSetupProgress } from "./kubernetes-k3s-progress";
import { setupK3sInfrastructure } from "./kubernetes-k3s-setup";

const progress = new ConsoleK3sSetupProgress();

try {
	await setupK3sInfrastructure({ progress });
} finally {
	progress.finish();
}
