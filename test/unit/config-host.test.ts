import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SUBAGENTS_SETTINGS, MIN_MAX_CONCURRENT } from "../../extension-src/pi-subagents/domain/config.js";
import {
	loadSubagentsSettings,
	mergeSettings,
	resolveSettingsPaths,
} from "../../extension-src/pi-subagents/pi/config-host.js";

let root: string | undefined;

afterEach(async () => {
	if (root) {
		await rm(root, { recursive: true, force: true });
		root = undefined;
	}
});

async function makeRoot(): Promise<string> {
	root = await mkdtemp(join(tmpdir(), "pi-subagents-config-"));
	return root;
}

describe("mergeSettings", () => {
	it("lets project keys override global keys per-key", () => {
		expect(
			mergeSettings(
				{ maxConcurrent: 4, backgroundByDefault: true, agentPanel: true },
				{ maxConcurrent: 9, agentPanel: false },
			),
		).toEqual({ maxConcurrent: 9, backgroundByDefault: true, agentPanel: false });
	});

	it("keeps global keys not overridden by a partial project file", () => {
		expect(mergeSettings({ maxConcurrent: 4, graceTurns: 3 }, { maxConcurrent: 6 })).toEqual({
			maxConcurrent: 6,
			graceTurns: 3,
		});
	});

	it("treats non-object input as empty on either level", () => {
		expect(mergeSettings(undefined, null)).toEqual({});
		expect(mergeSettings("nope", undefined)).toEqual({});
		expect(mergeSettings(null, { maxConcurrent: 2 })).toEqual({ maxConcurrent: 2 });
		expect(mergeSettings({ maxConcurrent: 2 }, 42)).toEqual({ maxConcurrent: 2 });
	});
});

describe("resolveSettingsPaths", () => {
	it("maps global under the agent dir and project under configCwd/.pi", () => {
		const paths = resolveSettingsPaths("/proj", "/agentdir");
		expect(paths.global).toBe(join("/agentdir", "subagents.json"));
		expect(paths.project).toBe(join("/proj", ".pi", "subagents.json"));
	});
});

describe("loadSubagentsSettings", () => {
	it("returns all defaults when both files are missing, without warning", async () => {
		const rootDir = await makeRoot();
		const warnings: string[] = [];
		const settings = await loadSubagentsSettings(rootDir, {
			agentDir: join(rootDir, "agent"),
			warn: (m) => warnings.push(m),
		});
		expect(settings).toEqual({ ...DEFAULT_SUBAGENTS_SETTINGS });
		expect(warnings).toEqual([]);
	});

	it("applies global settings when only the global file exists", async () => {
		const rootDir = await makeRoot();
		const agentDir = join(rootDir, "agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "subagents.json"), JSON.stringify({ maxConcurrent: 12 }));
		const settings = await loadSubagentsSettings(rootDir, { agentDir });
		expect(settings.maxConcurrent).toBe(12);
		expect(settings.backgroundByDefault).toBe(true); // untouched default
	});

	it("applies a project-only file", async () => {
		const rootDir = await makeRoot();
		await mkdir(join(rootDir, ".pi"), { recursive: true });
		await writeFile(join(rootDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 7 }));
		const settings = await loadSubagentsSettings(rootDir, { agentDir: join(rootDir, "agent") });
		expect(settings.maxConcurrent).toBe(7);
	});

	it("lets project override global per key", async () => {
		const rootDir = await makeRoot();
		const agentDir = join(rootDir, "agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "subagents.json"), JSON.stringify({ maxConcurrent: 4, graceTurns: 9 }));
		await mkdir(join(rootDir, ".pi"), { recursive: true });
		await writeFile(join(rootDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 6 }));
		const settings = await loadSubagentsSettings(rootDir, { agentDir });
		expect(settings.maxConcurrent).toBe(6); // project wins
		expect(settings.graceTurns).toBe(9); // global untouched key survives
	});

	it("warns once and uses the project level when the global file is corrupt", async () => {
		const rootDir = await makeRoot();
		const agentDir = join(rootDir, "agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "subagents.json"), "not json{{{");
		await mkdir(join(rootDir, ".pi"), { recursive: true });
		await writeFile(join(rootDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 3 }));
		const warnings: string[] = [];
		const settings = await loadSubagentsSettings(rootDir, { agentDir, warn: (m) => warnings.push(m) });
		expect(settings.maxConcurrent).toBe(3);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("corrupt");
	});

	it("warns once and uses the global level when the project file is corrupt", async () => {
		const rootDir = await makeRoot();
		const agentDir = join(rootDir, "agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "subagents.json"), JSON.stringify({ maxConcurrent: 5 }));
		await mkdir(join(rootDir, ".pi"), { recursive: true });
		await writeFile(join(rootDir, ".pi", "subagents.json"), "oops");
		const warnings: string[] = [];
		const settings = await loadSubagentsSettings(rootDir, { agentDir, warn: (m) => warnings.push(m) });
		expect(settings.maxConcurrent).toBe(5);
		expect(warnings).toHaveLength(1);
	});

	it("warns twice and falls back to defaults when both files are corrupt", async () => {
		const rootDir = await makeRoot();
		const agentDir = join(rootDir, "agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "subagents.json"), "[");
		await mkdir(join(rootDir, ".pi"), { recursive: true });
		await writeFile(join(rootDir, ".pi", "subagents.json"), "{ bad");
		const warnings: string[] = [];
		const settings = await loadSubagentsSettings(rootDir, { agentDir, warn: (m) => warnings.push(m) });
		expect(settings).toEqual({ ...DEFAULT_SUBAGENTS_SETTINGS });
		expect(warnings).toHaveLength(2);
	});

	it("treats an empty file as corrupt (warn + no keys) but an empty object as valid", async () => {
		const rootDir = await makeRoot();
		const agentDir = join(rootDir, "agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "subagents.json"), "");
		const warnings: string[] = [];
		const empty = await loadSubagentsSettings(rootDir, { agentDir, warn: (m) => warnings.push(m) });
		expect(empty).toEqual({ ...DEFAULT_SUBAGENTS_SETTINGS });
		expect(warnings).toHaveLength(1);

		await writeFile(join(agentDir, "subagents.json"), "{}");
		const warnings2: string[] = [];
		const emptyObj = await loadSubagentsSettings(rootDir, { agentDir, warn: (m) => warnings2.push(m) });
		expect(emptyObj).toEqual({ ...DEFAULT_SUBAGENTS_SETTINGS });
		expect(warnings2).toEqual([]);
	});

	it("never throws on unreadable (missing) files", async () => {
		const rootDir = await makeRoot();
		// No files written at all — must resolve to defaults.
		await expect(loadSubagentsSettings(rootDir, { agentDir: join(rootDir, "agent") })).resolves.toEqual({
			...DEFAULT_SUBAGENTS_SETTINGS,
		});
	});

	it("applies sanitize bounds end-to-end (clamp + invalid fallback)", async () => {
		const rootDir = await makeRoot();
		const agentDir = join(rootDir, "agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "subagents.json"), JSON.stringify({ maxConcurrent: 0, fallbackSubagent: "   " }));
		const settings = await loadSubagentsSettings(rootDir, { agentDir });
		expect(settings.maxConcurrent).toBe(MIN_MAX_CONCURRENT);
		expect(settings.fallbackSubagent).toBe("none");
	});
});
