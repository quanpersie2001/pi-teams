import type {
	AgentRegistryEntry,
	CompletedRunHistoryEntry,
	IncompatibleRegistryEntry,
	PersistedRegistryEntry,
} from "./run-registry.js";
import { isIncompatibleRegistryEntry } from "./run-registry.js";

export interface PartitionedRegistryEntries {
	owned: AgentRegistryEntry[];
	incompatible: IncompatibleRegistryEntry[];
	foreign: AgentRegistryEntry[];
}

export function partitionOwnedEntries(
	entries: readonly PersistedRegistryEntry[],
	isOwn: (entry: AgentRegistryEntry) => boolean,
): PartitionedRegistryEntries {
	const owned: AgentRegistryEntry[] = [];
	const incompatible: IncompatibleRegistryEntry[] = [];
	const foreign: AgentRegistryEntry[] = [];
	for (const entry of entries) {
		if (isIncompatibleRegistryEntry(entry)) incompatible.push(entry);
		else if (isOwn(entry)) owned.push(entry);
		else foreign.push(entry);
	}
	return { owned, incompatible, foreign };
}

export interface ArchiveRegistryDeps {
	dispose(entry: AgentRegistryEntry): boolean | Promise<boolean>;
	persist(entries: readonly PersistedRegistryEntry[]): void;
	recordCompleted(entry: CompletedRunHistoryEntry): void;
	rememberAgents: boolean;
	warn(message: string): void;
	now(): number;
}

/** Archive stale registry receipts without reconnecting children into this session. */
export async function archiveRegistryRuns(
	entries: readonly PersistedRegistryEntry[],
	deps: ArchiveRegistryDeps,
): Promise<void> {
	const kept: PersistedRegistryEntry[] = [];
	for (const entry of entries) {
		if (isIncompatibleRegistryEntry(entry)) {
			kept.push(entry);
			deps.warn(`preserving incompatible registry row: ${entry.reason}`);
			continue;
		}
		let cleanupError: string | undefined;
		if (entry.handle) {
			try {
				if (!(await deps.dispose(entry))) cleanupError = "verified disposal could not be confirmed";
			} catch (error) {
				cleanupError = `verified disposal failed: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		if (
			entry.status === "completed" ||
			entry.status === "stopped" ||
			entry.status === "aborted" ||
			entry.status === "error"
		) {
			const history = { ...entry };
			delete history.handle;
			if (cleanupError) {
				history.recoveryError = [entry.recoveryError, cleanupError].filter(Boolean).join("; ");
				deps.warn(`run "${entry.id}" retained its saved outcome with a startup cleanup error: ${cleanupError}`);
			}
			if (!deps.rememberAgents) kept.push(history);
			else deps.recordCompleted({ ...history, completedAt: entry.completedAt ?? deps.now() });
			continue;
		}

		let recoveryError =
			"stopped at startup: the owning session ended before settlement; live teammates are not restored across sessions";
		if (cleanupError) recoveryError += `; ${cleanupError}`;
		else if (!entry.handle)
			recoveryError += "; verified disposal was unavailable because the process identity is missing";
		const history = { ...entry };
		delete history.handle;
		deps.recordCompleted({ ...history, status: "stopped", completedAt: deps.now(), recoveryError });
		deps.warn(`run "${entry.id}" archived stopped at startup: ${recoveryError}`);
	}
	deps.persist(kept);
}
