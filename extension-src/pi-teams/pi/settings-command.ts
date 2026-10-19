// /teams-settings — edit pi-teams operational settings without leaving the TUI.
//
// Pi exposes no settings registry to extensions (its `/settings` and `pi config`
// own Pi's own keys), so this command is the extension's own editor. Groups and
// scopes are chosen with stock dialogs; the key list is a compact overlay sized
// to its rows, where ←/→ change a value in place, because a modal per value
// would make the common "tweak two numbers" case painful.
//
// Every edit is validated by the domain schema before it reaches a file, and
// the file is patched in place (unknown keys survive) by settings-writer.

import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { SubagentsSettings } from "../domain/config.js";
import {
	formatSettingValue,
	parseSettingText,
	rawSettingValue,
	SETTING_GROUP_LABELS,
	SETTING_SPECS,
	type SettingGroup,
	type SettingSpec,
	settingKey,
	settingValue,
	stepSettingValue,
} from "../domain/settings-schema.js";
import { createSettingsEditorComponent, type SettingsEditorData } from "../features/settings-editor/index.js";
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
	custom: ExtensionUIContext["custom"];
}

export interface SettingsCommandDeps extends SettingsWriterOptions {
	/** Current effective settings (already sanitized). */
	settings: () => Readonly<SubagentsSettings>;
	/** Re-read the files, apply what can be applied live, and return the result. */
	apply: () => Promise<Readonly<SubagentsSettings>>;
}

/** A change the editor asks for: a new explicit value, or a reset (key removal). */
export type SettingChange = { kind: "value"; value: unknown } | { kind: "reset" };

export interface SettingChangeResult {
	ok: boolean;
	message: string;
	type: "info" | "error";
}

const BACK = "← Back";
/** Widest the key list grows; longer lines would only add whitespace. */
const SETTINGS_EDITOR_MAX_WIDTH = 96;
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

/** Keys offered for one scope, with the level currently supplying each value. */
function visibleSpecs(scope: SettingsScope): readonly SettingSpec[] {
	return SETTING_SPECS.filter((spec) => scope === "global" || spec.scope !== "global");
}

async function buildData(
	deps: SettingsCommandDeps,
	scope: SettingsScope,
	group: SettingGroup,
): Promise<SettingsEditorData & { problem?: string }> {
	const origins = await loadOrigins(deps);
	const settings = deps.settings();
	const items = specsFor(scope, group).map((spec) => ({
		key: settingKey(spec),
		label: spec.label,
		spec,
		value: formatSettingValue(spec, settingValue(settings, spec)),
		origin: settingOrigin(spec, origins),
		overridden: rawSettingValue(scope === "global" ? origins.global : origins.project, spec.path).present,
		restart: spec.restart === true,
	}));
	return {
		title: `${scopeLabel(scope)} · ${SETTING_GROUP_LABELS[group]}${origins.problem ? ` ⚠ ${origins.problem}` : ""}`,
		items,
		...(origins.problem === undefined ? {} : { problem: origins.problem }),
	};
}

/**
 * Write one change and report the outcome. Writes are the only side effect, so
 * this is also the unit tests' entry point: the overlay is a thin shell.
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

async function openGroupEditor(
	ui: SettingsUiPort,
	deps: SettingsCommandDeps,
	scope: SettingsScope,
	group: SettingGroup,
): Promise<void> {
	let data = await buildData(deps, scope, group);
	// One write at a time: a held arrow key must not interleave two file edits.
	let queue: Promise<unknown> = Promise.resolve();
	const run = (task: () => Promise<void>): void => {
		queue = queue.then(task, task);
	};
	const refresh = async (): Promise<void> => {
		data = await buildData(deps, scope, group);
	};
	// The editor renders only its own rows, so the overlay is a compact dialog
	// instead of an empty fullscreen frame; width caps the stretched look on wide
	// terminals while still following narrow ones.
	let overlayTui: TUI | undefined;
	await ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			overlayTui = tui;
			return createSettingsEditorComponent(tui, theme, {
				getData: () => data,
				onStep: (item, direction) => {
					// Free text has no ladder and no meaningful ±1 step; Enter edits it.
					if (item.spec.kind === "text") return;
					const step = stepSettingValue(
						item.spec,
						settingValue(deps.settings(), item.spec),
						{ overridden: item.overridden, projectScope: scope === "project" },
						direction,
					);
					run(async () => {
						await applyAndNotify(ui, deps, scope, item.spec, step);
						await refresh();
						tui.requestRender();
					});
				},
				onEdit: (item) => {
					run(async () => {
						const current = formatSettingValue(item.spec, settingValue(deps.settings(), item.spec));
						const text = await ui.input(`${item.key} — ${item.label} · current ${current}; empty resets`, current);
						if (text === undefined) return;
						let change: SettingChange = { kind: "reset" };
						if (text.trim() !== "") {
							const parsed = parseSettingText(item.spec, text);
							if (!parsed.ok) {
								ui.notify(`${item.key}: ${parsed.reason}`, "error");
								return;
							}
							change = { kind: "value", value: parsed.value };
						}
						await applyAndNotify(ui, deps, scope, item.spec, change);
						await refresh();
						tui.requestRender();
					});
				},
				onReset: (item) => {
					if (!item.overridden) {
						ui.notify(
							`${item.key} has no ${scopeLabel(scope)} override; the effective value comes from ${item.origin}`,
							"info",
						);
						return;
					}
					run(async () => {
						await applyAndNotify(ui, deps, scope, item.spec, { kind: "reset" });
						await refresh();
						tui.requestRender();
					});
				},
				onBack: () => done(undefined),
			});
		},
		{
			overlay: true,
			overlayOptions: () => ({
				anchor: "center",
				width: Math.min(overlayTui?.terminal.columns ?? SETTINGS_EDITOR_MAX_WIDTH, SETTINGS_EDITOR_MAX_WIDTH),
			}),
		},
	);
}

async function applyAndNotify(
	ui: SettingsUiPort,
	deps: SettingsCommandDeps,
	scope: SettingsScope,
	spec: SettingSpec,
	change: SettingChange,
): Promise<void> {
	const result = await applySettingChange(deps, scope, spec, change);
	ui.notify(result.message, result.type);
}

async function editScope(ui: SettingsUiPort, deps: SettingsCommandDeps, scope: SettingsScope): Promise<void> {
	const paths = settingsWriterPaths(deps);
	for (;;) {
		const groups = [...new Set(visibleSpecs(scope).map((spec) => spec.group))];
		const byLabel = new Map(groups.map((group) => [SETTING_GROUP_LABELS[group], group]));
		const picked = await ui.select(`${scopeLabel(scope)} settings · ${paths[scope]}`, [...byLabel.keys(), BACK]);
		if (picked === undefined || picked === BACK) return;
		const group = byLabel.get(picked);
		if (group) await openGroupEditor(ui, deps, scope, group);
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
