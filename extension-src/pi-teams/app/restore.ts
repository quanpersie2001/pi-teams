import { isTerminalStatus } from "../domain/agent-run.js";
import type {
	AgentRegistryEntry,
	CompletedRunHistoryEntry,
	IncompatibleRegistryEntry,
	PersistedRegistryEntry,
	RestoreCompletionObservation,
	RestoreObservers,
	RestoreReconnectResult,
} from "./run-registry.js";
import { isIncompatibleRegistryEntry } from "./run-registry.js";

export interface RestoreObservation {
	completion: RestoreCompletionObservation;
}

export type RestoreDecision =
	| { action: "defer"; reason: string }
	| { action: "completed"; outcome: "completed" | "stopped" | "failed" }
	| { action: "recover-terminal" }
	| { action: "orphan-stopped" };

/**
 * Pure process-restore decision; child RPC outcome outranks launcher status.
 * Session-bound lifetime (ADR 0007 §1): an ACTIVE row is never re-adopted —
 * it is archived stopped with an honest note and its resource goes through
 * verified disposal. A settled child outcome observed before that archiving
 * stays authoritative.
 */
export function decideRestore(entry: AgentRegistryEntry, observation: RestoreObservation): RestoreDecision {
	if (!entry.handle) return { action: "defer", reason: "process control identity is unavailable" };
	if (observation.completion.finished) {
		return { action: "completed", outcome: observation.completion.outcome ?? "completed" };
	}
	if (isTerminalStatus(entry.status)) return { action: "recover-terminal" };
	// Active leftover row: the owning session ended without settlement.
	return { action: "orphan-stopped" };
}

export interface PartitionedRegistryEntries {
	/** Rows whose conversation owner is the current session. */
	owned: AgentRegistryEntry[];
	/** Incompatible raw rows preserved byte-for-value; never adopted. */
	incompatible: IncompatibleRegistryEntry[];
	/** Rows owned by other conversations or extensions. */
	foreign: AgentRegistryEntry[];
}

/**
 * Split persisted rows by owning conversation. Only rows whose conversation
 * owner matches the current session are restored; rows owned by another
 * conversation or by an extension consumer stay with their owning process.
 */
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

export interface RestoreDeps extends RestoreObservers {
	reconnect(entry: AgentRegistryEntry): RestoreReconnectResult | Promise<RestoreReconnectResult>;
	/** Verified disposal of an orphaned active row's resource (ADR 0007 §1). */
	disposeOrphan(entry: AgentRegistryEntry): boolean | Promise<boolean>;
	persist(entries: readonly PersistedRegistryEntry[]): void;
	recordCompleted(entry: CompletedRunHistoryEntry): void;
	rememberAgents: boolean;
	warn(message: string): void;
	now(): number;
}

export interface RestoreSummary {
	reconnected: string[];
	completed: string[];
	/** Active rows archived stopped under the session-bound lifetime. */
	orphaned: string[];
	failed: string[];
	deferred: string[];
	skippedByRememberAgents: string[];
	preservedIncompatible: string[];
}

/** Reconcile registry rows with authenticated child RPC state without JSONL polling. */
export async function restoreRegisteredRuns(
	entries: readonly PersistedRegistryEntry[],
	deps: RestoreDeps,
): Promise<RestoreSummary> {
	const summary: RestoreSummary = {
		reconnected: [],
		completed: [],
		orphaned: [],
		failed: [],
		deferred: [],
		skippedByRememberAgents: [],
		preservedIncompatible: [],
	};
	const kept: PersistedRegistryEntry[] = [];

	for (const entry of entries) {
		if (isIncompatibleRegistryEntry(entry)) {
			kept.push(entry);
			let incompatibleId = "unknown";
			if (entry.raw !== null && typeof entry.raw === "object" && "id" in entry.raw) {
				const id = entry.raw.id;
				if (typeof id === "string") incompatibleId = id;
			}
			summary.preservedIncompatible.push(incompatibleId);
			deps.warn(`preserving incompatible registry row: ${entry.reason}`);
			continue;
		}

		if (!deps.rememberAgents && isTerminalStatus(entry.status)) {
			kept.push(entry);
			summary.skippedByRememberAgents.push(entry.id);
			continue;
		}

		if (!entry.handle) {
			kept.push(entry);
			summary.deferred.push(entry.id);
			deps.warn(`restore deferred for run "${entry.id}": process control identity is unavailable`);
			continue;
		}

		const completion = await deps.detectCompletion(entry);
		const decision = decideRestore(entry, { completion });

		switch (decision.action) {
			case "completed": {
				const status =
					decision.outcome === "completed" ? "completed" : decision.outcome === "stopped" ? "stopped" : "error";
				const historyEntry = { ...entry };
				delete historyEntry.handle;
				deps.recordCompleted({
					...historyEntry,
					status,
					completedAt: entry.completedAt ?? deps.now(),
					...(completion.result !== undefined ? { result: completion.result } : {}),
					...(completion.error !== undefined ? { error: completion.error } : {}),
					...(completion.sessionFile !== undefined ? { sessionFile: completion.sessionFile } : {}),
					...(completion.usage !== undefined ? { usage: completion.usage } : {}),
					...(completion.turns !== undefined ? { turns: completion.turns } : {}),
					...(completion.toolUses !== undefined ? { toolUses: completion.toolUses } : {}),
				});
				summary.completed.push(entry.id);
				if ((await deps.resourceAlive(entry)) !== false) {
					await retainSettledProcessRow(entry, deps, summary, kept);
				}
				break;
			}

			case "recover-terminal": {
				const historyEntry = { ...entry };
				delete historyEntry.handle;
				deps.recordCompleted({ ...historyEntry, completedAt: entry.completedAt ?? deps.now() });
				summary.completed.push(entry.id);
				if ((await deps.resourceAlive(entry)) !== false) {
					await retainSettledProcessRow(entry, deps, summary, kept);
				}
				break;
			}

			case "orphan-stopped": {
				// Session-bound lifetime (ADR 0007 §1): never re-adopt an active
				// row. Archive it stopped with an honest note; verified disposal
				// of the leftover resource, with the row retained for an
				// explicit release retry when disposal cannot be verified.
				let disposalError: string | undefined;
				try {
					const disposed = await deps.disposeOrphan(entry);
					if (!disposed) disposalError = "verified disposal did not complete; retry with /agents release";
				} catch (error) {
					disposalError = `verified disposal failed: ${errorText(error)}`;
				}
				const historyEntry = { ...entry };
				delete historyEntry.handle;
				deps.recordCompleted({
					...historyEntry,
					status: "stopped",
					completedAt: deps.now(),
					recoveryError:
						disposalError ??
						"stopped at startup: teammates are session-bound and are never re-adopted (ADR 0007); the owning session ended before settlement",
				});
				summary.orphaned.push(entry.id);
				deps.warn(`run "${entry.id}" archived stopped at startup (session-bound lifetime)`);
				if (disposalError !== undefined) {
					kept.push(entry);
					summary.deferred.push(entry.id);
					deps.warn(`run "${entry.id}" retains its resource receipt: ${disposalError}`);
				}
				break;
			}

			case "defer":
				kept.push(entry);
				summary.deferred.push(entry.id);
				deps.warn(`restore deferred for run "${entry.id}": ${decision.reason}`);
				break;
		}
	}

	deps.persist(kept);
	return summary;
}

/**
 * A settled row whose child may still hold resources: retry verified cleanup
 * through the manager; a retained/deferred receipt stays in the registry.
 */
async function retainSettledProcessRow(
	entry: AgentRegistryEntry,
	deps: RestoreDeps,
	summary: RestoreSummary,
	kept: PersistedRegistryEntry[],
): Promise<void> {
	try {
		const result = await deps.reconnect(entry);
		if (result.state === "retained") kept.push(result.entry);
		else if (result.state === "deferred") {
			kept.push(entry);
			summary.deferred.push(entry.id);
			deps.warn(`retained settled process row "${entry.id}" because child reconnection did not complete`);
		}
	} catch (error) {
		kept.push(entry);
		summary.deferred.push(entry.id);
		deps.warn(`retained settled process row "${entry.id}" after reconnect error: ${errorText(error)}`);
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
