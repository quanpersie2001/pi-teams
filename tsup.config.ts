import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		"pi-teams": "extension-src/pi-teams/pi/index.ts",
		"child-bridge": "extension-src/pi-teams/pi/child-bridge.ts",
		"headless-child": "extension-src/pi-teams/pi/headless-child.ts",
		"terminal-client": "extension-src/pi-teams/pi/terminal-client.ts",
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
