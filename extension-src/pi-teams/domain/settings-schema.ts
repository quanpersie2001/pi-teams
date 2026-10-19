// Editable settings schema for the `/teams-settings` command.
//
// The runtime contract stays in config.ts (sanitizeSettings); this table only
// describes how each key is presented and which text input is acceptable, so a
// UI edit can be validated before it reaches a file. Keep the two in sync: a
// key that sanitizeSettings ignores must not be offered here.

import type { SubagentsSettings } from "./config.js";
import { MAX_MAX_CONCURRENT, MIN_MAX_CONCURRENT } from "./config.js";

/** Settings file a key may be written to. `global` keys cannot be elevated from a project file. */
export type SettingScopeRule = "both" | "global";

export type SettingGroup = "execution" | "validation" | "ui" | "tasks" | "peers" | "backend";

export const SETTING_GROUP_LABELS: Readonly<Record<SettingGroup, string>> = {
	execution: "Execution (concurrency, turns, time budgets, isolation)",
	validation: "Validation (definition files, model admission)",
	ui: "UI (Team Hub, inline panels)",
	tasks: "Tasks (inline widget, automation)",
	peers: "Peers (messaging, policy — global only)",
	backend: "Backend (launcher mode)",
};

export interface SettingChoice {
	label: string;
	value: unknown;
	/** Project files may narrow but cannot broaden; false hides the choice there. */
	projectAllowed?: boolean;
}

export interface SettingSpec {
	/** Nested key path inside teams.json, e.g. ["tasks", "inlineRows"]. */
	readonly path: readonly string[];
	readonly group: SettingGroup;
	readonly label: string;
	readonly kind: "boolean" | "integer" | "seconds" | "text" | "choice";
	readonly scope: SettingScopeRule;
	/** Takes effect for new children/sessions, not the running one. */
	readonly restart?: boolean;
	readonly min?: number;
	readonly max?: number;
	readonly choices?: readonly SettingChoice[];
}

const bool = (on: string, off: string): readonly SettingChoice[] => [
	{ label: on, value: true },
	{ label: off, value: false },
];

/** Every editable key, in menu order. */
export const SETTING_SPECS: readonly SettingSpec[] = [
	{
		path: ["maxConcurrent"],
		group: "execution",
		label: "Shared run capacity (foreground + background)",
		kind: "integer",
		scope: "both",
		min: MIN_MAX_CONCURRENT,
		max: MAX_MAX_CONCURRENT,
	},
	{
		path: ["defaultMaxTurns"],
		group: "execution",
		label: "Default turn limit (0 = unlimited)",
		kind: "integer",
		scope: "both",
		min: 0,
	},
	{
		path: ["defaultTimeout"],
		group: "execution",
		label: "Default wall-clock budget in seconds (0 = unlimited)",
		kind: "seconds",
		scope: "both",
	},
	{
		path: ["defaultIdleTimeout"],
		group: "execution",
		label: "Default idle budget in seconds (0 = unlimited)",
		kind: "seconds",
		scope: "both",
	},
	{
		path: ["graceTurns"],
		group: "execution",
		label: "Wrap-up turns after turn-limit steering",
		kind: "integer",
		scope: "both",
		min: 0,
	},
	{
		path: ["backgroundByDefault"],
		group: "execution",
		label: "Run in background when the definition omits the mode",
		kind: "boolean",
		scope: "both",
		choices: bool("background", "foreground"),
	},
	{
		path: ["worktreeIsolation"],
		group: "execution",
		label: "Allow definitions to request worktree isolation",
		kind: "boolean",
		scope: "both",
		choices: bool("enabled", "disabled"),
	},
	{
		path: ["rememberAgents"],
		group: "execution",
		label: "Retain settled teammate history for continuation",
		kind: "boolean",
		scope: "both",
		choices: bool("retain", "drop"),
	},
	{
		path: ["strictAgentFiles"],
		group: "validation",
		label: "Fail on malformed agent definition files",
		kind: "boolean",
		scope: "both",
		choices: bool("strict", "lenient"),
	},
	{
		path: ["strictModelAdmission"],
		group: "validation",
		label: "Require uniquely registered invocation models",
		kind: "boolean",
		scope: "both",
		choices: bool("strict", "relaxed"),
	},
	{
		path: ["fallbackSubagent"],
		group: "validation",
		label: "Specialist for unknown/disabled requests (`none` rejects)",
		kind: "text",
		scope: "both",
	},
	{
		path: ["agentPanel"],
		group: "ui",
		label: "Team Hub and agent UI",
		kind: "boolean",
		scope: "both",
		choices: bool("on", "off"),
	},
	{
		path: ["agentInlinePanel"],
		group: "ui",
		label: "Inline Agents panel default",
		kind: "boolean",
		scope: "both",
		choices: bool("on", "off"),
	},
	{
		path: ["tasks", "inlineRows"],
		group: "tasks",
		label: "Inline Tasks widget rows",
		kind: "choice",
		scope: "both",
		choices: [
			{ label: "off", value: 0 },
			{ label: "2 rows", value: 2 },
			{ label: "4 rows", value: 4 },
			{ label: "6 rows", value: 6 },
		],
	},
	{
		path: ["tasks", "autoCascade"],
		group: "tasks",
		label: "Launch planned dependents when a task completes",
		kind: "boolean",
		scope: "both",
		restart: true,
		choices: bool("on", "off"),
	},
	{
		path: ["tasks", "reminders"],
		group: "tasks",
		label: "Periodic task summaries in lead context",
		kind: "boolean",
		scope: "both",
		choices: bool("on", "off"),
	},
	{
		path: ["peers", "enabled"],
		group: "peers",
		label: "Peer messaging",
		kind: "boolean",
		scope: "both",
		restart: true,
		choices: bool("on", "off"),
	},
	{
		path: ["peers", "scope"],
		group: "peers",
		label: "Peer discovery scope",
		kind: "choice",
		scope: "both",
		restart: true,
		choices: [
			{ label: "project", value: "project" },
			{ label: "all", value: "all", projectAllowed: false },
		],
	},
	{
		path: ["peers", "policy"],
		group: "peers",
		label: "Receiver approval policy",
		kind: "choice",
		scope: "global",
		restart: true,
		choices: [
			{ label: "hold (approve each message)", value: "hold" },
			{ label: "accept", value: "accept" },
			{ label: "refuse", value: "refuse" },
		],
	},
	{
		path: ["backend"],
		group: "backend",
		label: "Launcher mode for new children",
		kind: "choice",
		scope: "both",
		restart: true,
		choices: [
			{ label: "auto (herdr → tmux → headless)", value: "auto" },
			{ label: "headless", value: "headless" },
		],
	},
];

/** Dotted key shown in the UI, e.g. `tasks.inlineRows`. */
export function settingKey(spec: SettingSpec): string {
	return spec.path.join(".");
}

/** Effective value for one spec; undefined means "not present". */
export function settingValue(settings: Readonly<SubagentsSettings>, spec: SettingSpec): unknown {
	let cursor: unknown = settings;
	for (const segment of spec.path) {
		if (typeof cursor !== "object" || cursor === null) return undefined;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor;
}

/** Value from a raw (unsanitized) settings file object, for origin reporting. */
export function rawSettingValue(raw: unknown, path: readonly string[]): { present: boolean; value: unknown } {
	let cursor: unknown = raw;
	for (const segment of path) {
		if (typeof cursor !== "object" || cursor === null || !Object.hasOwn(cursor, segment))
			return { present: false, value: undefined };
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return { present: true, value: cursor };
}

/** Human-readable rendering used in menus (`off` for the widget ladder's 0). */
export function formatSettingValue(spec: SettingSpec, value: unknown): string {
	if (spec.kind === "choice") {
		const match = spec.choices?.find((choice) => choice.value === value);
		return match ? match.label : String(value);
	}
	if (typeof value === "boolean") return value ? "on" : "off";
	return String(value);
}

export type SettingParseResult = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * Validate typed text for the open-ended kinds. Choices never reach here: the
 * caller writes the selected choice value directly.
 */
export function parseSettingText(spec: SettingSpec, text: string): SettingParseResult {
	const trimmed = text.trim();
	if (spec.kind === "text") {
		return trimmed.length > 0 ? { ok: true, value: trimmed } : { ok: false, reason: "value must not be empty" };
	}
	if (spec.kind === "choice") return { ok: false, reason: "pick one of the listed choices" };
	if (spec.kind === "boolean") return { ok: false, reason: "pick one of the listed choices" };
	if (!/^\d+$/.test(trimmed)) {
		return { ok: false, reason: "expected a whole number (digits only)" };
	}
	const value = Number.parseInt(trimmed, 10);
	if (spec.kind === "seconds") return { ok: true, value };
	if (spec.min !== undefined && value < spec.min) return { ok: false, reason: `must be >= ${spec.min}` };
	if (spec.max !== undefined && value > spec.max) return { ok: false, reason: `must be <= ${spec.max}` };
	return { ok: true, value };
}

/** Choices valid in a project file (narrowing only). */
export function projectChoices(spec: SettingSpec): readonly SettingChoice[] {
	if (spec.scope === "global") return [];
	return (spec.choices ?? []).filter((choice) => choice.projectAllowed !== false);
}
