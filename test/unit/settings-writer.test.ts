import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readScopeFile, writeScopeSetting } from "../../extension-src/pi-teams/pi/settings-writer.js";

async function workspace(project = ""): Promise<{ root: string; agentDir: string; projectFile: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-teams-writer-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(root, ".pi"), { recursive: true });
	const projectFile = join(root, ".pi", "teams.json");
	if (project) await writeFile(projectFile, project);
	return { root, agentDir, projectFile };
}

describe("settings writer", () => {
	it("creates a new file owner-only and leaves no temporary sibling", async () => {
		const { root, agentDir, projectFile } = await workspace();
		const result = await writeScopeSetting(
			{ configCwd: root, agentDir },
			{ scope: "project", path: ["maxConcurrent"], value: 6 },
		);
		expect(result.ok).toBe(true);
		expect((await stat(projectFile)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(projectFile, "utf8"))).toEqual({ maxConcurrent: 6 });
		expect((await readdir(join(root, ".pi"))).filter((name) => name.includes(".tmp-"))).toEqual([]);
	});

	it("refuses a file it cannot read as a JSON object", async () => {
		for (const contents of ["{oops", "[1,2]"]) {
			const { root, agentDir, projectFile } = await workspace(contents);
			const read = await readScopeFile({ configCwd: root, agentDir }, "project");
			expect(read.ok).toBe(false);
			const result = await writeScopeSetting(
				{ configCwd: root, agentDir },
				{ scope: "project", path: ["maxConcurrent"], value: 2 },
			);
			expect(result.ok).toBe(false);
			expect(await readFile(projectFile, "utf8")).toBe(contents);
		}
	});

	it("treats a missing file as an empty scope", async () => {
		const { root, agentDir } = await workspace();
		const read = await readScopeFile({ configCwd: root, agentDir }, "global");
		expect(read.ok).toBe(true);
		if (read.ok) expect(read.raw).toEqual({});
	});
});
