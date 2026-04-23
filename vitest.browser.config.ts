import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*browser.test.ts"],
		testTimeout: 15_000,
		hookTimeout: 60_000,
		browser: {
			enabled: true,
			provider: "playwright",
			headless: true,
			instances: [{ browser: "chromium" }],
		},
	},
});
