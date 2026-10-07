// Host adapter: operational settings I/O (docs/CONFIGURATION.md §5).
//
// Global settings live at ~/.pi/agent/teams.json; project overrides at
// <project>/.pi/teams.json. Project keys override global keys shallowly;
// the merged raw object is then sanitized by the pure domain function.
// Missing/unreadable/unparseable files are tolerated and never throw: a
// corrupt file logs a warning and contributes no keys, while the other level
// (or all-built-in defaults) still applies.
//
// Settings are read-only; operators own both global and project files.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type SubagentsSettings, sanitizeSettings } from "../domain/config.js";

/** Resolved settings file paths for one host cwd. */
export interface SettingsFilePaths {
	/** ~/.pi/agent/teams.json — global defaults. */
	global: string;
	/** <project>/.pi/teams.json — project overrides. */
	project: string;
}

/** Handles for environment-dependent parts of the read (injectable in tests). */
export interface LoadSettingsHandlers {
	/** Warning sink; defaults to console.warn with a [pi-teams] prefix. */
	warn?: (message: string) => void;
	/** Override the global agent dir (tests avoid the real ~/.pi/agent). */
	agentDir?: string;
}

export function resolveSettingsPaths(configCwd: string, agentDir = getAgentDir()): SettingsFilePaths {
	return {
		global: globalSettingsPath(agentDir),
		project: projectSettingsPath(configCwd),
	};
}

export function globalSettingsPath(agentDir = getAgentDir()): string {
	return join(agentDir, "teams.json");
}

export function projectSettingsPath(configCwd: string): string {
	return join(configCwd, ".pi", "teams.json");
}

/**
 * Pure per-key merge with project precedence. Non-object input (including JSON
 * that parsed to a scalar) is treated as empty. The result is a plain object
 * of the keys contributed by both levels, fed to sanitizeSettings afterwards.
 */
export function mergeSettings(global: unknown, project: unknown): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	if (typeof global === "object" && global !== null) Object.assign(merged, global);
	if (typeof project === "object" && project !== null) Object.assign(merged, project);
	return merged;
}

/**
 * Read one settings file with tolerant failure: missing/unreadable → undefined
 * (silent); unparseable → warning + undefined. Callers decide what "no value"
 * means for the level (the other level, or all defaults).
 */
async function readRawJson(path: string, label: string, warn: (message: string) => void): Promise<unknown> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		// Missing or unreadable: a normal state for users without the file.
		return undefined;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		warn(`${label} at ${path} is corrupt and was ignored (${error instanceof Error ? error.message : String(error)})`);
		return undefined;
	}
}

/**
 * Read global + project settings, merge (project wins per key) and sanitize.
 * Never throws: any combination of missing/corrupt files degrades to the other
 * level, then to built-in defaults via sanitizeSettings.
 */
export async function loadSubagentsSettings(
	configCwd: string,
	handlers: LoadSettingsHandlers = {},
): Promise<SubagentsSettings> {
	const warn = handlers.warn ?? ((message: string) => console.warn(`[pi-teams] ${message}`));
	const paths = resolveSettingsPaths(configCwd, handlers.agentDir);
	const [global, project] = await Promise.all([
		readRawJson(paths.global, "global settings file", warn),
		readRawJson(paths.project, "project settings file", warn),
	]);
	return sanitizeSettings(mergeSettings(global, project));
}
