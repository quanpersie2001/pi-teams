import type {
	AgentRegistryEntry,
	CompletedRunHistoryEntry,
	IncompatibleRegistryEntry,
	PersistedRegistryEntry,
} from "./run-registry.js";
import { hasVerifiedCleanupProof, isIncompatibleRegistryEntry } from "./run-registry.js";

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
export interface ArchiveRegistryResult {
	/** Entries for which a concrete handle was disposed successfully. */
	verifiedDisposed: AgentRegistryEntry[];
	/** Rows retained because ownership or disposal remains unresolved. */
	unresolved: PersistedRegistryEntry[];
}

export async function archiveRegistryRuns(
	entries: readonly PersistedRegistryEntry[],
	deps: ArchiveRegistryDeps,
): Promise<ArchiveRegistryResult> {
	const kept: PersistedRegistryEntry[] = [];
	const verifiedDisposed: AgentRegistryEntry[] = [];
	for (const entry of entries) {
		if (isIncompatibleRegistryEntry(entry)) {
			kept.push(entry);
			deps.warn(`preserving incompatible registry row: ${entry.reason}`);
			continue;
		}
		let cleanupError: string | undefined;
		const previouslyVerified = hasVerifiedCleanupProof(entry);
		if (previouslyVerified) verifiedDisposed.push(entry);
		else if (!entry.handle) cleanupError = "verified disposal unavailable because the process identity is missing";
		if (entry.handle) {
			try {
				if (!(await deps.dispose(entry))) cleanupError = "verified disposal could not be confirmed";
			} catch (error) {
				cleanupError = `verified disposal failed: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		if (!cleanupError && entry.handle) verifiedDisposed.push(entry);
		const history = { ...entry };
		delete history.handle;
		if (entry.handle && !cleanupError) {
			history.cleanupProof = {
				kind: "verified-process-disposal",
				runId: entry.id,
				...(entry.membershipId !== undefined ? { membershipId: entry.membershipId } : {}),
				verifiedAt: deps.now(),
			};
		}
		if (
			entry.status === "completed" ||
			entry.status === "stopped" ||
			entry.status === "aborted" ||
			entry.status === "error"
		) {
			if (cleanupError) {
				history.recoveryError = [entry.recoveryError, cleanupError].filter(Boolean).join("; ");
				kept.push({ ...entry, recoveryError: history.recoveryError });
				deps.warn(`run "${entry.id}" retained its saved outcome and cleanup receipt: ${cleanupError}`);
				if (deps.rememberAgents) deps.recordCompleted({ ...history, completedAt: entry.completedAt ?? deps.now() });
				continue;
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
		const completedAt = deps.now();
		if (cleanupError) kept.push({ ...entry, recoveryError });
		deps.recordCompleted({ ...history, status: "stopped", completedAt, recoveryError });
		deps.warn(`run "${entry.id}" archived stopped at startup: ${recoveryError}`);
	}
	deps.persist(kept);
	const verifiedIds = new Set(verifiedDisposed.map((entry) => entry.id));
	const unresolved = kept.filter((entry) => {
		if (isIncompatibleRegistryEntry(entry)) return true;
		if (verifiedIds.has(entry.id)) return false;
		// A handle-less history row retained solely because rememberAgents is off
		// records an outcome, not an unresolved process/resource receipt.
		return entry.handle !== undefined || entry.recoveryError !== undefined;
	});
	return { verifiedDisposed, unresolved };
}
