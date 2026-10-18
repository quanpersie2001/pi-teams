import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

let cwd: string | undefined;
afterEach(async () => {
	if (cwd) await rm(cwd, { recursive: true, force: true });
	cwd = undefined;
});

describe("installed Pi extension loader", () => {
	it("loads the production extension entry and registers its real commands and tools", async () => {
		const oldChildFlag = process.env.PI_TEAMS_CHILD;
		delete process.env.PI_TEAMS_CHILD;
		cwd = await mkdtemp(join(tmpdir(), "teams-loader-"));
		try {
			const loaderPath = resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
			const { loadExtensions } = await import(pathToFileURL(loaderPath).href);
			const loaded = await loadExtensions([resolve("extension-src/pi-teams/pi/index.ts")], cwd);
			expect(loaded.extensions).toHaveLength(1);
			const extension = loaded.extensions[0];
			expect(extension?.commands.has("peer-inbox")).toBe(true);
			expect(extension?.tools.has("peer_send")).toBe(true);
			expect(extension?.tools.has("peer_sessions")).toBe(true);
			expect(extension?.tools.has("teammate_shutdown")).toBe(true);
			expect(loaded.errors).toEqual([]);
		} finally {
			if (oldChildFlag === undefined) delete process.env.PI_TEAMS_CHILD;
			else process.env.PI_TEAMS_CHILD = oldChildFlag;
		}
	});
});
