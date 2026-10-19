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

/** One answer per dialog: a value, or a function of the offered options. */
type Answer = string | undefined | ((options: string[]) => string | undefined);

interface Workspace {
	ui: SettingsUiPort;
	deps: SettingsCommandDeps;
	globalFile: string;
	projectFile: string;
	/** Options offered by each `select` call, in order. */
	offered: string[][];
	inputs: string[];
	notifications: Array<{ message: string; type?: "info" | "warning" | "error" }>;
}

async function workspace(
	files: { global?: string; project?: string } = {},
	answers: Answer[] = [],
): Promise<Workspace> {
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
	const offered: string[][] = [];
	const inputs: string[] = [];
	const notifications: Workspace["notifications"] = [];
	let index = 0;
	const next = (options?: string[]): string | undefined => {
		const answer = answers[index++];
		return typeof answer === "function" ? answer(options ?? []) : answer;
	};
	const ui = {
		select: async (_title: string, options: string[]) => {
			offered.push(options);
			return next(options);
		},
		input: async (title: string) => {
			inputs.push(title);
			return next();
		},
		notify: (message: string, type?: "info" | "warning" | "error") => {
			notifications.push({ message, ...(type === undefined ? {} : { type }) });
		},
	} as unknown as SettingsUiPort;
	return { ui, deps, globalFile, projectFile, offered, inputs, notifications };
}

const pick = (predicate: (option: string) => boolean) => (offered: string[]) => offered.find(predicate);
const BACK = pick((option) => option.startsWith("← Back"));
const EXIT = undefined;

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

describe("/teams-settings dialogs", () => {
	it("offers two scopes and the read-only overview, and no raw-JSON editor", async () => {
		const w = await workspace({}, ["Show effective values"]);
		await runSettingsUi(w.ui, w.deps);
		const top = w.offered[0] ?? [];
		expect(top).toHaveLength(3);
		expect(top.join("\n")).toContain("Global · ");
		expect(top.join("\n")).toContain("Project · ");
		expect(top.join("\n")).not.toContain("raw JSON");
		expect(w.offered[1]?.join("\n")).toContain("tasks.inlineRows = 2");
	});

	it("writes the picked value through the value dialog and applies it live", async () => {
		const w = await workspace({ global: JSON.stringify({ tasks: { inlineRows: 4, reminders: true } }) }, [
			pick((option) => option.startsWith("Global")),
			pick((option) => option.startsWith("Tasks")),
			pick((option) => option.includes("tasks.inlineRows")),
			pick((option) => option === "off"),
			BACK,
			BACK,
			EXIT,
		]);
		await runSettingsUi(w.ui, w.deps);
		expect(JSON.parse(await readFile(w.globalFile, "utf8"))).toEqual({ tasks: { inlineRows: 0, reminders: true } });
		expect(w.deps.settings().tasks.inlineRows).toBe(0);
		expect(w.notifications.at(-1)?.message).toContain("tasks.inlineRows set to off");
		expect(w.notifications.at(-1)?.message).toContain("applied live");
	});

	it("resets a project override through an empty input so the global value applies", async () => {
		const w = await workspace(
			{ global: JSON.stringify({ maxConcurrent: 8 }), project: JSON.stringify({ maxConcurrent: 3 }) },
			[
				pick((option) => option.startsWith("Project")),
				pick((option) => option.startsWith("Execution")),
				pick((option) => option.includes("maxConcurrent = 3")),
				"",
				BACK,
				BACK,
				EXIT,
			],
		);
		await runSettingsUi(w.ui, w.deps);
		expect(JSON.parse(await readFile(w.projectFile, "utf8"))).toEqual({});
		expect(w.deps.settings().maxConcurrent).toBe(8);
		expect(w.notifications.at(-1)?.message).toContain("maxConcurrent reset to 8");
	});

	it("hides global-only keys from the project menus", async () => {
		const w = await workspace({}, [
			pick((option) => option.startsWith("Project")),
			pick((option) => option.startsWith("Peers")),
			BACK,
			BACK,
			EXIT,
		]);
		await runSettingsUi(w.ui, w.deps);
		const offered = w.offered.flat().join("\n");
		expect(offered).toContain("peers.enabled");
		expect(offered).not.toContain("peers.policy");
	});

	it("rejects an out-of-range value without touching the file", async () => {
		const w = await workspace({ global: JSON.stringify({ maxConcurrent: 6 }) }, [
			pick((option) => option.startsWith("Global")),
			pick((option) => option.startsWith("Execution")),
			pick((option) => option.includes("maxConcurrent")),
			"5000",
			BACK,
			BACK,
			EXIT,
		]);
		await runSettingsUi(w.ui, w.deps);
		expect(await readFile(w.globalFile, "utf8")).toBe(JSON.stringify({ maxConcurrent: 6 }));
		expect(w.notifications.at(-1)).toMatchObject({ type: "error", message: "maxConcurrent: must be <= 1024" });
	});
});
