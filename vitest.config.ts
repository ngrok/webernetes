import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		globalSetup: ["src/test/harnesses/kubernetes-k3s-global-setup.ts"],
		include: ["src/client/**/*.test.ts", "src/cluster/etcd.test.ts"],
		passWithNoTests: true,
		testTimeout: 240_000,
		hookTimeout: 40_000,
	},
});
