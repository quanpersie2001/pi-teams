// Durable process run registry/history file I/O.
//
// Registry rows carry process-control identity. Incompatible historical rows
// are preserved as raw JSON and never adopted as terminal or SDK controls.
// Writes remain atomic and owner-only.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CompletedRunHistoryEntry, PersistedRegistryEntry, SubagentRunStore } from "../app/run-registry.js";
import { coerceRegistryEntry, isIncompatibleRegistryEntry } from "../app/run-registry.js";
import { findNearestPiDir } from "./artifacts.js";

export function subagentsArtifactDir(cwd: string): string {
	return join(findNearestPiDir(cwd), "subagents");
}

export function registryFilePath(cwd: string): string {
	return join(subagentsArtifactDir(cwd), "registry.json");
}

export function historyFilePath(cwd: string): string {
	return join(subagentsArtifactDir(cwd), "history.json");
}

function warn(message: string): void {
	console.warn(`[pi-subagents] ${message}`);
}

/** Read a JSON array; strict callers never rewrite corrupt data as empty. */
function readJsonArray(path: string, label: string, strict = false): unknown[] {
	if (!existsSync(path)) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		if (strict) throw new Error(`${label} at ${path} is corrupt; refusing to rewrite it (${detail})`, { cause: error });
		warn(`${label} at ${path} is corrupt and will be ignored (${detail})`);
		return [];
	}
	if (!Array.isArray(parsed)) {
		if (strict) throw new Error(`${label} at ${path} has an unexpected shape; refusing to rewrite it`);
		warn(`${label} at ${path} has an unexpected shape (expected an array) and will be ignored`);
		return [];
	}
	return parsed;
}

/** Atomic full-file write: serialize first, then tmp+rename. */
function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, path);
}

function coerceEntries(rawList: unknown[]): PersistedRegistryEntry[] {
	return rawList.map((raw) => coerceRegistryEntry(raw));
}

/**
 * Build the fs-backed run store bound to one host cwd. The same store is used
 * across the process lifetime; every call re-reads current disk state so
 * external edits are picked up.
 */
export function createSubagentRunStore(cwd: string): SubagentRunStore {
	const registryPath = registryFilePath(cwd);
	const historyPath = historyFilePath(cwd);

	return {
		readRegistry(): PersistedRegistryEntry[] {
			return coerceEntries(readJsonArray(registryPath, "run registry", true));
		},

		writeRegistry(entries: readonly PersistedRegistryEntry[]): void {
			writeJsonAtomic(
				registryPath,
				entries.map((entry) => (isIncompatibleRegistryEntry(entry) ? entry.raw : entry)),
			);
		},

		readHistory(): CompletedRunHistoryEntry[] {
			const rows = readJsonArray(historyPath, "run history");
			const entries: CompletedRunHistoryEntry[] = [];
			for (const row of coerceEntries(rows)) {
				if (isIncompatibleRegistryEntry(row)) continue;
				if (typeof row.completedAt !== "number") {
					warn(`run history at ${historyPath} contains a row without completedAt and it was skipped`);
					continue;
				}
				const history = { ...row };
				delete history.handle;
				entries.push({ ...history, completedAt: row.completedAt });
			}
			return entries;
		},

		recordCompleted(entry: CompletedRunHistoryEntry): void {
			const rawRows = readJsonArray(historyPath, "run history");
			const matchingIndex = rawRows.findIndex((raw) => {
				const existing = coerceRegistryEntry(raw);
				return !isIncompatibleRegistryEntry(existing) && existing.id === entry.id;
			});
			if (matchingIndex >= 0) rawRows[matchingIndex] = entry;
			else rawRows.push(entry);
			writeJsonAtomic(historyPath, rawRows);
		},
	};
}
