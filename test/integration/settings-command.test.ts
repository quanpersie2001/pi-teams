import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SubagentsSettings } from "../../extension-src/pi-teams/domain/config.js";
import { SETTING_SPECS, settingKey } from "../../extension-src/pi-teams/domain/settings-schema.js";
import { loadSubagentsSettings } from "../../extension-src/pi-teams/pi/config-host.js";
import {
	applySettingChange,
	runSettingsUi,
	type SettingsCommandDeps,
	type SettingsUiPort,
} from "../../extension-src/pi-teams/pi/settings-command.js";

const spec = (key: string) => {
	const found = SETTING_SPECS.find((candidate) => settingKey(candidate) === key);
	if (!found) throw new Error(`missing spec ${key}`);
	return found;
};

interface Workspace {
	deps: SettingsCommandDeps;
	globalFile: string;
	projectFile: string;
	root: string;
}

async function workspace(files: { global?: string; project?: string } = {}): Promise<Workspace> {
	const root = await mkdtemp(join(tmpdir(), "pi-teams-settings-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(root, ".pi"), { recursive: true });
	const globalFile = join(agentDir, "teams.json");
	const projectFile = join(root, ".pi", "teams.json");
	if (files.global !== undefined) await writeFile(globalFile, files.global);
	if (files.project !== undefined) await writeFile(projectFile, files.project);
	let settings: SubagentsSettings = await loadSubagentsSettings(root, { agentDir });
	const deps: SettingsCommandDeps = {
		configCwd: root,
		agentDir,
		settings: () => settings,
		apply: async () => {
			settings = await loadSubagentsSettings(root, { agentDir });
			return settings;
		},
	};
	return { deps, globalFile, projectFile, root };
}

describe("applySettingChange", () => {
	it("patches the edited scope, keeps unknown keys and reports a live apply", async () => {
		const w = await workspace({ global: JSON.stringify({ tasks: { inlineRows: 4 }, futureKey: { kept: true } }) });
		const result = await applySettingChange(w.deps, "global", spec("tasks.inlineRows"), { kind: "value", value: 0 });
		expect(result).toMatchObject({ ok: true, type: "info" });
		expect(result.message).toContain("tasks.inlineRows set to off");
		expect(result.message).toContain("applied live");
		expect(JSON.parse(await readFile(w.globalFile, "utf8"))).toEqual({
			tasks: { inlineRows: 0 },
			futureKey: { kept: true },
		});
		expect(w.deps.settings().tasks.inlineRows).toBe(0);
	});

	it("resets a project override so the global value applies again", async () => {
		const w = await workspace({
			global: JSON.stringify({ maxConcurrent: 8 }),
			project: JSON.stringify({ maxConcurrent: 3 }),
		});
		const result = await applySettingChange(w.deps, "project", spec("maxConcurrent"), { kind: "reset" });
		expect(result.message).toContain("maxConcurrent reset to 8");
		expect(JSON.parse(await readFile(w.projectFile, "utf8"))).toEqual({});
		expect(w.deps.settings().maxConcurrent).toBe(8);
	});

	it("refuses a global-only key in a project file", async () => {
		const w = await workspace();
		const result = await applySettingChange(w.deps, "project", spec("peers.policy"), {
			kind: "value",
			value: "accept",
		});
		expect(result).toMatchObject({ ok: false, type: "error" });
		expect(result.message).toContain("only be set in the global file");
		await expect(readFile(w.projectFile, "utf8")).rejects.toThrow();
	});

	it("refuses to overwrite a file that is not valid JSON", async () => {
		const w = await workspace({ global: "{oops" });
		const result = await applySettingChange(w.deps, "global", spec("maxConcurrent"), { kind: "value", value: 6 });
		expect(result).toMatchObject({ ok: false, type: "error" });
		expect(result.message).toContain("is not valid JSON");
		expect(await readFile(w.globalFile, "utf8")).toBe("{oops");
	});

	it("preserves an existing file's mode and names keys that bind at startup", async () => {
		const w = await workspace({ global: JSON.stringify({ maxConcurrent: 6 }) });
		await chmod(w.globalFile, 0o640);
		await applySettingChange(w.deps, "global", spec("maxConcurrent"), { kind: "value", value: 7 });
		expect((await stat(w.globalFile)).mode & 0o777).toBe(0o640);
		const peers = await applySettingChange(w.deps, "global", spec("peers.enabled"), { kind: "value", value: true });
		expect(peers.message).toContain("takes effect next session");
	});
});

/** Minimal `ctx.ui` stub: records the offered options and answers from a script. */
function scriptedUi(answers: Array<string | undefined>): { ui: SettingsUiPort; offered: string[][] } {
	const offered: string[][] = [];
	let index = 0;
	const ui = {
		select: async (_title: string, options: string[]) => {
			offered.push(options);
			const answer = answers[index++];
			return answer === undefined ? undefined : options.find((option) => option.startsWith(answer));
		},
		input: async () => undefined,
		notify: () => {},
		custom: async () => undefined,
	} as unknown as SettingsUiPort;
	return { ui, offered };
}

describe("runSettingsUi", () => {
	it("offers two scopes and the effective-values view only", async () => {
		const w = await workspace();
		const { ui, offered } = scriptedUi(["Show effective values"]);
		await runSettingsUi(ui, w.deps);
		const top = offered[0] ?? [];
		expect(top).toHaveLength(3);
		expect(top.join("\n")).toContain("Global · ");
		expect(top.join("\n")).toContain("Project · ");
		expect(top.join("\n")).not.toContain("raw JSON");
		// The overview is read-only: every line of every setting is listed.
		expect(offered[1]?.join("\n")).toContain("tasks.inlineRows = 2");
	});
});
