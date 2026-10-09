import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("loads child and native UI from an isolated Pi package without installing host peers", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-teams-package-"));
	try {
		const dist = join(root, "dist/extensions");
		cpSync(join(process.cwd(), "dist/extensions"), dist, { recursive: true });
		const native = readdirSync(dist).find((file) => /^native-runtime-extension-.*\.js$/.test(file));
		if (!native) throw new Error("Native runtime chunk was not built");
		const hostEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const script = `await import(${JSON.stringify(pathToFileURL(join(dist, native)).href)}); await import(${JSON.stringify(pathToFileURL(join(dist, "headless-child.js")).href)});`;
		const loaderURL = pathToFileURL(join(dist, "child-module-loader.js")).href;
		const args = ["--import", loaderURL, "--input-type=module", "-e", script];
		const result = spawnSync(process.execPath, args, {
			env: { ...process.env, PI_TEAMS_HOST_MODULE: hostEntry },
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		const viewer = spawnSync(process.execPath, ["--import", loaderURL, join(dist, "terminal-client.js")], {
			env: { ...process.env, PI_TEAMS_HOST_MODULE: hostEntry, PI_TEAMS_TERMINAL_BOOTSTRAP: "" },
			encoding: "utf8",
		});
		expect(viewer.status).toBe(1);
		expect(viewer.stderr).toContain("PI_TEAMS_TERMINAL_BOOTSTRAP is required");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
