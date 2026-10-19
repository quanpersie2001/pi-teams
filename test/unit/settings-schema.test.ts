import { describe, expect, it } from "vitest";
import { DEFAULT_SUBAGENTS_SETTINGS, sanitizeSettings } from "../../extension-src/pi-teams/domain/config.js";
import {
	formatSettingValue,
	parseSettingText,
	projectChoices,
	SETTING_SPECS,
	settingKey,
	settingValue,
} from "../../extension-src/pi-teams/domain/settings-schema.js";
import { patchSetting, removeSetting } from "../../extension-src/pi-teams/domain/settings-write.js";

const spec = (key: string) => {
	const found = SETTING_SPECS.find((candidate) => settingKey(candidate) === key);
	if (!found) throw new Error(`missing spec ${key}`);
	return found;
};

describe("settings schema", () => {
	it("covers every sanitized key and nothing else", () => {
		const sanitizedKeys = Object.keys(DEFAULT_SUBAGENTS_SETTINGS).flatMap((key) => {
			const value = (DEFAULT_SUBAGENTS_SETTINGS as unknown as Record<string, unknown>)[key];
			return typeof value === "object" && value !== null
				? Object.keys(value as Record<string, unknown>).map((child) => `${key}.${child}`)
				: [key];
		});
		expect(SETTING_SPECS.map(settingKey).sort()).toEqual(sanitizedKeys.sort());
	});

	it("validates integer input against the sanitizer's bounds", () => {
		expect(parseSettingText(spec("maxConcurrent"), "8")).toEqual({ ok: true, value: 8 });
		expect(parseSettingText(spec("maxConcurrent"), " 12 ")).toEqual({ ok: true, value: 12 });
		expect(parseSettingText(spec("maxConcurrent"), "1.5")).toEqual({
			ok: false,
			reason: "expected a whole number (digits only)",
		});
		expect(parseSettingText(spec("maxConcurrent"), "0")).toEqual({ ok: false, reason: "must be >= 1" });
		expect(parseSettingText(spec("maxConcurrent"), "2048")).toEqual({ ok: false, reason: "must be <= 1024" });
		expect(parseSettingText(spec("defaultMaxTurns"), "0")).toEqual({ ok: true, value: 0 });
	});

	it("treats budgets as whole seconds and text as non-empty", () => {
		expect(parseSettingText(spec("defaultTimeout"), "600")).toEqual({ ok: true, value: 600 });
		expect(parseSettingText(spec("defaultTimeout"), "-30")).toEqual({
			ok: false,
			reason: "expected a whole number (digits only)",
		});
		expect(parseSettingText(spec("fallbackSubagent"), " general-purpose ")).toEqual({
			ok: true,
			value: "general-purpose",
		});
		expect(parseSettingText(spec("fallbackSubagent"), "   ")).toEqual({ ok: false, reason: "value must not be empty" });
		expect(parseSettingText(spec("tasks.inlineRows"), "4")).toEqual({
			ok: false,
			reason: "pick one of the listed choices",
		});
	});

	it("never offers a scope-broadening choice to a project file", () => {
		expect(projectChoices(spec("peers.scope")).map((choice) => choice.value)).toEqual(["project"]);
		// peers.policy is global-only: no choice survives and the key is filtered out of project menus.
		expect(projectChoices(spec("peers.policy"))).toEqual([]);
		expect(spec("peers.policy").scope).toBe("global");
	});

	it("renders the widget ladder readably and reads the effective value", () => {
		const settings = sanitizeSettings({ tasks: { inlineRows: 0 } });
		expect(formatSettingValue(spec("tasks.inlineRows"), settingValue(settings, spec("tasks.inlineRows")))).toBe("off");
		expect(formatSettingValue(spec("backend"), settings.backend)).toBe("auto (herdr → tmux → headless)");
		expect(settingValue(settings, spec("defaultMaxTurns"))).toBe(30);
	});
});

describe("raw settings patching", () => {
	const raw = {
		maxConcurrent: 6,
		tasks: { inlineRows: 4, autoCascade: true },
		futureKey: { nested: ["kept"] },
	};

	it("sets a nested key while preserving unknown keys and siblings", () => {
		const next = patchSetting(raw, ["tasks", "inlineRows"], 2);
		expect(next).toEqual({
			maxConcurrent: 6,
			tasks: { inlineRows: 2, autoCascade: true },
			futureKey: { nested: ["kept"] },
		});
		// The input object is untouched.
		expect(raw.tasks.inlineRows).toBe(4);
	});

	it("creates missing containers and replaces non-object values", () => {
		expect(patchSetting({}, ["peers", "enabled"], true)).toEqual({ peers: { enabled: true } });
		expect(patchSetting({ peers: "oops" }, ["peers", "enabled"], true)).toEqual({ peers: { enabled: true } });
		expect(patchSetting({ backend: "auto" }, ["backend"], "headless")).toEqual({ backend: "headless" });
	});

	it("removes a key and prunes only containers the removal emptied", () => {
		expect(removeSetting(raw, ["tasks", "inlineRows"])).toEqual({
			maxConcurrent: 6,
			tasks: { autoCascade: true },
			futureKey: { nested: ["kept"] },
		});
		const soleKey = removeSetting({ tasks: { inlineRows: 0 } }, ["tasks", "inlineRows"]);
		expect(soleKey).toEqual({});
		// An explicitly empty sibling container survives untouched.
		expect(removeSetting({ tasks: {}, peers: { enabled: true } }, ["peers", "enabled"])).toEqual({ tasks: {} });
	});
});
