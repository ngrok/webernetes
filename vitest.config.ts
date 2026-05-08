import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		passWithNoTests: true,
		testTimeout: 20_000,
		hookTimeout: 40_000,
	},
});
