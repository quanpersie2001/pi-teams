// Versioned public integration protocol for cross-extension consumers
// (pi-tasks is the reference consumer).
//
// Transport: pi.events RPC channels `subagents:rpc:<op>` with request-scoped
// reply channels `subagents:rpc:<op>:reply:<requestId>` and a success/error
// envelope. Lifecycle is broadcast as owner-aware events so extension-owned
// runs keep receiving results even after the spawning conversation is gone.

import type { AgentRun, AgentRunStatus, UsageSummary } from "./agent-run.js";
import type { AgentOwner, DeliveryPolicy, ParentSessionRef } from "./delivery.js";
import type { TimeBudgetKind } from "./time-policy.js";
import type { WorktreeInfo, WorktreeResult } from "./worktree.js";

/** Bumped when the envelope or any method/event contract changes. */
export const PROTOCOL_VERSION = 3 as const;

/** Serializable projection of an AgentRun for status queries and events. */
export interface AgentRunSnapshot {
	id: string;
	type: string;
	description: string;
	status: AgentRunStatus;
	backend: "process";
	model?: string;
	modelFallback?: string;
	sessionFile?: string;
	/** Absolute path of the run's full-result artifact; additive optional (protocol v3 unchanged). */
	resultFile?: string;
	result?: string;
	error?: string;
	recoveryError?: string;
	startedAt: number;
	completedAt?: number;
	durationMs?: number;
	toolUses: number;
	turns: number;
	usage: UsageSummary;
	owner: AgentOwner;
	delivery: DeliveryPolicy;
	parentSession?: ParentSessionRef;
	worktree?: WorktreeInfo;
	worktreeResult?: WorktreeResult;
	worktreeReleased?: boolean;
	/** Budget whose expiry stopped the run; additive optional (protocol v3 unchanged). */
	budgetExhausted?: TimeBudgetKind;
	/** Seconds of the exhausted budget. */
	budgetSeconds?: number;
}

export function toRunSnapshot(run: AgentRun): AgentRunSnapshot {
	const snapshot: AgentRunSnapshot = {
		id: run.id,
		type: run.type,
		description: run.description,
		status: run.status,
		backend: run.backend,
		startedAt: run.startedAt,
		toolUses: run.toolUses,
		turns: run.turns,
		usage: { ...run.usage },
		owner: { ...run.owner },
		delivery: run.delivery,
	};
	if (run.model !== undefined) snapshot.model = run.model;
	if (run.modelFallback !== undefined) snapshot.modelFallback = run.modelFallback;
	if (run.sessionFile !== undefined) snapshot.sessionFile = run.sessionFile;
	if (run.resultFile !== undefined) snapshot.resultFile = run.resultFile;
	if (run.result !== undefined) snapshot.result = run.result;
	if (run.error !== undefined) snapshot.error = run.error;
	if (run.recoveryError !== undefined) snapshot.recoveryError = run.recoveryError;
	if (run.completedAt !== undefined) {
		snapshot.completedAt = run.completedAt;
		snapshot.durationMs = Math.max(0, run.completedAt - run.startedAt);
	}
	if (run.parentSession !== undefined) snapshot.parentSession = { ...run.parentSession };
	if (run.worktree !== undefined) snapshot.worktree = { ...run.worktree };
	if (run.worktreeResult !== undefined) snapshot.worktreeResult = { ...run.worktreeResult };
	if (run.worktreeReleased !== undefined) snapshot.worktreeReleased = run.worktreeReleased;
	if (run.budgetExhausted !== undefined) snapshot.budgetExhausted = run.budgetExhausted;
	if (run.budgetSeconds !== undefined) snapshot.budgetSeconds = run.budgetSeconds;
	return snapshot;
}

export type AgentLifecycleEventName = "started" | "completed" | "failed" | "stopped" | "restored";

/** Owner-aware lifecycle event payload (events `subagents:<name>`). */
export interface AgentLifecycleEvent {
	protocolVersion: number;
	event: AgentLifecycleEventName;
	agentId: string;
	type: string;
	description: string;
	status: AgentRunStatus;
	model?: string;
	modelFallback?: string;
	owner: AgentOwner;
	delivery: DeliveryPolicy;
	result?: string;
	error?: string;
	recoveryError?: string;
	worktreeReleased?: boolean;
	parentSession?: ParentSessionRef;
	sessionFile?: string;
	/** Absolute path of the run's full-result artifact; additive optional (protocol v3 unchanged). */
	resultFile?: string;
	worktree?: WorktreeInfo;
	worktreeResult?: WorktreeResult;
	usage: UsageSummary;
	startedAt: number;
	completedAt?: number;
	durationMs?: number;
	/** Budget whose expiry stopped the run; additive optional (protocol v3 unchanged). */
	budgetExhausted?: TimeBudgetKind;
	/** Seconds of the exhausted budget. */
	budgetSeconds?: number;
}

/** Base shape of every RPC payload: carries the caller's correlation id. */
export interface RpcRequest {
	requestId: string;
}

/** RPC reply envelope — success carries optional data, failure an error string. */
export type RpcReply<T = void> = { success: true; data?: T } | { success: false; error: string };

export type SubagentsRpcOp = "ping" | "spawn" | "status" | "steer" | "stop" | "resume" | "release";

export const SUBAGENTS_RPC_OPS: readonly SubagentsRpcOp[] = [
	"ping",
	"spawn",
	"status",
	"steer",
	"stop",
	"resume",
	"release",
];

/** Request channel for an RPC operation. */
export function subagentsRpcChannel(op: SubagentsRpcOp | string): string {
	return `subagents:rpc:${op}`;
}

/** Request-scoped reply channel for an RPC operation. */
export function subagentsRpcReplyChannel(op: SubagentsRpcOp | string, requestId: string): string {
	return `subagents:rpc:${op}:reply:${requestId}`;
}

/** Success reply helper; omits `data` when undefined. */
export function rpcSuccess<T>(data?: T): RpcReply<T> {
	if (data === undefined) return { success: true };
	return { success: true, data };
}

/** Error reply helper. */
export function rpcError(error: unknown): RpcReply<never> {
	const message = error instanceof Error ? error.message : String(error);
	return { success: false, error: message || String(error) };
}
