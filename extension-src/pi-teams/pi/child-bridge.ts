import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decideTurnEvent, SOFT_STEER_MESSAGE } from "../app/turn-policy.js";
import { EMPTY_USAGE, type UsageSummary } from "../domain/agent-run.js";
import {
	CHILD_MAX_FRAME_BYTES,
	CHILD_PROTOCOL_VERSION,
	type ChildBootstrap,
	type ChildControlCommand,
	type ChildEvent,
	type ChildEventName,
	type ChildOutcome,
	ChildProtocolError,
	type ChildReply,
	type ChildRequest,
	type ChildState,
	type ChildStateEnvelope,
	type ChildTranscriptSnapshot,
	encodeChildFrame,
	isRecord,
	parseChildIdentity,
	parseChildRequest,
	requireString,
} from "../domain/child-protocol.js";
import type { ChildMessageReply, ChildMessageRequest, InboxMessage, MessageEndpoint } from "../domain/message.js";
import type { TranscriptItem } from "../domain/transcript.js";

const MAX_TRANSCRIPT_ITEMS = 256;
const MAX_PARTIAL_ITEMS = 16;
const MAX_TRANSCRIPT_STATE_BYTES = 768 * 1024;
const MAX_TEXT_CHARS = 8_192;
const MAX_REQUESTS = 512;
const MAX_CONNECTIONS = 16;
const MAX_SOCKET_PATH_BYTES = process.platform === "darwin" ? 103 : 107;
const CHILD_ENV = "PI_TEAMS_CHILD";
const BOOTSTRAP_ENV = "PI_TEAMS_BOOTSTRAP";
// Session-bound lifetime (ADR 0007 §1): losing the authenticated control
// socket is the local parent-death signal. A short reconnect grace absorbs
// the parent's own client reconnect; staying silent past it means the parent
// is gone and the child stops itself.
const CONTROL_LOSS_GRACE_MS = 5_000;
/** Bounded wait for a cooperative abort to settle before force-preserving. */
const CONTROL_LOSS_SETTLE_MS = 5_000;
/** Last-resort exit if a wedged host shutdown outlives the annotation. */
const CONTROL_LOSS_EXIT_MS = 3_000;
const CONTROL_LOSS_POLL_MS = 100;
/** First line of the preserved artifact when the parent control socket is lost. */
const CONTROL_LOSS_ANNOTATION = "stopped: parent control lost";
const SOFT_LIMIT_NOTICE = "subagents: soft turn limit reached — steering the agent to wrap up.";
const HARD_LIMIT_NOTICE = "subagents: hard turn limit reached — aborting the agent.";

export interface ChildBridgeHost {
	getSessionFile(): string | undefined;
	getTranscript(): readonly TranscriptItem[];
	getFocus(): NonNullable<ChildState["focus"]>;
	controlFocus(command: ChildControlCommand): Promise<void>;
	sendInbox(message: InboxMessage): Promise<void>;
	prompt(prompt: string): Promise<void>;
	steer(message: string): Promise<void>;
	abort(): Promise<void>;
	shutdown(): Promise<void>;
}
export interface ChildBridgeNativeEvent {
	type: string;
	message?: unknown;
	messages?: unknown;
	toolName?: unknown;
	toolCallId?: unknown;
	args?: unknown;
	result?: unknown;
	partialResult?: unknown;
	isError?: unknown;
	willRetry?: unknown;
	turnIndex?: unknown;
	attempt?: unknown;
	errorMessage?: unknown;
}
export function normalizeChildNativeEvent(value: unknown): ChildBridgeNativeEvent | undefined {
	if (!isRecord(value) || typeof value.type !== "string") return undefined;
	return {
		type: value.type,
		...(value.message !== undefined ? { message: value.message } : {}),
		...(value.messages !== undefined ? { messages: value.messages } : {}),
		...(value.toolName !== undefined ? { toolName: value.toolName } : {}),
		...(value.toolCallId !== undefined ? { toolCallId: value.toolCallId } : {}),
		...(value.args !== undefined ? { args: value.args } : {}),
		...(value.result !== undefined ? { result: value.result } : {}),
		...(value.partialResult !== undefined ? { partialResult: value.partialResult } : {}),
		...(value.isError !== undefined ? { isError: value.isError } : {}),
		...(value.willRetry !== undefined ? { willRetry: value.willRetry } : {}),
		...(value.turnIndex !== undefined ? { turnIndex: value.turnIndex } : {}),
		...(value.attempt !== undefined ? { attempt: value.attempt } : {}),
		...(value.errorMessage !== undefined ? { errorMessage: value.errorMessage } : {}),
	};
}

export interface ChildBridgeHandle {
	state(): ChildState;
	publishNativeEvent(event: ChildBridgeNativeEvent): void;
	failActiveRun(error: unknown): void;
	close(): Promise<void>;
}

interface JsonBudget {
	nodes: number;
	bytes: number;
	truncated: boolean;
}

interface ChildSocketHandle {
	server: Server;
	clients: Set<Socket>;
	socketPath: string;
	/** Marks the socket as intentionally closing; disarms the control-loss watch. */
	beginIntentionalClose(): void;
}

function parseOptionalString(record: Record<string, unknown>, field: string, maxLength = 32_768): string | undefined {
	const value = record[field];
	if (value === undefined) return undefined;
	return requireString(value, field, maxLength);
}
function isThinkingLevel(value: string): value is NonNullable<ChildBootstrap["thinking"]> {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
	);
}

export function parseChildBootstrap(value: unknown): ChildBootstrap {
	if (!isRecord(value)) throw new ChildProtocolError("invalid_bootstrap", "Child bootstrap must be a JSON object");
	const childId = requireString(value.childId, "childId");
	const token = requireString(value.token, "token", 512);
	if (token.length < 16) throw new ChildProtocolError("invalid_bootstrap", "Child bootstrap token is too short");
	const socketPath = requireString(value.socketPath, "socketPath", 4_096);
	if (!isAbsolute(socketPath) || Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
		throw new ChildProtocolError(
			"invalid_bootstrap",
			`Child socketPath must be absolute and fit in ${MAX_SOCKET_PATH_BYTES} UTF-8 bytes`,
		);
	}
	const sessionDir = requireString(value.sessionDir, "sessionDir", 4_096);
	const cwd = requireString(value.cwd, "cwd", 4_096);
	const configCwd = requireString(value.configCwd, "configCwd", 4_096);
	if (![sessionDir, cwd, configCwd].every(isAbsolute))
		throw new ChildProtocolError("invalid_bootstrap", "sessionDir, cwd, and configCwd must be absolute paths");
	const systemPrompt = typeof value.systemPrompt === "string" ? value.systemPrompt : "";
	if (systemPrompt.length > 262_144)
		throw new ChildProtocolError("invalid_bootstrap", "systemPrompt exceeds the supported size");
	if (value.promptMode !== "replace" && value.promptMode !== "append")
		throw new ChildProtocolError("invalid_bootstrap", "promptMode must be replace or append");
	const instructions = parseOptionalString(value, "instructions", 262_144);
	const model = parseOptionalString(value, "model", 1_024);
	const thinkingValue = parseOptionalString(value, "thinking", 64);
	if (thinkingValue !== undefined && !isThinkingLevel(thinkingValue)) {
		throw new ChildProtocolError("invalid_bootstrap", "thinking must be a supported Pi thinking level");
	}
	const thinking = thinkingValue;
	const sessionFile = parseOptionalString(value, "sessionFile", 4_096);
	if (sessionFile !== undefined && !isAbsolute(sessionFile))
		throw new ChildProtocolError("invalid_bootstrap", "sessionFile must be an absolute path");
	let tools: string[] | undefined;
	if (value.tools !== undefined) {
		if (
			!Array.isArray(value.tools) ||
			value.tools.length > 128 ||
			!value.tools.every((tool) => typeof tool === "string" && tool.length > 0 && tool.length <= 128)
		) {
			throw new ChildProtocolError("invalid_bootstrap", "tools must be an array of at most 128 tool names");
		}
		tools = [...new Set(value.tools as string[])];
	}
	const readCount = (field: string): number | undefined => {
		const count = value[field];
		if (count === undefined) return undefined;
		if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 100_000) {
			throw new ChildProtocolError("invalid_bootstrap", `${field} must be an integer between 0 and 100000`);
		}
		return count as number;
	};
	const maxTurns = readCount("maxTurns");
	const graceTurns = readCount("graceTurns");
	return {
		childId,
		token,
		socketPath,
		sessionDir,
		cwd,
		configCwd,
		systemPrompt,
		promptMode: value.promptMode,
		...(sessionFile !== undefined ? { sessionFile } : {}),
		...(instructions !== undefined ? { instructions } : {}),
		...(model !== undefined ? { model } : {}),
		...(thinking !== undefined ? { thinking } : {}),
		...(tools !== undefined ? { tools } : {}),
		...(maxTurns !== undefined ? { maxTurns } : {}),
		...(graceTurns !== undefined ? { graceTurns } : {}),
	};
}

export async function loadChildBootstrap(path = process.env[BOOTSTRAP_ENV]): Promise<ChildBootstrap> {
	if (!path) throw new ChildProtocolError("invalid_bootstrap", `${BOOTSTRAP_ENV} is required`);
	const details = await lstat(path);
	if (
		!details.isFile() ||
		(typeof process.getuid === "function" && details.uid !== process.getuid()) ||
		(details.mode & 0o077) !== 0
	) {
		throw new ChildProtocolError("invalid_bootstrap", "Child bootstrap must be an owner-only regular file");
	}
	const text = await readFile(path, "utf8");
	if (Buffer.byteLength(text, "utf8") > CHILD_MAX_FRAME_BYTES)
		throw new ChildProtocolError("invalid_bootstrap", "Child bootstrap exceeds the supported size");
	try {
		return parseChildBootstrap(JSON.parse(text) as unknown);
	} catch (error) {
		if (error instanceof ChildProtocolError) throw error;
		throw new ChildProtocolError("invalid_bootstrap", "Child bootstrap is not valid JSON");
	}
}

function boundedText(text: string): string {
	return text.length <= MAX_TEXT_CHARS ? text : `${text.slice(0, MAX_TEXT_CHARS)}…`;
}

function jsonSafe(value: unknown, depth = 0, budget: JsonBudget = { nodes: 0, bytes: 0, truncated: false }): unknown {
	budget.nodes++;
	if (budget.nodes > 64 || budget.bytes > 16_384 || depth > 6) {
		budget.truncated = true;
		return "[truncated]";
	}
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") {
		const text = boundedText(value);
		budget.bytes += Buffer.byteLength(text);
		if (text.length < value.length) budget.truncated = true;
		return text;
	}
	if (Array.isArray(value)) {
		if (value.length > 64) budget.truncated = true;
		return value.slice(0, 64).map((item) => jsonSafe(item, depth + 1, budget));
	}
	if (typeof value !== "object") return String(value);
	const output: Record<string, unknown> = {};
	const entries = Object.entries(value);
	if (entries.length > 64) budget.truncated = true;
	for (const [key, item] of entries.slice(0, 64)) {
		budget.bytes += Buffer.byteLength(key);
		if (budget.bytes > 16_384) {
			budget.truncated = true;
			break;
		}
		output[boundedText(key)] = jsonSafe(item, depth + 1, budget);
	}
	return output;
}

interface TextPreview {
	text: string;
	truncated: boolean;
	originalLength: number;
}

function previewText(text: string): TextPreview {
	if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false, originalLength: text.length };
	return { text: `${text.slice(0, MAX_TEXT_CHARS)}… [truncated]`, truncated: true, originalLength: text.length };
}

function previewContent(content: unknown): TextPreview {
	if (typeof content === "string") return previewText(content);
	if (!Array.isArray(content)) return { text: "", truncated: false, originalLength: 0 };
	let text = "";
	let originalLength = 0;
	let foundText = false;
	for (const part of content) {
		if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
		if (foundText) {
			originalLength++;
			if (text.length < MAX_TEXT_CHARS) text += "\n";
		}
		foundText = true;
		originalLength += part.text.length;
		if (text.length < MAX_TEXT_CHARS) text += part.text.slice(0, MAX_TEXT_CHARS - text.length);
	}
	if (originalLength <= MAX_TEXT_CHARS) return { text, truncated: false, originalLength };
	return { text: `${text.slice(0, MAX_TEXT_CHARS)}… [truncated]`, truncated: true, originalLength };
}

function previewJson(value: unknown): { value: unknown; truncated: boolean } {
	const budget: JsonBudget = { nodes: 0, bytes: 0, truncated: false };
	const safe = jsonSafe(value, 0, budget);
	return { value: safe, truncated: budget.truncated };
}

/**
 * Full, uncapped text of a message's text parts (full-result channel,
 * roadmap 1.1b). The inline outcome copy stays bounded by MAX_TEXT_CHARS;
 * this extraction feeds the durable result.md artifact.
 */
function fullTextOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (isRecord(part) && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("\n");
}

function extractText(content: unknown): string {
	return previewContent(content).text;
}

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	timer.unref();
	return promise;
}

export function normalizeMessage(message: unknown): TranscriptItem[] {
	if (!isRecord(message) || typeof message.role !== "string") return [];
	const timestamp =
		typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : Date.now();
	const content = message.content;
	if (message.role === "user") {
		const text = previewContent(content);
		return [
			{
				kind: "user",
				timestamp,
				text: text.text,
				...(text.truncated ? { metadata: { truncated: true, originalLength: text.originalLength } } : {}),
			},
		];
	}
	if (message.role === "assistant") {
		const items: TranscriptItem[] = [];
		if (Array.isArray(content)) {
			for (const part of content) {
				if (!isRecord(part)) continue;
				if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
					const text = previewText(part.text);
					items.push({
						kind: "assistant",
						timestamp,
						text: text.text,
						...(text.truncated ? { metadata: { truncated: true, originalLength: text.originalLength } } : {}),
					});
				}
				if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
					const args = part.arguments === undefined ? undefined : previewJson(part.arguments);
					items.push({
						kind: "toolCall",
						timestamp,
						toolName: part.name,
						toolCallId: part.id,
						...(args !== undefined ? { args: args.value } : {}),
						...(args?.truncated ? { metadata: { argsTruncated: true } } : {}),
					});
				}
			}
		} else if (typeof content === "string" && content.length > 0) {
			const text = previewText(content);
			items.push({
				kind: "assistant",
				timestamp,
				text: text.text,
				...(text.truncated ? { metadata: { truncated: true, originalLength: text.originalLength } } : {}),
			});
		}
		return items;
	}
	if (message.role === "toolResult") {
		const result = content === undefined ? undefined : previewJson(content);
		const text = previewContent(content);
		const metadata = {
			...(text.truncated ? { textTruncated: true, textOriginalLength: text.originalLength } : {}),
			...(result?.truncated ? { resultTruncated: true } : {}),
		};
		return [
			{
				kind: "toolResult",
				timestamp,
				...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
				...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
				text: text.text,
				...(result !== undefined ? { result: result.value } : {}),
				...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
				...(Object.keys(metadata).length > 0 ? { metadata } : {}),
			},
		];
	}
	if (message.role === "custom") {
		const text = previewContent(content);
		return [
			{
				kind: "system",
				timestamp,
				text: text.text,
				...(text.truncated ? { metadata: { truncated: true, originalLength: text.originalLength } } : {}),
			},
		];
	}
	return [];
}

function errorMessage(error: unknown, token: string): string {
	const message = error instanceof Error ? error.message : String(error);
	return boundedText(message.replaceAll(token, "[redacted]") || "Child command failed");
}

function previewError(error: unknown, token: string): TextPreview {
	const message = error instanceof Error ? error.message : String(error);
	return previewText(message.replaceAll(token, "[redacted]") || "Child command failed");
}

function fingerprint(method: string, params: Record<string, unknown>): string {
	return createHash("sha256")
		.update(JSON.stringify([method, params]))
		.digest("hex");
}

interface CachedResult {
	reply: unknown;
	afterReply?: () => void;
}

interface CachedCommand {
	fingerprint: string;
	result: Promise<CachedResult>;
	completed: boolean;
	afterReplyScheduled: boolean;
}

function respondCachedResult(
	command: CachedCommand,
	result: CachedResult,
	respond: (value: unknown, afterReply?: () => void) => void,
): void {
	respond(
		result.reply,
		result.afterReply
			? () => {
					if (command.afterReplyScheduled) return;
					command.afterReplyScheduled = true;
					result.afterReply?.();
				}
			: undefined,
	);
}

interface ActiveRun {
	runId: string;
	abortRequested: boolean;
	steered: boolean;
}

class ChildRuntime {
	private readonly transcriptItems: TranscriptItem[];
	private transcriptCursor: number;
	private sequence = 0;
	private activeRun: ActiveRun | undefined;
	private lastOutcome: ChildOutcome | undefined;
	private usage: UsageSummary = { ...EMPTY_USAGE };
	private turns = 0;
	private toolUses = 0;
	private readonly recentRunIds = new Set<string>();
	private readonly subscribers = new Set<(event: ChildEvent) => void>();
	private readonly partialItems: TranscriptItem[] = [];
	private messageStreamOrdinal = 0;
	private messageRevision = 0;
	private currentMessageId: string | undefined;
	private readonly pendingMessages = new Map<
		string,
		{ resolve(reply: ChildMessageReply): void; reject(error: Error): void; timer: NodeJS.Timeout }
	>();
	private shuttingDown = false;
	private shutdownStarted = false;
	/** Set once control loss is confirmed; annotates the preserved result. */
	private controlLost = false;
	private controlLossHandled = false;

	constructor(
		readonly bootstrap: ChildBootstrap,
		private readonly host: ChildBridgeHost,
	) {
		const history = host.getTranscript();
		this.transcriptItems = history.slice(-MAX_TRANSCRIPT_ITEMS).map((item, index) => {
			const text = item.text === undefined ? undefined : previewText(item.text);
			const args = item.args === undefined ? undefined : previewJson(item.args);
			const result = item.result === undefined ? undefined : previewJson(item.result);
			const metadataPreview = item.metadata === undefined ? undefined : previewJson(item.metadata);
			const metadata = {
				...(metadataPreview && isRecord(metadataPreview.value) ? metadataPreview.value : {}),
				...(metadataPreview?.truncated ? { metadataTruncated: true } : {}),
				...(text?.truncated ? { truncated: true, originalLength: text.originalLength } : {}),
				...(args?.truncated ? { argsTruncated: true } : {}),
				...(result?.truncated ? { resultTruncated: true } : {}),
			};
			return {
				...item,
				id: item.id ?? `history:${index}`,
				revision: item.revision ?? 0,
				...(text !== undefined ? { text: text.text } : {}),
				...(args !== undefined ? { args: args.value } : {}),
				...(result !== undefined ? { result: result.value } : {}),
				...(Object.keys(metadata).length > 0 ? { metadata } : {}),
			};
		});
		this.transcriptCursor = history.length;
	}

	state(): ChildState {
		const sessionFile = this.host.getSessionFile();
		const focus = this.host.getFocus();
		const items: TranscriptItem[] = [];
		let transcriptBytes = this.partialItems.reduce(
			(bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item) ?? ""),
			0,
		);
		for (let index = this.transcriptItems.length - 1; index >= 0; index--) {
			const item = this.transcriptItems[index];
			if (!item) continue;
			const serialized = JSON.stringify(item);
			const size = Buffer.byteLength(serialized ?? "");
			if (transcriptBytes + size > MAX_TRANSCRIPT_STATE_BYTES) break;
			transcriptBytes += size;
			items.unshift(item);
		}
		const snapshotItems = [...items, ...this.partialItems];
		const cursor = this.transcriptCursor + this.partialItems.length;
		const offset = cursor - snapshotItems.length;
		const truncated =
			offset > 0 || snapshotItems.some((item) => Object.values(item.metadata ?? {}).some((value) => value === true));
		const transcript: ChildTranscriptSnapshot = {
			items: snapshotItems.map((item) => ({ ...item })),
			cursor,
			offset,
			truncated,
		};
		return {
			childId: this.bootstrap.childId,
			pid: process.pid,
			...(sessionFile !== undefined ? { sessionFile } : {}),
			execution: this.activeRun ? "running" : "idle",
			...(this.activeRun ? { currentRunId: this.activeRun.runId } : {}),
			...(this.lastOutcome ? { lastOutcome: { ...this.lastOutcome } } : {}),
			transcript,
			seq: this.sequence,
			usage: { ...this.usage },
			turns: this.turns,
			toolUses: this.toolUses,
			focus,
		};
	}

	subscribe(listener: (event: ChildEvent) => void): () => void {
		this.subscribers.add(listener);
		return () => this.subscribers.delete(listener);
	}

	publishNativeEvent(event: ChildBridgeNativeEvent): void {
		if (event.type === "message_start") {
			this.currentMessageId = `${this.activeRun?.runId ?? "history"}:${++this.messageStreamOrdinal}`;
			this.messageRevision = 0;
			this.partialItems.length = 0;
			return;
		}
		if (event.type === "message_update") {
			const messageId = this.currentMessageId ?? `${this.activeRun?.runId ?? "history"}:${++this.messageStreamOrdinal}`;
			this.currentMessageId = messageId;
			const partialItems = normalizeMessage(event.message)
				.slice(0, MAX_PARTIAL_ITEMS)
				.map((item, index) => ({
					...item,
					id: `${messageId}:${index}`,
					revision: ++this.messageRevision,
					partial: true,
				}));
			this.partialItems.splice(0, this.partialItems.length, ...partialItems);
			this.emit("transcript", this.activeRun?.runId, {
				items: this.partialItems.map((item) => ({ ...item })),
				cursor: this.transcriptCursor,
				upsert: true,
			});
			return;
		}
		if (event.type === "message_end") {
			const items = normalizeMessage(event.message).map((item, index) => ({
				...item,
				id: `${this.currentMessageId ?? `message:${this.transcriptCursor}`}:${index}`,
				revision: ++this.messageRevision,
				partial: false,
			}));
			const cursorBefore = this.transcriptCursor;
			this.partialItems.length = 0;
			for (const item of items) this.appendTranscript(item);
			for (let offset = 0; offset < items.length; offset += 8) {
				const batch = items.slice(offset, offset + 8);
				this.emit("transcript", this.activeRun?.runId, {
					items: batch,
					cursor: cursorBefore + offset + batch.length,
					upsert: true,
				});
			}
			this.currentMessageId = undefined;
			this.messageRevision = 0;
			this.accumulateMessageUsage(event.message);
			if (isRecord(event.message) && event.message.role === "assistant") this.latestAssistant = event.message;
			return;
		}
		if (event.type === "agent_end" && Array.isArray(event.messages)) {
			for (let index = event.messages.length - 1; index >= 0; index--) {
				const message = event.messages[index];
				if (!isRecord(message) || message.role !== "assistant") continue;
				this.latestAssistant = message;
				break;
			}
			return;
		}
		if (event.type === "agent_settled") {
			this.settleActiveRun();
			return;
		}
		if (event.type === "turn_end") {
			if (!this.activeRun) return;
			this.turns++;
			this.emit("activity", this.activeRun.runId, { kind: "turn_end", turns: this.turns });
			// A final assistant turn has already ended the loop. Applying the hard
			// limit here would incorrectly turn a completed/error outcome into abort.
			const message = isRecord(event.message) ? event.message : this.latestAssistant;
			if (message?.role === "assistant" && ["stop", "length", "error", "aborted"].includes(String(message.stopReason)))
				return;
			const decision = decideTurnEvent({
				turns: this.turns,
				maxTurnLimit: this.bootstrap.maxTurns,
				graceTurns: this.bootstrap.graceTurns,
				steered: this.activeRun.steered,
			});
			if (decision.action === "softSteer") {
				this.activeRun.steered = true;
				const item: TranscriptItem = { kind: "system", timestamp: Date.now(), text: SOFT_LIMIT_NOTICE };
				this.appendTranscript(item);
				this.emit("transcript", this.activeRun.runId, { items: [item], cursor: this.transcriptCursor });
				void this.host.steer(SOFT_STEER_MESSAGE).catch((error: unknown) =>
					this.emit("activity", this.activeRun?.runId, {
						kind: "turn_policy_error",
						error: errorMessage(error, this.bootstrap.token),
					}),
				);
			} else if (decision.action === "abort") {
				const item: TranscriptItem = { kind: "system", timestamp: Date.now(), text: HARD_LIMIT_NOTICE };
				this.appendTranscript(item);
				this.emit("transcript", this.activeRun.runId, { items: [item], cursor: this.transcriptCursor });
				this.activeRun.abortRequested = true;
				void this.host.abort().catch((error: unknown) =>
					this.emit("activity", this.activeRun?.runId, {
						kind: "turn_policy_error",
						error: errorMessage(error, this.bootstrap.token),
					}),
				);
			}
			return;
		}
		if (event.type === "tool_execution_start" && this.activeRun) {
			this.toolUses++;
			this.emit("activity", this.activeRun.runId, {
				kind: "tool_start",
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				args: jsonSafe(event.args),
			});
			return;
		}
		if (event.type === "tool_execution_update" && this.activeRun) {
			this.emit("activity", this.activeRun.runId, {
				kind: "tool_update",
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				partialResult: jsonSafe(event.partialResult),
			});
			return;
		}
		if (event.type === "tool_execution_end" && this.activeRun) {
			this.emit("activity", this.activeRun.runId, {
				kind: "tool_end",
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				isError: event.isError,
				result: jsonSafe(event.result),
			});
			return;
		}
		if (
			event.type === "auto_retry_start" ||
			event.type === "auto_retry_end" ||
			event.type === "compaction_start" ||
			event.type === "compaction_end"
		) {
			this.emit("activity", this.activeRun?.runId, {
				kind: event.type,
				...(typeof event.attempt === "number" ? { attempt: event.attempt } : {}),
				...(typeof event.willRetry === "boolean" ? { willRetry: event.willRetry } : {}),
				...(typeof event.errorMessage === "string"
					? { error: errorMessage(new Error(event.errorMessage), this.bootstrap.token) }
					: {}),
			});
		}
	}

	private latestAssistant: Record<string, unknown> | undefined;

	async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
		if (this.shuttingDown && method !== "state" && method !== "shutdown")
			throw new ChildProtocolError("shutting_down", "Child is shutting down");
		if (method === "hello" || method === "state") return this.envelope();
		if (method === "prompt") return this.startRun(params);
		if (method === "steer") return this.steer(params);
		if (method === "abort") return this.abort(params);
		if (method === "control") return this.control(params);
		if (method === "send_inbox") {
			if (!isRecord(params.message)) throw new ChildProtocolError("invalid_request", "Inbox message is required");
			await this.host.sendInbox(params.message as unknown as InboxMessage);
			return { accepted: true };
		}
		if (method === "send_message") {
			if (!isRecord(params.request))
				throw new ChildProtocolError("invalid_request", "Child message request is required");
			return this.requestMessage(params.request);
		}
		if (method === "message_reply") {
			const requestId = requireString(params.requestId, "requestId");
			const pending = this.pendingMessages.get(requestId);
			if (!pending) throw new ChildProtocolError("stale_message_request", "Message request is no longer pending");
			this.pendingMessages.delete(requestId);
			clearTimeout(pending.timer);
			if (typeof params.error === "string") {
				pending.reject(new ChildProtocolError("message_rejected", params.error));
			} else if (isRecord(params.reply) && ["sent", "listed", "consumed"].includes(String(params.reply.action))) {
				pending.resolve(params.reply as unknown as ChildMessageReply);
			} else {
				pending.reject(new ChildProtocolError("invalid_reply", "Parent returned an invalid message receipt"));
			}
			return { accepted: true };
		}
		if (method === "shutdown") {
			this.shuttingDown = true;
			return {
				accepted: true,
				afterReply: () => {
					if (this.shutdownStarted) return;
					this.shutdownStarted = true;
					void this.host
						.shutdown()
						.catch((error: unknown) =>
							console.error("Pi child shutdown failed:", errorMessage(error, this.bootstrap.token)),
						);
				},
			};
		}
		throw new ChildProtocolError("unknown_method", "Unknown child RPC method");
	}

	private async control(params: Record<string, unknown>): Promise<unknown> {
		if (!isRecord(params.command) || typeof params.command.type !== "string")
			throw new ChildProtocolError("invalid_request", "A typed child control command is required");
		let command: ChildControlCommand;
		if (params.command.type === "model")
			command = { type: "model", model: requireString(params.command.model, "model", 512) };
		else if (params.command.type === "thinking") {
			const thinking = requireString(params.command.thinking, "thinking", 16);
			if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking))
				throw new ChildProtocolError("invalid_request", "Unsupported thinking level");
			command = {
				type: "thinking",
				thinking: thinking as Extract<ChildControlCommand, { type: "thinking" }>["thinking"],
			};
		} else if (params.command.type === "compact") command = { type: "compact" };
		else throw new ChildProtocolError("unsupported_command", "Unsupported child control command");
		if (!this.host.getFocus().capabilities.commands.includes(command.type))
			throw new ChildProtocolError("unsupported_command", `Child does not support the ${command.type} control`);
		if (command.type === "compact" && this.activeRun)
			throw new ChildProtocolError("busy", "Manual compaction is unavailable while the child is running");
		await this.host.controlFocus(command);
		this.emit("focus", this.activeRun?.runId, { focus: this.host.getFocus() });
		return this.state();
	}
	private requestMessage(value: Record<string, unknown>): Promise<ChildMessageReply> {
		let request: ChildMessageRequest;
		if (value.action === "list") request = { action: "list" };
		else if (value.action === "consume")
			request = { action: "consume", messageId: requireString(value.messageId, "messageId") };
		else if (value.action === "send") {
			if (typeof value.text !== "string" || value.text.length === 0 || value.text.length > 32_768)
				throw new ChildProtocolError("invalid_request", "Message text must contain 1 to 32768 characters");
			if (!isRecord(value.target)) throw new ChildProtocolError("invalid_request", "Message target is invalid");
			let target: MessageEndpoint;
			if (value.target.kind === "parent") target = { kind: "parent" };
			else if (value.target.kind === "agent")
				target = { kind: "agent", agentId: requireString(value.target.agentId, "target.agentId") };
			else throw new ChildProtocolError("invalid_request", "Message target is invalid");
			request = { action: "send", target, text: value.text };
		} else throw new ChildProtocolError("invalid_request", "Unsupported child message action");
		if (this.pendingMessages.size >= 32)
			throw new ChildProtocolError("too_many_requests", "Child message request capacity is full");
		const requestId = randomUUID();
		return new Promise<ChildMessageReply>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingMessages.delete(requestId);
				reject(new ChildProtocolError("request_timeout", "Parent did not acknowledge the inbox request"));
			}, 60_000);
			timer.unref();
			this.pendingMessages.set(requestId, { resolve, reject, timer });
			this.emit("message_request", this.activeRun?.runId, { requestId, request });
		});
	}

	private async startRun(params: Record<string, unknown>): Promise<unknown> {
		const runId = requireString(params.runId, "runId");
		if (runId.length > 121) throw new ChildProtocolError("invalid_request", "runId exceeds the supported length");
		const prompt = requireString(params.prompt, "prompt", 262_144);
		if (this.activeRun) throw new ChildProtocolError("busy", `Child is already running ${this.activeRun.runId}`);
		if (this.recentRunIds.has(runId))
			throw new ChildProtocolError("duplicate_run", "This runId has already been used by the child");
		this.recentRunIds.add(runId);
		if (this.recentRunIds.size > 1_024) this.recentRunIds.delete(this.recentRunIds.values().next().value as string);
		this.activeRun = { runId, abortRequested: false, steered: false };
		this.latestAssistant = undefined;
		this.usage = { ...EMPTY_USAGE };
		this.turns = 0;
		this.toolUses = 0;
		this.emit("run_started", runId, { runId });
		try {
			await this.host.prompt(prompt);
		} catch (error) {
			const failure = previewError(error, this.bootstrap.token);
			this.finish(runId, {
				runId,
				status: "failed",
				error: failure.text,
				...(failure.truncated ? { errorTruncated: true, errorOriginalLength: failure.originalLength } : {}),
			});
			throw new ChildProtocolError("prompt_failed", failure.text);
		}
		return { accepted: true, runId };
	}

	private async steer(params: Record<string, unknown>): Promise<unknown> {
		const runId = requireString(params.runId, "runId");
		const message = requireString(params.message, "message", 262_144);
		this.requireActiveRun(runId, "steer");
		await this.host.steer(message);
		if (this.activeRun?.runId === runId) this.activeRun.steered = true;
		this.emit("activity", runId, { kind: "steer_accepted" });
		return { accepted: true, runId };
	}

	private async abort(params: Record<string, unknown>): Promise<unknown> {
		const runId = requireString(params.runId, "runId");
		const run = this.requireActiveRun(runId, "abort");
		run.abortRequested = true;
		try {
			await this.host.abort();
		} catch (error) {
			if (this.activeRun === run) run.abortRequested = false;
			throw new ChildProtocolError("abort_failed", errorMessage(error, this.bootstrap.token));
		}
		if (this.activeRun?.runId === runId) this.emit("activity", runId, { kind: "abort_accepted" });
		return { accepted: true, runId };
	}

	private requireActiveRun(runId: string, operation: string): ActiveRun {
		if (!this.activeRun || this.activeRun.runId !== runId)
			throw new ChildProtocolError("stale_run", `${operation} target does not match the active child run`);
		return this.activeRun;
	}

	private envelope(): ChildStateEnvelope {
		return {
			identity: { protocolVersion: CHILD_PROTOCOL_VERSION, childId: this.bootstrap.childId },
			state: this.state(),
		};
	}

	private appendTranscript(item: TranscriptItem): void {
		this.transcriptItems.push({
			...item,
			id: item.id ?? `item:${this.transcriptCursor}`,
			revision: item.revision ?? 0,
			partial: false,
		});
		this.transcriptCursor++;
		if (this.transcriptItems.length > MAX_TRANSCRIPT_ITEMS)
			this.transcriptItems.splice(0, this.transcriptItems.length - MAX_TRANSCRIPT_ITEMS);
	}

	private accumulateMessageUsage(value: unknown): void {
		if (!this.activeRun || !isRecord(value) || !isRecord(value.usage)) return;
		const usage = value.usage;
		const count = (name: string): number =>
			typeof usage[name] === "number" && Number.isFinite(usage[name]) && (usage[name] as number) > 0
				? Math.floor(usage[name] as number)
				: 0;
		const input = count("input");
		const output = count("output");
		const cacheRead = count("cacheRead");
		const cacheWrite = count("cacheWrite");
		this.usage.inputTokens += input;
		this.usage.outputTokens += output;
		this.usage.cacheReadTokens += cacheRead;
		this.usage.cacheWriteTokens += cacheWrite;
		this.usage.totalTokens += input + output + cacheWrite;
		this.emit("usage", this.activeRun.runId, { usage: { ...this.usage }, turns: this.turns, toolUses: this.toolUses });
	}

	/**
	 * Full-result channel (roadmap 1.1b): the complete final answer is
	 * persisted to <sessionDir>/result.md before the outcome leaves the
	 * child. The inline outcome copy stays MAX_TEXT_CHARS-bounded for the
	 * parent's context economy; the file is the authoritative full copy the
	 * parent re-reads at will. Write failure never blocks settlement — the
	 * outcome degrades to the inline copy without a resultFile pointer.
	 * Last settled run wins when a child settles multiple runs.
	 */
	private persistFullResult(text: string): string | undefined {
		// Control loss annotates whatever partial answer exists so the stopped
		// artifact explains itself (ADR 0007 orphan self-termination).
		const body = this.controlLost
			? text.length > 0
				? `${CONTROL_LOSS_ANNOTATION}\n\n${text}`
				: CONTROL_LOSS_ANNOTATION
			: text;
		if (body.length === 0) return undefined;
		const file = join(this.bootstrap.sessionDir, "result.md");
		try {
			mkdirSync(this.bootstrap.sessionDir, { recursive: true, mode: 0o700 });
			writeFileSync(file, body, { mode: 0o600 });
			return file;
		} catch {
			return undefined;
		}
	}

	/**
	 * Session-bound lifetime (ADR 0007 §1): the authenticated control socket
	 * disappeared and did not come back. Abort the current turn through the
	 * native cooperative path, give settlement a bounded window to flush and
	 * persist the annotated partial result, then stop the host process — the
	 * headless worker exits and the interactive TUI pane closes with it. A
	 * hung parent that never dropped the socket changes nothing: the child
	 * simply runs to completion.
	 */
	async handleControlLoss(): Promise<void> {
		if (this.controlLossHandled) return;
		this.controlLossHandled = true;
		this.controlLost = true;
		this.shuttingDown = true;
		const run = this.activeRun;
		if (run) {
			run.abortRequested = true;
			try {
				await this.host.abort();
			} catch {
				// The annotated artifact is written regardless of abort acceptance.
			}
			const deadline = Date.now() + CONTROL_LOSS_SETTLE_MS;
			while (this.activeRun === run && Date.now() < deadline) {
				await delay(CONTROL_LOSS_POLL_MS);
			}
			if (this.activeRun === run) {
				// No native settlement in the window: preserve directly.
				const resultFile = this.persistFullResult(this.latestAssistant ? fullTextOf(this.latestAssistant.content) : "");
				this.finish(run.runId, { runId: run.runId, status: "stopped", ...(resultFile ? { resultFile } : {}) });
			}
		}
		try {
			await this.host.shutdown();
		} catch {
			// The caller's failsafe exit covers a wedged shutdown.
		}
	}

	private settleActiveRun(): void {
		const run = this.activeRun;
		if (!run) return;
		const assistant = this.latestAssistant;
		const stopReason = typeof assistant?.stopReason === "string" ? assistant.stopReason : undefined;
		const rawError =
			typeof assistant?.errorMessage === "string" && assistant.errorMessage.length > 0
				? assistant.errorMessage
				: undefined;
		const resultFile = this.persistFullResult(assistant ? fullTextOf(assistant.content) : "");
		let outcome: ChildOutcome;
		if (run.abortRequested || stopReason === "aborted") {
			// A stopped run keeps whatever partial answer exists in result.md
			// (ADR 0007 partial-result preservation) but no inline result.
			outcome = { runId: run.runId, status: "stopped", ...(resultFile ? { resultFile } : {}) };
		} else if (stopReason === "error" || rawError) {
			const error = previewError(new Error(rawError ?? "Pi agent run failed"), this.bootstrap.token);
			outcome = {
				runId: run.runId,
				status: "failed",
				error: error.text,
				...(error.truncated ? { errorTruncated: true, errorOriginalLength: error.originalLength } : {}),
				...(resultFile ? { resultFile } : {}),
			};
		} else {
			const result = assistant ? previewContent(assistant.content) : { text: "", truncated: false, originalLength: 0 };
			outcome = {
				runId: run.runId,
				status: "completed",
				...(result.text.length > 0 ? { result: result.text } : {}),
				...(result.truncated ? { resultTruncated: true, resultOriginalLength: result.originalLength } : {}),
				...(resultFile ? { resultFile } : {}),
			};
		}
		this.finish(run.runId, outcome);
	}
	failActiveRun(error: unknown): void {
		const run = this.activeRun;
		if (!run) return;
		if (run.abortRequested) {
			this.finish(run.runId, { runId: run.runId, status: "stopped" });
			return;
		}
		const failure = previewError(error, this.bootstrap.token);
		this.finish(run.runId, {
			runId: run.runId,
			status: "failed",
			error: failure.text,
			...(failure.truncated ? { errorTruncated: true, errorOriginalLength: failure.originalLength } : {}),
		});
	}

	private finish(runId: string, outcome: ChildOutcome): void {
		if (this.activeRun?.runId !== runId) return;
		this.lastOutcome = outcome;
		this.activeRun = undefined;
		this.emit("run_settled", runId, {
			outcome: { ...outcome },
			usage: { ...this.usage },
			turns: this.turns,
			toolUses: this.toolUses,
		});
	}

	private emit(event: ChildEventName, runId: string | undefined, payload: Record<string, unknown>): void {
		const childEvent: ChildEvent = {
			type: "event",
			seq: ++this.sequence,
			childId: this.bootstrap.childId,
			...(runId ? { runId } : {}),
			event,
			payload,
		};
		for (const listener of this.subscribers) {
			try {
				listener(childEvent);
			} catch {
				// Event observers cannot break native run settlement.
			}
		}
	}
}

export async function startChildBridge(bootstrap: ChildBootstrap, host: ChildBridgeHost): Promise<ChildBridgeHandle> {
	const childBootstrap = parseChildBootstrap(bootstrap);
	await mkdir(dirname(childBootstrap.socketPath), { recursive: true, mode: 0o700 });
	const sessionFile = host.getSessionFile();
	if (typeof sessionFile !== "string" || sessionFile.length === 0)
		throw new ChildProtocolError(
			"session_not_persisted",
			"Pi must create a persisted session file before child RPC becomes ready",
		);
	if (childBootstrap.sessionFile !== undefined && childBootstrap.sessionFile !== sessionFile) {
		throw new ChildProtocolError(
			"session_mismatch",
			"Pi opened a different session file than the child bootstrap requested",
		);
	}
	const runtime = new ChildRuntime(childBootstrap, host);
	const server = await openChildSocket(childBootstrap, runtime);
	return {
		state: () => runtime.state(),
		publishNativeEvent: (event) => runtime.publishNativeEvent(event),
		failActiveRun: (error) => runtime.failActiveRun(error),
		close: () => closeChildSocket(server),
	};
}

async function openChildSocket(bootstrap: ChildBootstrap, runtime: ChildRuntime): Promise<ChildSocketHandle> {
	try {
		const old = await lstat(bootstrap.socketPath);
		if (!old.isSocket() || (typeof process.getuid === "function" && old.uid !== process.getuid())) {
			throw new ChildProtocolError("socket_path_conflict", "Refusing to replace a non-owned child socket path");
		}
		await unlink(bootstrap.socketPath);
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	const clients = new Set<Socket>();
	const cache = new Map<string, CachedCommand>();
	let connections = 0;
	let intentionalClose = false;
	let controlLossTimer: NodeJS.Timeout | undefined;
	const cancelControlLossWatch = (): void => {
		if (controlLossTimer !== undefined) {
			clearTimeout(controlLossTimer);
			controlLossTimer = undefined;
		}
	};
	const armControlLossWatch = (): void => {
		if (intentionalClose) return;
		cancelControlLossWatch();
		controlLossTimer = setTimeout(() => {
			controlLossTimer = undefined;
			void terminateAfterControlLoss(server, clients, runtime, cancelControlLossWatch);
		}, CONTROL_LOSS_GRACE_MS);
		controlLossTimer.unref?.();
	};
	const server = createServer((socket) => {
		if (connections >= MAX_CONNECTIONS) {
			socket.destroy();
			return;
		}
		connections++;
		clients.add(socket);
		cancelControlLossWatch();
		attachClient(socket, bootstrap, runtime, cache, () => {
			connections--;
			clients.delete(socket);
			if (connections === 0) armControlLossWatch();
		});
	});
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(bootstrap.socketPath);
	});
	try {
		await chmod(bootstrap.socketPath, 0o600);
	} catch (error) {
		for (const socket of clients) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		throw error;
	}
	return {
		server,
		clients,
		socketPath: bootstrap.socketPath,
		beginIntentionalClose: () => {
			intentionalClose = true;
			cancelControlLossWatch();
		},
	};
}

/**
 * Orphan self-termination (ADR 0007 §1): the parent's control connection is
 * gone and stayed gone. Preserve the annotated partial result through the
 * runtime, tear the socket down, shut the host (headless exit / TUI pane
 * close) and keep an unref'd failsafe exit for a wedged shutdown.
 */
async function terminateAfterControlLoss(
	server: Server,
	clients: Set<Socket>,
	runtime: ChildRuntime,
	disarm: () => void,
): Promise<void> {
	disarm();
	console.error(
		"[pi-teams] parent control socket lost — aborting, preserving the partial result and stopping this child (session-bound lifetime, ADR 0007)",
	);
	const failsafe = setTimeout(() => process.exit(0), CONTROL_LOSS_EXIT_MS);
	failsafe.unref();
	try {
		await runtime.handleControlLoss();
	} catch {
		// Preservation is best-effort; the failsafe exit still applies.
	}
	for (const socket of clients) socket.destroy();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

function attachClient(
	socket: Socket,
	bootstrap: ChildBootstrap,
	runtime: ChildRuntime,
	cache: Map<string, CachedCommand>,
	onClose: () => void,
): void {
	let authenticated = false;
	let buffer = Buffer.alloc(0);
	let closed = false;
	const unsubscribe = runtime.subscribe((event) => {
		if (!authenticated || socket.destroyed) return;
		try {
			socket.write(encodeChildFrame(event));
		} catch {
			socket.destroy();
		}
	});
	const authTimer = setTimeout(() => {
		if (!authenticated) socket.destroy();
	}, 5_000);
	authTimer.unref();
	socket.once("close", () => {
		closed = true;
		clearTimeout(authTimer);
		unsubscribe();
		onClose();
	});
	socket.on("error", () => {
		closed = true;
		clearTimeout(authTimer);
		unsubscribe();
	});
	socket.on("data", (chunk: Buffer) => {
		if (closed) return;
		buffer = Buffer.concat([buffer, chunk]);
		if (buffer.byteLength > CHILD_MAX_FRAME_BYTES && buffer.indexOf(10) === -1) {
			socket.destroy(new ChildProtocolError("frame_too_large", "Child protocol frame exceeds the configured limit"));
			return;
		}
		let newline = buffer.indexOf(10);
		while (newline !== -1) {
			const line = buffer.subarray(0, newline);
			buffer = buffer.subarray(newline + 1);
			if (line.byteLength === 0 || line.byteLength > CHILD_MAX_FRAME_BYTES) {
				socket.destroy(new ChildProtocolError("invalid_frame", "Invalid child protocol frame size"));
				return;
			}
			let request: ChildRequest;
			try {
				request = parseChildRequest(JSON.parse(line.toString("utf8")) as unknown);
			} catch {
				socket.destroy(new ChildProtocolError("invalid_frame", "Malformed child protocol request"));
				return;
			}
			void handleSocketRequest(
				request,
				bootstrap,
				runtime,
				cache,
				() => authenticated,
				() => {
					authenticated = true;
				},
				(value, afterReply) => {
					if (closed || socket.destroyed) return;
					try {
						socket.write(encodeChildFrame(value), () => {
							if (afterReply) setImmediate(afterReply);
						});
					} catch {
						socket.destroy();
					}
				},
			);
			newline = buffer.indexOf(10);
		}
		if (buffer.byteLength > CHILD_MAX_FRAME_BYTES)
			socket.destroy(new ChildProtocolError("frame_too_large", "Child protocol frame exceeds the configured limit"));
	});
}

async function handleSocketRequest(
	request: ChildRequest,
	bootstrap: ChildBootstrap,
	runtime: ChildRuntime,
	cache: Map<string, CachedCommand>,
	isAuthenticated: () => boolean,
	markAuthenticated: () => void,
	respond: (value: unknown, afterReply?: () => void) => void,
): Promise<void> {
	const failure = (code: string, message: string): ChildReply => ({
		id: request.id,
		ok: false,
		error: { code, message: boundedText(message) },
	});
	if (request.method === "hello") {
		try {
			const identity = parseChildIdentity(request.params);
			const given = Buffer.from(identity.token);
			const expected = Buffer.from(bootstrap.token);
			if (
				identity.childId !== bootstrap.childId ||
				given.byteLength !== expected.byteLength ||
				!timingSafeEqual(given, expected)
			) {
				respond(failure("unauthorized", "Child identity was rejected"));
				return;
			}
			markAuthenticated();
			respond({
				id: request.id,
				ok: true,
				result: {
					identity: { protocolVersion: CHILD_PROTOCOL_VERSION, childId: bootstrap.childId },
					state: runtime.state(),
				},
			});
			return;
		} catch (error) {
			const problem =
				error instanceof ChildProtocolError
					? error
					: new ChildProtocolError("unauthorized", "Child identity was rejected");
			respond(failure(problem.code, problem.message));
			return;
		}
	}
	if (!isAuthenticated()) {
		respond(failure("unauthorized", "Child RPC handshake is required"));
		return;
	}
	const commandFingerprint = fingerprint(request.method, request.params);
	const cached = cache.get(request.id);
	if (cached) {
		if (cached.fingerprint !== commandFingerprint) {
			respond(failure("request_id_reused", "Request id was already used for a different command"));
			return;
		}
		respondCachedResult(cached, await cached.result, respond);
		return;
	}
	if (cache.size >= MAX_REQUESTS) {
		let oldestCompleted: string | undefined;
		for (const [id, entry] of cache) {
			if (entry.completed) {
				oldestCompleted = id;
				break;
			}
		}
		if (oldestCompleted === undefined) {
			respond(failure("too_many_requests", "Child request deduplication capacity is temporarily full"));
			return;
		}
		cache.delete(oldestCompleted);
	}
	const outcome: Promise<CachedResult> = (async (): Promise<CachedResult> => {
		try {
			const result = await runtime.handle(request.method, request.params);
			if (isRecord(result) && "afterReply" in result && typeof result.afterReply === "function") {
				const afterReply = result.afterReply as () => void;
				return { reply: { id: request.id, ok: true as const, result: { accepted: true } }, afterReply };
			}
			return { reply: { id: request.id, ok: true as const, result } };
		} catch (error) {
			const problem =
				error instanceof ChildProtocolError
					? error
					: new ChildProtocolError("command_failed", errorMessage(error, bootstrap.token));
			return { reply: failure(problem.code, problem.message) };
		}
	})();
	const command: CachedCommand = {
		fingerprint: commandFingerprint,
		result: outcome,
		completed: false,
		afterReplyScheduled: false,
	};
	cache.set(request.id, command);
	void outcome.then(() => {
		command.completed = true;
	});
	respondCachedResult(command, await outcome, respond);
}

async function closeChildSocket(handle: ChildSocketHandle): Promise<void> {
	handle.beginIntentionalClose();
	for (const socket of handle.clients) socket.destroy();
	await new Promise<void>((resolve) => handle.server.close(() => resolve()));
	try {
		const current = await lstat(handle.socketPath);
		if (current.isSocket() && (typeof process.getuid !== "function" || current.uid === process.getuid()))
			await unlink(handle.socketPath);
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
}

export function installChildBridgeExtension(pi: ExtensionAPI): void {
	if (process.env[CHILD_ENV] !== "1")
		throw new ChildProtocolError("not_child", "The child bridge extension can only run in a PI_TEAMS_CHILD process");
	let bridge: ChildBridgeHandle | undefined;
	let started = false;
	let bootstrapPromise: Promise<ChildBootstrap> | undefined;
	const getBootstrap = () => (bootstrapPromise ??= loadChildBootstrap());
	pi.on("before_agent_start", async (event) => {
		const bootstrap = await getBootstrap();
		const additions = [bootstrap.systemPrompt, bootstrap.instructions]
			.filter((part): part is string => typeof part === "string" && part.length > 0)
			.join("\n\n");
		if (bootstrap.promptMode === "replace") return { systemPrompt: additions };
		return { systemPrompt: [event.systemPrompt, additions].filter((part) => part.length > 0).join("\n\n") };
	});
	pi.on("session_start", async (_event, context) => {
		if (started) return;
		started = true;
		const bootstrap = await getBootstrap();
		bridge = await startChildBridge(bootstrap, createInteractiveHost(pi, context));
	});
	const publishNativeEvent = (value: unknown) => {
		const event = normalizeChildNativeEvent(value);
		if (event) bridge?.publishNativeEvent(event);
	};
	pi.on("message_end", (event) => publishNativeEvent(event));
	pi.on("agent_end", (event) => publishNativeEvent(event));
	pi.on("agent_settled", (event) => publishNativeEvent(event));
	pi.on("turn_end", (event) => publishNativeEvent(event));
	pi.on("tool_execution_start", (event) => publishNativeEvent(event));
	pi.on("tool_execution_update", (event) => publishNativeEvent(event));
	pi.on("tool_execution_end", (event) => publishNativeEvent(event));
	pi.on("session_shutdown", async () => {
		await bridge?.close();
		bridge = undefined;
	});
}

function createInteractiveHost(pi: ExtensionAPI, context: ExtensionContext): ChildBridgeHost {
	let selectedModel = context.model;
	let thinkingLevel = context.thinkingLevel ?? pi.getThinkingLevel();
	const getFocus = (): NonNullable<ChildState["focus"]> => {
		const model = selectedModel;
		const thinking = model?.reasoning
			? (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).filter(
					(level) => model.thinkingLevelMap?.[level] !== null,
				)
			: (["off"] as const);
		const contextUsage = context.getContextUsage();
		return {
			cwd: context.cwd,
			...(model ? { model: { provider: model.provider, id: model.id, name: model.name } } : {}),
			thinking: thinkingLevel,
			...(contextUsage && contextUsage.tokens !== null
				? {
						context: {
							tokens: contextUsage.tokens,
							contextWindow: contextUsage.contextWindow,
							percent: contextUsage.contextWindow > 0 ? (contextUsage.tokens / contextUsage.contextWindow) * 100 : 0,
						},
					}
				: {}),
			capabilities: {
				models: context.modelRegistry.getAvailable().map((entry) => ({
					provider: entry.provider,
					id: entry.id,
					name: entry.name,
				})),
				thinking,
				commands: ["model", "thinking"],
			},
		};
	};
	return {
		getSessionFile: () => context.sessionManager.getSessionFile() ?? undefined,
		getTranscript: () =>
			context.sessionManager.buildContextEntries().flatMap((entry) => {
				if (entry.type === "message") return normalizeMessage(entry.message);
				if (entry.type === "compaction" || entry.type === "branch_summary")
					return [
						{
							kind: "system" as const,
							timestamp: Date.parse(entry.timestamp) || Date.now(),
							text: boundedText(entry.summary),
						},
					];
				if (entry.type === "custom_message")
					return [
						{
							kind: "system" as const,
							timestamp: Date.parse(entry.timestamp) || Date.now(),
							text: extractText(entry.content),
						},
					];
				return [];
			}),
		getFocus,
		controlFocus: async (command) => {
			if (command.type === "model") {
				const models = context.modelRegistry.getAvailable();
				const separator = command.model.indexOf("/");
				const matches =
					separator > 0
						? models.filter(
								(model) =>
									model.provider === command.model.slice(0, separator) &&
									model.id === command.model.slice(separator + 1),
							)
						: models.filter(
								(model) =>
									model.id.toLowerCase() === command.model.toLowerCase() ||
									model.name.toLowerCase() === command.model.toLowerCase(),
							);
				const model = matches[0];
				if (matches.length !== 1 || !model)
					throw new ChildProtocolError(
						matches.length > 1 ? "model_ambiguous" : "model_unavailable",
						`Model ${command.model} is ${matches.length > 1 ? "ambiguous" : "unavailable"} in native Pi`,
					);
				if (!(await pi.setModel(model)))
					throw new ChildProtocolError("model_unavailable", `Pi could not select ${command.model}`);
				selectedModel = model;
				return;
			}
			if (command.type === "thinking") {
				if (!getFocus().capabilities.thinking.includes(command.thinking))
					throw new ChildProtocolError(
						"unsupported_thinking",
						`Thinking level ${command.thinking} is unavailable for the current model`,
					);
				pi.setThinkingLevel(command.thinking);
				thinkingLevel = command.thinking;
				return;
			}
			throw new ChildProtocolError("unsupported_command", "Manual compaction is unavailable in the process backend");
		},
		sendInbox: async (message) => {
			pi.sendMessage(
				{ customType: "pi-teams-inbox", content: JSON.stringify(message), display: true },
				{ triggerTurn: false },
			);
		},
		prompt: async (prompt) => {
			// Dispatch is void; native preflight failures otherwise emit no settlement event.
			// Validate with the native registry before acknowledging admission.
			const model = selectedModel;
			if (!model) throw new Error("No model selected. Select a model before sending a prompt.");
			const registry = context.modelRegistry;
			const hasAuth =
				registry.hasConfiguredAuth(model) || (await registry.getProviderAuth(model.provider)) !== undefined;
			if (!hasAuth) {
				if (registry.isUsingOAuth(model))
					throw new Error(
						`Authentication failed for "${model.provider}". Credentials may have expired or network is unavailable. Run '/login ${model.provider}' to re-authenticate.`,
					);
				throw new Error(
					`No API key found for ${model.provider}. Configure credentials or run '/login ${model.provider}'.`,
				);
			}
			pi.sendUserMessage(prompt, { expandPromptTemplates: false });
		},
		steer: async (message) => {
			pi.sendUserMessage(message, { deliverAs: "steer", expandPromptTemplates: false });
		},
		abort: async () => {
			context.abort();
		},
		shutdown: async () => {
			context.shutdown();
		},
	};
}

export default function childBridgeExtension(pi: ExtensionAPI): void {
	installChildBridgeExtension(pi);
}
