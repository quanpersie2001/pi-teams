import { createHash, randomUUID } from "node:crypto";
import { connect as connectSocket, type Socket } from "node:net";
import {
	assertChildState,
	CHILD_MAX_FRAME_BYTES,
	CHILD_PROTOCOL_VERSION,
	type ChildControlCommand,
	type ChildEvent,
	ChildProtocolError,
	type ChildState,
	decodeChildFrame,
	encodeChildFrame,
	isChildEvent,
	isRecord,
} from "../domain/child-protocol.js";

export interface ChildRpcClientOptions {
	socketPath: string;
	childId: string;
	token: string;
	connectTimeoutMs?: number;
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}
interface PromptRequest {
	fingerprint: string;
	promise: Promise<void>;
}

export class ChildRpcClient {
	private readonly socketPath: string;
	private readonly childId: string;
	private readonly token: string;
	private readonly connectTimeoutMs: number;
	private socket: Socket | undefined;
	private frameBuffer = Buffer.alloc(0);
	private readonly pending = new Map<string, PendingRequest>();
	private readonly promptRequests = new Map<string, PromptRequest>();
	private readonly listeners = new Set<(event: ChildEvent) => void>();
	private readonly connectionListeners = new Set<(connected: boolean) => void>();
	private connectPromise: Promise<ChildState> | undefined;
	private cancelConnect: (() => void) | undefined;
	private connected = false;
	private lastSeq = 0;
	private generation = 0;

	constructor(options: ChildRpcClientOptions) {
		if (!options.socketPath || !options.childId || !options.token)
			throw new Error("socketPath, childId, and token are required");
		this.socketPath = options.socketPath;
		this.childId = options.childId;
		this.token = options.token;
		this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
		if (!Number.isFinite(this.connectTimeoutMs) || this.connectTimeoutMs <= 0)
			throw new Error("connectTimeoutMs must be a positive finite number");
	}

	connect(): Promise<ChildState> {
		if (this.connected) return this.state();
		if (this.connectPromise) return this.connectPromise;
		const generation = ++this.generation;
		const pending = this.connectUntilReady(generation);
		this.connectPromise = pending;
		void pending
			.finally(() => {
				if (this.generation === generation) this.connectPromise = undefined;
			})
			.catch(() => undefined);
		return pending;
	}

	async state(): Promise<ChildState> {
		const envelope = await this.call("state", {});
		const state = this.readStateEnvelope(envelope);
		this.lastSeq = Math.max(this.lastSeq, state.seq);
		return state;
	}

	prompt(runId: string, prompt: string, limits?: { maxTurns?: number; graceTurns?: number }): Promise<void> {
		if (!runId || runId.length > 121)
			return Promise.reject(new ChildProtocolError("invalid_request", "runId must contain at most 121 characters"));
		const requestId = `prompt:${runId}`;
		const requestFingerprint = createHash("sha256")
			.update(JSON.stringify([runId, prompt, limits]))
			.digest("hex");
		const existing = this.promptRequests.get(requestId);
		if (existing) {
			if (existing.fingerprint !== requestFingerprint)
				return Promise.reject(
					new ChildProtocolError("request_id_reused", "This runId was already used with a different prompt"),
				);
			return existing.promise;
		}
		const promise = this.call("prompt", { runId, prompt, ...limits }, requestId).then(() => undefined);
		const entry: PromptRequest = { fingerprint: requestFingerprint, promise };
		this.promptRequests.set(requestId, entry);
		while (this.promptRequests.size > 256) {
			const oldest = this.promptRequests.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.promptRequests.delete(oldest);
		}
		void promise.catch((error: unknown) => {
			if (this.promptRequests.get(requestId) !== entry || !(error instanceof ChildProtocolError)) return;
			if (
				error.code === "disconnected" ||
				error.code === "connection_failed" ||
				error.code === "request_timeout" ||
				error.code === "connect_timeout"
			) {
				this.promptRequests.delete(requestId);
			}
		});
		return promise;
	}

	admitAssignment(runId: string): Promise<void> {
		return this.call("admit_assignment", { runId }, `admit:${runId}`).then(() => undefined);
	}

	async steer(runId: string, message: string): Promise<void> {
		await this.call("steer", { runId, message });
	}

	async abort(runId: string): Promise<void> {
		await this.call("abort", { runId });
	}

	async control(command: ChildControlCommand): Promise<ChildState> {
		const state = await this.call("control", { command });
		return assertChildState(state, this.childId);
	}

	async shutdown(): Promise<void> {
		await this.call("shutdown", {});
	}

	subscribe(listener: (event: ChildEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	subscribeConnection(listener: (connected: boolean) => void): () => void {
		this.connectionListeners.add(listener);
		return () => this.connectionListeners.delete(listener);
	}

	disconnect(): void {
		this.generation++;
		const cancel = this.cancelConnect;
		this.cancelConnect = undefined;
		cancel?.();
		this.connectPromise = undefined;
		const socket = this.socket;
		this.socket = undefined;
		this.frameBuffer = Buffer.alloc(0);
		this.setConnected(false);
		if (socket) {
			socket.removeAllListeners();
			socket.destroy();
		}
		this.rejectPending(new ChildProtocolError("disconnected", "Child RPC client disconnected"));
	}

	private async connectUntilReady(generation: number): Promise<ChildState> {
		const deadline = Date.now() + this.connectTimeoutMs;
		while (generation === this.generation) {
			const remaining = deadline - Date.now();
			if (remaining <= 0)
				throw new ChildProtocolError(
					"connect_timeout",
					`Child ${this.childId} did not open its control socket before the startup deadline`,
				);
			try {
				return await this.connectSocket(generation, remaining);
			} catch (error) {
				if (!(error instanceof ChildProtocolError) || error.code !== "socket_not_ready") throw error;
				await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
			}
		}
		throw new ChildProtocolError("disconnected", "Child RPC connection was cancelled");
	}

	private connectSocket(generation: number, timeoutMs: number): Promise<ChildState> {
		return new Promise<ChildState>((resolve, reject) => {
			const socket = connectSocket(this.socketPath);
			this.socket = socket;
			this.frameBuffer = Buffer.alloc(0);
			let settled = false;
			const timeout = setTimeout(() => {
				fail(new ChildProtocolError("connect_timeout", `Timed out connecting to child ${this.childId}`));
				socket.destroy();
			}, timeoutMs);
			timeout.unref();

			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (this.cancelConnect === cancel) this.cancelConnect = undefined;
				reject(error);
			};
			const cancel = () => fail(new ChildProtocolError("disconnected", "Child RPC connection was cancelled"));
			this.cancelConnect = cancel;

			socket.on("connect", () => {
				if (generation !== this.generation)
					return fail(new ChildProtocolError("disconnected", "Child RPC connection was cancelled"));
				this.writeRequest(socket, "hello", {
					protocolVersion: CHILD_PROTOCOL_VERSION,
					childId: this.childId,
					token: this.token,
				})
					.then((reply) => {
						const state = this.readStateEnvelope(reply);
						if (generation !== this.generation)
							throw new ChildProtocolError("disconnected", "Child RPC connection was cancelled");
						settled = true;
						clearTimeout(timeout);
						if (this.cancelConnect === cancel) this.cancelConnect = undefined;
						this.lastSeq = Math.max(this.lastSeq, state.seq);
						this.setConnected(true);
						resolve(state);
					})
					.catch((error: unknown) => {
						const failure = error instanceof Error ? error : new Error(String(error));
						if (!socket.destroyed) socket.destroy(failure);
						fail(failure);
					});
			});

			socket.on("data", (chunk: Buffer) => {
				try {
					this.onData(chunk, socket);
				} catch (error) {
					const failure = error instanceof Error ? error : new Error(String(error));
					fail(failure);
					socket.destroy(failure);
				}
			});
			socket.on("error", (error) => {
				const code = (error as NodeJS.ErrnoException).code;
				const failure = new ChildProtocolError(
					code === "ENOENT" || code === "ECONNREFUSED" ? "socket_not_ready" : "connection_failed",
					`Child RPC connection failed: ${error.message}`,
				);
				this.onSocketClosed(socket, failure);
				fail(failure);
			});
			socket.on("close", () => {
				this.onSocketClosed(socket, new ChildProtocolError("disconnected", "Child RPC connection closed"));
				fail(new ChildProtocolError("disconnected", "Child RPC connection closed before handshake completed"));
			});
		});
	}

	private async call(method: string, params: Record<string, unknown>, requestId?: string): Promise<unknown> {
		const socket = this.socket;
		if (!this.connected || !socket || socket.destroyed)
			throw new ChildProtocolError("disconnected", "Child RPC client is not connected");
		return this.writeRequest(socket, method, params, requestId);
	}

	private writeRequest(
		socket: Socket,
		method: string,
		params: Record<string, unknown>,
		requestId?: string,
	): Promise<unknown> {
		const id = requestId ?? randomUUID();
		const frame = encodeChildFrame({ id, method, params });
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(
				() => {
					this.pending.delete(id);
					reject(new ChildProtocolError("request_timeout", `Child RPC ${method} request timed out`));
				},
				Math.max(this.connectTimeoutMs * 4, 20_000),
			);
			timer.unref();
			this.pending.set(id, { resolve, reject, timer });
			socket.write(frame, (error) => {
				if (!error) return;
				const request = this.pending.get(id);
				if (!request) return;
				this.pending.delete(id);
				clearTimeout(request.timer);
				request.reject(
					new ChildProtocolError("connection_failed", `Unable to write child RPC request: ${error.message}`),
				);
			});
		});
	}

	private onData(chunk: Buffer, socket: Socket): void {
		this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);
		if (this.frameBuffer.byteLength > CHILD_MAX_FRAME_BYTES && this.frameBuffer.indexOf(10) === -1) {
			throw new ChildProtocolError("frame_too_large", "Child protocol frame exceeds the configured limit");
		}
		let newline = this.frameBuffer.indexOf(10);
		while (newline !== -1) {
			const line = this.frameBuffer.subarray(0, newline);
			this.frameBuffer = this.frameBuffer.subarray(newline + 1);
			if (line.byteLength === 0) throw new ChildProtocolError("invalid_frame", "Empty child protocol frame");
			const decoded = decodeChildFrame(line);
			if (isChildEvent(decoded, this.childId)) {
				if (decoded.seq <= this.lastSeq) {
					newline = this.frameBuffer.indexOf(10);
					continue;
				}
				this.lastSeq = decoded.seq;
				for (const listener of this.listeners) {
					try {
						listener(decoded);
					} catch {
						// Consumer callbacks cannot corrupt framing or starve other listeners.
					}
				}
			} else {
				this.resolveReply(decoded, socket);
			}
			newline = this.frameBuffer.indexOf(10);
		}
		if (this.frameBuffer.byteLength > CHILD_MAX_FRAME_BYTES)
			throw new ChildProtocolError("frame_too_large", "Child protocol frame exceeds the configured limit");
	}

	private resolveReply(value: unknown, socket: Socket): void {
		if (!isRecord(value) || typeof value.id !== "string" || typeof value.ok !== "boolean") {
			throw new ChildProtocolError("invalid_reply", "Malformed child RPC reply");
		}
		const request = this.pending.get(value.id);
		if (!request) throw new ChildProtocolError("invalid_reply", "Child RPC reply has no matching request");
		this.pending.delete(value.id);
		clearTimeout(request.timer);
		if (value.ok) {
			if (!("result" in value))
				throw new ChildProtocolError("invalid_reply", "Successful child RPC reply has no result");
			request.resolve(value.result);
			return;
		}
		if (!isRecord(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string") {
			throw new ChildProtocolError("invalid_reply", "Failed child RPC reply has an invalid error");
		}
		request.reject(new ChildProtocolError(value.error.code, value.error.message));
		if (socket.destroyed) return;
	}

	private readStateEnvelope(value: unknown): ChildState {
		if (
			!isRecord(value) ||
			!isRecord(value.identity) ||
			value.identity.protocolVersion !== CHILD_PROTOCOL_VERSION ||
			value.identity.childId !== this.childId
		) {
			throw new ChildProtocolError(
				"identity_mismatch",
				"Child handshake state identity does not match the connected child",
			);
		}
		return assertChildState(value.state, this.childId);
	}

	private onSocketClosed(socket: Socket, reason: Error): void {
		if (this.socket !== socket) return;
		this.socket = undefined;
		this.frameBuffer = Buffer.alloc(0);
		this.setConnected(false);
		this.rejectPending(reason);
	}

	private rejectPending(error: Error): void {
		for (const [id, request] of this.pending) {
			clearTimeout(request.timer);
			request.reject(error);
			this.pending.delete(id);
		}
	}

	private setConnected(connected: boolean): void {
		if (this.connected === connected) return;
		this.connected = connected;
		for (const listener of this.connectionListeners) {
			try {
				listener(connected);
			} catch {
				// Connection observers are isolated from the transport.
			}
		}
	}
}
