import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAgentMarkdownFiles, resolveAgentSourceDirs } from "../../extension-src/pi-subagents/pi/agent-files.js";

describe("loadAgentMarkdownFiles", () => {
	let root: string;
	let globalDir: string;
	let projectDir: string;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-subagents-agent-files-"));
		globalDir = join(root, "global");
		projectDir = join(root, "project");
		await mkdir(globalDir, { recursive: true });
		await mkdir(projectDir, { recursive: true });
		await writeFile(join(globalDir, "b-second.md"), "---\nname: b\nsource: global\n---\nGlobal body.", "utf8");
		await writeFile(join(globalDir, "a-first.md"), "---\nname: a\n---\nBody A.", "utf8");
		await writeFile(join(globalDir, "ignored.txt"), "not an agent file", "utf8");
		await writeFile(join(projectDir, "c.md"), "---\nname: c\n---\nBody C.", "utf8");
		await writeFile(join(projectDir, "broken.md"), "---\nname: [unclosed\n---\nbody", "utf8");
	});

	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("collects *.md files per directory in input order with parsed frontmatter", async () => {
		const files = await loadAgentMarkdownFiles([globalDir, projectDir]);
		const paths = files.map((file) => file.sourcePath);
		expect(paths).toEqual([
			join(globalDir, "a-first.md"),
			join(globalDir, "b-second.md"),
			join(projectDir, "broken.md"),
			join(projectDir, "c.md"),
		]);
		expect(files[0]?.frontmatter).toEqual({ name: "a" });
		expect(files[0]?.body).toBe("Body A.");
		expect(files[0]?.filenameStem).toBe("a-first");
		expect(files[3]?.frontmatter).toEqual({ name: "c" });
	});

	it("skips missing directories silently", async () => {
		const files = await loadAgentMarkdownFiles([join(root, "does-not-exist"), projectDir]);
		expect(files).toHaveLength(2);
	});

	it("records read/parse failures as RawAgentFile.error instead of throwing", async () => {
		const files = await loadAgentMarkdownFiles([projectDir]);
		const broken = files.find((file) => file.filenameStem === "broken");
		expect(broken?.error).toBeTruthy();
		expect(broken?.frontmatter).toEqual({});
		expect(broken?.body).toBe("");
		const healthy = files.find((file) => file.filenameStem === "c");
		expect(healthy?.error).toBeUndefined();
	});
});

describe("resolveAgentSourceDirs", () => {
	it("orders global < workspace < project (ascending precedence)", () => {
		expect(resolveAgentSourceDirs("/repo", "/home/.pi/agent")).toEqual([
			"/home/.pi/agent/agents",
			"/repo/.agents/agents",
			"/repo/.pi/agents",
		]);
	});
});
