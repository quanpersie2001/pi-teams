// Execution backend abstraction for independently hosted child processes.
//
// Every specialist runs in a separate OS process and is controlled through
// the process backend; terminal launchers only create, attach, or terminate.

import type { IsolationPolicy, PromptMode, ThinkingLevel } from "./agent-definition.js";
import type { UsageSummary } from "./agent-run.js";
import type { ChildControlCommand, ChildState } from "./child-protocol.js";
import type { ChildMessageReply, ChildMessageRequest, InboxMessage } from "./message.js";
import type { TranscriptSnapshot } from "./transcript.js";
import type { WorktreeInfo } from "./worktree.js";

/** Input for launching a specialist agent in a child process. */
export interface AgentLaunchInput {
	runId: string;
	type: string;
	description: string;
	prompt: string;
	systemPrompt: string;
	promptMode: PromptMode;
	instructions?: string;
	model?: string;
	modelFallback?: string;
	thinking?: ThinkingLevel;
	/** Built-in tool allowlist; undefined = default toolset. */
	tools?: readonly string[];
	/** Turn limit; 0/undefined = unlimited. */
	maxTurns?: number;
	/** Grace turns allowed after the soft-limit steer; default 0. From settings.graceTurns. */
	graceTurns?: number;
	cwd: string;
	configCwd: string;
	background: boolean;
	/** Requested isolation policy, with an optional prepared checkout. */
	isolation?: IsolationPolicy;
	worktree?: WorktreeInfo;
}

/** Opaque process-backend handle. */
export interface AgentBackendHandle {
	kind: "process";
	handle: string;
}

/** Native execution observation or verified child loss; launcher liveness never means completion. */
export interface BackendStatus {
	state: "starting" | "running" | "completed" | "failed" | "stopped" | "timeout" | "disconnected";
	model?: string;
	modelFallback?: string;
	detail?: string;
	result?: string;
	error?: string;
	/** Verified child loss without a recovered RPC outcome; must not replace a persisted terminal outcome. */
	outcomeUnavailable?: true;
	/** Persisted session path, once available for future cold resume. */
	sessionFile?: string;
	usage?: UsageSummary;
	turns?: number;
	toolUses?: number;
}

/** Input for cold-resuming a persisted session as a new child run. */
export interface AgentResumeInput {
	runId: string;
	sessionFile: string;
	prompt: string;
	cwd: string;
	background: boolean;
	model?: string;
	modelFallback?: string;
}

/** Model/auth admission must finish before allocating a run or child resource. */
export interface ModelAdmissionInput {
	model?: string;
	/** Caller model ignored by a definition pin can still serve as a fallback. */
	fallbackModel?: string;
	/** Cold resume prefers its saved bootstrap model when no model is supplied. */
	sessionFile?: string;
}

export interface ModelAdmission {
	model: string;
	/** Human-readable reason and requested model when admission selected a fallback. */
	fallback?: string;
}

export interface AgentExecutionBackend {
	kind: "process";
	available(): Promise<boolean>;
	prepareModel(input: ModelAdmissionInput): Promise<ModelAdmission>;
	launch(input: AgentLaunchInput): Promise<AgentBackendHandle>;
	status(handle: AgentBackendHandle): Promise<BackendStatus>;
	steer(handle: AgentBackendHandle, message: string): Promise<boolean>;
	stop(handle: AgentBackendHandle): Promise<boolean>;
	resume(input: AgentResumeInput): Promise<AgentBackendHandle>;
	readTranscript(handle: AgentBackendHandle): Promise<TranscriptSnapshot>;
	subscribe(handle: AgentBackendHandle, listener: (status: BackendStatus) => void): () => void;
	readFocusState?(handle: AgentBackendHandle): Promise<ChildState | undefined>;
	controlFocus?(handle: AgentBackendHandle, command: ChildControlCommand): Promise<ChildState>;
	subscribeFocus?(handle: AgentBackendHandle, listener: (state: ChildState) => void): () => void;
	sendInbox?(handle: AgentBackendHandle, message: InboxMessage): Promise<boolean>;
	subscribeMessages?(
		handle: AgentBackendHandle,
		listener: (request: ChildMessageRequest) => Promise<ChildMessageReply>,
	): () => void;
	attach?(handle: AgentBackendHandle): Promise<boolean>;
	dispose(handle: AgentBackendHandle): Promise<void>;
	detach(handle: AgentBackendHandle): void;
	/**
	 * Hard time-budget enforcement (roadmap 1.1): verified termination of an
	 * OWNED child that ignored the cooperative abort. Budget-only — ordinary
	 * user stop semantics never call this. Implementation must verify the
	 * cached/authenticated child identity and launcher ownership without RPC
	 * (a frozen child cannot answer), terminate the owned process group,
	 * escalate to a forced kill when the group survives the graceful signal,
	 * and resolve with the final authoritative status (partial session/usage
	 * preserved) only after the exit is verified. Identity refusal, unsupported
	 * transport, or unverifiable termination must THROW — a visible failure
	 * with a retained receipt — never a fabricated outcome.
	 */
	enforceTerminate?(handle: AgentBackendHandle, graceMs: number): Promise<BackendStatus>;
}
