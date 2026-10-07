// Process-only durable run registry/history file I/O.
//
// Registry rows retain control identity only while a child is active or cleanup
// remains recoverable. History rows contain outcome/session metadata for cold
// resume, never a live-process receipt.
// Parsed legacy or malformed rows remain opaque and are never adopted.

import type { AgentRun, AgentRunStatus, UsageSummary } from "../domain/agent-run.js";
import type { AgentBackendHandle, BackendStatus } from "../domain/backend.js";
import type { AgentOwner, DeliveryPolicy, ParentSessionRef } from "../domain/delivery.js";
import type { LauncherHandle } from "../domain/process-launcher.js";
import type { WorktreeResult } from "../domain/worktree.js";

/** Durable identity and credentials needed to reconnect to one child process. */
export interface SerializableBackendHandle {
	kind: "process";
	childId: string;
	socketPath: string;
	token: string;
	runDir: string;
	launcher: LauncherHandle;
	sessionFile?: string;
}

/** Durable worktree metadata needed to retain or explicitly release a checkout. */
export interface SerializableWorktreeInfo {
	baseRepo: string;
	path: string;
	checkoutRoot?: string;
	baseSha?: string;
	branch?: string;
}

/** One process-backed run persisted independently from its child process. */
export interface AgentRegistryEntry {
	id: string;
	type: string;
	description: string;
	status: AgentRunStatus;
	backend: "process";
	handle?: SerializableBackendHandle;
	model?: string;
	modelFallback?: string;
	sessionFile?: string;
	/** Absolute path of the run's full-result artifact (result.md). */
	resultFile?: string;
	/** Inline result copy; preview-bounded when resultTruncated is true. */
	result?: string;
	resultTruncated?: boolean;
	resultOriginalLength?: number;
	error?: string;
	recoveryError?: string;
	cwd: string;
	configCwd: string;
	owner: AgentOwner;
	delivery: DeliveryPolicy;
	startedAt: number;
	completedAt?: number;
	parentSession?: ParentSessionRef;
	toolUses?: number;
	turns?: number;
	usage?: UsageSummary;
	isBackground?: boolean;
	resultConsumed?: boolean;
	worktreeReleased?: boolean;
	worktree?: SerializableWorktreeInfo;
	worktreeResult?: WorktreeResult;
	/** Effective wall budget (seconds) frozen at admission; 0 = unlimited. */
	budgetTimeout?: number;
	/** Effective idle budget (seconds) frozen at admission; 0 = unlimited. */
	budgetIdleTimeout?: number;
	/** Epoch ms the frozen budgets began counting (immediately before launch/resume). */
	budgetStartedAt?: number;
	/** Epoch ms of the last counted child output. */
	budgetLastOutputAt?: number;
	/** Budget whose expiry stopped the run. */
	budgetExhausted?: "timeout" | "idle_timeout";
	/** Seconds of the exhausted budget. */
	budgetSeconds?: number;
}

/** Incompatible historical rows are retained byte-for-value without adoption. */
export interface IncompatibleRegistryEntry {
	kind: "incompatible";
	raw: unknown;
	reason: string;
}

export type PersistedRegistryEntry = AgentRegistryEntry | IncompatibleRegistryEntry;

/** Completed process-backed run/session history row. */
export interface CompletedRunHistoryEntry extends Omit<AgentRegistryEntry, "handle"> {
	completedAt: number;
}

/** Durable state adapter; registry writers preserve incompatible raw rows. */
export interface SubagentRunStore {
	readRegistry(): PersistedRegistryEntry[];
	writeRegistry(entries: readonly PersistedRegistryEntry[]): void;
	readHistory(): CompletedRunHistoryEntry[];
	recordCompleted(entry: CompletedRunHistoryEntry): void;
}

/** Outcome returned by an identity-checked process RPC snapshot. */
export interface RestoreCompletionObservation {
	finished: boolean;
	outcome?: "completed" | "stopped" | "failed";
	result?: string;
	error?: string;
	sessionFile?: string;
	usage?: UsageSummary;
	turns?: number;
	toolUses?: number;
}

/** Process-RPC observations needed to restore a child without guessing. */
export interface RestoreObservers {
	sessionPresent(entry: AgentRegistryEntry): boolean;
	detectCompletion(entry: AgentRegistryEntry): RestoreCompletionObservation | Promise<RestoreCompletionObservation>;
	resourceAlive(entry: AgentRegistryEntry): boolean | undefined | Promise<boolean | undefined>;
}

/** Result of asking the manager to restore or clean up a process receipt. */
export type RestoreReconnectResult =
	| { state: "retained"; entry: AgentRegistryEntry }
	| { state: "closed" }
	| { state: "deferred" };

/** Process backend persistence hooks; status is read from child RPC. */
export interface RestorableExecutionBackend {
	restoreHandle(runId: string, serialized: SerializableBackendHandle): AgentBackendHandle | null;
	serializeHandle?(handle: AgentBackendHandle, sessionFile?: string): SerializableBackendHandle | undefined;
	probeSerialized?(serialized: SerializableBackendHandle, runId: string): Promise<BackendStatus>;
}

export type HandleProjector = (
	handle: AgentBackendHandle,
	sessionFile: string | undefined,
) => SerializableBackendHandle | undefined;

export function isIncompatibleRegistryEntry(entry: PersistedRegistryEntry): entry is IncompatibleRegistryEntry {
	return "kind" in entry && entry.kind === "incompatible";
}

/** Project an in-memory run into its process-only durable representation. */
export function toRegistryEntry(
	record: AgentRun,
	cwd: string,
	configCwd: string,
	project?: HandleProjector,
): AgentRegistryEntry {
	const entry: AgentRegistryEntry = {
		id: record.id,
		type: record.type,
		description: record.description,
		status: record.status,
		backend: "process",
		cwd,
		configCwd,
		owner: { ...record.owner },
		delivery: record.delivery,
		startedAt: record.startedAt,
		toolUses: record.toolUses,
		turns: record.turns,
		usage: { ...record.usage },
		isBackground: record.isBackground === true,
	};
	if (record.handle !== undefined) {
		const serialized = project?.(record.handle, record.sessionFile);
		if (serialized !== undefined) entry.handle = serialized;
	}
	if (record.model !== undefined) entry.model = record.model;
	if (record.modelFallback !== undefined) entry.modelFallback = record.modelFallback;
	if (record.sessionFile !== undefined) entry.sessionFile = record.sessionFile;
	if (record.resultFile !== undefined) entry.resultFile = record.resultFile;
	if (record.result !== undefined) entry.result = record.result;
	if (record.resultTruncated !== undefined) entry.resultTruncated = record.resultTruncated;
	if (record.resultOriginalLength !== undefined) entry.resultOriginalLength = record.resultOriginalLength;
	if (record.error !== undefined) entry.error = record.error;
	if (record.recoveryError !== undefined) entry.recoveryError = record.recoveryError;
	if (record.completedAt !== undefined) entry.completedAt = record.completedAt;
	if (record.parentSession !== undefined) entry.parentSession = { ...record.parentSession };
	if (record.resultConsumed !== undefined) entry.resultConsumed = record.resultConsumed;
	if (record.worktreeReleased !== undefined) entry.worktreeReleased = record.worktreeReleased;
	if (record.worktreeResult !== undefined) {
		entry.worktreeResult = { ...record.worktreeResult, commits: [...record.worktreeResult.commits] };
	}
	if (record.worktree !== undefined) {
		entry.worktree = {
			baseRepo: record.worktree.baseRepo,
			path: record.worktree.path,
			...(record.worktree.checkoutRoot !== undefined ? { checkoutRoot: record.worktree.checkoutRoot } : {}),
			...(record.worktree.baseSha !== undefined ? { baseSha: record.worktree.baseSha } : {}),
			...(record.worktree.branch !== undefined ? { branch: record.worktree.branch } : {}),
		};
	}
	if (record.budgetTimeout !== undefined) entry.budgetTimeout = record.budgetTimeout;
	if (record.budgetIdleTimeout !== undefined) entry.budgetIdleTimeout = record.budgetIdleTimeout;
	if (record.budgetStartedAt !== undefined) entry.budgetStartedAt = record.budgetStartedAt;
	if (record.budgetLastOutputAt !== undefined) entry.budgetLastOutputAt = record.budgetLastOutputAt;
	if (record.budgetExhausted !== undefined) entry.budgetExhausted = record.budgetExhausted;
	if (record.budgetSeconds !== undefined) entry.budgetSeconds = record.budgetSeconds;
	return entry;
}

/** History row for a settled process-backed run. */
export function toHistoryEntry(
	record: AgentRun,
	cwd: string,
	configCwd: string,
	completedAt: number,
): CompletedRunHistoryEntry {
	return {
		...toRegistryEntry(record, cwd, configCwd),
		completedAt,
	};
}

/** Convert a parsed row to a process entry or a raw, non-adoptable record. */
export function coerceRegistryEntry(raw: unknown): PersistedRegistryEntry {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { kind: "incompatible", raw, reason: "registry row is not an object" };
	}
	const candidate = raw as Record<string, unknown>;
	if (
		candidate.backend !== "process" ||
		typeof candidate.id !== "string" ||
		candidate.id.length === 0 ||
		typeof candidate.type !== "string" ||
		typeof candidate.description !== "string" ||
		typeof candidate.cwd !== "string" ||
		typeof candidate.configCwd !== "string" ||
		typeof candidate.owner !== "object" ||
		candidate.owner === null ||
		typeof candidate.startedAt !== "number" ||
		typeof candidate.delivery !== "string"
	) {
		return {
			kind: "incompatible",
			raw,
			reason: "registry row is not a valid process-backed entry",
		};
	}
	const statuses: readonly string[] = ["queued", "starting", "running", "completed", "aborted", "stopped", "error"];
	if (!statuses.includes(candidate.status as string)) {
		return { kind: "incompatible", raw, reason: "registry row has an unknown run status" };
	}
	if (candidate.handle !== undefined && !isSerializableBackendHandle(candidate.handle)) {
		return { kind: "incompatible", raw, reason: "registry row has no valid process control identity" };
	}
	return candidate as unknown as AgentRegistryEntry;
}

export function isSerializableBackendHandle(raw: unknown): raw is SerializableBackendHandle {
	if (typeof raw !== "object" || raw === null) return false;
	const handle = raw as Record<string, unknown>;
	const launcher =
		typeof handle.launcher === "object" && handle.launcher !== null
			? (handle.launcher as Record<string, unknown>)
			: undefined;
	return (
		handle.kind === "process" &&
		typeof handle.childId === "string" &&
		handle.childId.length > 0 &&
		typeof handle.socketPath === "string" &&
		typeof handle.token === "string" &&
		handle.token.length > 0 &&
		typeof handle.runDir === "string" &&
		launcher !== undefined &&
		["herdr", "tmux", "headless"].includes(launcher.kind as string) &&
		launcher.childId === handle.childId
	);
}
