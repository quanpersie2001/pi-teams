// Host adapter: writing one key into a teams.json file (docs/CONFIGURATION.md §5).
//
// Reads are owned by config-host.ts and stay tolerant. A write is stricter:
// a file that does not parse as a JSON object is refused rather than replaced,
// because the writer cannot preserve what it cannot read. Every unrelated key —
// including keys this version does not know — survives the edit, and the file
// is replaced atomically so a crash mid-write cannot truncate it.

import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { patchSetting, removeSetting } from "../domain/settings-write.js";
import { globalSettingsPath, projectSettingsPath } from "./config-host.js";

export type SettingsScope = "global" | "project";

export interface SettingsWriterPaths {
	global: string;
	project: string;
}

export interface SettingsWriterOptions {
	configCwd: string;
	/** Override the global agent dir (tests avoid the real ~/.pi/agent). */
	agentDir?: string;
}

export function settingsWriterPaths(options: SettingsWriterOptions): SettingsWriterPaths {
	return {
		global: globalSettingsPath(options.agentDir),
		project: projectSettingsPath(options.configCwd),
	};
}

export type RawScopeFile =
	| { ok: true; file: string; text: string; raw: unknown }
	| { ok: false; file: string; reason: string };

/**
 * Read one scope's file as unfiltered JSON. A missing file is an empty object;
 * anything unparseable or non-object is an error the writer must not overwrite.
 */
export async function readScopeFile(options: SettingsWriterOptions, scope: SettingsScope): Promise<RawScopeFile> {
	const file = settingsWriterPaths(options)[scope];
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch {
		return { ok: true, file, text: "", raw: {} };
	}
	if (text.trim() === "") return { ok: true, file, text, raw: {} };
	let raw: unknown;
	try {
		raw = JSON.parse(text) as unknown;
	} catch (error) {
		return {
			ok: false,
			file,
			reason: `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix it manually first`,
		};
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, file, reason: `${file} must contain a JSON object; fix it manually first` };
	}
	return { ok: true, file, text, raw };
}

export type SettingsWriteResult =
	| { ok: true; file: string; raw: Record<string, unknown> }
	| { ok: false; reason: string };

async function atomicWrite(file: string, text: string): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	let mode = 0o600;
	try {
		mode = (await stat(file)).mode & 0o777;
	} catch {
		// New file: owner-only, matching the peer/registry artifacts.
	}
	const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(temporary, text, { mode });
	try {
		await rename(temporary, file);
	} catch (error) {
		// Never leave a half-written sibling behind; the target is untouched.
		await unlink(temporary).catch(() => {});
		throw error;
	}
}

/**
 * Set one key (`value !== undefined`) or remove it (`value === undefined`) in
 * one scope. Removal is the reset path: the other scope, then the built-in
 * default, applies again.
 */
export async function writeScopeSetting(
	options: SettingsWriterOptions,
	request: { scope: SettingsScope; path: readonly string[]; value: unknown },
): Promise<SettingsWriteResult> {
	if (request.path.length === 0) return { ok: false, reason: "empty settings path" };
	const current = await readScopeFile(options, request.scope);
	if (!current.ok) return { ok: false, reason: current.reason };
	const next =
		request.value === undefined
			? removeSetting(current.raw, request.path)
			: patchSetting(current.raw, request.path, request.value);
	const text = `${JSON.stringify(next, null, "\t")}\n`;
	try {
		await atomicWrite(current.file, text);
	} catch (error) {
		return {
			ok: false,
			reason: `${current.file} could not be written (${error instanceof Error ? error.message : String(error)})`,
		};
	}
	return { ok: true, file: current.file, raw: next };
}
