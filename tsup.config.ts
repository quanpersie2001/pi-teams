import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		"pi-teams": "extension-src/pi-teams/pi/index.ts",
		"child-bridge": "extension-src/pi-teams/pi/child-bridge.ts",
		"headless-child": "extension-src/pi-teams/pi/headless-child.ts",
		"child-viewer": "extension-src/pi-teams/pi/child-viewer.ts",
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
