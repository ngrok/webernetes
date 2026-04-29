import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		passWithNoTests: true,
		testTimeout: 15_000,
		hookTimeout: 60_000,
	},
});
