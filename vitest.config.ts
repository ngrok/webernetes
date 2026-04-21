import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		testTimeout: 15_000,
		hookTimeout: 60_000,
	},
});
