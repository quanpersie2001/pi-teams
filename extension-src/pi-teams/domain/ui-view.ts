// Immutable UI view contracts (ARCH-008).
//
// app/ projects mutable AgentManager state onto these snapshots before any
// feature renderer sees it. Feature modules (features/agent-panel,
// features/agent-view) consume ONLY these types — they never import app/ or
// pi/, and their render paths perform no I/O.
//
// The shapes intentionally mirror docs/ui/AGENT-PANEL-AND-VIEW.md §2: one row
// per named teammate (latest run), or per anonymous AgentRun, with status,
// backend indicator, elapsed, tool uses/turns,
// latest activity, worktree branch and an optional owner reference
// (e.g. "task:auth-fix"). Task-domain semantics never appear here.

import { type AgentRunStatus, isActiveStatus, isTerminalStatus, type UsageSummary } from "./agent-run.js";
import type { ChildControlCommand } from "./child-protocol.js";
import type { TranscriptItem } from "./transcript.js";

/** What the user may currently do with a run — honest capability reporting. */
export interface AgentRowCapabilities {
	/** A native terminal pane can attach to the live child resource. */
	attachable: boolean;
	/** A transcript/result can be shown for this run. */
	viewable: boolean;
	/** A steering message can reach the agent right now. */
	steerable: boolean;
	/** The underlying resource can still be stopped. */
	stoppable: boolean;
	/** The persisted session can be reopened with a new prompt. */
	resumable: boolean;
}
/** Named teammates retain idle native processes; anonymous terminal handles await cleanup. */
export type AgentResourceState = "pending" | "open" | "idle" | "closed" | "cleanup-unconfirmed";

export function deriveResourceState(
	status: AgentRunStatus,
	hasHandle: boolean,
	isNamedTeammate: boolean,
): AgentResourceState {
	if (isTerminalStatus(status)) return hasHandle ? (isNamedTeammate ? "idle" : "cleanup-unconfirmed") : "closed";
	return hasHandle ? "open" : "pending";
}

export interface AgentListRow {
	/** Verified process resource state; closed is only shown after handle removal. */
	resourceState: AgentResourceState;
	id: string;
	type: string;
	/** Current-team identity, preferred over the specialist type in compact rows. */
	teammateName?: string;
	/** Normalized #RRGGBB identity color, when supplied at creation. */
	teammateColor?: string;
	description: string;
	status: AgentRunStatus;
	backend: "process";
	startedAt: number;
	completedAt?: number;
	toolUses: number;
	turns: number;
	/** Authoritative per-run token usage, excluding cache reads. */
	totalTokens: number;
	/** One-line latest activity (e.g. `read login.ts`); absent when unknown. */
	activity?: string;
	/** Worktree branch when the runs executes in isolation. */
	branch?: string;
	/**
	 * Optional owner reference for extension-owned runs, e.g. `pi-tasks:task-123`
	 * or the compact form `task:auth-fix` when the owner id is "task".
	 */
	ownerRef?: string;
	isBackground: boolean;
	capabilities: AgentRowCapabilities;
}

/** Immutable panel snapshot: rows only; selection state lives in the UI host. */
export interface AgentListView {
	rows: readonly AgentListRow[];
	runningCount: number;
	generatedAt: number;
}

/** Immutable transcript-view snapshot for ONE selected run. */
export interface AgentTranscriptView {
	agentId: string;
	type: string;
	teammateName?: string;
	teammateColor?: string;
	description: string;
	status: AgentRunStatus;
	backend: "process";
	resourceState: AgentResourceState;
	startedAt: number;
	completedAt?: number;
	toolUses: number;
	turns: number;
	/** Authoritative cumulative usage reported by this child. */
	usage: UsageSummary;
	items: readonly TranscriptItem[];
	/** True when older items were cut off by the tail window. */
	truncatedHead: boolean;
	capabilities: AgentRowCapabilities;
	generatedAt: number;
}

/** Native child state shown by the focused transcript; absent data is explicit. */
export interface AgentFocusSnapshot {
	runId: string;
	currentRunId: string | null;
	model: string | null;
	thinking: string | null;
	cwd: string | null;
	context: { usedTokens: number | null; windowTokens: number | null } | null;
	capabilities: readonly string[];
	items: readonly TranscriptItem[];
	truncatedHead: boolean;
	closed: boolean;
}

/** Injectable child control boundary; implementations must scope to this run. */
export interface AgentFocusPort {
	read(runId: string): Promise<AgentFocusSnapshot>;
	subscribe(runId: string, listener: () => void): () => void;
	steer(runId: string, message: string): Promise<void>;
	abort(runId: string): Promise<void>;
	control(runId: string, command: ChildControlCommand): Promise<AgentFocusSnapshot>;
	continue(runId: string, message: string): Promise<{ runId: string }>;
}

/**
 * Honest capability derivation: live queued/starting/running process handles
 * can be controlled, while completed sessions require a persisted session
 * file before resume is offered.
 */
export function deriveCapabilities(input: {
	status: AgentRunStatus;
	hasHandle: boolean;
	hasSessionFile: boolean;
	attachable?: boolean;
}): AgentRowCapabilities {
	const active = isActiveStatus(input.status);
	const actionable = active && (input.hasHandle || input.status === "queued");
	return {
		attachable: input.attachable ?? false,
		viewable: input.hasHandle || input.hasSessionFile || isTerminalStatus(input.status),
		steerable: actionable,
		stoppable: actionable,
		resumable: isTerminalStatus(input.status) && input.hasSessionFile,
	};
}

/**
 * Owner reference label shown on the row. Extension owners render as
 * `id:ref`; the common pi-tasks shape collapses to `task:<ref>` so rows read
 * like the design mock (`task:auth-fix`). Conversation owners have none.
 */
export function ownerRefLabel(owner: { kind: string; id?: string; ref?: string }): string | undefined {
	if (owner.kind !== "extension") return undefined;
	const ref = typeof owner.ref === "string" ? owner.ref.trim() : "";
	if (!ref) return undefined;
	return owner.id === "task" ? `task:${ref}` : `${owner.id ?? "ext"}:${ref}`;
}
