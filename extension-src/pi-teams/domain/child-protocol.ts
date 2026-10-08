import type { ThinkingLevel } from "./agent-definition.js";
import type { UsageSummary } from "./agent-run.js";
import type { TranscriptItem, TranscriptSnapshot } from "./transcript.js";

export const CHILD_PROTOCOL_VERSION = 2 as const;
export const CHILD_MAX_FRAME_BYTES = 1024 * 1024;
export const CHILD_MAX_ID_LENGTH = 128;

export type ChildExecution = "idle" | "running";
export type ChildOutcomeStatus = "completed" | "stopped" | "failed";
export type ChildEventName =
	| "run_started"
	| "run_settled"
	| "transcript"
	| "activity"
	| "usage"
	| "focus"
	| "mailbox_assignment";
export type ChildRpcMethod =
	| "hello"
	| "state"
	| "prompt"
	| "steer"
	| "abort"
	| "control"
	| "shutdown"
	| "admit_assignment";

export interface ChildBootstrap {
	childId: string;
	token: string;
	socketPath: string;
	/** Native InteractiveMode terminal transport; absent for SDK-only headless execution. */
	terminalSocketPath?: string;
	/** Loaded Main extension paths; native workers allowlist pi-style, never orchestration. */
	presentationExtensionPaths?: string[];
	sessionDir: string;
	sessionFile?: string;
	cwd: string;
	configCwd: string;
	systemPrompt: string;
	promptMode: "replace" | "append";
	instructions?: string;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	maxTurns?: number;
	graceTurns?: number;
	/** Team directory `.pi/teams/t/<team-id>/`; present for named teammates (mailbox/board context, ADR 0007). */
	teamDir?: string;
	/** Per-team mailbox HMAC key; delivered only through the authenticated bootstrap file (0600). */
	teamKey?: string;
	/** This child's teammate name (its mailbox address). */
	teammateName?: string;
	/** Normalized #RRGGBB runtime identity color. */
	teammateColor?: string;
}

export interface ChildOutcome {
	runId: string;
	status: ChildOutcomeStatus;
	result?: string;
	resultTruncated?: boolean;
	resultOriginalLength?: number;
	/** Absolute path of the full-result artifact (result.md) written at settlement; additive (protocol v2 unchanged). */
	resultFile?: string;
	error?: string;
	errorTruncated?: boolean;
	errorOriginalLength?: number;
}

export interface ChildTranscriptSnapshot extends TranscriptSnapshot {
	/** Absolute ordinal of the first item in the bounded retained tail. */
	offset: number;
	/** True when older transcript content or individual item output was truncated. */
	truncated: boolean;
}

export interface ChildFocusModel {
	provider: string;
	id: string;
	name: string;
}

export interface ChildState {
	childId: string;
	teammateName?: string;
	teammateColor?: string;
	pid: number;
	sessionFile?: string;
	execution: ChildExecution;
	currentRunId?: string;
	lastOutcome?: ChildOutcome;
	transcript: ChildTranscriptSnapshot;
	seq: number;
	usage?: UsageSummary;
	turns?: number;
	toolUses?: number;
	focus?: {
		cwd: string;
		model?: ChildFocusModel;
		thinking: ThinkingLevel;
		context?: { tokens: number; contextWindow: number; percent: number };
		stats?: {
			userMessages: number;
			assistantMessages: number;
			toolCalls: number;
			toolResults: number;
			totalMessages: number;
			tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
			cost: number;
		};
		capabilities: {
			models: readonly ChildFocusModel[];
			thinking: readonly ThinkingLevel[];
			commands: readonly ("model" | "thinking" | "compact")[];
		};
	};
}

export type ChildControlCommand =
	| { type: "model"; model: string }
	| { type: "thinking"; thinking: ThinkingLevel }
	| { type: "compact" };

export interface ChildEvent {
	type: "event";
	seq: number;
	childId: string;
	runId?: string;
	event: ChildEventName;
	payload: Record<string, unknown>;
}

export interface ChildIdentity {
	protocolVersion: typeof CHILD_PROTOCOL_VERSION;
	childId: string;
	token: string;
}

export interface ChildRequest {
	id: string;
	method: ChildRpcMethod;
	params: Record<string, unknown>;
}

export interface ChildRpcError {
	code: string;
	message: string;
}

export interface ChildSuccessReply {
	id: string;
	ok: true;
	result: unknown;
}

export interface ChildFailureReply {
	id: string;
	ok: false;
	error: ChildRpcError;
}

export type ChildReply = ChildSuccessReply | ChildFailureReply;

export interface ChildStateEnvelope {
	identity: { protocolVersion: typeof CHILD_PROTOCOL_VERSION; childId: string };
	state: ChildState;
}

export class ChildProtocolError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ChildProtocolError";
		this.code = code;
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireString(value: unknown, field: string, maxLength = CHILD_MAX_ID_LENGTH): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
		throw new ChildProtocolError(
			"invalid_request",
			`${field} must be a non-empty string of at most ${maxLength} characters`,
		);
	}
	return value;
}

export function parseChildRequest(value: unknown): ChildRequest {
	if (!isRecord(value)) throw new ChildProtocolError("invalid_request", "Request must be a JSON object");
	const id = requireString(value.id, "id");
	const method = value.method;
	if (
		method !== "hello" &&
		method !== "state" &&
		method !== "prompt" &&
		method !== "steer" &&
		method !== "abort" &&
		method !== "control" &&
		method !== "admit_assignment" &&
		method !== "shutdown"
	) {
		throw new ChildProtocolError("invalid_request", "Unknown child RPC method");
	}
	if (!isRecord(value.params)) throw new ChildProtocolError("invalid_request", "params must be a JSON object");
	return { id, method, params: value.params };
}

export function parseChildIdentity(value: unknown): ChildIdentity {
	if (!isRecord(value)) throw new ChildProtocolError("unauthorized", "Invalid child identity");
	if (value.protocolVersion !== CHILD_PROTOCOL_VERSION) {
		throw new ChildProtocolError("protocol_mismatch", "Unsupported child protocol version");
	}
	return {
		protocolVersion: CHILD_PROTOCOL_VERSION,
		childId: requireString(value.childId, "childId"),
		token: requireString(value.token, "token", 512),
	};
}

function assertChildFocus(value: unknown): boolean {
	if (!isRecord(value) || typeof value.cwd !== "string" || value.cwd.length === 0) return false;
	if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value.thinking))) return false;
	if (value.model !== undefined) {
		if (!isRecord(value.model)) return false;
		if (
			typeof value.model.provider !== "string" ||
			typeof value.model.id !== "string" ||
			typeof value.model.name !== "string"
		)
			return false;
	}
	if (value.context !== undefined) {
		if (!isRecord(value.context)) return false;
		if (
			typeof value.context.tokens !== "number" ||
			!Number.isFinite(value.context.tokens) ||
			typeof value.context.contextWindow !== "number" ||
			!Number.isFinite(value.context.contextWindow) ||
			typeof value.context.percent !== "number" ||
			!Number.isFinite(value.context.percent)
		)
			return false;
	}
	if (
		!isRecord(value.capabilities) ||
		!Array.isArray(value.capabilities.models) ||
		!Array.isArray(value.capabilities.thinking) ||
		!Array.isArray(value.capabilities.commands)
	)
		return false;
	if (
		!value.capabilities.models.every(
			(model) =>
				isRecord(model) &&
				typeof model.provider === "string" &&
				typeof model.id === "string" &&
				typeof model.name === "string",
		)
	)
		return false;
	if (
		!value.capabilities.thinking.every((level) =>
			["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(level)),
		)
	)
		return false;
	if (
		!value.capabilities.commands.every(
			(command) => command === "model" || command === "thinking" || command === "compact",
		)
	)
		return false;
	if (value.stats !== undefined) {
		if (!isRecord(value.stats) || !isRecord(value.stats.tokens)) return false;
		for (const name of ["userMessages", "assistantMessages", "toolCalls", "toolResults", "totalMessages", "cost"]) {
			if (typeof value.stats[name] !== "number" || !Number.isFinite(value.stats[name])) return false;
		}
		for (const name of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
			if (typeof value.stats.tokens[name] !== "number" || !Number.isFinite(value.stats.tokens[name])) return false;
		}
	}
	return true;
}
export function assertChildState(value: unknown, expectedChildId: string): ChildState {
	if (!isRecord(value) || value.childId !== expectedChildId) {
		throw new ChildProtocolError("identity_mismatch", "Child state identity does not match the connected child");
	}
	if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) {
		throw new ChildProtocolError("invalid_state", "Child state has an invalid pid");
	}
	if (value.execution !== "idle" && value.execution !== "running") {
		throw new ChildProtocolError("invalid_state", "Child state has an invalid execution status");
	}
	if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0) {
		throw new ChildProtocolError("invalid_state", "Child state has an invalid event sequence");
	}
	if (value.teammateName !== undefined && typeof value.teammateName !== "string") {
		throw new ChildProtocolError("invalid_state", "Child teammate name is invalid");
	}
	if (
		value.teammateColor !== undefined &&
		(typeof value.teammateColor !== "string" || !/^#[\da-f]{6}$/.test(value.teammateColor))
	) {
		throw new ChildProtocolError("invalid_state", "Child teammate color is invalid");
	}
	if (value.focus !== undefined && !assertChildFocus(value.focus)) {
		throw new ChildProtocolError("invalid_state", "Child focus metadata is invalid");
	}
	if (
		!isRecord(value.transcript) ||
		!Array.isArray(value.transcript.items) ||
		!value.transcript.items.every(isTranscriptItem) ||
		!Number.isSafeInteger(value.transcript.cursor) ||
		!Number.isSafeInteger(value.transcript.offset) ||
		typeof value.transcript.truncated !== "boolean"
	) {
		throw new ChildProtocolError("invalid_state", "Child state has an invalid transcript snapshot");
	}
	if (
		(value.transcript.offset as number) < 0 ||
		(value.transcript.cursor as number) < 0 ||
		(value.transcript.offset as number) + value.transcript.items.length !== value.transcript.cursor
	) {
		throw new ChildProtocolError("invalid_state", "Child transcript offsets are inconsistent");
	}
	if (value.execution === "running" && typeof value.currentRunId !== "string") {
		throw new ChildProtocolError("invalid_state", "Running child state has no current run id");
	}
	return value as unknown as ChildState;
}

export function encodeChildFrame(value: unknown, maxBytes = CHILD_MAX_FRAME_BYTES): Buffer {
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch {
		throw new ChildProtocolError("invalid_frame", "Message is not JSON serializable");
	}
	if (json === undefined) throw new ChildProtocolError("invalid_frame", "Message is not JSON serializable");
	const frame = Buffer.from(`${json}\n`, "utf8");
	if (frame.byteLength > maxBytes)
		throw new ChildProtocolError("frame_too_large", "Child protocol frame exceeds the configured limit");
	return frame;
}

export function decodeChildFrame(line: Buffer, maxBytes = CHILD_MAX_FRAME_BYTES): unknown {
	if (line.byteLength > maxBytes)
		throw new ChildProtocolError("frame_too_large", "Child protocol frame exceeds the configured limit");
	try {
		return JSON.parse(line.toString("utf8")) as unknown;
	} catch {
		throw new ChildProtocolError("invalid_frame", "Child protocol frame is not valid JSON");
	}
}

export function isTranscriptItem(value: unknown): value is TranscriptItem {
	return (
		isRecord(value) &&
		(value.kind === "user" ||
			value.kind === "assistant" ||
			value.kind === "toolCall" ||
			value.kind === "toolResult" ||
			value.kind === "system") &&
		typeof value.timestamp === "number" &&
		(value.id === undefined || (typeof value.id === "string" && value.id.length > 0)) &&
		(value.revision === undefined || (Number.isSafeInteger(value.revision) && (value.revision as number) >= 0)) &&
		(value.partial === undefined || typeof value.partial === "boolean") &&
		(value.partial !== true || (typeof value.id === "string" && Number.isSafeInteger(value.revision)))
	);
}

export function isTranscriptSnapshot(value: unknown): value is TranscriptSnapshot {
	return (
		isRecord(value) &&
		Array.isArray(value.items) &&
		value.items.every(isTranscriptItem) &&
		Number.isSafeInteger(value.cursor)
	);
}

export function isChildEvent(value: unknown, childId: string): value is ChildEvent {
	return (
		isRecord(value) &&
		value.type === "event" &&
		value.childId === childId &&
		Number.isSafeInteger(value.seq) &&
		(value.seq as number) > 0 &&
		(value.event === "run_started" ||
			value.event === "run_settled" ||
			value.event === "transcript" ||
			value.event === "activity" ||
			value.event === "usage" ||
			value.event === "mailbox_assignment" ||
			value.event === "focus") &&
		isRecord(value.payload) &&
		(value.runId === undefined || typeof value.runId === "string")
	);
}
