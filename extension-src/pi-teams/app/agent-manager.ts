// AgentManager owns run lifecycle, admission capacity, subscriptions and
// owner-aware delivery projection. Child-process RPC owns execution outcomes.
//
// Every assigned run consumes the same global concurrency slot; result delivery
// policy never changes admission or execution authority.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AgentDefinitionSnapshot, ThinkingLevel } from "../domain/agent-definition.js";
import {
	type AgentRun,
	type AgentRunEvent,
	type AgentRunStatus,
	EMPTY_USAGE,
	isActiveStatus,
	isTerminalStatus,
	transition,
} from "../domain/agent-run.js";
import type {
	AgentBackendHandle,
	AgentExecutionBackend,
	AgentLaunchInput,
	AgentResumeInput,
	BackendStatus,
} from "../domain/backend.js";
import type { ChildControlCommand, ChildState } from "../domain/child-protocol.js";
import type { SubagentsSettings } from "../domain/config.js";
import type { AgentOwner, DeliveryPolicy, ParentSessionRef } from "../domain/delivery.js";
import {
	type AgentLifecycleEvent,
	type AgentLifecycleEventName,
	PROTOCOL_VERSION,
	toRunSnapshot,
} from "../domain/integration-protocol.js";
import type { InboxMessage } from "../domain/message.js";
import type { WorktreeInfo } from "../domain/worktree.js";
import type { AgentRegistry } from "./agent-registry.js";
import { resolveBackend } from "./backend-selector.js";
import type { MessageService } from "./message-service.js";
import type {
	AgentRegistryEntry,
	CompletedRunHistoryEntry,
	HandleProjector,
	PersistedRegistryEntry,
	RestorableExecutionBackend,
	RestoreReconnectResult,
	SubagentRunStore,
} from "./run-registry.js";
import {
	isIncompatibleRegistryEntry,
	isSerializableBackendHandle,
	toHistoryEntry,
	toRegistryEntry,
} from "./run-registry.js";
import { type BudgetExpiry, TimeBudgetWatcher } from "./time-budget-watcher.js";
import type { WorktreeService } from "./worktree-service.js";

/** Spawn request accepted by the manager (tool/RPC-neutral shape). */
export interface SpawnRequest {
	type: string;
	prompt: string;
	description?: string | undefined;
	/** Explicit detached flag; omitted → the resolved definition's defaultBackground. */
	run_in_background?: boolean | undefined;
	model?: string | undefined;
	thinking?: ThinkingLevel | undefined;
	max_turns?: number | undefined;
	/**
	 * Wall-clock budget override in whole seconds. Malformed provided values
	 * (0, negative, fraction, too large) reject the spawn — never "unlimited".
	 */
	timeout?: number | undefined;
	/** Idle-budget override in whole seconds; validated like `timeout`. */
	idle_timeout?: number | undefined;
	/** Defaults to the spawning conversation. */
	owner?: AgentOwner | undefined;
	/** Defaults to "conversation" for conversation owners, "event" otherwise. */
	delivery?: DeliveryPolicy | undefined;
	parentSession?: ParentSessionRef | undefined;
}

export interface GetResultOptions {
	wait?: boolean | undefined;
	signal?: AbortSignal | undefined;
}

export interface ResumeOptions {
	run_in_background?: boolean | undefined;
	/** Wall-clock budget override (whole seconds); beats the frozen source budgets. */
	timeout?: number | undefined;
	/** Idle-budget override (whole seconds); beats the frozen source budgets. */
	idle_timeout?: number | undefined;
}

export interface AgentManagerOptions {
	registry: AgentRegistry;
	settings: SubagentsSettings;
	backends: readonly AgentExecutionBackend[];
	cwd: string;
	configCwd: string;
	getSessionId?: () => string;
	registryStore?: SubagentRunStore;
	worktreeService?: WorktreeService;
	idFactory?: () => string;
	now?: () => number;
}

type LaunchPlan =
	| { kind: "launch"; prompt: string }
	| {
			kind: "resume";
			input: AgentResumeInput;
			sourceAgentId: string;
			/** Effective budgets frozen on the source run (0 = unlimited); undefined for legacy rows. */
			sourceBudgets?: { timeout?: number; idleTimeout?: number };
	  };

/**
 * Bounded cooperative window after a budget expiry: the abort RPC is fired
 * fire-and-forget (a wedged socket must not hold the deadline), and a child
 * that settles within this window keeps the ordinary cooperative path. Past
 * it, the owned child is force-terminated through the backend port.
 */
const BUDGET_ENFORCEMENT_GRACE_MS = 2_000;

function enforcementDelay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	timer.unref();
	return promise;
}

interface RunInternals {
	record: AgentRun;
	backend?: AgentExecutionBackend;
	cwd: string;
	settle: Promise<AgentRun>;
	resolveSettle: (record: AgentRun) => void;
	plan: LaunchPlan;
	pendingSteers: string[];
	stopRequested: boolean;
	stopAcknowledged: boolean;
	stopCommand?: Promise<boolean>;
	slotAcquired: boolean;
	launchPromise?: Promise<void>;
	unsubscribeBackend?: () => void;
	unsubscribeMessages?: () => void;
	worktreeInfo?: WorktreeInfo;
	finalizePromise?: Promise<void>;
	settlementPromise?: Promise<void>;
	controlsFlushing?: boolean;
	lastFocusState?: ChildState;
	/** Focus subscription feeding the idle clock; armed only when a budget is active. */
	budgetFocusUnsubscribe?: () => void;
	/**
	 * Highest transcript revision seen per counted output item id. Created by
	 * the baseline snapshot pass.
	 */
	budgetOutputSeen?: Map<string, number>;
	/** True once the first post-subscribe snapshot has been absorbed as history. */
	budgetOutputBaselined?: boolean;
	/** Budget expiry observed while the launch was still in flight. */
	pendingBudgetStop?: BudgetExpiry;
}
export interface ReleaseOptions {
	cleanupWorktree?: boolean;
}

function cloneRecord(record: AgentRun): AgentRun {
	return { ...record, usage: { ...record.usage } };
}

interface FocusObservation {
	listeners: Set<() => void>;
	handle?: AgentBackendHandle;
	unsubscribe?: () => void;
}

export class AgentManager {
	private readonly runs = new Map<string, RunInternals>();
	private queue: string[] = [];
	private readonly listeners = new Set<(event: AgentLifecycleEvent) => void>();
	private readonly focusObservations = new Map<string, FocusObservation>();
	private runningSlots = 0;
	private maxConcurrent: number;
	private settings: SubagentsSettings;
	private disposed = false;
	private shuttingDown = false;
	private admissionEpoch = 0;

	private readonly registry: AgentRegistry;
	private readonly backends: readonly AgentExecutionBackend[];
	private readonly cwd: string;
	private readonly configCwd: string;
	private readonly getSessionId: () => string;
	private readonly idFactory: () => string;
	private readonly now: () => number;
	private readonly registryStore: SubagentRunStore | undefined;
	private readonly worktreeService: WorktreeService | undefined;
	private readonly terminalCleanupByChild = new WeakMap<AgentExecutionBackend, Map<string, Promise<void>>>();
	private messageService: MessageService | undefined;
	private preservedRegistryEntries: PersistedRegistryEntry[] = [];
	/** Rows owned by other conversations/extensions; kept verbatim on every rewrite. */
	private foreignRegistryEntries: PersistedRegistryEntry[] = [];
	/** Hard time-budget watchdog; timers never mutate settled/disposed runs. */
	private readonly budgetWatcher: TimeBudgetWatcher;

	constructor(options: AgentManagerOptions) {
		this.registry = options.registry;
		this.settings = options.settings;
		this.backends = [...options.backends];
		this.cwd = options.cwd;
		this.configCwd = options.configCwd;
		this.maxConcurrent = Math.max(1, Math.floor(options.settings.maxConcurrent));
		this.getSessionId = options.getSessionId ?? (() => "unknown-session");
		this.idFactory = options.idFactory ?? (() => randomUUID());
		this.now = options.now ?? (() => Date.now());
		this.registryStore = options.registryStore;
		this.worktreeService = options.worktreeService;
		this.budgetWatcher = new TimeBudgetWatcher({
			now: () => this.now(),
			onExpiry: (runId, decision) => this.handleBudgetExpiry(runId, decision),
		});
	}

	// -- configuration ---------------------------------------------------------

	updateSettings(settings: SubagentsSettings): void {
		this.settings = settings;
		this.setMaxConcurrent(settings.maxConcurrent);
	}
	/** Begin a host session after previously detaching child RPC clients. */
	beginSession(): void {
		if (this.disposed) throw new Error("AgentManager is disposed");
		this.admissionEpoch += 1;
		this.shuttingDown = false;
	}

	get currentSettings(): Readonly<SubagentsSettings> {
		return this.settings;
	}

	setMaxConcurrent(n: number): void {
		this.maxConcurrent = Math.max(1, Math.floor(n));
		this.drainQueue();
	}

	getMaxConcurrent(): number {
		return this.maxConcurrent;
	}

	setMessageService(service: MessageService): void {
		this.messageService = service;
	}

	/** A queued/closed recipient retains an inbox; this never starts a child. */
	async sendInbox(agentId: string, message: InboxMessage): Promise<boolean> {
		const internal = this.runs.get(agentId);
		if (
			!internal ||
			this.disposed ||
			this.shuttingDown ||
			internal.stopRequested ||
			!isActiveStatus(internal.record.status)
		) {
			return false;
		}
		const handle = internal.record.handle;
		if (!handle || !internal.backend?.sendInbox) return false;
		return internal.backend.sendInbox(handle, message);
	}

	private connectMessages(internal: RunInternals): void {
		const messages = this.messageService;
		const handle = internal.record.handle;
		if (!messages || !handle || !internal.backend?.subscribeMessages) return;
		internal.unsubscribeMessages?.();
		const epoch = this.admissionEpoch;
		internal.unsubscribeMessages = internal.backend.subscribeMessages(handle, async (request) => {
			if (
				this.disposed ||
				this.shuttingDown ||
				internal.stopRequested ||
				epoch !== this.admissionEpoch ||
				this.runs.get(internal.record.id) !== internal ||
				!isActiveStatus(internal.record.status)
			) {
				throw new Error("The sending child no longer belongs to an active parent runtime.");
			}
			return messages.handleChildMessage(internal.record.id, request);
		});
	}

	// -- events ------------------------------------------------------------------

	/** Subscribe to owner-aware lifecycle events; returns an unsubscribe fn. */
	subscribe(listener: (event: AgentLifecycleEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(record: AgentRun, event: AgentLifecycleEventName): void {
		if (this.listeners.size === 0) return;
		const snapshot = toRunSnapshot(record);
		const payload: AgentLifecycleEvent = {
			protocolVersion: PROTOCOL_VERSION,
			event,
			agentId: snapshot.id,
			type: snapshot.type,
			description: snapshot.description,
			status: snapshot.status,
			owner: snapshot.owner,
			delivery: snapshot.delivery,
			usage: snapshot.usage,
			startedAt: snapshot.startedAt,
			...(snapshot.model !== undefined ? { model: snapshot.model } : {}),
			...(snapshot.modelFallback !== undefined ? { modelFallback: snapshot.modelFallback } : {}),
			...(snapshot.result !== undefined ? { result: snapshot.result } : {}),
			...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
			...(snapshot.sessionFile !== undefined ? { sessionFile: snapshot.sessionFile } : {}),
			...(snapshot.resultFile !== undefined ? { resultFile: snapshot.resultFile } : {}),
			...(snapshot.parentSession !== undefined ? { parentSession: snapshot.parentSession } : {}),
			...(snapshot.completedAt !== undefined ? { completedAt: snapshot.completedAt } : {}),
			...(snapshot.durationMs !== undefined ? { durationMs: snapshot.durationMs } : {}),
			...(snapshot.worktree !== undefined ? { worktree: snapshot.worktree } : {}),
			...(record.worktreeResult !== undefined ? { worktreeResult: record.worktreeResult } : {}),
			...(record.recoveryError !== undefined ? { recoveryError: record.recoveryError } : {}),
			...(record.worktreeReleased !== undefined ? { worktreeReleased: record.worktreeReleased } : {}),
			...(snapshot.budgetExhausted !== undefined ? { budgetExhausted: snapshot.budgetExhausted } : {}),
			...(snapshot.budgetSeconds !== undefined ? { budgetSeconds: snapshot.budgetSeconds } : {}),
		};
		for (const listener of [...this.listeners]) {
			try {
				listener(payload);
			} catch {
				/* a broken subscriber must never break run settlement */
			}
		}
	}

	// -- queries -------------------------------------------------------------

	get(agentId: string): AgentRun | undefined {
		const internal = this.runs.get(agentId);
		return internal ? cloneRecord(internal.record) : undefined;
	}

	list(): AgentRun[] {
		return [...this.runs.values()]
			.map((internal) => cloneRecord(internal.record))
			.sort((a, b) => b.startedAt - a.startedAt);
	}

	hasRunning(): boolean {
		return [...this.runs.values()].some((internal) => isActiveStatus(internal.record.status));
	}

	/** Promise resolving when the run reaches a terminal status. */
	whenSettled(agentId: string): Promise<AgentRun> | undefined {
		return this.runs.get(agentId)?.settle;
	}

	// -- spawn ------------------------------------------------------------------

	/**
	 * Spawn a specialist run. Returns immediately with the record either
	 * "queued" (background, pool full) or already launching. Throws on an
	 * unresolvable agent type (the fallbackSubagent policy is applied by the
	 * registry before anything is allocated).
	 */
	async spawn(request: SpawnRequest): Promise<AgentRun> {
		const plan: LaunchPlan = { kind: "launch", prompt: request.prompt };
		return this.allocate(request, plan);
	}

	/**
	 * Foreground spawn: shares the concurrency queue and awaits settlement.
	 */
	async spawnAndWait(
		request: Omit<SpawnRequest, "run_in_background"> & { run_in_background?: false | undefined },
	): Promise<AgentRun> {
		const record = await this.spawn({ ...request, run_in_background: false });
		return this.awaitInternal(record.id);
	}

	private async awaitInternal(id: string): Promise<AgentRun> {
		const internal = this.runs.get(id);
		if (!internal) throw new Error(`AgentRun "${id}" vanished`);
		return internal.settle;
	}

	private async allocate(request: SpawnRequest, plan: LaunchPlan, worktree?: WorktreeInfo): Promise<AgentRun> {
		if (this.disposed) throw new Error("AgentManager is disposed");
		if (this.shuttingDown) throw new Error("AgentManager is shutting down");
		const epoch = this.admissionEpoch;

		const overrides: {
			model?: string;
			thinking?: ThinkingLevel;
			maxTurnLimit?: number;
			timeout?: number;
			idleTimeout?: number;
		} = {};
		if (request.model !== undefined) overrides.model = request.model;
		if (request.thinking !== undefined) overrides.thinking = request.thinking;
		if (request.max_turns !== undefined) overrides.maxTurnLimit = request.max_turns;
		// Budgets are validated inside resolveInvocation: malformed provided
		// values throw before anything is allocated.
		if (request.timeout !== undefined) overrides.timeout = request.timeout;
		if (request.idle_timeout !== undefined) overrides.idleTimeout = request.idle_timeout;

		let snapshot = this.registry.resolveInvocation(request.type, overrides);
		const background = request.run_in_background ?? snapshot.resolved.defaultBackground;
		const owner: AgentOwner = request.owner ?? ({ kind: "conversation", sessionId: this.getSessionId() } as const);
		const delivery: DeliveryPolicy = request.delivery ?? (owner.kind === "conversation" ? "conversation" : "event");
		const parentSession: ParentSessionRef = request.parentSession ?? {
			sessionId: owner.kind === "conversation" ? owner.sessionId : this.getSessionId(),
		};
		const backend = await resolveBackend({ backends: this.backends });
		if (!backend) throw new Error("No process execution backend is available for model admission.");
		const admission = await backend.prepareModel({
			...(plan.kind === "launch" && snapshot.resolved.model !== undefined ? { model: snapshot.resolved.model } : {}),
			...(request.model !== undefined ? { fallbackModel: request.model } : {}),
			...(plan.kind === "resume" ? { sessionFile: plan.input.sessionFile } : {}),
		});
		if (this.disposed || this.shuttingDown || epoch !== this.admissionEpoch)
			throw new Error("AgentManager session changed during model admission; no run was allocated.");
		snapshot = { ...snapshot, resolved: { ...snapshot.resolved, model: admission.model } };
		const id = this.idFactory();
		this.registry.trackSnapshot(id, snapshot);
		if (plan.kind === "resume") {
			plan.input.runId = id;
			plan.input.model = admission.model;
			if (admission.fallback !== undefined) plan.input.modelFallback = admission.fallback;
		}
		const record: AgentRun = {
			id,
			type: snapshot.resolved.type,
			description: request.description ?? snapshot.resolved.description,
			status: "queued",
			backend: "process",
			model: admission.model,
			...(admission.fallback !== undefined ? { modelFallback: admission.fallback } : {}),
			...(worktree !== undefined ? { worktree: { ...worktree } } : {}),
			startedAt: this.now(),
			toolUses: 0,
			turns: 0,
			usage: { ...EMPTY_USAGE },
			owner,
			delivery,
			isBackground: background,
			...(parentSession !== undefined ? { parentSession } : {}),
			// Frozen at admission: a resumed run replays these limits even when the
			// definition/settings later change (0 = explicitly unlimited).
			budgetTimeout: effectiveBudgetSeconds(
				request.timeout !== undefined ? snapshot.resolved.timeout : undefined,
				plan.kind === "resume" ? plan.sourceBudgets?.timeout : undefined,
				snapshot.resolved.timeout,
				this.settings.defaultTimeout,
			),
			budgetIdleTimeout: effectiveBudgetSeconds(
				request.idle_timeout !== undefined ? snapshot.resolved.idleTimeout : undefined,
				plan.kind === "resume" ? plan.sourceBudgets?.idleTimeout : undefined,
				snapshot.resolved.idleTimeout,
				this.settings.defaultIdleTimeout,
			),
		};

		const { promise: settle, resolve: resolveSettle } = Promise.withResolvers<AgentRun>();
		const internal: RunInternals = {
			record,
			backend,
			cwd: plan.kind === "resume" ? plan.input.cwd : this.cwd,
			...(worktree !== undefined ? { worktreeInfo: { ...worktree } } : {}),
			settle,
			resolveSettle,
			plan,
			pendingSteers: [],
			stopRequested: false,
			stopAcknowledged: false,
			slotAcquired: false,
		};
		this.runs.set(id, internal);
		if (plan.kind === "resume" && this.messageService) {
			try {
				await this.messageService.continueInbox(plan.sourceAgentId, id);
				if (this.disposed || this.shuttingDown || epoch !== this.admissionEpoch) {
					throw new Error("Parent session changed during inbox continuation; no child was started.");
				}
			} catch (error) {
				this.runs.delete(id);
				this.registry.releaseSnapshot(id);
				throw error;
			}
		}

		if (this.runningSlots < this.maxConcurrent) {
			this.runningSlots += 1;
			internal.slotAcquired = true;
			internal.launchPromise = this.startRun(internal);
		} else {
			this.queue.push(id);
		}
		return cloneRecord(record);
	}

	// -- control ---------------------------------------------------------------

	/** Await child acknowledgement; starting/queued requests are retained locally. */
	async steer(agentId: string, message: string): Promise<boolean> {
		const internal = this.runs.get(agentId);
		if (!internal || this.disposed || !isActiveStatus(internal.record.status) || internal.stopRequested) return false;
		if (internal.record.status === "queued" || internal.record.status === "starting") {
			internal.pendingSteers.push(message);
			return true;
		}
		if (!internal.backend || !internal.record.handle) return false;
		return internal.backend.steer(internal.record.handle, message);
	}

	/** Authenticated child state; settled runs retain their last observed metadata. */
	async readFocusState(agentId: string): Promise<ChildState | undefined> {
		const internal = this.runs.get(agentId);
		if (!internal) throw new Error(`Unknown agent: "${agentId}".`);
		if (this.disposed || this.shuttingDown) throw new Error("AgentManager session is not active.");
		const { backend } = internal;
		const handle = internal.record.handle;
		if (!backend?.readFocusState || !handle || isTerminalStatus(internal.record.status)) {
			return internal.lastFocusState;
		}
		const epoch = this.admissionEpoch;
		const state = await backend.readFocusState(handle);
		if (epoch !== this.admissionEpoch || this.disposed || this.shuttingDown) {
			throw new Error("Parent session changed while reading child state.");
		}
		return state ? this.rememberFocusState(internal, state) : internal.lastFocusState;
	}

	async controlFocus(agentId: string, command: ChildControlCommand): Promise<ChildState> {
		const internal = this.runs.get(agentId);
		if (!internal) throw new Error(`Unknown agent: "${agentId}".`);
		const { backend } = internal;
		const handle = internal.record.handle;
		if (
			this.disposed ||
			this.shuttingDown ||
			internal.stopRequested ||
			internal.record.status !== "running" ||
			!handle
		) {
			throw new Error("Child controls require a currently running child; closed sessions need cold continuation.");
		}
		if (!backend?.controlFocus) throw new Error("This child runtime does not support focus controls.");
		const epoch = this.admissionEpoch;
		const state = await backend.controlFocus(handle, command);
		if (epoch !== this.admissionEpoch || this.disposed || this.shuttingDown) {
			throw new Error("Parent session changed while controlling the child.");
		}
		const latest = this.rememberFocusState(internal, state);
		const model = latest.focus?.model;
		if (model) {
			internal.record.model = `${model.provider}/${model.id}`;
			this.syncRegistry();
		}
		this.notifyFocus(internal);
		return latest;
	}

	subscribeFocus(agentId: string, listener: () => void): () => void {
		const internal = this.runs.get(agentId);
		if (!internal) throw new Error(`Unknown agent: "${agentId}".`);
		let observation = this.focusObservations.get(agentId);
		if (!observation) {
			observation = { listeners: new Set() };
			this.focusObservations.set(agentId, observation);
		}
		observation.listeners.add(listener);
		this.observeFocus(internal);
		return () => {
			observation.listeners.delete(listener);
			if (observation.listeners.size === 0) {
				observation.unsubscribe?.();
				if (this.focusObservations.get(agentId) === observation) this.focusObservations.delete(agentId);
			}
		};
	}

	private observeFocus(internal: RunInternals): void {
		const observation = this.focusObservations.get(internal.record.id);
		if (!observation) return;
		const handle = internal.record.handle;
		if (observation.handle === handle) return;
		observation.unsubscribe?.();
		delete observation.unsubscribe;
		if (!handle || !internal.backend?.subscribeFocus) {
			delete observation.handle;
			return;
		}
		observation.handle = handle;
		observation.unsubscribe = internal.backend.subscribeFocus(handle, (state) => {
			this.rememberFocusState(internal, state);
			this.notifyFocus(internal);
		});
	}

	private notifyFocus(internal: RunInternals): void {
		this.observeFocus(internal);
		for (const listener of this.focusObservations.get(internal.record.id)?.listeners ?? []) {
			try {
				listener();
			} catch {
				/* View failures must never interrupt child execution or settlement. */
			}
		}
	}

	private rememberFocusState(internal: RunInternals, state: ChildState): ChildState {
		if (state.currentRunId && state.currentRunId !== internal.record.id) {
			throw new Error("Authenticated child state belongs to a different run.");
		}
		const previous = internal.lastFocusState;
		if (previous && state.seq < previous.seq) return previous;
		internal.lastFocusState = state;
		return state;
	}

	private clearFocusObservations(): void {
		for (const observation of this.focusObservations.values()) observation.unsubscribe?.();
		this.focusObservations.clear();
	}

	/** A stop acknowledgement is not settlement; only child status settles a launched run. */
	async stop(agentId: string): Promise<boolean> {
		const internal = this.runs.get(agentId);
		if (!internal || this.disposed || !isActiveStatus(internal.record.status)) return false;
		internal.stopRequested = true;
		if (internal.record.status === "queued") {
			this.queue = this.queue.filter((id) => id !== agentId);
			this.applyEvent(internal, { type: "stop" });
			return true;
		}
		if (!internal.backend || !internal.record.handle) return true;
		return this.sendStop(internal);
	}

	private sendStop(internal: RunInternals): Promise<boolean> {
		if (internal.stopAcknowledged) return Promise.resolve(true);
		if (internal.stopCommand) return internal.stopCommand;
		const { backend } = internal;
		const handle = internal.record.handle;
		if (!backend || !handle) return Promise.resolve(false);
		const command = backend.stop(handle).then((accepted) => {
			if (accepted) internal.stopAcknowledged = true;
			return accepted;
		});
		internal.stopCommand = command;
		void command
			.finally(() => {
				if (internal.stopCommand === command) delete internal.stopCommand;
			})
			.catch(() => {});
		return command;
	}
	private async flushPendingControls(internal: RunInternals): Promise<void> {
		if (internal.controlsFlushing || internal.record.status !== "running") return;
		const backend = internal.backend;
		const handle = internal.record.handle;
		if (!backend || !handle) return;
		internal.controlsFlushing = true;
		try {
			while (internal.pendingSteers.length > 0 && internal.record.status === "running") {
				const message = internal.pendingSteers[0];
				if (message === undefined) break;
				try {
					if (!(await backend.steer(handle, message))) break;
				} catch {
					break;
				}
				internal.pendingSteers.shift();
			}
			if (internal.stopRequested && internal.record.status === "running") {
				try {
					await this.sendStop(internal);
				} catch {
					// Keep the run active and retry when a later status event reconnects.
				}
			}
		} finally {
			internal.controlsFlushing = false;
		}
	}

	// -- hard time budgets (roadmap 1.1) -----------------------------------------

	/**
	 * Freeze the budget clocks onto the run and arm the watchdog. Called
	 * immediately before backend.launch/resume, so queue/admission/worktree time
	 * never spends budget. Unlimited runs arm nothing.
	 */
	private beginBudgetClocks(internal: RunInternals): void {
		const record = internal.record;
		const startedAt = this.now();
		record.budgetStartedAt = startedAt;
		record.budgetLastOutputAt = startedAt;
		const timeout = record.budgetTimeout ?? 0;
		const idleTimeout = record.budgetIdleTimeout ?? 0;
		if (timeout <= 0 && idleTimeout <= 0) return;
		this.budgetWatcher.watch(record.id, { timeout, idleTimeout, startedAt, lastOutputAt: startedAt });
	}

	/** Subscribe to child snapshots so counted output moves the idle clock. */
	private connectBudgetOutput(internal: RunInternals): void {
		const record = internal.record;
		const backend = internal.backend;
		const handle = record.handle;
		if (!backend?.subscribeFocus || !handle) return;
		if ((record.budgetTimeout ?? 0) <= 0 && (record.budgetIdleTimeout ?? 0) <= 0) return;
		internal.budgetFocusUnsubscribe?.();
		internal.budgetFocusUnsubscribe = backend.subscribeFocus(handle, (state) => {
			this.observeBudgetOutput(internal, state);
		});
	}

	/**
	 * Only child-produced output resets the idle clock, and it does so on
	 * ARRIVAL, not on wall timestamps: a new assistant message, a new partial
	 * revision of a streaming assistant message, or a COMPLETED tool result.
	 * Steers, user items, tool-call starts, empty assistant upserts, partial
	 * tool updates and usage/turn refreshes never count. The first snapshot
	 * after subscribe (baseline — including a reconnect restore) re-derives the
	 * output clock strictly from item timestamps, so historical content never
	 * buys a fresh idle window.
	 */
	private observeBudgetOutput(internal: RunInternals, state: ChildState): void {
		if (!isActiveStatus(internal.record.status) || internal.record.budgetStartedAt === undefined) return;
		// The first snapshot after subscribe is history (launch or reconnect
		// baseline): re-derive from item timestamps. Everything after is arrival.
		const isHistorySnapshot = internal.budgetOutputBaselined !== true;
		internal.budgetOutputSeen ??= new Map();
		internal.budgetOutputBaselined = true;
		this.absorbBudgetSnapshot(internal, state, isHistorySnapshot);
	}

	private absorbBudgetSnapshot(internal: RunInternals, state: ChildState, isHistorySnapshot: boolean): void {
		const record = internal.record;
		const seen = internal.budgetOutputSeen;
		const startedAt = record.budgetStartedAt;
		if (seen === undefined || startedAt === undefined) return;
		const nowMs = this.now();
		let latest = record.budgetLastOutputAt ?? startedAt;
		const items = state.transcript.items;
		for (let index = 0; index < items.length; index += 1) {
			const item = items[index];
			if (item === undefined) continue;
			if (item.kind !== "assistant" && item.kind !== "toolResult") continue;
			// A partial tool update is not a completed tool result.
			if (item.kind === "toolResult" && item.partial === true) continue;
			// Empty assistant upserts buy no idle time.
			if (item.kind === "assistant" && (item.text === undefined || item.text.trim().length === 0)) continue;
			if (item.id === undefined) {
				// No stable identity: creation timestamps are the only signal.
				if (item.timestamp >= startedAt && item.timestamp > latest) latest = item.timestamp;
				continue;
			}
			const revision = item.revision ?? 0;
			const known = seen.get(item.id);
			if (known !== undefined && known >= revision) continue;
			seen.set(item.id, revision);
			if (isHistorySnapshot) {
				// Baseline history: re-derive strictly from the item timestamp.
				if (item.timestamp >= startedAt && item.timestamp > latest) latest = item.timestamp;
			} else if (nowMs > latest) {
				// New output arrival (new item or newer partial revision) is NOW.
				latest = nowMs;
			}
		}
		if (latest === record.budgetLastOutputAt) return;
		record.budgetLastOutputAt = latest;
		this.budgetWatcher.observeOutput(record.id, latest);
	}

	/**
	 * Watchdog expiry: record which budget was exhausted, then hard-stop. The
	 * stop acknowledgement is NOT settlement — the run settles either through
	 * authenticated child RPC within the bounded cooperative window or through
	 * verified enforcement termination.
	 */
	private handleBudgetExpiry(runId: string, decision: BudgetExpiry): void {
		const internal = this.runs.get(runId);
		if (!internal || this.disposed || this.shuttingDown) return;
		const record = internal.record;
		if (!isActiveStatus(record.status) || record.budgetExhausted !== undefined) return;
		record.budgetExhausted = decision.budget;
		record.budgetSeconds = decision.seconds;
		if (record.handle === undefined || internal.backend === undefined) {
			// Launch still in flight: startRun enforces the stop once the handle exists.
			internal.pendingBudgetStop = decision;
			return;
		}
		this.beginEnforcedStop(internal);
		this.syncRegistry();
	}

	/**
	 * Budget expiry with a live handle: fire the cooperative abort without
	 * awaiting it (a wedged socket must not hold the deadline), give the child
	 * the bounded cooperative window, then verify-and-terminate the owned
	 * process through the backend port. Ordinary user stops never take this
	 * path.
	 */
	private beginEnforcedStop(internal: RunInternals): void {
		void this.stop(internal.record.id).catch(() => {});
		void this.enforceBudgetDeadline(internal).catch((error: unknown) => {
			// Visible failure with a retained receipt — never a fabricated outcome.
			if (this.runs.get(internal.record.id) !== internal || !isActiveStatus(internal.record.status)) return;
			internal.record.recoveryError = `Budget enforcement failed: ${errorText(error)}`;
			this.syncRegistry();
		});
	}

	private async enforceBudgetDeadline(internal: RunInternals): Promise<void> {
		const outcome = await Promise.race([
			internal.settle.then(() => "settled" as const),
			enforcementDelay(BUDGET_ENFORCEMENT_GRACE_MS).then(() => "deadline" as const),
		]);
		if (outcome === "settled") return;
		if (this.runs.get(internal.record.id) !== internal || !isActiveStatus(internal.record.status)) return;
		const backend = internal.backend;
		const handle = internal.record.handle;
		// Without the enforcement port (or already detached) only cooperative
		// semantics exist; stopRequested keeps retrying on reconnects.
		if (!backend?.enforceTerminate || !handle) return;
		const status = await backend.enforceTerminate(handle, 0);
		if (this.runs.get(internal.record.id) !== internal || !isActiveStatus(internal.record.status)) return;
		await this.reconcileBackendStatus(internal, status);
	}

	/** Disarm the watchdog and drop the output subscription for one run. */
	private detachBudgetWatch(internal: RunInternals): void {
		this.budgetWatcher.stop(internal.record.id);
		internal.budgetFocusUnsubscribe?.();
		delete internal.budgetFocusUnsubscribe;
	}

	/**
	 * Re-arm the watchdog for a restored receipt using the persisted original
	 * limits and clocks. Runs without a budget snapshot (legacy rows) or with
	 * both budgets unlimited stay unwatched.
	 */
	private resumeBudgetWatch(internal: RunInternals): void {
		const record = internal.record;
		if (!isActiveStatus(record.status) || record.budgetStartedAt === undefined) return;
		const timeout = record.budgetTimeout ?? 0;
		const idleTimeout = record.budgetIdleTimeout ?? 0;
		if (timeout <= 0 && idleTimeout <= 0) return;
		record.budgetLastOutputAt = Math.max(record.budgetLastOutputAt ?? 0, record.budgetStartedAt);
		// The reconnect snapshot is history: re-baseline strictly from item
		// timestamps so nothing produced while the parent was away buys a fresh
		// idle window.
		delete internal.budgetOutputSeen;
		delete internal.budgetOutputBaselined;
		this.budgetWatcher.watch(record.id, {
			timeout,
			idleTimeout,
			startedAt: record.budgetStartedAt,
			lastOutputAt: record.budgetLastOutputAt,
		});
		this.connectBudgetOutput(internal);
	}

	/** Request stop for every run without pretending backend acceptance settled it. */
	abortAll(): number {
		let count = 0;
		for (const [id, internal] of this.runs) {
			if (!isActiveStatus(internal.record.status)) continue;
			count += 1;
			void this.stop(id).catch(() => {});
		}
		return count;
	}

	/** Wait for every admitted run to settle, including runs still in the queue. */
	async waitForAll(): Promise<void> {
		for (;;) {
			this.drainQueue();
			const pending = [...this.runs.values()].filter((internal) => isActiveStatus(internal.record.status));
			if (pending.length === 0) return;
			await Promise.allSettled(pending.map((internal) => internal.settle));
		}
	}

	/** Resume a terminal run from its persisted session after completion cleanup. */
	async resume(agentId: string, prompt: string, options: ResumeOptions = {}): Promise<AgentRun> {
		if (this.disposed) throw new Error("AgentManager is disposed");
		const internal = this.runs.get(agentId);
		let source: AgentRun;
		let sourceCwd: string;
		if (internal) {
			if (isActiveStatus(internal.record.status)) {
				throw new Error(`Agent "${agentId}" is still ${internal.record.status} — steer it instead.`);
			}
			// Completion cleanup and resume must not race to reuse the same child.
			await internal.finalizePromise?.catch(() => {});
			source = internal.record;
			sourceCwd = internal.cwd;
		} else {
			const historical = this.registryStore?.readHistory().find((entry) => entry.id === agentId);
			if (!historical) throw new Error(`Unknown agent: "${agentId}". It may have been cleaned up.`);
			source = historyToRun(historical);
			sourceCwd = historical.cwd;
		}
		if (source.worktreeReleased) {
			throw new Error(`Agent "${agentId}"'s worktree was explicitly released and its checkout is no longer resumable.`);
		}
		if (source.handle !== undefined) {
			const recovery = source.recoveryError ? ` ${source.recoveryError}` : "";
			throw new Error(`Agent "${agentId}" still has a retained child; resolve its cleanup before resuming.${recovery}`);
		}
		if (source.sessionFile === undefined) {
			throw new Error(`Agent "${agentId}" has no persisted session to resume from.`);
		}

		const background = (options.run_in_background ?? source.isBackground ?? true) === true;
		const input: AgentResumeInput = {
			runId: "(allocated below)",
			prompt,
			cwd: sourceCwd,
			background,
			sessionFile: source.sessionFile,
		};
		const spawnRequest: SpawnRequest = {
			type: source.type,
			prompt,
			description: source.description,
			run_in_background: background,
			...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
			...(options.idle_timeout !== undefined ? { idle_timeout: options.idle_timeout } : {}),
			owner: { ...source.owner },
			delivery: source.delivery,
		};
		if (source.parentSession !== undefined) spawnRequest.parentSession = { ...source.parentSession };
		const sourceBudgets =
			source.budgetTimeout !== undefined || source.budgetIdleTimeout !== undefined
				? {
						...(source.budgetTimeout !== undefined ? { timeout: source.budgetTimeout } : {}),
						...(source.budgetIdleTimeout !== undefined ? { idleTimeout: source.budgetIdleTimeout } : {}),
					}
				: undefined;
		return this.allocate(
			spawnRequest,
			{
				kind: "resume",
				input,
				sourceAgentId: agentId,
				...(sourceBudgets !== undefined ? { sourceBudgets } : {}),
			},
			source.worktree,
		);
	}

	// -- result consumption --------------------------------------------------------

	/**
	 * Controller logic behind get_subagent_result: optionally waits
	 * (abortably), then reports status/result. Reads are repeatable (roadmap
	 * 1.1b): the durable result.md artifact is re-read on every call and
	 * `resultConsumed` only suppresses the duplicate completion notification.
	 */
	async getResult(agentId: string, options: GetResultOptions = {}): Promise<string> {
		const internal = this.runs.get(agentId);
		if (!internal) return `Agent not found: "${agentId}". It may have been cleaned up.`;

		const signal = options.signal;
		const abortedBeforeWait = signal?.aborted === true;
		if (options.wait === true && !abortedBeforeWait && isActiveStatus(internal.record.status)) {
			const abortRace = Promise.withResolvers<"aborted">();
			signal?.addEventListener("abort", () => abortRace.resolve("aborted"), { once: true });
			const outcome = await Promise.race([
				internal.settle.then(() => "settled" as const),
				...(signal !== undefined ? [abortRace.promise] : []),
			]);
			if (outcome === "aborted") {
				// Cancellation stops only this wait; the run keeps going and its
				// result stays unconsumed for the completion notification.
				return this.formatRecord(internal);
			}
		}

		if (isActiveStatus(internal.record.status)) return this.formatRecord(internal);
		internal.record.resultConsumed = true;
		return this.formatRecord(internal, this.readFullResult(internal.record));
	}

	/**
	 * Full-result channel: re-read the durable artifact when present. A
	 * missing or unreadable file degrades to the inline copy with an explicit
	 * note — never to a fabricated full result.
	 */
	private readFullResult(record: AgentRun): { text?: string; note?: string } {
		if (record.status !== "completed" && record.status !== "stopped") return {};
		if (record.resultFile === undefined) return {};
		try {
			return { text: readFileSync(record.resultFile, "utf8") };
		} catch (error) {
			return {
				note: `Full result file ${record.resultFile} is unreadable (${errorText(error)}); showing the inline copy.`,
			};
		}
	}

	/**
	 * Mark a terminal run's result consumed without returning it — used when
	 * the result was delivered inline by a foreground Agent call.
	 */
	markResultConsumed(agentId: string): boolean {
		const internal = this.runs.get(agentId);
		if (!internal || isActiveStatus(internal.record.status)) return false;
		if (internal.record.resultConsumed === true) return false;
		internal.record.resultConsumed = true;
		return true;
	}
	canAttachPane(agentId: string): boolean {
		const internal = this.runs.get(agentId);
		const backend = internal?.backend;
		const handle = internal?.record.handle;
		if (!backend?.attach || !handle) return false;
		const serialized = (backend as unknown as RestorableExecutionBackend).serializeHandle?.(
			handle,
			internal.record.sessionFile,
		);
		return serialized?.launcher.kind === "herdr" || serialized?.launcher.kind === "tmux";
	}
	async attachPane(agentId: string): Promise<boolean> {
		const internal = this.runs.get(agentId);
		if (!internal?.backend || !internal.record.handle || !internal.backend.attach) return false;
		return internal.backend.attach(internal.record.handle);
	}

	/** Retry cleanup for a retained terminal child; worktrees remain unless explicitly removed. */
	async release(agentId: string, options: ReleaseOptions = {}): Promise<boolean> {
		const target = this.runs.get(agentId);
		if (!target) return false;
		if (isActiveStatus(target.record.status)) throw new Error(`Cannot release active run "${agentId}".`);

		const targetSerialized =
			target.backend && target.record.handle
				? (target.backend as unknown as RestorableExecutionBackend).serializeHandle?.(
						target.record.handle,
						target.record.sessionFile,
					)
				: undefined;
		const sharedChild: RunInternals[] = [];
		for (const internal of this.runs.values()) {
			if (!internal.backend || !internal.record.handle) continue;
			const serialized = (internal.backend as unknown as RestorableExecutionBackend).serializeHandle?.(
				internal.record.handle,
				internal.record.sessionFile,
			);
			if (internal === target || (targetSerialized && serialized?.childId === targetSerialized.childId)) {
				if (isActiveStatus(internal.record.status)) {
					throw new Error(`Cannot release child for "${agentId}" while run "${internal.record.id}" is active.`);
				}
				sharedChild.push(internal);
			}
		}

		const worktree = target.worktreeInfo ?? target.record.worktree;
		const relatedWorktree = worktree
			? [...this.runs.values()].filter((internal) => internal.record.worktree?.path === worktree.path)
			: [];
		if (options.cleanupWorktree === true) {
			for (const internal of relatedWorktree) {
				if (isActiveStatus(internal.record.status)) {
					throw new Error(`Cannot release worktree while run "${internal.record.id}" is active.`);
				}
			}
			if (!worktree || !this.worktreeService) throw new Error(`Run "${agentId}" has no releasable worktree.`);
			if (target.record.recoveryError) {
				throw new Error(`Cannot release worktree before changes are preserved: ${target.record.recoveryError}`);
			}
		}

		const releasable = sharedChild[0];
		if (releasable?.backend && releasable.record.handle) {
			await releasable.backend.dispose(releasable.record.handle);
			for (const internal of sharedChild) {
				this.detachBudgetWatch(internal);
				internal.unsubscribeBackend?.();
				delete internal.unsubscribeBackend;
				internal.unsubscribeMessages?.();
				delete internal.unsubscribeMessages;
				delete internal.record.handle;
				delete internal.backend;
				this.notifyFocus(internal);
			}
		}
		this.preservedRegistryEntries = this.preservedRegistryEntries.filter(
			(entry) => isIncompatibleRegistryEntry(entry) || !sharedChild.some((internal) => internal.record.id === entry.id),
		);
		this.syncRegistry();
		await this.persistReleasedHistory(sharedChild);

		if (options.cleanupWorktree === true && worktree && this.worktreeService) {
			await this.worktreeService.releaseForRun(worktree);
			for (const internal of relatedWorktree) {
				delete internal.record.worktree;
				delete internal.worktreeInfo;
				internal.record.worktreeReleased = true;
			}
			this.syncRegistry();
			await this.persistReleasedHistory(relatedWorktree);
		}
		return true;
	}

	private async persistReleasedHistory(internals: readonly RunInternals[]): Promise<void> {
		const store = this.registryStore;
		if (!store || internals.length === 0) return;
		const previousIds = new Set(store.readHistory().map((entry) => entry.id));
		for (const internal of internals) {
			if (!this.settings.rememberAgents && !previousIds.has(internal.record.id)) continue;
			store.recordCompleted(
				toHistoryEntry(internal.record, internal.cwd, this.configCwd, internal.record.completedAt ?? this.now()),
			);
		}
	}

	// -- teardown ---------------------------------------------------------------

	/** Explicit teardown stops child runs, waits for their RPC outcomes, then closes children. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.shuttingDown = true;
		this.admissionEpoch += 1;
		for (const [id, internal] of [...this.runs]) {
			if (internal.record.status === "queued") await this.stop(id);
		}
		await Promise.allSettled(
			[...this.runs.values()].map((internal) => internal.launchPromise).filter((promise) => promise !== undefined),
		);
		for (const [id, internal] of this.runs) {
			if (!isActiveStatus(internal.record.status) || !internal.backend || !internal.record.handle) continue;
			if (!(await this.stop(id)) && isActiveStatus(internal.record.status)) {
				this.shuttingDown = false;
				throw new Error(`Child did not accept abort for run "${id}".`);
			}
		}
		await this.waitForAll();
		await Promise.allSettled(
			[...this.runs.values()].map((internal) => internal.finalizePromise).filter((promise) => promise !== undefined),
		);
		this.disposed = true;
		this.queue = [];
		for (const internal of this.runs.values()) {
			this.detachBudgetWatch(internal);
			internal.unsubscribeBackend?.();
			delete internal.unsubscribeBackend;
			internal.unsubscribeMessages?.();
			delete internal.unsubscribeMessages;
			if (internal.backend && internal.record.handle) {
				await internal.backend.dispose(internal.record.handle);
				delete internal.record.handle;
				delete internal.backend;
			}
		}
		this.budgetWatcher.clear();
		this.syncRegistry();
		this.clearFocusObservations();
		this.runs.clear();
		this.runningSlots = 0;
	}

	// -- durable registry / restore -------------------------------------------

	/** Rebuild a validated stored receipt; controls require RPC auth, disposal verifies resource ownership. */
	async restoreReconnectedRun(entry: AgentRegistryEntry): Promise<RestoreReconnectResult> {
		if (this.disposed || this.runs.has(entry.id) || !entry.handle || !isSerializableBackendHandle(entry.handle))
			return { state: "deferred" };
		const backend = this.backends.find((candidate) => candidate.kind === "process");
		if (!backend) return { state: "deferred" };
		const restorable = backend as unknown as RestorableExecutionBackend;
		const handle = restorable.restoreHandle(entry.id, entry.handle);
		if (!handle) return { state: "deferred" };

		let resolveSettle!: (record: AgentRun) => void;
		const settle = new Promise<AgentRun>((resolve) => {
			resolveSettle = resolve;
		});
		const record: AgentRun = {
			id: entry.id,
			type: entry.type,
			description: entry.description,
			status: entry.status,
			backend: "process",
			handle,
			...(entry.model !== undefined ? { model: entry.model } : {}),
			...(entry.modelFallback !== undefined ? { modelFallback: entry.modelFallback } : {}),
			...(entry.sessionFile !== undefined ? { sessionFile: entry.sessionFile } : {}),
			...(entry.result !== undefined ? { result: entry.result } : {}),
			...(entry.resultFile !== undefined ? { resultFile: entry.resultFile } : {}),
			...(entry.resultTruncated !== undefined ? { resultTruncated: entry.resultTruncated } : {}),
			...(entry.resultOriginalLength !== undefined ? { resultOriginalLength: entry.resultOriginalLength } : {}),
			...(entry.error !== undefined ? { error: entry.error } : {}),
			...(entry.recoveryError !== undefined ? { recoveryError: entry.recoveryError } : {}),
			...(entry.completedAt !== undefined ? { completedAt: entry.completedAt } : {}),
			startedAt: entry.startedAt,
			toolUses: entry.toolUses ?? 0,
			turns: entry.turns ?? 0,
			usage: entry.usage ? { ...entry.usage } : { ...EMPTY_USAGE },
			owner: { ...entry.owner },
			delivery: entry.delivery,
			isBackground: entry.isBackground ?? true,
			...(entry.resultConsumed !== undefined ? { resultConsumed: entry.resultConsumed } : {}),
			...(entry.parentSession !== undefined ? { parentSession: { ...entry.parentSession } } : {}),
			...(entry.worktree !== undefined ? { worktree: { ...entry.worktree } } : {}),
			...(entry.worktreeResult !== undefined
				? { worktreeResult: { ...entry.worktreeResult, commits: [...entry.worktreeResult.commits] } }
				: {}),
			...(entry.worktreeReleased !== undefined ? { worktreeReleased: entry.worktreeReleased } : {}),
			...(entry.budgetTimeout !== undefined ? { budgetTimeout: entry.budgetTimeout } : {}),
			...(entry.budgetIdleTimeout !== undefined ? { budgetIdleTimeout: entry.budgetIdleTimeout } : {}),
			...(entry.budgetStartedAt !== undefined ? { budgetStartedAt: entry.budgetStartedAt } : {}),
			...(entry.budgetLastOutputAt !== undefined ? { budgetLastOutputAt: entry.budgetLastOutputAt } : {}),
			...(entry.budgetExhausted !== undefined ? { budgetExhausted: entry.budgetExhausted } : {}),
			...(entry.budgetSeconds !== undefined ? { budgetSeconds: entry.budgetSeconds } : {}),
		};
		const internal: RunInternals = {
			record,
			backend,
			cwd: entry.cwd,
			settle,
			resolveSettle,
			plan: { kind: "launch", prompt: "" },
			pendingSteers: [],
			stopRequested: false,
			stopAcknowledged: false,
			slotAcquired: isActiveStatus(record.status),
			...(record.worktree !== undefined ? { worktreeInfo: { ...record.worktree } } : {}),
		};
		this.runs.set(record.id, internal);
		if (internal.slotAcquired) this.runningSlots += 1;
		else resolveSettle(record);
		if (record.worktree !== undefined) this.worktreeService?.reconnect(record.worktree);
		// A retained live child keeps its ORIGINAL clocks: the persisted
		// budgetStartedAt/budgetLastOutputAt continue counting wall time across
		// the parent restart (no fresh idle window). The first authenticated
		// snapshot re-derives lastOutputAt from the transcript when the child
		// produced output while the parent was away.
		this.resumeBudgetWatch(internal);
		internal.unsubscribeBackend = backend.subscribe(handle, (status) => {
			void this.reconcileBackendStatus(internal, status).catch((error: unknown) => {
				record.recoveryError = errorText(error);
				this.syncRegistry();
			});
		});
		this.connectMessages(internal);
		try {
			await this.reconcileBackendStatus(internal, await backend.status(handle));
			await this.messageService?.deliverPending(record.id);
		} catch {
			// Connection failures are retained as active/unknown, never rewritten as job failures.
		}
		if (isTerminalStatus(record.status) && record.handle === undefined) return { state: "closed" };
		const restoredEntry = toRegistryEntry(record, entry.cwd, this.configCwd, this.projectHandle(internal));
		return { state: "retained", entry: restoredEntry };
	}

	/** Preserve hidden and incompatible rows while the remember setting is off. */
	setPreservedRegistryEntries(entries: readonly PersistedRegistryEntry[]): void {
		this.preservedRegistryEntries = [...entries];
	}

	/** Registry rows owned by other sessions: never adopted, always preserved on rewrite. */
	setForeignRegistryEntries(entries: readonly PersistedRegistryEntry[]): void {
		this.foreignRegistryEntries = [...entries];
	}

	/** Session shutdown detaches RPC clients and persists ownership without stopping children. */
	async shutdownSession(): Promise<void> {
		if (this.disposed) return;
		this.shuttingDown = true;
		this.admissionEpoch += 1;
		for (const [id, internal] of [...this.runs]) {
			if (internal.record.status === "queued") await this.stop(id);
		}
		await Promise.allSettled(
			[...this.runs.values()].map((internal) => internal.launchPromise).filter((promise) => promise !== undefined),
		);
		await Promise.allSettled(
			[...this.runs.values()].map((internal) => internal.finalizePromise).filter((promise) => promise !== undefined),
		);
		for (const internal of this.runs.values()) {
			this.detachBudgetWatch(internal);
			internal.unsubscribeBackend?.();
			delete internal.unsubscribeBackend;
			internal.unsubscribeMessages?.();
			delete internal.unsubscribeMessages;
			if (internal.backend && internal.record.handle) internal.backend.detach(internal.record.handle);
			this.focusObservations.get(internal.record.id)?.unsubscribe?.();
		}
		this.budgetWatcher.clear();
		this.syncRegistry();
		this.clearFocusObservations();
		this.runs.clear();
		this.queue = [];
		this.runningSlots = 0;
	}
	// -- internals -------------------------------------------------------------

	private applyEvent(internal: RunInternals, event: AgentRunEvent): void {
		const record = internal.record;
		let next: AgentRunStatus;
		try {
			next = transition(record.status, event);
		} catch {
			return;
		}
		record.status = next;
		if (event.type === "complete") {
			record.result = event.result ?? "";
			if (event.resultFile !== undefined) record.resultFile = event.resultFile;
			else delete record.resultFile;
			if (event.resultTruncated !== undefined) record.resultTruncated = event.resultTruncated;
			else delete record.resultTruncated;
			if (event.resultOriginalLength !== undefined) record.resultOriginalLength = event.resultOriginalLength;
			else delete record.resultOriginalLength;
		}
		if (event.type === "fail") record.error = event.error ?? "unknown failure";
		if (!isTerminalStatus(next)) return;

		// A budget stop only explains an actually stopped run; a completion or
		// failure racing the watchdog must not carry the budget annotation.
		if (next === "completed" || next === "error") {
			delete record.budgetExhausted;
			delete record.budgetSeconds;
		}
		record.completedAt = this.now();
		this.detachBudgetWatch(internal);
		internal.unsubscribeBackend?.();
		delete internal.unsubscribeBackend;
		internal.unsubscribeMessages?.();
		delete internal.unsubscribeMessages;
		this.registry.releaseSnapshot(record.id);
		if (internal.slotAcquired) {
			internal.slotAcquired = false;
			this.runningSlots = Math.max(0, this.runningSlots - 1);
		}
		internal.finalizePromise = this.finalizeTerminalRun(internal);
		const finish = (): void => {
			this.emit(record, lifecycleName(next));
			internal.resolveSettle(record);
			this.drainQueue();
		};
		void internal.finalizePromise.then(finish, (error: unknown) => {
			record.recoveryError = errorText(error);
			finish();
		});
	}

	private async startRun(internal: RunInternals): Promise<void> {
		await Promise.resolve();
		if (internal.record.status !== "queued") return;
		this.queue = this.queue.filter((id) => id !== internal.record.id);
		this.applyEvent(internal, { type: "start" });
		this.emit(internal.record, "started");

		try {
			const backend = internal.backend;
			if (!backend) throw new Error("Admitted process execution backend is unavailable.");

			let handle: AgentBackendHandle;
			if (internal.plan.kind === "resume") {
				// Clocks start here — after admission/queue prep, immediately before
				// the resume call itself.
				this.beginBudgetClocks(internal);
				handle = await backend.resume({ ...internal.plan.input, runId: internal.record.id });
			} else {
				const snapshot = this.registry.getActiveSnapshot(internal.record.id);
				if (!snapshot) throw new Error(`invocation snapshot lost for run "${internal.record.id}"`);
				if (
					this.worktreeService &&
					snapshot.resolved.isolationPolicy === "worktree" &&
					this.settings.worktreeIsolation
				) {
					const info = await this.worktreeService.createForRun(internal.record.id, this.cwd);
					internal.worktreeInfo = info;
					internal.record.worktree = info;
					internal.cwd = info.path;
				}
				// Clocks start here — after admission/queue/worktree prep, immediately
				// before the launch call itself.
				this.beginBudgetClocks(internal);
				handle = await backend.launch(this.buildLaunchInput(internal, snapshot));
			}

			internal.record.handle = handle;
			this.connectBudgetOutput(internal);
			if (internal.pendingBudgetStop !== undefined) {
				// The deadline expired while the launch was still in flight; enforce
				// it as soon as a stoppable handle exists.
				delete internal.pendingBudgetStop;
				this.beginEnforcedStop(internal);
				this.syncRegistry();
			}
			this.connectMessages(internal);
			this.notifyFocus(internal);
			internal.unsubscribeBackend = backend.subscribe(handle, (status) => {
				void this.reconcileBackendStatus(internal, status).catch((error: unknown) => {
					internal.record.recoveryError = errorText(error);
				});
			});
			this.syncRegistry();
			await this.reconcileBackendStatus(internal, await backend.status(handle));
			await this.messageService?.deliverPending(internal.record.id);

			await this.flushPendingControls(internal);
			if (this.shuttingDown) this.syncRegistry();
		} catch (error) {
			if (internal.record.handle !== undefined) {
				// A post-launch RPC failure is connection uncertainty, not job failure.
				this.syncRegistry();
				return;
			}
			await this.preserveWorktree(internal);
			this.applyEvent(internal, {
				type: "fail",
				error: errorText(error),
			});
		}
	}

	private buildLaunchInput(internal: RunInternals, snapshot: AgentDefinitionSnapshot): AgentLaunchInput {
		const record = internal.record;
		const resolved = snapshot.resolved;
		if (internal.plan.kind !== "launch") throw new Error("launch plan mismatch");
		const input: AgentLaunchInput = {
			runId: record.id,
			type: resolved.type,
			description: record.description,
			prompt: internal.plan.prompt,
			systemPrompt: resolved.systemPrompt,
			promptMode: resolved.promptMode,
			cwd: internal.cwd,
			configCwd: this.configCwd,
			background: record.isBackground === true,
			isolation: resolved.isolationPolicy,
			graceTurns: this.settings.graceTurns,
		};
		if (internal.worktreeInfo !== undefined) input.worktree = { ...internal.worktreeInfo };
		if (resolved.instructions !== undefined) input.instructions = resolved.instructions;
		if (resolved.model !== undefined) input.model = resolved.model;
		if (record.modelFallback !== undefined) input.modelFallback = record.modelFallback;
		if (resolved.thinking !== undefined) input.thinking = resolved.thinking;
		if (resolved.tools !== undefined) input.tools = [...resolved.tools];
		if (resolved.maxTurnLimit !== undefined) input.maxTurns = resolved.maxTurnLimit;
		return input;
	}

	private async reconcileBackendStatus(internal: RunInternals, status: BackendStatus): Promise<void> {
		const record = internal.record;
		if (isTerminalStatus(record.status)) {
			if (internal.finalizePromise) return internal.finalizePromise;
			if (status.outcomeUnavailable) {
				await this.disposeTerminalChild(internal);
				return;
			}
			if (
				status.state !== "completed" &&
				status.state !== "failed" &&
				status.state !== "stopped" &&
				status.state !== "timeout"
			) {
				// A persisted outcome is authoritative even without RPC. Disposal still
				// requires authenticated idle state or verified exited-resource ownership.
				if (status.state === "disconnected") await this.disposeTerminalChild(internal);
				return;
			}
			if (internal.settlementPromise) return internal.settlementPromise;

			const settlePersistedTerminal = async (): Promise<void> => {
				await this.preserveWorktree(internal);
				if (status.sessionFile !== undefined) record.sessionFile = status.sessionFile;
				if (status.usage !== undefined) record.usage = { ...status.usage };
				if (status.turns !== undefined) record.turns = status.turns;
				if (status.toolUses !== undefined) record.toolUses = status.toolUses;
				delete record.result;
				delete record.error;
				delete record.resultFile;
				delete record.resultTruncated;
				delete record.resultOriginalLength;
				switch (status.state) {
					case "completed":
						record.status = "completed";
						record.result = status.result ?? "";
						if (status.resultFile !== undefined) record.resultFile = status.resultFile;
						if (status.resultTruncated !== undefined) record.resultTruncated = status.resultTruncated;
						if (status.resultOriginalLength !== undefined) record.resultOriginalLength = status.resultOriginalLength;
						delete record.budgetExhausted;
						delete record.budgetSeconds;
						break;
					case "stopped":
						record.status = "stopped";
						break;
					case "failed":
					case "timeout":
						record.status = "error";
						record.error = status.error ?? status.detail ?? `child reported ${status.state}`;
						delete record.budgetExhausted;
						delete record.budgetSeconds;
						break;
				}
				record.completedAt ??= this.now();
				this.detachBudgetWatch(internal);
				internal.unsubscribeBackend?.();
				delete internal.unsubscribeBackend;
				internal.unsubscribeMessages?.();
				delete internal.unsubscribeMessages;
				this.registry.releaseSnapshot(record.id);
				internal.finalizePromise = this.finalizeTerminalRun(internal);
				await internal.finalizePromise;
			};
			internal.settlementPromise = settlePersistedTerminal();
			return internal.settlementPromise;
		}
		let metadataChanged = false;
		if (status.model !== undefined && record.model !== status.model) {
			record.model = status.model;
			metadataChanged = true;
		}
		if (status.modelFallback !== undefined && record.modelFallback !== status.modelFallback) {
			record.modelFallback = status.modelFallback;
			metadataChanged = true;
		}
		if (status.sessionFile !== undefined && record.sessionFile !== status.sessionFile) {
			record.sessionFile = status.sessionFile;
			metadataChanged = true;
		}
		if (status.usage !== undefined) record.usage = { ...status.usage };
		if (status.turns !== undefined) record.turns = status.turns;
		if (status.toolUses !== undefined) record.toolUses = status.toolUses;
		if (status.state === "running") {
			if (record.status === "queued") this.applyEvent(internal, { type: "start" });
			if (record.status === "starting") this.applyEvent(internal, { type: "launched" });
		}
		if (metadataChanged || status.usage !== undefined || status.turns !== undefined || status.toolUses !== undefined) {
			this.syncRegistry();
		}

		if (status.state === "starting" || status.state === "disconnected") return;
		if (status.state === "running") {
			await this.flushPendingControls(internal);
			return;
		}
		if (internal.settlementPromise) return internal.settlementPromise;
		const settle = async (): Promise<void> => {
			await this.preserveWorktree(internal);
			switch (status.state) {
				case "completed":
					this.applyEvent(internal, {
						type: "complete",
						result: status.result ?? "",
						...(status.resultFile !== undefined ? { resultFile: status.resultFile } : {}),
						...(status.resultTruncated !== undefined ? { resultTruncated: status.resultTruncated } : {}),
						...(status.resultOriginalLength !== undefined ? { resultOriginalLength: status.resultOriginalLength } : {}),
					});
					break;
				case "stopped":
					this.applyEvent(internal, { type: "stop" });
					break;
				case "failed":
				case "timeout":
					this.applyEvent(internal, {
						type: "fail",
						error: status.error ?? status.detail ?? `child reported ${status.state}`,
					});
					break;
				default:
					break;
			}
			if (internal.finalizePromise) await internal.finalizePromise;
		};
		internal.settlementPromise = settle();
		return internal.settlementPromise;
	}

	private drainQueue(): void {
		if (this.shuttingDown || this.disposed) return;
		while (this.queue.length > 0 && this.runningSlots < this.maxConcurrent) {
			const id = this.queue.shift();
			if (id === undefined) break;
			const internal = this.runs.get(id);
			if (internal?.record.status !== "queued") continue;
			this.runningSlots += 1;
			internal.slotAcquired = true;
			internal.launchPromise = this.startRun(internal);
		}
	}

	private async preserveWorktree(internal: RunInternals): Promise<void> {
		const info = internal.worktreeInfo;
		const service = this.worktreeService;
		if (!info || !service || internal.record.worktreeResult !== undefined) return;
		try {
			const result = await service.preserveForRun(info, internal.record.description);
			internal.record.worktreeResult = result;
			internal.worktreeInfo = { ...info, branch: result.branch };
			internal.record.worktree = { ...internal.worktreeInfo };
		} catch (error) {
			internal.record.recoveryError = `Worktree changes remain at ${info.checkoutRoot ?? info.path}: ${errorText(error)}`;
		}
		this.syncRegistry();
	}

	private async finalizeTerminalRun(internal: RunInternals): Promise<void> {
		this.persistCompletedHistory([internal]);
		// Keep a durable recovery receipt until the verified child has actually
		// been disposed. Worktree/session metadata and the native outcome are
		// already present on the terminal run at this point.
		this.syncRegistry();
		await this.disposeTerminalChild(internal);
	}

	private async disposeTerminalChild(internal: RunInternals): Promise<void> {
		const backend = internal.backend;
		const handle = internal.record.handle;
		if (!backend || !handle) return;
		const restorable = backend as unknown as RestorableExecutionBackend;
		const serialized = restorable.serializeHandle?.(handle, internal.record.sessionFile);
		const childId = serialized?.childId;
		if (!childId) {
			await this.disposeTerminalRuns([internal]);
			return;
		}

		let byChild = this.terminalCleanupByChild.get(backend);
		if (!byChild) {
			byChild = new Map();
			this.terminalCleanupByChild.set(backend, byChild);
		}
		const pending = byChild.get(childId);
		if (pending) {
			await pending;
			return;
		}

		const cleanup = this.disposeTerminalRuns(this.runsForChild(backend, childId));
		byChild.set(childId, cleanup);
		try {
			await cleanup;
		} finally {
			if (byChild.get(childId) === cleanup) byChild.delete(childId);
		}
	}

	private runsForChild(backend: AgentExecutionBackend, childId: string): RunInternals[] {
		const linked: RunInternals[] = [];
		const restorable = backend as unknown as RestorableExecutionBackend;
		for (const internal of this.runs.values()) {
			if (internal.backend !== backend || !internal.record.handle) continue;
			if (restorable.serializeHandle?.(internal.record.handle, internal.record.sessionFile)?.childId === childId) {
				linked.push(internal);
			}
		}
		return linked;
	}

	private async disposeTerminalRuns(linked: readonly RunInternals[]): Promise<void> {
		const representative = linked.find((internal) => internal.backend && internal.record.handle);
		if (!representative?.backend || !representative.record.handle) return;
		if (linked.some((internal) => isActiveStatus(internal.record.status))) return;

		try {
			await representative.backend.dispose(representative.record.handle);
		} catch (error) {
			const recoveryError = `Child cleanup failed; process receipt retained: ${errorText(error)}`;
			for (const internal of linked) {
				if (isTerminalStatus(internal.record.status)) internal.record.recoveryError = recoveryError;
			}
			this.syncRegistry();
			this.persistCompletedHistory(linked);
			return;
		}

		let cleanupErrorCleared = false;
		for (const internal of linked) {
			this.detachBudgetWatch(internal);
			internal.unsubscribeBackend?.();
			delete internal.unsubscribeBackend;
			internal.unsubscribeMessages?.();
			delete internal.unsubscribeMessages;
			delete internal.record.handle;
			delete internal.backend;
			this.notifyFocus(internal);
			if (internal.record.recoveryError?.startsWith("Child cleanup failed;")) {
				delete internal.record.recoveryError;
				cleanupErrorCleared = true;
			}
		}
		this.syncRegistry();
		if (cleanupErrorCleared) this.persistCompletedHistory(linked);
	}

	private persistCompletedHistory(internals: readonly RunInternals[]): void {
		const store = this.registryStore;
		if (!store || !this.settings.rememberAgents) return;
		for (const internal of internals) {
			if (!isTerminalStatus(internal.record.status)) continue;
			// History is for inspection and cold resume, not a live-process
			// registry. The child bootstrap and JSONL remain on disk separately.
			store.recordCompleted(
				toHistoryEntry(internal.record, internal.cwd, this.configCwd, internal.record.completedAt ?? this.now()),
			);
		}
	}

	private syncRegistry(): void {
		const store = this.registryStore;
		if (!store) return;
		const entries: PersistedRegistryEntry[] = [];
		const persistedIds = new Set<string>();
		for (const internal of this.runs.values()) {
			if (!internal.backend || !internal.record.handle) continue;
			const entry = toRegistryEntry(internal.record, internal.cwd, this.configCwd, this.projectHandle(internal));
			if (entry.handle !== undefined) {
				entries.push(entry);
				persistedIds.add(entry.id);
			}
		}
		for (const preserved of this.preservedRegistryEntries) {
			if (isIncompatibleRegistryEntry(preserved)) {
				entries.push(preserved);
				continue;
			}
			if (this.settings.rememberAgents || !isTerminalStatus(preserved.status) || persistedIds.has(preserved.id)) {
				continue;
			}
			entries.push(preserved);
		}
		for (const foreign of this.foreignRegistryEntries) {
			if (isIncompatibleRegistryEntry(foreign)) {
				entries.push(foreign);
				continue;
			}
			if (persistedIds.has(foreign.id)) continue;
			entries.push(foreign);
		}
		store.writeRegistry(entries);
	}

	private projectHandle(internal: RunInternals): HandleProjector | undefined {
		const backend = internal.backend;
		if (!backend || !internal.record.handle) return undefined;
		const restorable = backend as unknown as RestorableExecutionBackend;
		if (typeof restorable.serializeHandle !== "function") return undefined;
		return (handle, sessionFile) => restorable.serializeHandle?.(handle, sessionFile);
	}
	private formatRecord(internal: RunInternals, fullResult?: { text?: string; note?: string }): string {
		const record = internal.record;
		const duration = record.completedAt !== undefined ? Math.max(0, record.completedAt - record.startedAt) : undefined;
		const head =
			`Agent: ${record.id}\n` +
			`Type: ${record.type} | Status: ${record.status}\n` +
			`Description: ${record.description}\n` +
			(record.model !== undefined ? `Model: ${record.model}\n` : "") +
			(record.modelFallback !== undefined ? `Model fallback: ${record.modelFallback}\n` : "") +
			`Tool uses: ${record.toolUses}` +
			(duration !== undefined ? ` | Duration: ${duration}ms` : "");
		if (isActiveStatus(record.status)) {
			return `${head}\n\nAgent is still ${record.status}. Use wait: true or check back later.`;
		}
		if (record.status === "error") {
			return `${head}\n\nError: ${record.error ?? "unknown failure"}${record.recoveryError ? `\nRecovery: ${record.recoveryError}` : ""}`;
		}
		const budgetNote = budgetStopNote(record);
		// Full-result channel: prefer the re-read artifact; the inline copy is
		// the fallback and is labeled when it is a truncation.
		const showingFull = (fullResult?.text ?? "").trim().length > 0;
		const body = showingFull ? (fullResult?.text ?? "") : record.result?.trim() || "No output.";
		const inlineChars = record.result !== undefined ? Math.max(0, record.result.length - 1) : 0;
		const truncationNote =
			!showingFull && record.resultTruncated === true
				? record.resultFile !== undefined
					? `Result truncated at ${inlineChars}/${record.resultOriginalLength ?? "?"} chars — full: ${record.resultFile}`
					: `Result truncated at ${inlineChars}/${record.resultOriginalLength ?? "?"} chars.`
				: undefined;
		const pointer = showingFull && record.resultFile !== undefined ? `full result: ${record.resultFile}` : undefined;
		return (
			`${head}\n\n${body}` +
			(truncationNote !== undefined ? `\n\n${truncationNote}` : "") +
			(pointer !== undefined ? `\n${pointer}` : "") +
			(budgetNote !== undefined ? `\n\n${budgetNote}` : "") +
			(fullResult?.note !== undefined ? `\n\n${fullResult.note}` : "") +
			(record.recoveryError ? `\nRecovery: ${record.recoveryError}` : "")
		);
	}
}

/**
 * Single wording for the parent-facing budget-stop annotation: identifies the
 * exact exhausted budget and its seconds, flags partial work as possibly
 * incomplete, and points at the same-limit resume. Present only when the
 * watchdog actually stopped the run.
 */
export function budgetStopNote(record: Pick<AgentRun, "id" | "budgetExhausted" | "budgetSeconds">): string | undefined {
	if (record.budgetExhausted === undefined) return undefined;
	return (
		`Stopped by ${record.budgetExhausted} budget after ${record.budgetSeconds}s — ` +
		"the run ended early and partial work may be incomplete. " +
		`Resume with Agent(resume: "${record.id}") to continue under the same budgets.`
	);
}

/**
 * Effective budget resolution: invocation override > frozen snapshot of the
 * source run (resume/restore; 0 = unlimited) > current definition tier >
 * settings default (0 = unlimited). Malformed overrides never reach this
 * function — resolveInvocation rejects them first.
 */
function effectiveBudgetSeconds(
	invoked: number | undefined,
	frozen: number | undefined,
	resolved: number | undefined,
	settingsDefault: number,
): number {
	if (invoked !== undefined) return invoked;
	if (frozen !== undefined) return frozen;
	return resolved ?? settingsDefault;
}

/** Map a terminal status onto the integration-protocol lifecycle event name. */
function lifecycleName(status: AgentRunStatus): AgentLifecycleEventName {
	switch (status) {
		case "completed":
			return "completed";
		case "error":
			return "failed";
		default:
			// stopped / aborted → "stopped"
			return "stopped";
	}
}

/** Rehydrate a minimal in-memory projection of a completed history row. */
function historyToRun(entry: CompletedRunHistoryEntry): AgentRun {
	return {
		id: entry.id,
		type: entry.type,
		description: entry.description,
		status: entry.status,
		backend: entry.backend,
		...(entry.model !== undefined ? { model: entry.model } : {}),
		...(entry.modelFallback !== undefined ? { modelFallback: entry.modelFallback } : {}),
		...(entry.sessionFile !== undefined ? { sessionFile: entry.sessionFile } : {}),
		...(entry.result !== undefined ? { result: entry.result } : {}),
		...(entry.resultFile !== undefined ? { resultFile: entry.resultFile } : {}),
		...(entry.resultTruncated !== undefined ? { resultTruncated: entry.resultTruncated } : {}),
		...(entry.resultOriginalLength !== undefined ? { resultOriginalLength: entry.resultOriginalLength } : {}),
		...(entry.error !== undefined ? { error: entry.error } : {}),
		...(entry.recoveryError !== undefined ? { recoveryError: entry.recoveryError } : {}),
		...(entry.budgetTimeout !== undefined ? { budgetTimeout: entry.budgetTimeout } : {}),
		...(entry.budgetIdleTimeout !== undefined ? { budgetIdleTimeout: entry.budgetIdleTimeout } : {}),
		...(entry.budgetStartedAt !== undefined ? { budgetStartedAt: entry.budgetStartedAt } : {}),
		...(entry.budgetLastOutputAt !== undefined ? { budgetLastOutputAt: entry.budgetLastOutputAt } : {}),
		...(entry.budgetExhausted !== undefined ? { budgetExhausted: entry.budgetExhausted } : {}),
		...(entry.budgetSeconds !== undefined ? { budgetSeconds: entry.budgetSeconds } : {}),
		startedAt: entry.startedAt,
		...(entry.completedAt !== undefined ? { completedAt: entry.completedAt } : {}),
		toolUses: entry.toolUses ?? 0,
		turns: entry.turns ?? 0,
		usage: entry.usage ? { ...entry.usage } : { ...EMPTY_USAGE },
		owner: { ...entry.owner },
		delivery: entry.delivery,
		isBackground: entry.isBackground ?? true,
		...(entry.parentSession !== undefined ? { parentSession: { ...entry.parentSession } } : {}),
		...(entry.worktree !== undefined ? { worktree: { ...entry.worktree } } : {}),
		...(entry.worktreeResult !== undefined
			? { worktreeResult: { ...entry.worktreeResult, commits: [...entry.worktreeResult.commits] } }
			: {}),
		...(entry.worktreeReleased !== undefined ? { worktreeReleased: entry.worktreeReleased } : {}),
		...(entry.resultConsumed !== undefined ? { resultConsumed: entry.resultConsumed } : {}),
	};
}
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
