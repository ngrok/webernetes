import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";

import {
	K3S_CONTAINER_NAME,
	K3S_SETUP_MARKER_ROOT,
	K3S_START_LOCK_DIR,
} from "./kubernetes-k3s-setup";

const markerPaths = [K3S_START_LOCK_DIR, K3S_SETUP_MARKER_ROOT];

const inspect = spawnSync("docker", ["inspect", K3S_CONTAINER_NAME], {
	shell: false,
	stdio: "ignore",
});

if (inspect.status === 0) {
	const remove = spawnSync("docker", ["rm", "-f", K3S_CONTAINER_NAME], {
		shell: false,
		stdio: "inherit",
	});
	if (remove.status !== 0) {
		process.exit(remove.status ?? 1);
	}
} else {
	process.stderr.write(`[k3s] container ${K3S_CONTAINER_NAME} is not present\n`);
}

for (const path of markerPaths) {
	await rm(path, { force: true, recursive: true });
}

process.stderr.write("[k3s] teardown complete\n");
