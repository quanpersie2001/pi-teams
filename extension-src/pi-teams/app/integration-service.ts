// IntegrationService — versioned RPC orchestration for cross-extension
// consumers (docs/INTEGRATION.md; pi-tasks is the reference consumer).
//
// Pure app-layer: this module never imports from pi/. The transport is
// injected as an EventBus-shaped object ({ on, emit }) — the real host passes
// pi.events, tests pass createEventBus() from @earendil-works/pi-coding-agent.
//
// Wire contract (protocol v3, domain/integration-protocol.ts):
//
//   request : `subagents:rpc:<op>`          { requestId, ...payload }
//   reply   : `subagents:rpc:<op>:reply:<requestId>`
//             { success: true, data? } | { success: false, error }
//
// Operations: ping | spawn | status | steer | stop | resume | release.
// Consumer compatibility notes (mirrors pi-tasks' SubagentRuntime):
//   - ping replies data.version = PROTOCOL_VERSION. The consumer rejects a
//     non-numeric or older version and accepts newer optimistically.
//   - spawn carries options.isBackground (NOT background); it is mapped onto
//     the manager's run_in_background here so the wire shape stays stable.
//   - the consumer never sends an owner in the spawn payload: RPC callers are
//     extension callers by construction, so owner defaults to
//     { kind: "extension", id: "pi-tasks", ref? } and delivery defaults to
//     "event" (docs/INTEGRATION.md). An
//     explicitly provided protocol-valid owner/delivery still wins.
//   - lifecycle events broadcast on `subagents:<name>` carry BOTH agentId and
//     id (id === agentId alias) — see pi/rpc.ts for the boundary that adds it.
//
// Robustness rules: malformed payloads get an error envelope (never an
// unhandled throw), unknown ops get an error envelope when the request is
// routable, requests are handled exactly once each, and duplicate or unknown
// requestIds are harmless because every reply is scoped to its own channel.

import type { AgentOwner, DeliveryPolicy } from "../domain/delivery.js";
import {
	type AgentRunSnapshot,
	PROTOCOL_VERSION,
	type RpcReply,
	rpcError,
	rpcSuccess,
	SUBAGENTS_RPC_OPS,
	subagentsRpcChannel,
	subagentsRpcReplyChannel,
	toRunSnapshot,
} from "../domain/integration-protocol.js";
import type { AgentManager } from "./agent-manager.js";

/** Extension id used as the default RPC-caller owner (the reference consumer). */
export const PI_TASKS_EXTENSION_ID = "pi-tasks";

/** Minimal bus surface; satisfied by pi.events and createEventBus(). */
export interface SubagentsEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface IntegrationServiceOptions {
	/** Bus carrying `subagents:rpc:<op>` channels (pi.events on the host). */
	events: SubagentsEventBus;
	/**
	 * Reply sink factory. Default emits the envelope on `events`. Tests inject
	 * a capture sink to observe envelopes without bus round-trips.
	 */
	createReply?(channel: string): (payload: unknown) => void;
}

export class IntegrationService {
	private readonly unsubs: Array<() => void> = [];
	private readonly events: SubagentsEventBus;

	constructor(
		private readonly manager: AgentManager,
		options: IntegrationServiceOptions,
	) {
		this.events = options.events;
		const createReply =
			options.createReply ?? ((channel: string) => (payload: unknown) => this.events.emit(channel, payload));
		this.createReply = createReply;
		for (const op of SUBAGENTS_RPC_OPS) {
			this.unsubs.push(options.events.on(subagentsRpcChannel(op), (raw) => this.handle(op, raw)));
		}
	}

	/**
	 * Dispatch one raw request. Never throws: every failure mode becomes an
	 * error envelope on the request-scoped reply channel, or is dropped
	 * silently when even the requestId is unusable (nowhere to reply to).
	 */
	handle(op: string, raw: unknown): void {
		void this.dispatch(op, raw);
	}

	/** Remove all channel subscriptions; the service must not be used after. */
	dispose(): void {
		for (const unsub of this.unsubs.splice(0)) {
			try {
				unsub();
			} catch {
				/* best-effort teardown */
			}
		}
	}

	// -- internals ------------------------------------------------------------

	private readonly createReply: (channel: string) => (payload: unknown) => void;

	private async dispatch(op: string, raw: unknown): Promise<void> {
		let routed: { requestId: string; envelope: RpcReply<unknown> } | undefined;
		try {
			routed = await this.invoke(op, raw);
		} catch (error) {
			// Belt and braces: invoke() already catches per-op, but a bug in the
			// plumbing itself must not escape as an unhandled rejection.
			const requestId = requestIdOf(raw);
			if (requestId !== undefined) routed = { requestId, envelope: rpcError(error) };
		}
		if (!routed) return;
		try {
			this.createReply(subagentsRpcReplyChannel(op, routed.requestId))(routed.envelope);
		} catch {
			/* a broken reply sink must not break the bus */
		}
	}

	private async invoke(
		op: string,
		raw: unknown,
	): Promise<{ requestId: string; envelope: RpcReply<unknown> } | undefined> {
		const requestId = requestIdOf(raw);
		if (requestId === undefined) return undefined; // unroutable: drop quietly
		try {
			switch (op) {
				case "ping":
					return { requestId, envelope: this.handlePing(raw) };
				case "spawn":
					return { requestId, envelope: await this.handleSpawn(raw) };
				case "status":
					return { requestId, envelope: this.handleStatus(raw) };
				case "steer":
					return { requestId, envelope: await this.handleSteer(raw) };
				case "stop":
					return { requestId, envelope: await this.handleStop(raw) };
				case "resume":
					return { requestId, envelope: await this.handleResume(raw) };
				case "release":
					return { requestId, envelope: await this.handleRelease(raw) };
				default:
					return { requestId, envelope: rpcError(`unknown operation "${op}"`) };
			}
		} catch (error) {
			return { requestId, envelope: rpcError(error) };
		}
	}

	// -- op handlers (each validates strictly, throws RpcFailure on bad input) --

	private handlePing(raw: unknown): RpcReply<{ version: number }> {
		parseRequest(raw, (payload) => {
			optionalNumber(payload, "version"); // echoed by callers; tolerated absent
		});
		return rpcSuccess({ version: PROTOCOL_VERSION });
	}

	private async handleSpawn(raw: unknown): Promise<RpcReply<{ id: string; model?: string; modelFallback?: string }>> {
		const payload = parseRequest(raw, (p) => {
			requireString(p, "type");
			requireString(p, "prompt");
			if (p.options !== undefined) {
				const options = objectOf(p.options, "options");
				optionalString(options, "description");
				optionalBoolean(options, "isBackground");
				optionalNumber(options, "maxTurns");
				optionalString(options, "model");
				// Wire shape uses isBackground; anything else in options is foreign.
				for (const key of Object.keys(options)) {
					if (!["description", "isBackground", "maxTurns", "model"].includes(key)) {
						throw new RpcFailure(`unexpected option "${key}"`);
					}
				}
			}
			optionalOwner(p);
			optionalDelivery(p);
		});

		const record = payloadToRecord(payload);
		const spawned = await this.manager.spawn(record);
		return rpcSuccess({
			id: spawned.id,
			...(spawned.model !== undefined ? { model: spawned.model } : {}),
			...(spawned.modelFallback !== undefined ? { modelFallback: spawned.modelFallback } : {}),
		});
	}

	private handleStatus(raw: unknown): RpcReply<AgentRunSnapshot | null> {
		const payload = parseRequest(raw, (p) => {
			requireString(p, "agentId");
		});
		const run = this.manager.get(payload.agentId as string);
		return rpcSuccess<AgentRunSnapshot | null>(run ? toRunSnapshot(run) : null);
	}

	private async handleSteer(raw: unknown): Promise<RpcReply<{ accepted: true; queued: boolean }>> {
		const payload = parseRequest(raw, (p) => {
			requireString(p, "agentId");
			requireString(p, "message");
		});
		const agentId = payload.agentId as string;
		const run = this.manager.get(agentId);
		const queued = run?.status === "queued" || run?.status === "starting";
		if (!(await this.manager.steer(agentId, payload.message as string))) {
			throw new Error(`Agent "${agentId}" cannot be steered (unknown or settled).`);
		}
		return rpcSuccess({ accepted: true, queued });
	}

	private async handleStop(raw: unknown): Promise<RpcReply<{ stopped: true }>> {
		const payload = parseRequest(raw, (p) => {
			requireString(p, "agentId");
		});
		const agentId = payload.agentId as string;
		if (!(await this.manager.stop(agentId))) {
			throw new Error(`Agent "${agentId}" cannot be stopped (unknown or already settled).`);
		}
		return rpcSuccess({ stopped: true });
	}

	private async handleRelease(raw: unknown): Promise<RpcReply<{ released: true }>> {
		const payload = parseRequest(raw, (p) => {
			requireString(p, "agentId");
			optionalBoolean(p, "cleanupWorktree");
		});
		const cleanupWorktree = booleanOrUndefined(payload, "cleanupWorktree");
		const released = await this.manager.release(payload.agentId as string, {
			...(cleanupWorktree !== undefined ? { cleanupWorktree } : {}),
		});
		if (!released) throw new Error(`Agent "${payload.agentId as string}" was not found.`);
		return rpcSuccess({ released: true });
	}

	private async handleResume(raw: unknown): Promise<RpcReply<{ agentId: string }>> {
		const payload = parseRequest(raw, (p) => {
			requireString(p, "agentId");
			requireString(p, "prompt");
			optionalBoolean(p, "isBackground");
		});
		const resumed = await this.manager.resume(payload.agentId as string, payload.prompt as string, {
			run_in_background: booleanOrUndefined(payload, "isBackground"),
		});
		return rpcSuccess({ agentId: resumed.id });
	}
}

// -- strict parsing helpers -----------------------------------------------------

/** Sentinel for validation failures with a caller-facing message. */
class RpcFailure extends Error {}

export type ParsedRpcRequest = { requestId: string } & Record<string, unknown>;

/**
 * Validate one raw request: requestId must be a non-empty string and `check`
 * must accept the remaining fields. Throws RpcFailure on any violation.
 */
function parseRequest(raw: unknown, check: (payload: Record<string, unknown>) => void): ParsedRpcRequest {
	const requestId = requestIdOf(raw);
	if (requestId === undefined) throw new RpcFailure("request is missing a non-empty string requestId");
	const payload = raw as Record<string, unknown>;
	check(payload);
	return { requestId, ...payload };
}

function requestIdOf(raw: unknown): string | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const value = (raw as Record<string, unknown>).requestId;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireString(payload: Record<string, unknown>, key: string): void {
	const value = payload[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new RpcFailure(`field "${key}" must be a non-empty string`);
	}
}

function optionalString(payload: Record<string, unknown>, key: string): void {
	const value = payload[key];
	if (value === undefined || value === null) return;
	if (typeof value !== "string") throw new RpcFailure(`field "${key}" must be a string when present`);
}

function optionalNumber(payload: Record<string, unknown>, key: string): void {
	const value = payload[key];
	if (value === undefined || value === null) return;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new RpcFailure(`field "${key}" must be a finite number when present`);
	}
}

function optionalBoolean(payload: Record<string, unknown>, key: string): void {
	const value = payload[key];
	if (value === undefined || value === null) return;
	if (typeof value !== "boolean") throw new RpcFailure(`field "${key}" must be a boolean when present`);
}

function objectOf(value: unknown, key: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RpcFailure(`field "${key}" must be an object when present`);
	}
	return value as Record<string, unknown>;
}

function optionalOwner(payload: Record<string, unknown>): void {
	if (payload.owner === undefined) return;
	const owner = objectOf(payload.owner, "owner");
	if (owner.kind !== "conversation" && owner.kind !== "extension") {
		throw new RpcFailure('field "owner.kind" must be "conversation" or "extension"');
	}
	if (owner.kind === "conversation") optionalString(owner, "sessionId");
	else {
		optionalString(owner, "id");
		optionalString(owner, "ref");
	}
}

function optionalDelivery(payload: Record<string, unknown>): void {
	const value = payload.delivery;
	if (value === undefined || value === null) return;
	if (value !== "conversation" && value !== "event" && value !== "both" && value !== "none") {
		throw new RpcFailure('field "delivery" must be one of "conversation" | "event" | "both" | "none"');
	}
}

function stringOrUndefined(payload: Record<string, unknown>, key: string): string | undefined {
	const value = payload[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOrUndefined(payload: Record<string, unknown>, key: string): number | undefined {
	const value = payload[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanOrUndefined(payload: Record<string, unknown>, key: string): boolean | undefined {
	const value = payload[key];
	return typeof value === "boolean" ? value : undefined;
}

/** Map a validated spawn wire payload onto the manager's SpawnRequest. */
function payloadToRecord(payload: Record<string, unknown>): {
	type: string;
	prompt: string;
	description?: string;
	run_in_background?: boolean;
	model?: string;
	max_turns?: number;
	owner?: AgentOwner;
	delivery?: DeliveryPolicy;
} {
	const options =
		payload.options !== undefined
			? (payload.options as { description?: unknown; isBackground?: unknown; maxTurns?: unknown; model?: unknown })
			: {};
	const request: ReturnType<typeof payloadToRecord> = {
		type: payload.type as string,
		prompt: payload.prompt as string,
	};
	const description = stringOrUndefined(options, "description");
	if (description !== undefined) request.description = description;
	// Wire name isBackground → manager flag run_in_background.
	const isBackground = booleanOrUndefined(options, "isBackground");
	if (isBackground !== undefined) request.run_in_background = isBackground;
	const model = stringOrUndefined(options, "model");
	if (model !== undefined) request.model = model;
	const maxTurns = numberOrUndefined(options, "maxTurns");
	if (maxTurns !== undefined) request.max_turns = maxTurns;

	// Ownership defaults for RPC callers (docs/INTEGRATION.md): extension
	// caller by construction → pi-tasks extension owner + "event" delivery.
	// An explicitly supplied protocol-valid owner/delivery wins.
	const ownerField = payload.owner;
	if (ownerField !== undefined && typeof ownerField === "object" && ownerField !== null) {
		const owner = ownerField as Record<string, unknown>;
		if (owner.kind === "conversation") {
			const conversation: AgentOwner = {
				kind: "conversation",
				sessionId: stringOrUndefined(owner, "sessionId") ?? "unknown-session",
			};
			request.owner = conversation;
		} else {
			const ref = stringOrUndefined(owner, "ref");
			const extensionOwner: AgentOwner = {
				kind: "extension",
				id: stringOrUndefined(owner, "id") ?? PI_TASKS_EXTENSION_ID,
				...(ref !== undefined ? { ref } : {}),
			};
			request.owner = extensionOwner;
		}
	} else {
		request.owner = { kind: "extension", id: PI_TASKS_EXTENSION_ID };
	}
	// RPC callers are extension callers: task assignment defaults to "event"
	// (docs/INTEGRATION.md). A validated explicit delivery still wins.
	const delivery = stringOrUndefined(payload, "delivery") as DeliveryPolicy | undefined;
	request.delivery = delivery ?? (request.owner.kind === "conversation" ? "conversation" : "event");
	return request;
}
