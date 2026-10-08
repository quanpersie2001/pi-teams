// AgentRun domain model and lifecycle state machine.
//
// AgentRun is the execution record of one specialist invocation. It contains no
// task-domain fields (title, dependencies, priority, acceptance criteria) —
// those belong to pi-tasks, which maps its Task state onto these statuses.

import type { AgentBackendHandle } from "./backend.js";
import type { AgentOwner, DeliveryPolicy, ParentSessionRef } from "./delivery.js";
import type { TimeBudgetKind } from "./time-policy.js";
import type { WorktreeInfo, WorktreeResult } from "./worktree.js";

export type AgentRunStatus = "queued" | "starting" | "running" | "completed" | "aborted" | "stopped" | "error";

export type AgentRunBackend = "process";

/** Token usage accumulated across the run. totalTokens excludes cacheRead. */
export interface UsageSummary {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
}

export const EMPTY_USAGE: UsageSummary = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
};

/**
 * A single execution instance of a specialist agent. All fields are
 * serializable so the run registry can persist and restore runs.
 */
export interface AgentRun {
	id: string;
	type: string;
	description: string;
	status: AgentRunStatus;
	/** Teammate address this run was spawned under (ADR 0007 §2); unset for anonymous runs. */
	teammateName?: string;
	/** Teammate identity color, normalized to lowercase #RRGGBB. */
	teammateColor?: string;

	backend: AgentRunBackend;
	handle?: AgentBackendHandle;
	/** Canonical model actually admitted for this invocation. */
	model?: string;
	modelFallback?: string;
	sessionFile?: string;
	result?: string;
	/** Absolute path of the child's full-result artifact (result.md); the inline `result` stays preview-bounded. */
	resultFile?: string;
	/** True when `result` is the truncated inline copy of a longer final answer. */
	resultTruncated?: boolean;
	/** Original character length of the final answer when `result` is truncated. */
	resultOriginalLength?: number;
	error?: string;
	/** Worktree-preservation or durable-recovery failure that did not change the child outcome. */
	recoveryError?: string;

	startedAt: number;
	completedAt?: number;
	toolUses: number;
	turns: number;
	usage: UsageSummary;

	owner: AgentOwner;
	delivery: DeliveryPolicy;
	parentSession?: ParentSessionRef;

	worktree?: WorktreeInfo;
	worktreeResult?: WorktreeResult;
	worktreeReleased?: boolean;

	// -- Delivery bookkeeping --------------------------------------------------

	/** True when the run was spawned detached (occupies a maxConcurrent slot). */
	isBackground?: boolean;
	/** Set by get_subagent_result once the model has read a terminal result. */
	resultConsumed?: boolean;

	// -- Hard time budgets (roadmap 1.1; seconds; 0 = unlimited) ---------------

	/**
	 * Effective wall-clock budget frozen at admission (invocation > definition >
	 * settings). Presence marks the frozen snapshot — including 0 = unlimited —
	 * so resume/restore never re-resolve changed definitions/settings.
	 */
	budgetTimeout?: number;
	/** Effective idle budget frozen at admission; 0 = unlimited. */
	budgetIdleTimeout?: number;
	/** Epoch ms the frozen budgets began counting: immediately before backend.launch/resume. */
	budgetStartedAt?: number;
	/** Epoch ms of the last counted child output (assistant message or completed tool result). */
	budgetLastOutputAt?: number;
	/** Budget whose expiry made the watchdog stop this run; kept only when the run actually stopped. */
	budgetExhausted?: TimeBudgetKind;
	/** Seconds of the exhausted budget at expiry. */
	budgetSeconds?: number;
}

/** Lifecycle events driving the run status machine. Payloads are informational. */
export type AgentRunEvent =
	| { type: "start"; at?: number }
	| { type: "launched"; at?: number }
	| {
			type: "complete";
			result?: string;
			resultFile?: string;
			resultTruncated?: boolean;
			resultOriginalLength?: number;
	  }
	| { type: "stop" }
	| { type: "abort" }
	| { type: "fail"; error?: string };

export type AgentRunEventType = AgentRunEvent["type"];

const TERMINAL_STATUSES: readonly AgentRunStatus[] = ["completed", "stopped", "aborted", "error"];

export function isTerminalStatus(status: AgentRunStatus): boolean {
	return TERMINAL_STATUSES.includes(status);
}

export function isActiveStatus(status: AgentRunStatus): boolean {
	return !isTerminalStatus(status);
}

/**
 * Child RPC is the source of running/settled state. Steer commands do not
 * create an intermediate run status.
 */
export const AGENT_RUN_TRANSITIONS: Readonly<
	Record<AgentRunStatus, Readonly<Partial<Record<AgentRunEventType, AgentRunStatus>>>>
> = {
	queued: { start: "starting", stop: "stopped", fail: "error" },
	starting: { launched: "running", complete: "completed", stop: "stopped", abort: "aborted", fail: "error" },
	running: {
		complete: "completed",
		stop: "stopped",
		abort: "aborted",
		fail: "error",
	},
	completed: {},
	stopped: {},
	aborted: {},
	error: {},
};

/**
 * Pure status transition. Throws on any transition not present in the table —
 * including every event applied to a terminal status.
 */
export function transition(state: AgentRunStatus, event: AgentRunEvent): AgentRunStatus {
	const next = AGENT_RUN_TRANSITIONS[state][event.type];
	if (next === undefined) {
		throw new Error(`invalid AgentRun transition: ${state} cannot accept event "${event.type}"`);
	}
	return next;
}
