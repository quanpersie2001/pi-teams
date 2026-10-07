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
	sessionPresent: boolean;
	completion: RestoreCompletionObservation;
	resourceAlive?: boolean;
}

export type RestoreDecision =
	| { action: "defer"; reason: string }
	| { action: "reconnect" }
	| { action: "completed"; outcome: "completed" | "stopped" | "failed" }
	| { action: "failed"; error: string }
	| { action: "recover-terminal" };

/** Pure process-restore decision; child RPC outcome outranks launcher status. */
export function decideRestore(entry: AgentRegistryEntry, observation: RestoreObservation): RestoreDecision {
	if (!entry.handle) return { action: "defer", reason: "process control identity is unavailable" };
	if (observation.completion.finished) {
		return { action: "completed", outcome: observation.completion.outcome ?? "completed" };
	}
	if (isTerminalStatus(entry.status)) return { action: "recover-terminal" };
	if (observation.resourceAlive === undefined) {
		return { action: "defer", reason: "child RPC state is unavailable; registry row is retained" };
	}
	if (observation.resourceAlive) return { action: "reconnect" };
	return {
		action: "failed",
		error: observation.sessionPresent
			? "child process is no longer available and has no settled RPC outcome"
			: "child process and persisted session artifacts are unavailable, with no settled RPC outcome",
	};
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
	persist(entries: readonly PersistedRegistryEntry[]): void;
	recordCompleted(entry: CompletedRunHistoryEntry): void;
	rememberAgents: boolean;
	warn(message: string): void;
	now(): number;
}

export interface RestoreSummary {
	reconnected: string[];
	completed: string[];
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
		const resourceAlive = await deps.resourceAlive(entry);
		const decision = decideRestore(entry, {
			sessionPresent: deps.sessionPresent(entry),
			completion,
			...(resourceAlive !== undefined ? { resourceAlive } : {}),
		});

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
				if (resourceAlive !== false) {
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
				break;
			}

			case "recover-terminal": {
				const historyEntry = { ...entry };
				delete historyEntry.handle;
				deps.recordCompleted({ ...historyEntry, completedAt: entry.completedAt ?? deps.now() });
				summary.completed.push(entry.id);
				if (resourceAlive !== false) {
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
				break;
			}

			case "failed": {
				const historyEntry = { ...entry };
				delete historyEntry.handle;
				deps.recordCompleted({
					...historyEntry,
					status: "error",
					completedAt: deps.now(),
					error: decision.error,
				});
				summary.failed.push(entry.id);
				deps.warn(`run "${entry.id}" marked failed at restore: ${decision.error}`);
				break;
			}

			case "reconnect": {
				let result: RestoreReconnectResult;
				try {
					result = await deps.reconnect(entry);
					if (result.state === "retained") summary.reconnected.push(entry.id);
					else if (result.state === "deferred") {
						summary.deferred.push(entry.id);
						deps.warn(`restore deferred for run "${entry.id}": child reconnection did not complete`);
					}
				} catch (error) {
					result = { state: "deferred" };
					summary.deferred.push(entry.id);
					deps.warn(`restore deferred for run "${entry.id}": ${errorText(error)}`);
				}
				if (result.state === "retained") kept.push(result.entry);
				else if (result.state === "deferred") kept.push(entry);
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

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
