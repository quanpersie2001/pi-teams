import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SerializableBackendHandle } from "../app/run-registry.js";
import type {
	AgentBackendHandle,
	AgentExecutionBackend,
	AgentLaunchInput,
	AgentResumeInput,
	BackendStatus,
	ModelAdmission,
	ModelAdmissionInput,
} from "../domain/backend.js";
import {
	type ChildBootstrap,
	type ChildControlCommand,
	type ChildEvent,
	ChildProtocolError,
	type ChildState,
} from "../domain/child-protocol.js";
import type { BackendMode, BackendSelector } from "../domain/config.js";
import type { ChildMessageReply, ChildMessageRequest, InboxMessage } from "../domain/message.js";
import type { LauncherHandle, ProcessLauncher } from "../domain/process-launcher.js";
import { ProcessLaunchCleanupPendingError } from "../domain/process-launcher.js";
import type { TranscriptSnapshot } from "../domain/transcript.js";
import { ChildRpcClient } from "./child-rpc-client.js";
import { createModelAdmission } from "./model-admission.js";
import { createProcessLaunchers } from "./process-launchers.js";
import { subagentsArtifactDir } from "./registry-host.js";

interface ChildConnection {
	bootstrap: ChildBootstrap;
	runDir: string;
	launcher: ProcessLauncher;
	launcherHandle: LauncherHandle;
	modelFallback?: string;
	client: ChildRpcClient;
	snapshot?: ChildState;
	connected: boolean;
	detached: boolean;
	closed: boolean;
	identityFailure?: ChildProtocolError;
	refreshing: boolean;
	refreshAgain: boolean;
	reconnectTimer?: NodeJS.Timeout;
	unlisten: (() => void)[];
	focusListeners: Set<(state: ChildState) => void>;
	messageListeners: Set<(request: ChildMessageRequest) => Promise<ChildMessageReply>>;
	pendingMessages: { requestId: string; request: ChildMessageRequest; timer: NodeJS.Timeout }[];
}
interface RunConnection {
	runId: string;
	child: ChildConnection;
	status: BackendStatus;
	listeners: Set<(status: BackendStatus) => void>;
	admissionUncertain?: boolean;
}
export interface ProcessBackendOptions {
	launcherHint?: BackendSelector;
	launchers?: readonly ProcessLauncher[];
	connectTimeoutMs?: number;
	/** Built runtime entrypoints; overridable for independently launched integration fixtures. */
	entryPaths?: { bridge: string; headless: string };
	piCommand?: string;
	agentDir?: string;
	getParentModel?: () => string | undefined;
}

export function resolveLauncherHint(env: NodeJS.ProcessEnv = process.env): BackendSelector {
	const value = env.PI_SUBAGENTS_BACKEND?.trim() ?? "auto";
	if (value !== "auto" && value !== "herdr" && value !== "tmux" && value !== "headless") {
		throw new Error(`Unsupported PI_SUBAGENTS_BACKEND "${value}"; use auto, herdr, tmux or headless.`);
	}
	return value;
}

/**
 * Effective launcher hint at session start: an explicit `PI_SUBAGENTS_BACKEND`
 * (full four-launcher selection) overrides the `backend` settings key
 * (auto/headless only); without either, launchers auto-detect.
 */
export function resolveSessionLauncherHint(env: NodeJS.ProcessEnv, settingsBackend: BackendMode): BackendSelector {
	const raw = env.PI_SUBAGENTS_BACKEND?.trim();
	if (raw !== undefined && raw.length > 0) return resolveLauncherHint(env);
	return settingsBackend;
}

function entryPaths(): { bridge: string; headless: string } {
	const adjacent = {
		bridge: fileURLToPath(new URL("./child-bridge.js", import.meta.url)),
		headless: fileURLToPath(new URL("./headless-child.js", import.meta.url)),
	};
	if (existsSync(adjacent.bridge) && existsSync(adjacent.headless)) return adjacent;
	const built = {
		bridge: fileURLToPath(new URL("../../../dist/extensions/child-bridge.js", import.meta.url)),
		headless: fileURLToPath(new URL("../../../dist/extensions/headless-child.js", import.meta.url)),
	};
	if (!existsSync(built.bridge) || !existsSync(built.headless))
		throw new Error("Child runtime is not built. Run npm run build before launching subagents.");
	return built;
}
function isChildMessageRequest(value: unknown): value is ChildMessageRequest {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const request = value as Record<string, unknown>;
	if (request.action === "list") return true;
	if (request.action === "consume") return typeof request.messageId === "string" && request.messageId.length > 0;
	if (request.action !== "send" || typeof request.text !== "string") return false;
	const target = request.target;
	if (target === null || typeof target !== "object" || Array.isArray(target)) return false;
	const endpoint = target as Record<string, unknown>;
	return endpoint.kind === "parent" || (endpoint.kind === "agent" && typeof endpoint.agentId === "string");
}
export class ProcessAgentExecutionBackend implements AgentExecutionBackend {
	readonly kind = "process" as const;
	private readonly launchers: readonly ProcessLauncher[];
	private readonly runs = new Map<string, RunConnection>();
	private readonly children = new Map<string, ChildConnection>();
	private readonly options: ProcessBackendOptions;
	private readonly admitModel: (input: ModelAdmissionInput) => Promise<ModelAdmission>;
	private launcherHint: BackendSelector;

	constructor(options: ProcessBackendOptions = {}) {
		this.options = options;
		this.launchers = options.launchers ?? createProcessLaunchers();
		this.launcherHint = options.launcherHint ?? "auto";
		this.admitModel = createModelAdmission({
			...(options.agentDir !== undefined ? { agentDir: options.agentDir } : {}),
			...(options.getParentModel !== undefined ? { getParentModel: options.getParentModel } : {}),
		});
	}
	/** Current launcher selection hint; `auto` means multiplexer auto-detection. */
	getLauncherHint(): BackendSelector {
		return this.launcherHint;
	}
	/** Replace the launcher hint for future launches; started children keep theirs. */
	setLauncherHint(hint: BackendSelector): void {
		this.launcherHint = hint;
	}
	/** Launcher kind the current hint resolves to; rejects when none is available. */
	async detectLauncherKind(): Promise<ProcessLauncher["kind"]> {
		return (await this.chooseLauncher()).kind;
	}
	async available(): Promise<boolean> {
		try {
			await this.chooseLauncher();
			return true;
		} catch {
			return false;
		}
	}
	prepareModel(input: ModelAdmissionInput): Promise<ModelAdmission> {
		return this.admitModel(input);
	}
	private async chooseLauncher(): Promise<ProcessLauncher> {
		const hint = this.launcherHint;
		for (const launcher of this.launchers) {
			if (hint !== "auto" && launcher.kind !== hint) continue;
			if (await launcher.available()) return launcher;
		}
		throw new Error(`No available process launcher for "${hint}".`);
	}

	async launch(input: AgentLaunchInput): Promise<AgentBackendHandle> {
		return this.launchChild(input);
	}
	private async launchChild(input: AgentLaunchInput, sessionFile?: string): Promise<AgentBackendHandle> {
		// Recheck after queueing and before creating any filesystem/process/pane resource.
		const admission = await this.prepareModel({
			...(input.model !== undefined ? { model: input.model } : {}),
			...(sessionFile !== undefined ? { sessionFile } : {}),
		});
		input = {
			...input,
			model: admission.model,
			...(admission.fallback !== undefined ? { modelFallback: admission.fallback } : {}),
		};
		const launcher = await this.chooseLauncher();
		const paths = this.options.entryPaths ?? entryPaths();
		const childId = randomUUID();
		const runDir = join(subagentsArtifactDir(input.configCwd), "sessions", childId);
		mkdirSync(runDir, { recursive: true, mode: 0o700 });
		chmodSync(runDir, 0o700);
		// Unix socket pathname limits are small; project/session paths may be arbitrarily long.
		const controlDir = mkdtempSync("/tmp/pi-subagents-");
		chmodSync(controlDir, 0o700);
		const bootstrap: ChildBootstrap = {
			childId,
			token: randomBytes(32).toString("hex"),
			socketPath: join(controlDir, "control.sock"),
			sessionDir: sessionFile ? dirname(sessionFile) : runDir,
			cwd: input.cwd,
			configCwd: input.configCwd,
			systemPrompt: input.systemPrompt,
			promptMode: input.promptMode,
			...(sessionFile ? { sessionFile } : {}),
			...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
			...(input.model !== undefined ? { model: input.model } : {}),
			...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
			...(input.tools !== undefined ? { tools: [...input.tools] } : {}),
			...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
			...(input.graceTurns !== undefined ? { graceTurns: input.graceTurns } : {}),
		};
		const configFile = join(runDir, "bootstrap.json");
		writeFileSync(configFile, JSON.stringify(bootstrap), { mode: 0o600 });
		const interactiveArgv = ["--no-extensions", "--extension", paths.bridge, "--session-dir", bootstrap.sessionDir];
		if (sessionFile) interactiveArgv.push("--session", sessionFile);
		if (!sessionFile && input.model) interactiveArgv.push("--model", input.model);
		if (!sessionFile && input.thinking) interactiveArgv.push("--thinking", input.thinking);
		let handle: LauncherHandle | undefined;
		let child: ChildConnection | undefined;
		try {
			const command = this.options.piCommand
				? [this.options.piCommand]
				: [
						process.execPath,
						fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent"))),
					];
			handle = await launcher.launch({
				childId,
				runDir,
				cwd: input.cwd,
				env: {
					PI_SUBAGENTS_BOOTSTRAP: configFile,
					PI_SUBAGENTS_CHILD: "1",
					...(this.options.agentDir !== undefined ? { PI_CODING_AGENT_DIR: this.options.agentDir } : {}),
				},
				interactiveArgv: [...command, ...interactiveArgv],
				headlessCommand: process.execPath,
				headlessArgv: [paths.headless],
			});
			const client = new ChildRpcClient({
				socketPath: bootstrap.socketPath,
				childId,
				token: bootstrap.token,
				connectTimeoutMs: this.options.connectTimeoutMs ?? 20_000,
			});
			const snapshot = await client.connect();
			child = {
				bootstrap,
				runDir,
				launcher,
				launcherHandle: handle,
				...(input.modelFallback !== undefined ? { modelFallback: input.modelFallback } : {}),
				client,
				snapshot,
				connected: true,
				detached: false,
				closed: false,
				refreshing: false,
				refreshAgain: false,
				unlisten: [],
				focusListeners: new Set(),
				messageListeners: new Set(),
				pendingMessages: [],
			};
			this.verifyChildPid(handle, snapshot);
			this.children.set(childId, child);
			this.watchChild(child);
			const run = this.createRun(input.runId, child);
			await client.prompt(input.runId, input.prompt);
			await this.refreshChild(child);
			return { kind: "process", handle: run.runId };
		} catch (error) {
			if (error instanceof ProcessLaunchCleanupPendingError)
				throw new AggregateError(
					[error],
					`Child launcher cleanup remains unverified. Recovery bootstrap: ${configFile}`,
				);
			if (error instanceof ChildProtocolError && error.code === "prompt_failed" && child) {
				try {
					this.acceptSnapshot(child, await child.client.state());
				} catch (snapshotError) {
					if (child.identityFailure)
						throw new AggregateError(
							[error, snapshotError],
							`Child prompt failed and its authenticated outcome could not be reconciled. Recovery bootstrap: ${configFile}`,
						);
				}
				const run = this.runs.get(input.runId);
				if (run?.child === child) {
					this.publish(run, {
						state: "failed",
						...(child.snapshot?.sessionFile && existsSync(child.snapshot.sessionFile)
							? { sessionFile: child.snapshot.sessionFile }
							: {}),
						error: error.message,
					});
					return { kind: "process", handle: input.runId };
				}
			}
			const alive = handle ? await launcher.alive(handle).catch(() => undefined) : undefined;
			const failure =
				error instanceof ChildProtocolError && error.code === "connect_timeout"
					? new Error(
							`Child control startup deadline expired (launcher=${launcher.kind}, alive=${String(alive)}). ${launcher.kind === "headless" ? `Inspect ${join(runDir, "child.log")}.` : `Native pane: ${handle?.paneId ?? "unavailable"}.`} Bootstrap: ${configFile}`,
							{ cause: error },
						)
					: error;
			if (handle) {
				try {
					await launcher.terminate(handle);
				} catch (cleanupError) {
					throw new AggregateError(
						[failure, cleanupError],
						`Child launch failed; cleanup failed. Recovery bootstrap: ${configFile}`,
					);
				}
			}
			if (child) {
				this.releaseChild(child);
				this.children.delete(childId);
				this.runs.delete(input.runId);
			} else {
				rmSync(controlDir, { recursive: true, force: true });
			}
			throw failure;
		}
	}
	private createRun(runId: string, child: ChildConnection): RunConnection {
		const run: RunConnection = {
			runId,
			child,
			status: {
				state: "starting",
				...(child.snapshot?.sessionFile && existsSync(child.snapshot.sessionFile)
					? { sessionFile: child.snapshot.sessionFile }
					: {}),
			},
			listeners: new Set(),
		};
		this.runs.set(runId, run);
		this.updateRun(run);
		return run;
	}
	private verifyChildPid(handle: LauncherHandle, snapshot: ChildState): void {
		if (handle.kind !== "tmux" && handle.pid !== snapshot.pid) {
			throw new ChildProtocolError(
				"identity_mismatch",
				"Authenticated child PID does not match its owned launcher process",
			);
		}
	}

	private acceptSnapshot(child: ChildConnection, snapshot: ChildState): void {
		if (child.identityFailure) throw child.identityFailure;
		try {
			this.verifyChildPid(child.launcherHandle, snapshot);
		} catch (error) {
			if (error instanceof ChildProtocolError && error.code === "identity_mismatch") {
				child.identityFailure = error;
				child.connected = false;
				this.unwatch(child);
				child.client.disconnect();
				for (const run of this.runs.values())
					if (run.child === child && !isSettled(run.status))
						this.publish(run, { state: "disconnected", detail: error.message });
			}
			throw error;
		}
		if (!child.snapshot || snapshot.seq >= child.snapshot.seq) child.snapshot = snapshot;
		child.connected = true;
		for (const run of this.runs.values()) if (run.child === child) this.updateRun(run);
		const current = child.snapshot;
		if (current) for (const listener of [...child.focusListeners]) listener(current);
	}
	private watchChild(child: ChildConnection): void {
		child.unlisten.push(
			child.client.subscribe((event: ChildEvent) => {
				if (event.event === "message_request" && typeof event.payload.requestId === "string") {
					const request = event.payload.request;
					if (isChildMessageRequest(request)) {
						const requestId = event.payload.requestId;
						const listener = [...child.messageListeners].at(-1);
						if (listener) this.deliverChildMessage(child, requestId, request, listener);
						else if (child.pendingMessages.length < 64) {
							const timer = setTimeout(() => {
								const index = child.pendingMessages.findIndex((entry) => entry.requestId === requestId);
								if (index >= 0) child.pendingMessages.splice(index, 1);
								void child.client.rejectMessageRequest(requestId, "Message service is not attached");
							}, 30_000);
							timer.unref();
							child.pendingMessages.push({ requestId, request, timer });
						} else void child.client.rejectMessageRequest(requestId, "Message request queue is full");
					}
				}
				void this.refreshChild(child);
			}),
		);
		child.unlisten.push(
			child.client.subscribeConnection((connected) => {
				child.connected = connected;
				if (connected) return; // The connect caller accepts its authenticated snapshot.
				for (const run of this.runs.values()) if (run.child === child) this.updateRun(run);
				this.scheduleReconnect(child);
			}),
		);
	}
	private unwatch(child: ChildConnection): void {
		for (const off of child.unlisten.splice(0)) off();
		clearTimeout(child.reconnectTimer);
		delete child.reconnectTimer;
	}
	private releaseChild(child: ChildConnection): void {
		this.unwatch(child);
		for (const pending of child.pendingMessages) clearTimeout(pending.timer);
		child.pendingMessages.length = 0;
		child.client.disconnect();
		rmSync(dirname(child.bootstrap.socketPath), { recursive: true, force: true });
		child.closed = true;
	}
	private reattachChild(child: ChildConnection): void {
		if (!child.detached || child.closed || child.identityFailure) return;
		child.detached = false;
		this.watchChild(child);
	}

	private scheduleReconnect(child: ChildConnection): void {
		if (child.detached || child.closed || child.identityFailure || child.reconnectTimer) return;
		child.reconnectTimer = setTimeout(() => {
			delete child.reconnectTimer;
			void child.client
				.connect()
				.then((snapshot) => {
					this.acceptSnapshot(child, snapshot);
				})
				.catch(async () => {
					if (child.identityFailure) return;
					// Verified disappearance is an execution failure, never a successful result.
					const exited = await child.launcher.cleanupExited(child.launcherHandle).catch(() => false);
					if (exited) {
						for (const run of this.runs.values())
							if (run.child === child && !isSettled(run.status))
								this.publish(run, {
									state: "failed",
									outcomeUnavailable: true,
									error: "Child process exited before an RPC outcome was recovered.",
									detail: "Child process exited before an RPC outcome was recovered.",
								});
						return;
					}
					this.scheduleReconnect(child);
				});
		}, 500);
		child.reconnectTimer.unref?.();
	}
	private async refreshChild(child: ChildConnection): Promise<void> {
		if (child.closed || child.detached || !child.connected) return;
		if (child.refreshing) {
			child.refreshAgain = true;
			return;
		}
		child.refreshing = true;
		try {
			do {
				child.refreshAgain = false;
				this.acceptSnapshot(child, await child.client.state());
			} while (child.refreshAgain && child.connected && !child.detached);
		} catch {
			if (child.identityFailure) return;
			child.connected = false;
			for (const run of this.runs.values()) if (run.child === child) this.updateRun(run);
			this.scheduleReconnect(child);
		} finally {
			child.refreshing = false;
		}
	}
	private updateRun(run: RunConnection): void {
		if (isSettled(run.status)) return;
		const snapshot = run.child.snapshot;
		if (!snapshot) {
			this.publish(run, { state: "disconnected", detail: "Awaiting an authenticated child snapshot." });
			return;
		}
		const outcome = snapshot.lastOutcome?.runId === run.runId ? snapshot.lastOutcome : undefined;
		const meta = {
			// Pi assigns a filename before its first persisted entry; rejected preflight has no resumable JSONL.
			...(snapshot.sessionFile && existsSync(snapshot.sessionFile) ? { sessionFile: snapshot.sessionFile } : {}),
			...(snapshot.usage ? { usage: snapshot.usage } : {}),
			...(snapshot.turns !== undefined ? { turns: snapshot.turns } : {}),
			...(snapshot.toolUses !== undefined ? { toolUses: snapshot.toolUses } : {}),
		};
		if (outcome) {
			this.publish(run, {
				state: outcome.status,
				...meta,
				...(outcome.result !== undefined ? { result: outcome.result } : {}),
				...(outcome.error !== undefined ? { error: outcome.error } : {}),
			});
		} else if (!run.child.connected)
			this.publish(run, { state: "disconnected", ...meta, detail: "Child control connection lost; reconnecting." });
		else if (run.admissionUncertain && snapshot.currentRunId !== run.runId) {
			this.publish(run, { state: "failed", ...meta, error: "Child snapshot confirms the prompt was not admitted." });
		} else {
			if (snapshot.currentRunId === run.runId) run.admissionUncertain = false;
			this.publish(run, {
				state: snapshot.currentRunId === run.runId && snapshot.execution === "running" ? "running" : "starting",
				...meta,
			});
		}
	}
	private publish(run: RunConnection, status: BackendStatus): void {
		const selected = run.child.snapshot?.focus?.model;
		const next: BackendStatus = {
			...(selected
				? { model: `${selected.provider}/${selected.id}` }
				: run.child.bootstrap.model !== undefined
					? { model: run.child.bootstrap.model }
					: {}),
			...(run.child.modelFallback !== undefined ? { modelFallback: run.child.modelFallback } : {}),
			...status,
		};
		const previous = run.status;
		const usageMatches =
			previous.usage === next.usage ||
			(previous.usage !== undefined &&
				next.usage !== undefined &&
				previous.usage.inputTokens === next.usage.inputTokens &&
				previous.usage.outputTokens === next.usage.outputTokens &&
				previous.usage.cacheReadTokens === next.usage.cacheReadTokens &&
				previous.usage.cacheWriteTokens === next.usage.cacheWriteTokens &&
				previous.usage.totalTokens === next.usage.totalTokens);
		if (
			previous.state === next.state &&
			previous.model === next.model &&
			previous.modelFallback === next.modelFallback &&
			previous.detail === next.detail &&
			previous.result === next.result &&
			previous.error === next.error &&
			previous.outcomeUnavailable === next.outcomeUnavailable &&
			previous.sessionFile === next.sessionFile &&
			previous.turns === next.turns &&
			previous.toolUses === next.toolUses &&
			usageMatches
		)
			return;
		run.status = next;
		for (const listener of [...run.listeners]) {
			try {
				listener({ ...run.status });
			} catch {
				/* One observer cannot disrupt child reconciliation. */
			}
		}
	}
	private requireRun(handle: AgentBackendHandle): RunConnection {
		const run = this.runs.get(handle.handle);
		if (handle.kind !== "process" || !run) throw new Error("Unknown process run handle.");
		return run;
	}
	async status(handle: AgentBackendHandle): Promise<BackendStatus> {
		const run = this.requireRun(handle);
		if (run.child.identityFailure) return { ...run.status };
		this.reattachChild(run.child);
		if (!run.child.connected && !run.child.detached && !run.child.closed) {
			try {
				this.acceptSnapshot(run.child, await run.child.client.connect());
			} catch (error) {
				if (!isSettled(run.status))
					this.publish(run, {
						state: "disconnected",
						detail: `Child reconnect failed: ${error instanceof Error ? error.message : String(error)}`,
					});
				this.scheduleReconnect(run.child);
				return { ...run.status };
			}
		}
		await this.refreshChild(run.child);
		return { ...run.status };
	}
	subscribe(handle: AgentBackendHandle, listener: (status: BackendStatus) => void): () => void {
		const run = this.requireRun(handle);
		run.listeners.add(listener);
		return () => run.listeners.delete(listener);
	}
	async readFocusState(handle: AgentBackendHandle): Promise<ChildState | undefined> {
		const run = this.requireRun(handle);
		if (run.child.identityFailure) throw run.child.identityFailure;
		if (run.child.closed) return run.child.snapshot;
		if (run.child.connected) await this.refreshChild(run.child);
		return run.child.snapshot;
	}

	async controlFocus(handle: AgentBackendHandle, command: ChildControlCommand): Promise<ChildState> {
		const run = this.requireRun(handle);
		this.requireControl(run.child);
		const state = await run.child.client.control(command);
		this.acceptSnapshot(run.child, state);
		return run.child.snapshot ?? state;
	}

	subscribeFocus(handle: AgentBackendHandle, listener: (state: ChildState) => void): () => void {
		const child = this.requireRun(handle).child;
		child.focusListeners.add(listener);
		if (child.snapshot) listener(child.snapshot);
		return () => child.focusListeners.delete(listener);
	}

	async sendInbox(handle: AgentBackendHandle, message: InboxMessage): Promise<boolean> {
		const child = this.requireRun(handle).child;
		if (child.closed || !child.connected || child.identityFailure) return false;
		await child.client.sendInbox(message);
		return true;
	}
	subscribeMessages(
		handle: AgentBackendHandle,
		listener: (request: ChildMessageRequest) => Promise<ChildMessageReply>,
	): () => void {
		const child = this.requireRun(handle).child;
		child.messageListeners.add(listener);
		for (const pending of child.pendingMessages.splice(0)) {
			clearTimeout(pending.timer);
			this.deliverChildMessage(child, pending.requestId, pending.request, listener);
		}
		return () => child.messageListeners.delete(listener);
	}

	private deliverChildMessage(
		child: ChildConnection,
		requestId: string,
		request: ChildMessageRequest,
		listener: (request: ChildMessageRequest) => Promise<ChildMessageReply>,
	): void {
		void listener(request)
			.then((reply) => child.client.replyMessageRequest(requestId, reply))
			.catch((error: unknown) =>
				child.client.rejectMessageRequest(requestId, error instanceof Error ? error.message : String(error)),
			);
	}
	private requireControl(child: ChildConnection): void {
		if (child.identityFailure) throw child.identityFailure;
		if (!child.connected)
			throw new ChildProtocolError("disconnected", "Child control requires an authenticated connection");
	}
	async steer(handle: AgentBackendHandle, message: string): Promise<boolean> {
		const run = this.requireRun(handle);
		this.requireControl(run.child);
		await run.child.client.steer(run.runId, message);
		return true;
	}
	async stop(handle: AgentBackendHandle): Promise<boolean> {
		const run = this.requireRun(handle);
		this.requireControl(run.child);
		await run.child.client.abort(run.runId);
		await this.refreshChild(run.child);
		return true;
	}
	/**
	 * Budget-only hard stop for a child that ignored the cooperative abort.
	 * Entirely RPC-free on the identity path: a frozen child cannot answer, so
	 * ownership is proven from the cached authenticated bootstrap (childId,
	 * token, socketPath), the last authenticated snapshot PID and the owned
	 * launcher handle. Graceful terminate first; SIGKILL escalation when the
	 * owned group survives. Resolves only after a verified group exit —
	 * identity refusal or unverifiable termination throws (visible failure,
	 * retained receipt), never a fabricated outcome.
	 */
	async enforceTerminate(handle: AgentBackendHandle, graceMs: number): Promise<BackendStatus> {
		const run = this.requireRun(handle);
		const child = run.child;
		if (child.closed) return { ...run.status };
		// Cached-identity ownership gate — no RPC, no reconnect, no reattach.
		// The run→child mapping was authenticated at launch/restore (bootstrap
		// childId+token+socketPath); the launcher handle must belong to that
		// child, and a cached authenticated snapshot must keep matching its PID.
		if (child.identityFailure) throw child.identityFailure;
		if (child.bootstrap.childId !== child.launcherHandle.childId) {
			throw new Error("Budget enforcement refused: launcher handle does not belong to the owned child identity.");
		}
		if (child.snapshot !== undefined) this.verifyChildPid(child.launcherHandle, child.snapshot);
		if (graceMs > 0 && !isSettled(run.status)) {
			const deadline = Date.now() + graceMs;
			while (Date.now() < deadline && !isSettled(run.status)) {
				if (child.connected) {
					try {
						await this.refreshChild(child);
					} catch {
						// A frozen child cannot refresh; keep the bounded wait honest.
					}
				}
				if (isSettled(run.status)) break;
				await enforcementDelay(100);
			}
			if (isSettled(run.status)) return { ...run.status };
		}
		const snapshot = child.snapshot;
		try {
			await child.launcher.terminate(child.launcherHandle);
		} catch (terminateError) {
			if (!child.launcher.forceKill) {
				throw new Error(
					`Budget enforcement failed: graceful termination was not confirmed and this launcher has no forced kill: ${
						terminateError instanceof Error ? terminateError.message : String(terminateError)
					}`,
				);
			}
			// The group survived SIGTERM (e.g. SIGSTOP-frozen): escalate while the
			// identity is still the verified owned one.
			await child.launcher.forceKill(child.launcherHandle);
		}
		this.releaseChild(child);
		// The owned process group is gone: sibling runs sharing this child lost
		// their resource; publish the verified-loss outcome honestly.
		for (const other of this.runs.values()) {
			if (other !== run && other.child === child && !isSettled(other.status)) {
				this.publish(other, {
					state: "failed",
					outcomeUnavailable: true,
					error: "Owned child process group was terminated by budget enforcement.",
				});
			}
		}
		return {
			state: "stopped",
			...(snapshot?.sessionFile && existsSync(snapshot.sessionFile) ? { sessionFile: snapshot.sessionFile } : {}),
			...(snapshot?.usage ? { usage: { ...snapshot.usage } } : {}),
			...(snapshot?.turns !== undefined ? { turns: snapshot.turns } : {}),
			...(snapshot?.toolUses !== undefined ? { toolUses: snapshot.toolUses } : {}),
			detail: "budget enforcement: owned child process group terminated after ignoring the cooperative abort",
		};
	}
	async resume(input: AgentResumeInput): Promise<AgentBackendHandle> {
		const bootstrapFile = join(dirname(input.sessionFile), "bootstrap.json");
		if (!existsSync(bootstrapFile))
			throw new Error("Cannot resume a child without its persisted invocation bootstrap.");
		const bootstrap = JSON.parse(readFileSync(bootstrapFile, "utf8")) as ChildBootstrap;
		return this.launchChild(
			{
				runId: input.runId,
				type: "resumed",
				description: "Resumed agent",
				prompt: input.prompt,
				cwd: input.cwd,
				configCwd: bootstrap.configCwd,
				systemPrompt: bootstrap.systemPrompt,
				promptMode: bootstrap.promptMode,
				background: input.background,
				...(bootstrap.instructions !== undefined ? { instructions: bootstrap.instructions } : {}),
				...(input.model !== undefined ? { model: input.model } : {}),
				...(input.modelFallback !== undefined ? { modelFallback: input.modelFallback } : {}),
				...(bootstrap.thinking !== undefined ? { thinking: bootstrap.thinking } : {}),
				...(bootstrap.tools !== undefined ? { tools: bootstrap.tools } : {}),
				...(bootstrap.maxTurns !== undefined ? { maxTurns: bootstrap.maxTurns } : {}),
				...(bootstrap.graceTurns !== undefined ? { graceTurns: bootstrap.graceTurns } : {}),
			},
			input.sessionFile,
		);
	}
	async readTranscript(handle: AgentBackendHandle): Promise<TranscriptSnapshot> {
		const run = this.requireRun(handle);
		const transcript = run.child.snapshot?.transcript;
		return transcript ? { ...transcript, items: [...transcript.items] } : { items: [], cursor: 0 };
	}
	async attach(handle: AgentBackendHandle): Promise<boolean> {
		const child = this.requireRun(handle).child;
		if (child.closed) return false;
		if (child.identityFailure) throw child.identityFailure;
		if (!child.launcher.attach) return false;
		await child.launcher.attach(child.launcherHandle);
		return true;
	}
	detach(handle: AgentBackendHandle): void {
		const child = this.requireRun(handle).child;
		child.detached = true;
		child.connected = false;
		this.unwatch(child);
		child.client.disconnect();
	}
	async dispose(handle: AgentBackendHandle): Promise<void> {
		const child = this.requireRun(handle).child;
		if (child.closed) return;
		if (child.identityFailure) throw child.identityFailure;
		this.reattachChild(child);
		if (!child.connected) {
			try {
				this.acceptSnapshot(child, await child.client.connect());
			} catch (error) {
				if (child.identityFailure) throw child.identityFailure;
				if (await child.launcher.cleanupExited(child.launcherHandle)) {
					this.releaseChild(child);
					return;
				}
				throw error;
			}
		}
		await this.refreshChild(child);
		if (!child.connected || !child.snapshot) {
			if (child.identityFailure) throw child.identityFailure;
			if (await child.launcher.cleanupExited(child.launcherHandle)) {
				this.releaseChild(child);
				return;
			}
			throw new Error("Cannot dispose a child without an authenticated current snapshot.");
		}
		if (child.snapshot.execution !== "idle")
			throw new Error("Cannot dispose a child while its native process is running another run.");
		// Terminate while launcher identity is still verifiable. Headless SIGTERM
		// closes the native session gracefully; an RPC shutdown first races PID exit.
		await child.launcher.terminate(child.launcherHandle);
		this.releaseChild(child);
	}
	serializeHandle(handle: AgentBackendHandle, sessionFile?: string): SerializableBackendHandle | undefined {
		const child = this.requireRun(handle).child;
		if (child.closed) return undefined;
		return {
			kind: "process",
			childId: child.bootstrap.childId,
			socketPath: child.bootstrap.socketPath,
			token: child.bootstrap.token,
			runDir: child.runDir,
			launcher: child.launcherHandle,
			...(sessionFile ? { sessionFile } : {}),
		};
	}
	restoreHandle(runId: string, serialized: SerializableBackendHandle): AgentBackendHandle | null {
		if (serialized.kind !== "process") return null;
		const launcher = this.launchers.find((candidate) => candidate.kind === serialized.launcher.kind);
		if (!launcher) return null;
		const bootstrapFile = join(serialized.runDir, "bootstrap.json");
		if (!existsSync(bootstrapFile)) return null;
		const bootstrap = JSON.parse(readFileSync(bootstrapFile, "utf8")) as ChildBootstrap;
		if (
			bootstrap.childId !== serialized.childId ||
			bootstrap.token !== serialized.token ||
			bootstrap.socketPath !== serialized.socketPath
		)
			return null;
		launcher.restore?.(serialized.launcher);
		let child = this.children.get(serialized.childId);
		if (!child) {
			const client = new ChildRpcClient({
				socketPath: serialized.socketPath,
				childId: serialized.childId,
				token: serialized.token,
				connectTimeoutMs: this.options.connectTimeoutMs ?? 2000,
			});
			child = {
				bootstrap,
				runDir: serialized.runDir,
				launcher,
				launcherHandle: serialized.launcher,
				client,
				connected: false,
				detached: false,
				closed: false,
				refreshing: false,
				refreshAgain: false,
				unlisten: [],
				focusListeners: new Set(),
				messageListeners: new Set(),
				pendingMessages: [],
			};
			this.children.set(serialized.childId, child);
			this.watchChild(child);
		}
		this.reattachChild(child);
		this.createRun(runId, child);
		return { kind: "process", handle: runId };
	}
	async probeSerialized(serialized: SerializableBackendHandle, runId: string): Promise<BackendStatus> {
		const handle = this.runs.has(runId)
			? { kind: "process" as const, handle: runId }
			: this.restoreHandle(runId, serialized);
		if (!handle) return { state: "disconnected", detail: "Cannot validate persisted child identity." };
		return this.status(handle);
	}
}
function isSettled(status: BackendStatus): boolean {
	return (
		status.state === "completed" ||
		status.state === "stopped" ||
		status.state === "failed" ||
		status.state === "timeout"
	);
}

function enforcementDelay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	// Bounded enforcement wait only; never holds the parent process open.
	timer.unref();
	return promise;
}
