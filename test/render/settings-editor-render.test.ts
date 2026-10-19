// Settings editor: width discipline, key mapping and the ←/→ value ladder.

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { INLINE_TASK_ROW_CHOICES, sanitizeSettings } from "../../extension-src/pi-teams/domain/config.js";
import {
	SETTING_SPECS,
	settingKey,
	settingValue,
	stepSettingValue,
} from "../../extension-src/pi-teams/domain/settings-schema.js";
import {
	renderSettingsEditor,
	type SettingsEditorData,
	settingsEditorHeight,
	settingsEditorKey,
} from "../../extension-src/pi-teams/features/settings-editor/index.js";
import { renderTheme } from "../helpers/render-theme.js";

const fg = renderTheme().fg.bind(renderTheme());

const spec = (key: string) => {
	const found = SETTING_SPECS.find((candidate) => settingKey(candidate) === key);
	if (!found) throw new Error(`missing spec ${key}`);
	return found;
};

function data(): SettingsEditorData {
	const settings = sanitizeSettings({});
	return {
		title: "Global · Execution",
		items: [
			{
				key: "maxConcurrent",
				label: "Shared run capacity",
				spec: spec("maxConcurrent"),
				value: "4",
				origin: "default",
				overridden: false,
				restart: false,
			},
			{
				key: "backgroundByDefault",
				label: "Background by default",
				spec: spec("backgroundByDefault"),
				value: String(settingValue(settings, spec("backgroundByDefault"))),
				origin: "project",
				overridden: true,
				restart: false,
			},
			{
				key: "fallbackSubagent",
				label: "Fallback specialist",
				spec: spec("fallbackSubagent"),
				value: "none",
				origin: "global",
				overridden: false,
				restart: true,
			},
		],
	};
}

describe("settings editor rendering", () => {
	it("respects the viewport at every width and stays inside its height", () => {
		for (const [width, height] of [
			[200, 24],
			[80, 12],
			[40, 6],
			[8, 3],
		] as const) {
			const lines = renderSettingsEditor(data(), 0, fg, width, height);
			expect(lines).toHaveLength(height);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		// Below a usable size nothing is drawn; the host then removes the editor.
		expect(renderSettingsEditor(data(), 0, fg, 4, 2)).toEqual([]);
	});

	it("sizes itself to its rows instead of filling the terminal", () => {
		// Title + rows + hints + selected label + bottom rule.
		expect(settingsEditorHeight(8, 40)).toBe(12);
		expect(settingsEditorHeight(0, 40)).toBe(4);
		// Never taller than the terminal, never unusably short.
		expect(settingsEditorHeight(60, 20)).toBe(20);
		expect(settingsEditorHeight(1, 1)).toBe(3);
		// The compact height leaves no filler rows.
		const lines = renderSettingsEditor(data(), 0, fg, 80, settingsEditorHeight(data().items.length, 40));
		expect(lines).toHaveLength(7);
		expect(lines.slice(4, -2).every((line) => visibleWidth(line) > 0)).toBe(true);
	});

	it("marks the selected row, its origin and the footer hints", () => {
		const lines = stripTerminalSequences(renderSettingsEditor(data(), 1, fg, 100, 10).join("\n"));
		expect(lines).toContain("Global · Execution");
		expect(lines).toContain("› backgroundByDefault");
		expect(lines).toContain("project");
		expect(lines).toContain("next session");
		expect(lines).toContain("←→ change");
		expect(lines).toContain("enter set");
		// The selected row's own label replaces the hint line's detail slot.
		expect(lines).toContain("Background by default");
	});

	it("maps arrows, reset and back, and ignores every other key", () => {
		expect(settingsEditorKey("\u001b[A")).toBe("up");
		expect(settingsEditorKey("\u001b[B")).toBe("down");
		expect(settingsEditorKey("\u001b[D")).toBe("stepLeft");
		expect(settingsEditorKey("\u001b[C")).toBe("stepRight");
		expect(settingsEditorKey("\r")).toBe("edit");
		expect(settingsEditorKey("r")).toBe("reset");
		expect(settingsEditorKey("\u001b")).toBe("back");
		expect(settingsEditorKey("x")).toBeUndefined();
	});
});

describe("stepSettingValue", () => {
	const defaults = { overridden: false, projectScope: false };

	it("cycles a boolean ladder and wraps", () => {
		expect(stepSettingValue(spec("backgroundByDefault"), true, defaults, 1)).toEqual({ kind: "value", value: false });
		expect(stepSettingValue(spec("backgroundByDefault"), false, defaults, 1)).toEqual({ kind: "value", value: true });
		expect(stepSettingValue(spec("backgroundByDefault"), false, defaults, -1)).toEqual({ kind: "value", value: true });
	});

	it("includes the reset state only when the edited scope holds an override", () => {
		const inline = spec("tasks.inlineRows");
		expect(stepSettingValue(inline, 6, defaults, 1)).toEqual({ kind: "value", value: 0 });
		expect(stepSettingValue(inline, 6, { ...defaults, overridden: true }, 1)).toEqual({ kind: "reset" });
		// Mid-ladder steps still move through values.
		expect(stepSettingValue(inline, 4, { ...defaults, overridden: true }, 1)).toEqual({ kind: "value", value: 6 });
		// Every ladder value is reachable from the default.
		for (const value of INLINE_TASK_ROW_CHOICES) {
			expect(stepSettingValue(inline, value, defaults, 1)).toBeDefined();
		}
	});

	it("never offers a scope-broadening choice to a project row", () => {
		const scope = spec("peers.scope");
		// project → all would broaden; only "project" remains, so the step stays put.
		expect(stepSettingValue(scope, "project", { overridden: false, projectScope: true }, 1)).toEqual({
			kind: "value",
			value: "project",
		});
		expect(stepSettingValue(scope, "project", defaults, 1)).toEqual({ kind: "value", value: "all" });
	});

	it("steps numbers by one inside the sanitizer bounds", () => {
		const capacity = spec("maxConcurrent");
		expect(stepSettingValue(capacity, 4, defaults, 1)).toEqual({ kind: "value", value: 5 });
		expect(stepSettingValue(capacity, 4, defaults, -1)).toEqual({ kind: "value", value: 3 });
		expect(stepSettingValue(capacity, 1, defaults, -1)).toEqual({ kind: "value", value: 1 });
		expect(stepSettingValue(capacity, 1024, defaults, 1)).toEqual({ kind: "value", value: 1024 });
		expect(stepSettingValue(spec("defaultMaxTurns"), 0, defaults, -1)).toEqual({ kind: "value", value: 0 });
	});
});
