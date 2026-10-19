// /teams-settings — edit pi-teams operational settings without leaving the TUI.
//
// Pi exposes no settings registry to extensions (its `/settings` and `pi config`
// own Pi's own keys), so this command is the extension's own editor. It is
// deliberately built from stock dialogs — scope, group, key, value — so there is
// no custom key handling to maintain and the flow works in every UI-capable
// host mode. ↑↓/Enter inside a dialog choose; there is no in-place editing.
//
// Every edit is validated by the domain schema before it reaches a file, and
// the file is patched in place (unknown keys survive) by settings-writer.

import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { SubagentsSettings } from "../domain/config.js";
import {
	formatSettingValue,
	parseSettingText,
	projectChoices,
	rawSettingValue,
	SETTING_GROUP_LABELS,
	SETTING_SPECS,
	type SettingGroup,
	type SettingSpec,
	settingKey,
	settingValue,
} from "../domain/settings-schema.js";
import {
	readScopeFile,
	type SettingsScope,
	type SettingsWriterOptions,
	settingsWriterPaths,
	writeScopeSetting,
} from "./settings-writer.js";

/** The subset of `ctx.ui` this flow needs; tests stub it directly. */
export interface SettingsUiPort {
	select: ExtensionUIContext["select"];
	input: ExtensionUIContext["input"];
	notify: ExtensionUIContext["notify"];
}

export interface SettingsCommandDeps extends SettingsWriterOptions {
	/** Current effective settings (already sanitized). */
	settings: () => Readonly<SubagentsSettings>;
	/** Re-read the files, apply what can be applied live, and return the result. */
	apply: () => Promise<Readonly<SubagentsSettings>>;
}

/** A change the flow asks for: a new explicit value, or a reset (key removal). */
export type SettingChange = { kind: "value"; value: unknown } | { kind: "reset" };

export interface SettingChangeResult {
	ok: boolean;
	message: string;
	type: "info" | "error";
}

const BACK = "← Back";
const RESET = "reset to default (remove the key)";
const SCOPES: readonly SettingsScope[] = ["global", "project"];

function scopeLabel(scope: SettingsScope): string {
	return scope === "global" ? "Global" : "Project";
}

interface Origins {
	global: unknown;
	project: unknown;
	problem?: string;
}

async function loadOrigins(deps: SettingsWriterOptions): Promise<Origins> {
	const [global, project] = await Promise.all([readScopeFile(deps, "global"), readScopeFile(deps, "project")]);
	const problem = [global, project].flatMap((file) => (file.ok ? [] : [file.reason]))[0];
	return {
		global: global.ok ? global.raw : {},
		project: project.ok ? project.raw : {},
		...(problem === undefined ? {} : { problem }),
	};
}

/** Which level supplies the effective value: project > global > built-in default. */
function settingOrigin(spec: SettingSpec, origins: Origins): "project" | "global" | "default" {
	if (spec.scope !== "global" && rawSettingValue(origins.project, spec.path).present) return "project";
	if (rawSettingValue(origins.global, spec.path).present) return "global";
	return "default";
}

function specsFor(scope: SettingsScope, group: SettingGroup): readonly SettingSpec[] {
	return SETTING_SPECS.filter((spec) => spec.group === group && (scope === "global" || spec.scope !== "global"));
}

/** Keys offered for one scope; a project file can never hold a global-only key. */
function visibleSpecs(scope: SettingsScope): readonly SettingSpec[] {
	return SETTING_SPECS.filter((spec) => scope === "global" || spec.scope !== "global");
}

function keyLine(spec: SettingSpec, deps: SettingsCommandDeps, origins: Origins): string {
	const value = formatSettingValue(spec, settingValue(deps.settings(), spec));
	return `${settingKey(spec)} = ${value}  [${settingOrigin(spec, origins)}]${spec.restart ? " · next session" : ""}`;
}

/**
 * Write one change and report the outcome. Writes are the only side effect, so
 * this is also the tests' entry point: the dialogs only ask for the change.
 */
export async function applySettingChange(
	deps: SettingsCommandDeps,
	scope: SettingsScope,
	spec: SettingSpec,
	change: SettingChange,
): Promise<SettingChangeResult> {
	if (spec.scope === "global" && scope === "project") {
		return { ok: false, message: `${settingKey(spec)} can only be set in the global file`, type: "error" };
	}
	// A value-less "value" change would silently become a reset in the writer.
	if (change.kind === "value" && change.value === undefined) {
		return { ok: false, message: `${settingKey(spec)}: no value supplied`, type: "error" };
	}
	const written = await writeScopeSetting(deps, {
		scope,
		path: spec.path,
		value: change.kind === "reset" ? undefined : change.value,
	});
	if (!written.ok) return { ok: false, message: written.reason, type: "error" };
	const applied = await deps.apply();
	const effective = formatSettingValue(spec, settingValue(applied, spec));
	const verb = change.kind === "reset" ? "reset" : "set";
	return {
		ok: true,
		message: `${settingKey(spec)} ${verb} to ${effective} in ${written.file}${
			spec.restart ? " — takes effect next session; running children keep their setting" : " — applied live"
		}`,
		type: "info",
	};
}

async function editSetting(
	ui: SettingsUiPort,
	deps: SettingsCommandDeps,
	scope: SettingsScope,
	spec: SettingSpec,
): Promise<void> {
	let change: SettingChange;
	if (spec.kind === "choice" || spec.kind === "boolean") {
		const choices = scope === "global" ? (spec.choices ?? []) : projectChoices(spec);
		const picked = await ui.select(`${scopeLabel(scope)} · ${settingKey(spec)} — ${spec.label}`, [
			...choices.map((choice) => choice.label),
			RESET,
		]);
		if (picked === undefined) return;
		const choice = choices.find((candidate) => candidate.label === picked);
		change = picked === RESET || choice === undefined ? { kind: "reset" } : { kind: "value", value: choice.value };
	} else {
		const current = formatSettingValue(spec, settingValue(deps.settings(), spec));
		const text = await ui.input(`${settingKey(spec)} — ${spec.label} · current ${current}; empty resets`, current);
		if (text === undefined) return;
		if (text.trim() === "") {
			change = { kind: "reset" };
		} else {
			const parsed = parseSettingText(spec, text);
			if (!parsed.ok) {
				ui.notify(`${settingKey(spec)}: ${parsed.reason}`, "error");
				return;
			}
			change = { kind: "value", value: parsed.value };
		}
	}
	const result = await applySettingChange(deps, scope, spec, change);
	ui.notify(result.message, result.type);
}

async function editGroup(
	ui: SettingsUiPort,
	deps: SettingsCommandDeps,
	scope: SettingsScope,
	group: SettingGroup,
): Promise<void> {
	for (;;) {
		const origins = await loadOrigins(deps);
		const specs = specsFor(scope, group);
		if (specs.length === 0) return;
		const byLine = new Map(specs.map((spec) => [keyLine(spec, deps, origins), spec]));
		const picked = await ui.select(
			`${scopeLabel(scope)} · ${SETTING_GROUP_LABELS[group]}${origins.problem ? ` ⚠ ${origins.problem}` : ""}`,
			[...byLine.keys(), BACK],
		);
		if (picked === undefined || picked === BACK) return;
		const spec = byLine.get(picked);
		if (spec) await editSetting(ui, deps, scope, spec);
	}
}

async function editScope(ui: SettingsUiPort, deps: SettingsCommandDeps, scope: SettingsScope): Promise<void> {
	const paths = settingsWriterPaths(deps);
	for (;;) {
		const groups = [...new Set(visibleSpecs(scope).map((spec) => spec.group))];
		const byLabel = new Map(groups.map((group) => [SETTING_GROUP_LABELS[group], group]));
		const picked = await ui.select(`${scopeLabel(scope)} settings · ${paths[scope]}`, [...byLabel.keys(), BACK]);
		if (picked === undefined || picked === BACK) return;
		const group = byLabel.get(picked);
		if (group) await editGroup(ui, deps, scope, group);
	}
}

async function showEffective(ui: SettingsUiPort, deps: SettingsCommandDeps): Promise<void> {
	const origins = await loadOrigins(deps);
	const settings = deps.settings();
	const paths = settingsWriterPaths(deps);
	const lines = [
		`global file  ${paths.global}`,
		`project file ${paths.project}`,
		...(origins.problem ? [`warning: ${origins.problem}`] : []),
		...SETTING_SPECS.map((spec) => {
			const restart = spec.restart ? " · next session" : "";
			return `${settingKey(spec)} = ${formatSettingValue(spec, settingValue(settings, spec))}  [${settingOrigin(spec, origins)}]${restart}`;
		}),
	];
	// Read-only: selecting a line (or Escape) simply closes it.
	await ui.select("Effective pi-teams settings (read-only)", lines);
}

/** The whole `/teams-settings` interaction; resolves when the user closes it. */
export async function runSettingsUi(ui: SettingsUiPort, deps: SettingsCommandDeps): Promise<void> {
	for (;;) {
		const paths = settingsWriterPaths(deps);
		const entries = [`Global · ${paths.global}`, `Project · ${paths.project}`, "Show effective values"];
		const picked = await ui.select("pi-teams settings", entries);
		if (picked === undefined) return;
		const scope = SCOPES.find((candidate) => picked.startsWith(scopeLabel(candidate)));
		if (picked === "Show effective values") await showEffective(ui, deps);
		else if (scope) await editScope(ui, deps, scope);
	}
}

/** Register `/teams-settings`. */
export function registerSettingsCommand(pi: ExtensionAPI, deps: SettingsCommandDeps): void {
	pi.registerCommand("teams-settings", {
		description: "View or edit pi-teams settings in ~/.pi/agent/teams.json or .pi/teams.json",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("pi-teams settings need an interactive session; edit teams.json directly", "error");
				return;
			}
			await runSettingsUi(ctx.ui, deps);
		},
	});
}
