import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		"pi-subagents": "extension-src/pi-subagents/pi/index.ts",
		"child-bridge": "extension-src/pi-subagents/pi/child-bridge.ts",
		"headless-child": "extension-src/pi-subagents/pi/headless-child.ts",
	},
	format: ["esm"],
	dts: false,
	sourcemap: true,
	clean: true,
	target: "node22",
	outDir: "dist/extensions",
	external: [
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
		"typebox",
	],
});
