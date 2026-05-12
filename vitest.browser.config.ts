import { defineConfig } from "vitest/config";

export default defineConfig({
	optimizeDeps: {
		exclude: ["@kubernetes/client-node", "@testcontainers/k3s", "testcontainers"],
	},
	test: {
		include: ["src/**/*.test.ts"],
		passWithNoTests: true,
		testTimeout: 10_000,
		hookTimeout: 20_000,
		browser: {
			enabled: true,
			provider: "playwright",
			headless: true,
			instances: [{ browser: "chromium" }],
			screenshotFailures: false,
		},
	},
});
