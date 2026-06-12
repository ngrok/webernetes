import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tailwindcss()],
	optimizeDeps: {
		exclude: ["webernetes"],
	},
	resolve: {
		alias: {
			webernetes: new URL("../src/index.ts", import.meta.url).pathname,
		},
	},
	server: {
		fs: {
			allow: [".."],
		},
		port: 5174,
	},
});
