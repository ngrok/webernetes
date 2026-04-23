import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		exclude: [...configDefaults.exclude, "src/**/*browser.test.ts"],
		testTimeout: 15_000,
		hookTimeout: 60_000,
	},
});
