import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("loads child and native UI from an isolated Pi package without installing host peers", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-teams-package-"));
	try {
		const dist = join(root, "dist/extensions");
		cpSync(join(process.cwd(), "dist/extensions"), dist, { recursive: true });
		const native = readdirSync(dist).find((file) => /^native-runtime-extension-.*\.js$/.test(file));
		if (!native) throw new Error("Native runtime chunk was not built");
		const hostEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const script = `await import(${JSON.stringify(join(dist, native))}); await import(${JSON.stringify(join(dist, "headless-child.js"))});`;
		const args = ["--import", join(dist, "child-module-loader.js"), "--input-type=module", "-e", script];
		const result = spawnSync(process.execPath, args, {
			env: { ...process.env, PI_TEAMS_HOST_MODULE: hostEntry },
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
