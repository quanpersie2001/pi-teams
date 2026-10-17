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
	TeamBootstrapContext,
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
import { normalizeTeammateColor, teammateNameProblem } from "../domain/team.js";
import type { WorktreeInfo } from "../domain/worktree.js";
import type { AgentRegistry } from "./agent-registry.js";
import { backendUnavailableReason, resolveBackend } from "./backend-selector.js";
import type {
	AgentRegistryEntry,
	CompletedRunHistoryEntry,
	HandleProjector,
	PersistedExecutionBackend,
	PersistedRegistryEntry,
	SubagentRunStore,
} from "./run-registry.js";
import { isIncompatibleRegistryEntry, toHistoryEntry, toRegistryEntry } from "./run-registry.js";
import type { TeamService } from "./team-service.js";
import { type TeammateLifecycle, TeammateRuntime } from "./teammate-runtime.js";
import { type BudgetExpiry, TimeBudgetWatcher } from "./time-budget-watcher.js";
import type { WorktreeService } from "./worktree-service.js";

/** Spawn request accepted by the manager (tool/RPC-neutral shape). */
export interface SpawnRequest {
	type: string;
	/** Teammate address for this assignment (ADR 0007 §2); uniqueness is enforced against active runs. */
	name?: string;
	prompt: string;
	/** Teammate identity color; accepted only with name and frozen at creation. */
	color?: string;
	description?: string | undefined;
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
	/** Teammate context policy. Default: continue an idle child, otherwise start fresh. */
	context?: "continue" | "fresh" | undefined;
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
	color?: string | undefined;
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
	teamService?: TeamService;
	idFactory?: () => string;
	now?: () => number;
	/** Test seam for the session-teardown cooperative window; default 15s. */
	teardownGraceMs?: number;
}

type LaunchPlan =
	| {
			kind: "launch";
			prompt: string;
			/**
			 * Strict re-check of the admitted model before child resources are created;
			 * set only when the invocation model was selected without fallback.
			 */
			strict?: boolean;
	  }
	| { kind: "mailbox" }
	| { kind: "assignment"; handle: AgentBackendHandle; prompt: string; sourceAgentId: string }
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

/**
 * Session teardown grace (ADR 0007 §1, roadmap T1): after the abort request,
 * children get this long to settle cooperatively and preserve their partial
 * result artifact (1.1b) before the verified force-kill path runs.
 */
const SESSION_TEARDOWN_GRACE_MS = 15_000;

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
	unsubscribeAssignments?: () => void;
	unsubscribePresentation?: () => void;
	presentationHandle?: AgentBackendHandle;
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

export interface TeammateStatus {
	name: string;
	membershipId?: string;
	type: string;
	color?: string;
	state: "idle" | "busy" | "released" | "retired";
	operation?: "shutting_down";
	availability: "available" | "unavailable";
	recoveryError?: string;
	/** Most recent assignment artifact; distinct from the live runtime owner. */
	lastRunId?: string;
	/** Current assignment/runtime owner, when a child context is retained. */
	currentRunId?: string;
	/** True only for a settled, available teammate with a verified live child to continue. */
	contextAvailable: boolean;
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
	private readonly presentationListeners = new Set<(agentId: string) => void>();
	private runningSlots = 0;
	private maxConcurrent: number;
	private settings: SubagentsSettings;
	private disposed = false;
	private shuttingDown = false;
	private sessionShutdownOperation: Promise<void> | undefined;
	private sessionShutdownComplete = false;
	private admissionEpoch = 0;

	private readonly registry: AgentRegistry;
	private readonly backends: readonly AgentExecutionBackend[];
	private readonly cwd: string;
	private readonly configCwd: string;
	private readonly getSessionId: () => string;
	private readonly idFactory: () => string;
	private readonly now: () => number;
	/** Cooperative window before the verified teardown force-kill. */
	private readonly teardownGraceMs: number;
	private readonly registryStore: SubagentRunStore | undefined;
	private readonly worktreeService: WorktreeService | undefined;
	private teamService: TeamService | undefined;
	private taskShutdownReconciler:
		| ((name: string, membershipId?: string, phase?: "fence" | "reconcile") => void | Promise<void>)
		| undefined;
	private readonly taskShutdownReconcilers = new Set<NonNullable<typeof this.taskShutdownReconciler>>();
	private readonly teammateRuntime = new TeammateRuntime();
	private readonly teammateLocks = new Map<string, Promise<void>>();
	private readonly pendingMailboxAssignments = new Set<string>();
	private readonly shuttingDownTeammates = new Set<string>();
	private readonly teammateShutdownOperations = new Map<string, Promise<boolean>>();
	private readonly terminalCleanupByChild = new WeakMap<AgentExecutionBackend, Map<string, Promise<void>>>();
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
		this.teardownGraceMs = options.teardownGraceMs ?? SESSION_TEARDOWN_GRACE_MS;
		this.registryStore = options.registryStore;
		this.worktreeService = options.worktreeService;
		this.teamService = options.teamService;
		this.budgetWatcher = new TimeBudgetWatcher({
			now: () => this.now(),
			onExpiry: (runId, decision) => this.handleBudgetExpiry(runId, decision),
		});
	}
	setTeamService(service: TeamService | undefined): void {
		this.teamService = service;
	}
	setTaskShutdownReconciler(
		reconcile:
			| ((name: string, membershipId?: string, phase?: "fence" | "reconcile") => void | Promise<void>)
			| undefined,
	): void {
		this.taskShutdownReconciler = reconcile;
	}
	registerTaskShutdownReconciler(reconcile: NonNullable<typeof this.taskShutdownReconciler>): () => void {
		this.taskShutdownReconcilers.add(reconcile);
		return () => this.taskShutdownReconcilers.delete(reconcile);
	}
	private async reconcileShutdownTasks(name: string, membershipId: string | undefined, phase: "fence" | "reconcile") {
		for (const reconcile of [
			...this.taskShutdownReconcilers,
			...(this.taskShutdownReconciler ? [this.taskShutdownReconciler] : []),
		])
			await reconcile(name, membershipId, phase);
	}

	// -- configuration ---------------------------------------------------------

	updateSettings(settings: SubagentsSettings): void {
		this.settings = settings;
		this.setMaxConcurrent(settings.maxConcurrent);
	}
	/** Begin a host session after the previous session's teardown completes. */
	beginSession(): void {
		if (this.disposed) throw new Error("AgentManager is disposed");
		if (this.sessionShutdownOperation)
			throw new Error("Cannot begin a session while previous session teardown is in progress.");
		if (this.shuttingDown && !this.sessionShutdownComplete)
			throw new Error("Cannot begin a session while previous session cleanup is unconfirmed; retry session shutdown.");
		if (
			[...this.runs.values()].some((internal) => isActiveStatus(internal.record.status) || this.liveResource(internal))
		)
			throw new Error("Cannot begin a session while previous child cleanup is unconfirmed; retry session shutdown.");
		this.teammateRuntime.clearSettled();
		this.admissionEpoch += 1;
		this.shuttingDown = false;
		this.sessionShutdownOperation = undefined;
		this.sessionShutdownComplete = false;
		for (const backend of this.backends) backend.setPresentationActive?.(true);
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

	// -- events ------------------------------------------------------------------

	/** Subscribe to owner-aware lifecycle events; returns an unsubscribe fn. */
	subscribe(listener: (event: AgentLifecycleEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	/** Subscribe to live presentation-view availability changes. */
	subscribePresentation(listener: (agentId: string) => void): () => void {
		this.presentationListeners.add(listener);
		return () => {
			this.presentationListeners.delete(listener);
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
			...(snapshot.teammateName !== undefined ? { teammateName: snapshot.teammateName } : {}),
			...(snapshot.membershipId !== undefined ? { membershipId: snapshot.membershipId } : {}),
			...(snapshot.teammateColor !== undefined ? { teammateColor: snapshot.teammateColor } : {}),
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
		return internal ? this.publicRecord(internal) : undefined;
	}

	/** Read a settled history receipt without adopting or attaching to an old process. */
	getHistoricalRun(agentId: string): AgentRun | undefined {
		const entry = this.registryStore?.readHistory().find((item) => item.id === agentId);
		return entry ? historyToRun(entry) : undefined;
	}

	list(): AgentRun[] {
		return [...this.runs.values()]
			.map((internal) => this.publicRecord(internal))
			.sort((a, b) => b.startedAt - a.startedAt);
	}

	/** Existing run-facing APIs may project the child handle, but ownership stays in TeammateRuntime. */
	private publicRecord(internal: RunInternals): AgentRun {
		const record = cloneRecord(internal.record);
		const resource = this.liveResource(internal);
		if (resource) record.handle = resource.handle;
		return record;
	}

	hasRunning(): boolean {
		return [...this.runs.values()].some((internal) => isActiveStatus(internal.record.status));
	}

	/** Promise resolving when the run reaches a terminal status. */
	whenSettled(agentId: string): Promise<AgentRun> | undefined {
		return this.runs.get(agentId)?.settle;
	}

	teammateMembershipId(name: string): string | undefined {
		return this.teamService?.current?.members.find((member) => member.name === name)?.membershipId;
	}

	teammateStatus(name: string): TeammateStatus | undefined {
		const member = this.teamService?.current?.members.find((candidate) => candidate.name === name);
		const runtime = this.teammateRuntime.get(name);
		const latest = this.latestTeammateRun(name);
		if (!member && !runtime && !latest) return undefined;
		const recoveryError = runtime?.recoveryError ?? member?.recoveryError ?? latest?.recoveryError;
		const color = runtime?.color ?? member?.color ?? latest?.teammateColor;
		const lastRunId = latest?.id ?? member?.lastRunId;
		const available = runtime?.recoveryError === undefined && member?.availability !== "unavailable";
		const contextAvailable =
			available && runtime?.state === "idle" && runtime.backend !== undefined && runtime.handle !== undefined;
		const running =
			runtime?.state === "busy" ||
			[...this.runs.values()].some(
				(internal) => internal.record.teammateName === name && isActiveStatus(internal.record.status),
			);
		const state =
			runtime?.state === "retired" || member?.lifecycle === "retired"
				? "retired"
				: running
					? "busy"
					: runtime?.state === "released"
						? "released"
						: runtime?.state === "idle"
							? "idle"
							: (member?.lifecycle ?? "released");
		return {
			name,
			...(member?.membershipId !== undefined ? { membershipId: member.membershipId } : {}),
			type: runtime?.type ?? member?.type ?? latest?.type ?? "unknown",
			...(color !== undefined ? { color } : {}),
			state,
			...((runtime?.operation ?? (member?.operation ? "shutting_down" : undefined)) !== undefined
				? { operation: runtime?.operation ?? "shutting_down" }
				: {}),
			availability:
				runtime?.recoveryError !== undefined || member?.availability === "unavailable" ? "unavailable" : "available",
			...(recoveryError ? { recoveryError } : {}),
			...(lastRunId !== undefined ? { lastRunId } : {}),
			...(runtime?.currentRunId !== undefined ? { currentRunId: runtime.currentRunId } : {}),
			contextAvailable,
		};
	}

	shutdownTeammate(name: string): Promise<boolean> {
		const existing = this.teammateShutdownOperations.get(name);
		if (existing) return existing;
		const operation = this.shutdownTeammateCore(name);
		this.teammateShutdownOperations.set(name, operation);
		void operation
			.finally(() => {
				if (this.teammateShutdownOperations.get(name) === operation) this.teammateShutdownOperations.delete(name);
			})
			.catch(() => {});
		return operation;
	}

	private async shutdownTeammateCore(name: string): Promise<boolean> {
		const member = this.teamService?.current?.members.find((candidate) => candidate.name === name);
		const runtime = this.teammateRuntime.get(name);
		if (!member && !runtime) return false;
		if (this.shuttingDownTeammates.has(name)) throw new Error(`Shutdown already in progress for @${name}.`);
		this.shuttingDownTeammates.add(name);
		if (runtime) runtime.operation = "shutting_down";
		const membershipId = member?.membershipId;
		const operationId = member?.operation?.operationId ?? randomUUID();
		const existingPhase = member?.operation?.phase;
		const phaseRank = { requested: 0, settled: 1, tasks_reconciled: 2, resources_disposed: 3 } as const;
		let currentPhase = existingPhase;
		const persistPhase = (phase: keyof typeof phaseRank): boolean => {
			if (!member || (currentPhase !== undefined && phaseRank[currentPhase] >= phaseRank[phase])) return true;
			if (!this.teamService?.setShutdownOperation(name, { kind: "shutdown", operationId, phase }, membershipId))
				return false;
			currentPhase = phase;
			return true;
		};
		let shutdownComplete = false;
		if (!persistPhase("requested")) {
			this.shuttingDownTeammates.delete(name);
			if (runtime) delete runtime.operation;
			throw new Error(`Could not persist shutdown intent for @${name}; shutdown was not started.`);
		}
		try {
			await this.reconcileShutdownTasks(name, membershipId, "fence");
			// Fence admission before cancellation; never hold the teammate lock while waiting for settlement.
			const owned = [...this.runs.values()].filter(
				(run) => run.record.teammateName === name && isActiveStatus(run.record.status),
			);
			// Stop RPCs may reject or hang; enforcement deadline starts independently and never awaits them.
			for (const run of owned) void this.stop(run.record.id).catch(() => false);
			await Promise.all(owned.map((run) => this.enforceStopDeadline(run, this.teardownGraceMs)));
			const unsettled = owned.find((run) => isActiveStatus(run.record.status));
			if (unsettled)
				throw new Error(
					`Shutdown could not verify settlement for @${name}; run ${unsettled.record.id} remains active.`,
				);
			await Promise.all(owned.map((run) => run.settle));
			await Promise.all(owned.map((run) => run.finalizePromise).filter((promise) => promise !== undefined));
			if (!persistPhase("settled")) throw new Error(`Could not persist settled shutdown phase for @${name}.`);
			await this.reconcileShutdownTasks(name, membershipId, "reconcile");
			if (!persistPhase("tasks_reconciled"))
				throw new Error(`Could not persist task reconciliation phase for @${name}.`);
			return await this.withTeammateLock(name, async () => {
				const stillActive = [...this.runs.values()].find(
					(run) => run.record.teammateName === name && isActiveStatus(run.record.status),
				);
				if (stillActive)
					throw new Error(
						`Shutdown could not verify settlement for @${name}; run ${stillActive.record.id} remains active.`,
					);
				const ownerId =
					runtime?.currentRunId ?? [...this.runs.values()].find((run) => run.record.teammateName === name)?.record.id;
				if (ownerId)
					await this.releaseCore(ownerId, {}, "shutdown", () => {
						if (!persistPhase("resources_disposed"))
							throw new Error(`Could not persist verified cleanup proof for @${name}.`);
					});
				else if (runtime?.backend && runtime.handle) throw new Error(`Shutdown cannot verify ownership for @${name}.`);
				const registryRows = [
					...(this.registryStore?.readRegistry() ?? []),
					...this.preservedRegistryEntries,
					...this.foreignRegistryEntries,
				];
				const receipts = [
					...new Map(
						registryRows.flatMap((entry) =>
							!isIncompatibleRegistryEntry(entry) &&
							membershipId !== undefined &&
							entry.membershipId === membershipId &&
							entry.handle !== undefined
								? [[entry.id, entry] as const]
								: [],
						),
					).values(),
				];
				for (const receipt of receipts) {
					if (!(await this.attemptStaleDisposal(receipt)))
						throw new Error(
							`Shutdown could not verify disposal of persisted run ${receipt.id}; membership remains fenced.`,
						);
				}
				if (receipts.length > 0) {
					const disposedIds = new Set(receipts.map((entry) => entry.id));
					this.preservedRegistryEntries = this.preservedRegistryEntries.filter(
						(entry) => isIncompatibleRegistryEntry(entry) || !disposedIds.has(entry.id),
					);
					this.foreignRegistryEntries = this.foreignRegistryEntries.filter(
						(entry) => isIncompatibleRegistryEntry(entry) || !disposedIds.has(entry.id),
					);
					this.syncRegistry();
				}
				if (
					existingPhase !== undefined &&
					existingPhase !== "resources_disposed" &&
					!runtime &&
					!ownerId &&
					receipts.length === 0
				)
					throw new Error(`Shutdown recovery for @${name} has no cleanup proof; membership remains fenced.`);
				if (!persistPhase("resources_disposed")) throw new Error(`Could not persist cleanup phase for @${name}.`);
				if (!ownerId) await this.teamService?.discardPending(name, "shutdown");
				if (this.teammateRuntime.get(name) !== runtime)
					throw new Error(`Membership changed during shutdown for @${name}.`);
				if (this.teamService && !this.teamService.removeMember(name, membershipId))
					throw new Error(`Could not persist removal of teammate @${name}; membership remains available for recovery.`);
				this.teammateRuntime.remove(name, runtime);
				shutdownComplete = true;
				return true;
			});
		} catch (error) {
			const recoveryError = `Shutdown for @${name} remains fenced: ${errorText(error)}`;
			if (runtime) this.teammateRuntime.setRecoveryError(name, recoveryError);
			this.teamService?.setAvailability(name, "unavailable", recoveryError, membershipId);
			throw error;
		} finally {
			this.shuttingDownTeammates.delete(name);
			if (shutdownComplete && runtime && this.teammateRuntime.get(name) === runtime) delete runtime.operation;
		}
	}

	async releaseTeammate(name: string): Promise<boolean> {
		if (
			this.teamService?.current?.members.some((member) => member.name === name && member.operation?.kind === "shutdown")
		)
			throw new Error(`Teammate "@${name}" is shutting down; retry shutdown recovery instead.`);
		const status = this.teammateStatus(name);
		if (!status) return false;
		if (status.state === "retired") return true;
		return this.withTeammateLock(name, async () => {
			const latest = this.latestTeammateRun(name);
			if (latest && isActiveStatus(latest.status)) throw new Error(`Cannot release busy teammate "@${name}".`);
			await this.releaseTeammateCore(name, "released");
			return true;
		});
	}

	async retireTeammate(name: string): Promise<boolean> {
		const status = this.teammateStatus(name);
		if (!status) return false;
		if (status.state === "retired") return true;
		return this.withTeammateLock(name, async () => {
			const latest = this.latestTeammateRun(name);
			if (latest && isActiveStatus(latest.status)) throw new Error(`Cannot retire busy teammate "@${name}".`);
			await this.releaseTeammateCore(name, "retired");
			return true;
		});
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
	 * Teammate names are the team's address space (ADR 0007 §2): a valid name
	 * is claimable while its previous assignment is settled — teammates
	 * persist across assignments until the session ends — and rejected while
	 * an active run still carries it.
	 */
	private assertTeammateNameAvailable(name: string): void {
		if (
			this.shuttingDownTeammates.has(name) ||
			this.teamService?.current?.members.some((member) => member.name === name && member.operation?.kind === "shutdown")
		)
			throw new Error(`Teammate "@${name}" is shutting down.`);
		const problem = teammateNameProblem(name);
		if (problem !== undefined) throw new Error(`Invalid teammate name "${name}": ${problem}.`);
		if (
			this.teammateRuntime.get(name)?.state === "busy" &&
			![...this.runs.values()].some(
				(candidate) => candidate.record.teammateName === name && isActiveStatus(candidate.record.status),
			)
		) {
			throw new Error(
				`Teammate "@${name}" is already working on an assignment — wait for it to settle or steer it instead.`,
			);
		}
		for (const internal of this.runs.values()) {
			if (internal.record.teammateName !== name || !isActiveStatus(internal.record.status)) continue;
			throw new Error(
				`Teammate "@${name}" is already working on run "${internal.record.id}" — wait for it to settle or steer it instead.`,
			);
		}
	}
	private latestTeammateRun(name: string): AgentRun | undefined {
		let latest: AgentRun | undefined;
		for (const internal of this.runs.values()) {
			if (internal.record.teammateName === name) latest = internal.record;
		}
		return latest;
	}
	private assertTeammateColor(name: string, color: string | undefined): void {
		const member = this.teamService?.current?.members.find((candidate) => candidate.name === name);
		const runtime = this.teammateRuntime.get(name);
		if (member?.lifecycle === "retired" || runtime?.state === "retired")
			throw new Error(`Teammate "@${name}" is retired and cannot be reassigned.`);
		if (runtime && color !== undefined && color !== runtime.color)
			throw new Error(
				`Teammate "@${name}" already has color ${runtime.color ?? "the default"}; its identity color cannot change.`,
			);
		this.teamService?.assertIdentityColor(name, color);
		if (this.teamService) return;
		const existing = this.latestTeammateRun(name);
		if (existing && color !== undefined && color !== existing.teammateColor)
			throw new Error(
				`Teammate "@${name}" already has color ${existing.teammateColor ?? "the default"}; its identity color cannot change.`,
			);
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

	private liveResource(
		internal: RunInternals,
	): { backend: AgentExecutionBackend; handle: AgentBackendHandle } | undefined {
		const name = internal.record.teammateName;
		const entry = name !== undefined ? this.teammateRuntime.get(name) : undefined;
		if (entry?.currentRunId === internal.record.id && entry.backend && entry.handle)
			return { backend: entry.backend, handle: entry.handle };
		if (internal.backend && internal.record.handle)
			return { backend: internal.backend, handle: internal.record.handle };
		return undefined;
	}

	private async allocate(request: SpawnRequest, plan: LaunchPlan, worktree?: WorktreeInfo): Promise<AgentRun> {
		if (request.name === undefined) return this.allocateCore(request, plan, worktree);
		return this.withTeammateLock(request.name, () => this.allocateCore(request, plan, worktree));
	}

	private async withTeammateLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
		const prior = this.teammateLocks.get(name) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = prior.then(() => gate);
		this.teammateLocks.set(name, tail);
		await prior;
		try {
			return await operation();
		} finally {
			release();
			if (this.teammateLocks.get(name) === tail) this.teammateLocks.delete(name);
		}
	}

	private async allocateCore(request: SpawnRequest, plan: LaunchPlan, worktree?: WorktreeInfo): Promise<AgentRun> {
		if (this.disposed) throw new Error("AgentManager is disposed");
		if (this.shuttingDown) throw new Error("AgentManager is shutting down");
		if (request.color !== undefined && request.name === undefined)
			throw new Error("Teammate color requires a named teammate.");
		const color = request.color === undefined ? undefined : normalizeTeammateColor(request.color);
		if (request.color !== undefined && color === undefined)
			throw new Error("Invalid teammate color; use #RGB or #RRGGBB.");
		if (request.name !== undefined) {
			this.assertTeammateNameAvailable(request.name);
			this.assertTeammateColor(request.name, color);
			const member = this.teamService?.current?.members.find((candidate) => candidate.name === request.name);
			const runtime = this.teammateRuntime.get(request.name);
			if (
				plan.kind === "launch" &&
				request.context === "continue" &&
				(!runtime?.handle || !runtime.backend || runtime.state !== "idle" || runtime.recoveryError !== undefined)
			) {
				throw new Error(
					`Teammate "@${request.name}" has no idle live context to continue; use context: "fresh" or explicitly cold-resume an artifact.`,
				);
			}
			const existingType = member?.type ?? this.latestTeammateRun(request.name)?.type;
			if (existingType !== undefined && request.type !== existingType)
				throw new Error(`Teammate "@${request.name}" keeps its specialist role; use a new name for a different role.`);
		}
		const epoch = this.admissionEpoch;

		// A blank/whitespace-only invocation model is treated as absent: admission
		// trims it internally, so a raw-compare strict gate would otherwise let it
		// silently inherit the parent model. Normalize once and reuse everywhere.
		const invocationModel = request.model?.trim() || undefined;

		const overrides: {
			model?: string;
			thinking?: ThinkingLevel;
			maxTurnLimit?: number;
			timeout?: number;
			idleTimeout?: number;
		} = {};
		if (invocationModel !== undefined) overrides.model = invocationModel;
		if (request.thinking !== undefined) overrides.thinking = request.thinking;
		if (request.max_turns !== undefined) overrides.maxTurnLimit = request.max_turns;
		// Budgets are validated inside resolveInvocation: malformed provided
		// values throw before anything is allocated.
		if (request.timeout !== undefined) overrides.timeout = request.timeout;
		if (request.idle_timeout !== undefined) overrides.idleTimeout = request.idle_timeout;

		const snapshot = this.registry.resolveInvocation(request.type, overrides);
		const background = request.run_in_background ?? snapshot.resolved.defaultBackground;
		const owner: AgentOwner = request.owner ?? ({ kind: "conversation", sessionId: this.getSessionId() } as const);
		const delivery: DeliveryPolicy = request.delivery ?? (owner.kind === "conversation" ? "conversation" : "event");
		const parentSession: ParentSessionRef = request.parentSession ?? {
			sessionId: owner.kind === "conversation" ? owner.sessionId : this.getSessionId(),
		};
		const backend = await resolveBackend({ backends: this.backends });
		if (!backend) {
			// The failure is the execution backend itself, not the model check that
			// never ran: name the launcher problem and keep admission out of it.
			const reason = await backendUnavailableReason({ backends: this.backends });
			throw new Error(
				reason === undefined
					? "No usable process launcher is available on this platform; model admission was not attempted."
					: `No usable process launcher is available on this platform (${reason}); model admission was not attempted.`,
			);
		}
		const requestedModel = plan.kind === "launch" ? snapshot.resolved.model : undefined;
		// Strict admission is for an explicit invocation request only: a definition pin keeps its
		// documented fallback to the caller/definition/parent model.
		const strictRequest =
			requestedModel !== undefined && invocationModel === requestedModel && this.settings.strictModelAdmission;
		const admission = await backend.prepareModel({
			...(requestedModel !== undefined ? { model: requestedModel } : {}),
			...(invocationModel !== undefined && invocationModel !== requestedModel
				? { fallbackModel: invocationModel }
				: {}),
			...(strictRequest ? { strict: true } : {}),
			...(plan.kind === "resume" ? { sessionFile: plan.input.sessionFile } : {}),
		});
		// The launch re-check stays strict only when admission 1 selected the requested model
		// itself; a system-chosen fallback must not produce a "Requested model" failure.
		const launchStrict = strictRequest && admission.fallback === undefined;
		if (plan.kind === "launch") plan.strict = launchStrict;
		if (this.disposed || this.shuttingDown || epoch !== this.admissionEpoch)
			throw new Error("AgentManager session changed during model admission; no run was allocated.");
		if (request.name !== undefined) {
			this.assertTeammateNameAvailable(request.name);
			this.assertTeammateColor(request.name, color);
		}
		if (plan.kind === "resume" && request.name !== undefined) {
			for (const candidate of this.runs.values()) {
				if (candidate.record.teammateName === request.name && candidate.record.handle !== undefined)
					throw new Error(
						`Teammate "${request.name}" retains child run "${candidate.record.id}"; assign it or release it before cold continuation.`,
					);
			}
		}
		if (plan.kind === "resume" && request.name !== undefined) {
			const runtime = this.teammateRuntime.get(request.name);
			if (runtime?.handle)
				throw new Error(`Teammate "${request.name}" retains a child; release it before cold continuation.`);
			await this.teamService?.discardPending(request.name, "context-reset");
		}
		const existingMember =
			request.name !== undefined
				? this.teamService?.current?.members.find((candidate) => candidate.name === request.name)
				: undefined;
		const previous = request.name !== undefined ? this.latestTeammateRun(request.name) : undefined;
		const teammateColor =
			request.name !== undefined
				? (this.teamService?.ensureIdentity({
						name: request.name,
						type: snapshot.resolved.type,
						...(color !== undefined ? { color } : {}),
					}) ??
					existingMember?.color ??
					previous?.teammateColor ??
					color)
				: undefined;
		const currentMember =
			request.name !== undefined
				? this.teamService?.current?.members.find((candidate) => candidate.name === request.name)
				: undefined;
		const teammate =
			request.name !== undefined
				? this.teammateRuntime.ensure({
						name: request.name,
						...(currentMember?.membershipId !== undefined ? { membershipId: currentMember.membershipId } : {}),
						type: snapshot.resolved.type,
						...(teammateColor !== undefined ? { color: teammateColor } : {}),
					})
				: undefined;
		let retained: RunInternals | undefined;
		if (plan.kind === "launch" && request.name !== undefined && teammate) {
			const hasChild = teammate.backend !== undefined && teammate.handle !== undefined;
			let pendingDiscarded = false;
			const startsFresh = request.context === "fresh" || (request.context === undefined && !hasChild);
			if (
				request.context === "continue" &&
				(!hasChild || teammate.state !== "idle" || teammate.recoveryError !== undefined)
			) {
				throw new Error(
					`Teammate "@${request.name}" has no idle live context to continue; use context: "fresh" or explicitly cold-resume an artifact.`,
				);
			}
			if (startsFresh) {
				worktree = teammate.worktreeInfo;
				if (hasChild) {
					if (teammate.state !== "idle") throw new Error(`Cannot reset busy teammate "@${request.name}".`);
					const oldOwner = teammate.currentRunId;
					if (!oldOwner)
						throw new Error(
							`Teammate "@${request.name}" child ownership is uncertain; release it before fresh context.`,
						);
					await this.releaseCore(oldOwner, {}, "fresh");
					pendingDiscarded = true;
				}
				if (!pendingDiscarded)
					try {
						await this.teamService?.discardPending(request.name, "fresh");
						this.teammateRuntime.clearRecoveryError(request.name);
						this.teamService?.setAvailability(request.name, "available");
					} catch (error) {
						this.teammateRuntime.setRecoveryError(
							request.name,
							`Pending mailbox cleanup failed; fresh context was not started: ${errorText(error)}`,
						);
						this.teamService?.setAvailability(
							request.name,
							"unavailable",
							`Pending mailbox cleanup failed: ${errorText(error)}`,
						);
						throw error;
					}
			}
			if (!startsFresh && hasChild && teammate.state === "idle") {
				if (teammate.recoveryError !== undefined)
					throw new Error(
						`Teammate "@${request.name}" context is unavailable: ${teammate.recoveryError}. Release it or request a verified fresh context.`,
					);
				retained = teammate.currentRunId ? this.runs.get(teammate.currentRunId) : undefined;
				if (!backend.assign || teammate.backend !== backend)
					throw new Error("The retained teammate backend cannot accept another assignment.");
				plan = {
					kind: "assignment",
					handle: teammate.handle as AgentBackendHandle,
					prompt: plan.prompt,
					sourceAgentId: teammate.currentRunId ?? "",
				};
				worktree = teammate.worktreeInfo;
			}
		}
		if (request.name !== undefined && teammate?.state === "retired")
			throw new Error(`Teammate "@${request.name}" is retired and cannot be reassigned.`);
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
			...(request.name !== undefined ? { teammateName: request.name } : {}),
			...(currentMember?.membershipId !== undefined ? { membershipId: currentMember.membershipId } : {}),
			...(teammateColor !== undefined ? { teammateColor } : {}),
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
			cwd: retained?.cwd ?? teammate?.cwd ?? (plan.kind === "resume" ? plan.input.cwd : this.cwd),
			...(worktree !== undefined ? { worktreeInfo: { ...worktree } } : {}),
			settle,
			resolveSettle,
			plan,
			pendingSteers: [],
			stopRequested: false,
			stopAcknowledged: false,
			slotAcquired: false,
		};
		if (retained) {
			retained.unsubscribeAssignments?.();
			delete retained.unsubscribeAssignments;
			retained.unsubscribePresentation?.();
			delete retained.unsubscribePresentation;
			delete retained.presentationHandle;
			delete retained.record.handle;
			delete retained.backend;
		}
		this.runs.set(id, internal);
		if (request.name !== undefined && teammate) {
			this.teammateRuntime.reserve(request.name, id);
			this.teamService?.recordAssignment({
				name: request.name,
				type: record.type,
				runId: id,
				...(record.teammateColor !== undefined ? { color: record.teammateColor } : {}),
			});
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
		const resource = this.liveResource(internal);
		const handle = resource?.handle;
		if (observation.handle === handle) return;
		observation.unsubscribe?.();
		delete observation.unsubscribe;
		if (!resource?.backend.subscribeFocus || !handle) {
			delete observation.handle;
			return;
		}
		observation.handle = handle;
		observation.unsubscribe = resource.backend.subscribeFocus(handle, (state) => {
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
	private observePresentation(internal: RunInternals): void {
		const resource = this.liveResource(internal);
		const handle = resource?.handle;
		if (internal.presentationHandle === handle) return;
		internal.unsubscribePresentation?.();
		delete internal.unsubscribePresentation;
		if (!handle) {
			delete internal.presentationHandle;
			this.notifyPresentation(internal);
			return;
		}
		internal.presentationHandle = handle;
		const backend = resource?.backend;
		if (backend?.subscribePresentation) {
			internal.unsubscribePresentation = backend.subscribePresentation(handle, () => {
				this.syncRegistry();
				this.notifyPresentation(internal);
			});
		}
		this.notifyPresentation(internal);
	}

	private notifyPresentation(internal: RunInternals): void {
		for (const listener of this.presentationListeners) {
			try {
				listener(internal.record.id);
			} catch {
				/* View refresh failures must never interrupt child execution. */
			}
		}
	}
	private stopObservingPresentation(internal: RunInternals): void {
		internal.unsubscribePresentation?.();
		delete internal.unsubscribePresentation;
		delete internal.presentationHandle;
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
	 * after subscribe (the launch baseline) re-derives the output clock strictly
	 * from item timestamps, so historical content never buys a fresh idle window.
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
		await this.enforceStopDeadline(internal, BUDGET_ENFORCEMENT_GRACE_MS);
	}

	/**
	 * Bounded cooperative window, then verified force-termination of the owned
	 * child through the budget-enforcement backend path (identity-verified,
	 * SIGTERM→SIGKILL escalation, never a fabricated outcome). Shared by
	 * budget expiry (2s) and session teardown (15s, ADR 0007 §1).
	 */
	private async enforceStopDeadline(internal: RunInternals, graceMs: number): Promise<void> {
		const outcome = await Promise.race([
			internal.settle.then(() => "settled" as const),
			enforcementDelay(graceMs).then(() => "deadline" as const),
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
		if (
			source.recoveryError &&
			/verified disposal (?:could not|failed|was unavailable)|Child cleanup failed;|process receipt retained/.test(
				source.recoveryError,
			)
		) {
			throw new Error(`Agent "${agentId}" cleanup is unconfirmed; cold resume is blocked: ${source.recoveryError}`);
		}
		if (source.worktreeReleased) {
			throw new Error(`Agent "${agentId}"'s worktree was explicitly released and its checkout is no longer resumable.`);
		}
		if (source.teammateName !== undefined) {
			const currentMember = this.teamService?.current?.members.find((member) => member.name === source.teammateName);
			const hasArchivedIncarnation = this.teamService?.current?.archivedMembers?.some(
				(member) => member.name === source.teammateName,
			);
			if (
				this.teamService &&
				(!currentMember ||
					(source.membershipId !== undefined
						? currentMember.membershipId !== source.membershipId
						: currentMember.lastRunId !== source.id && hasArchivedIncarnation))
			)
				throw new Error(
					`Run "${agentId}" belongs to an older or unverified membership; create a new teammate identity to resume it.`,
				);
		}
		const teammateResource =
			source.teammateName !== undefined ? this.teammateRuntime.get(source.teammateName) : undefined;
		if (source.handle !== undefined || (teammateResource?.backend && teammateResource.handle)) {
			const recovery =
				(teammateResource?.recoveryError ?? source.recoveryError)
					? ` ${teammateResource?.recoveryError ?? source.recoveryError}`
					: "";
			const nextStep =
				source.teammateName !== undefined && !source.recoveryError
					? ` Named teammate @${source.teammateName} keeps its idle child: send_message to ${source.teammateName} or start a new Agent assignment with the same name/color. Cold resume requires releasing the child first.`
					: " Release the retained child before cold resume; check recovery details if cleanup failed.";
			throw new Error(`Agent "${agentId}" still has a retained child.${nextStep}${recovery}`);
		}
		if (source.sessionFile === undefined) {
			throw new Error(`Agent "${agentId}" has no persisted session to resume from.`);
		}
		if (options.color !== undefined) {
			const color = normalizeTeammateColor(options.color);
			if (color === undefined) throw new Error("Invalid teammate color; use #RGB or #RRGGBB.");
			if (source.teammateName === undefined) throw new Error("Teammate color requires a named teammate.");
			if (color !== source.teammateColor)
				throw new Error(
					`Teammate "@${source.teammateName}" already has color ${source.teammateColor ?? "the default"}; its identity color cannot change.`,
				);
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
			// A resumed run is the same teammate's next assignment.
			...(source.teammateName !== undefined ? { name: source.teammateName } : {}),
			...(source.teammateColor !== undefined ? { color: source.teammateColor } : {}),
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
		const resource = internal ? this.liveResource(internal) : undefined;
		return resource?.backend.hasViewer?.(resource.handle) ?? false;
	}
	async attachPane(agentId: string): Promise<boolean> {
		const internal = this.runs.get(agentId);
		const resource = internal ? this.liveResource(internal) : undefined;
		if (!resource?.backend.attach) return false;
		return resource.backend.attach(resource.handle);
	}

	private async releaseTeammateCore(name: string, finalState: "released" | "retired"): Promise<void> {
		const entry = this.teammateRuntime.get(name);
		const latest = this.latestTeammateRun(name);
		if (latest && isActiveStatus(latest.status)) throw new Error(`Cannot release busy teammate "@${name}".`);
		if (entry?.state === "busy") throw new Error(`Cannot release busy teammate "@${name}".`);
		const ownerRunId = entry?.currentRunId;
		const run = ownerRunId ? this.runs.get(ownerRunId) : latest ? this.runs.get(latest.id) : undefined;
		if ((entry?.handle || entry?.currentRunId) && !run) {
			const message = `Teammate "@${name}" child ownership is uncertain; no settled owner run is available.`;
			this.teammateRuntime.setRecoveryError(name, message);
			this.teamService?.setAvailability(name, "unavailable", message);
			throw new Error(message);
		}
		if (run) await this.releaseCore(run.record.id, {}, finalState === "retired" ? "retire" : "release");
		else {
			try {
				await this.teamService?.discardPending(name, finalState === "retired" ? "retire" : "release");
			} catch (error) {
				const message = `Pending mailbox cleanup failed; teammate context is unavailable: ${errorText(error)}`;
				this.teammateRuntime.setRecoveryError(name, message);
				this.teamService?.setAvailability(name, "unavailable", message);
				throw error;
			}
			this.teammateRuntime.clearRecoveryError(name);
			this.teamService?.setAvailability(name, "available");
		}
		if (entry) {
			this.teammateRuntime.clearChild(name, finalState);
			this.teammateRuntime.setState(name, finalState);
		}
		this.teamService?.setLifecycle(name, finalState);
	}

	/** Retry cleanup for a retained terminal child; worktrees remain unless explicitly removed. */
	async release(agentId: string, options: ReleaseOptions = {}): Promise<boolean> {
		const internal = this.runs.get(agentId);
		const name = internal?.record.teammateName;
		if (name !== undefined) return this.withTeammateLock(name, () => this.releaseCore(agentId, options));
		return this.releaseCore(agentId, options);
	}

	private async releaseCore(
		agentId: string,
		options: ReleaseOptions = {},
		discardReason: "release" | "retire" | "fresh" | "context-reset" | "shutdown" = "release",
		onVerifiedDispose?: () => void,
	): Promise<boolean> {
		const target = this.runs.get(agentId);
		if (!target) return false;
		if (isActiveStatus(target.record.status)) throw new Error(`Cannot release active run "${agentId}".`);
		const teammateName = target.record.teammateName;
		const runtime = teammateName !== undefined ? this.teammateRuntime.get(teammateName) : undefined;
		const currentMember =
			teammateName !== undefined
				? this.teamService?.current?.members.find((member) => member.name === teammateName)
				: undefined;
		if (
			teammateName !== undefined &&
			((runtime !== undefined && runtime.membershipId !== target.record.membershipId) ||
				(currentMember !== undefined && currentMember.membershipId !== target.record.membershipId))
		)
			throw new Error(
				`Cannot release stale run "${agentId}"; its membership does not match the current @${teammateName} incarnation.`,
			);
		const runtimeOwner = runtime?.currentRunId ? this.runs.get(runtime.currentRunId) : undefined;
		if (runtimeOwner && isActiveStatus(runtimeOwner.record.status))
			throw new Error(`Cannot release child for "${agentId}" while run "${runtimeOwner.record.id}" is active.`);
		const ownedBackend = runtime?.backend ?? target.backend;
		const ownedHandle = runtime?.handle ?? target.record.handle;
		const ownedRecord = runtimeOwner?.record ?? target.record;

		const targetSerialized =
			ownedBackend && ownedHandle
				? (ownedBackend as AgentExecutionBackend & PersistedExecutionBackend).serializeHandle?.(
						ownedHandle,
						ownedRecord.sessionFile,
					)
				: undefined;
		const sharedChild: RunInternals[] = [];
		for (const internal of this.runs.values()) {
			if (!internal.backend || !internal.record.handle) continue;
			const serialized = (internal.backend as AgentExecutionBackend & PersistedExecutionBackend).serializeHandle?.(
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

		const ownerInternal = runtimeOwner ?? target;
		if (ownedBackend && ownedHandle && !sharedChild.includes(ownerInternal)) sharedChild.push(ownerInternal);
		if (!sharedChild.includes(target)) sharedChild.push(target);
		const worktree = runtime?.worktreeInfo ?? target.worktreeInfo ?? target.record.worktree;
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
		if (ownedBackend && ownedHandle) {
			try {
				await ownedBackend.dispose(ownedHandle);
				onVerifiedDispose?.();
			} catch (error) {
				const message = `Child cleanup failed; process receipt retained: ${errorText(error)}`;
				if (teammateName !== undefined) {
					this.teammateRuntime.setRecoveryError(teammateName, message);
					this.teamService?.setAvailability(teammateName, "unavailable", message);
				}
				target.record.recoveryError = message;
				this.syncRegistry();
				throw error;
			}
			for (const internal of sharedChild) {
				this.detachBudgetWatch(internal);
				internal.unsubscribeBackend?.();
				delete internal.unsubscribeBackend;
				internal.unsubscribeAssignments?.();
				delete internal.unsubscribeAssignments;
				this.stopObservingPresentation(internal);
				delete internal.record.handle;
				delete internal.backend;
				this.notifyFocus(internal);
				this.notifyPresentation(internal);
			}
		}
		if (teammateName !== undefined) {
			const preservedState = runtime?.state === "retired" ? "retired" : "released";
			this.teammateRuntime.clearChild(teammateName, preservedState);
			try {
				await this.teamService?.discardPending(teammateName, discardReason);
			} catch (error) {
				const message = `Pending mailbox cleanup failed; teammate context is unavailable: ${errorText(error)}`;
				this.teammateRuntime.setRecoveryError(teammateName, message);
				this.teamService?.setAvailability(teammateName, "unavailable", message);
				target.record.recoveryError = message;
				this.syncRegistry();
				throw error;
			}
			this.teamService?.setAvailability(teammateName, "available");
			for (const internal of sharedChild) {
				if (
					internal.record.recoveryError?.startsWith("Child cleanup failed;") ||
					internal.record.recoveryError?.startsWith("Session shutdown could not confirm") ||
					internal.record.recoveryError?.startsWith("Session ended before") ||
					internal.record.recoveryError?.startsWith("Pending mailbox cleanup failed;")
				)
					delete internal.record.recoveryError;
			}
		}
		this.preservedRegistryEntries = this.preservedRegistryEntries.filter(
			(entry) => isIncompatibleRegistryEntry(entry) || !sharedChild.some((internal) => internal.record.id === entry.id),
		);
		this.syncRegistry();
		await this.persistReleasedHistory(sharedChild);

		if (target.record.teammateName !== undefined && (releasable !== undefined || runtime !== undefined)) {
			const preservedState = runtime?.state === "retired" ? "retired" : "released";
			this.teammateRuntime.setState(target.record.teammateName, preservedState);
			this.teamService?.setLifecycle(target.record.teammateName, preservedState);
			this.teamService?.setAvailability(target.record.teammateName, "available");
		}
		if (options.cleanupWorktree === true && worktree && this.worktreeService) {
			await this.worktreeService.releaseForRun(worktree);
			if (teammateName !== undefined) this.teammateRuntime.clearWorktree(teammateName);
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
		await Promise.all([...this.teammateLocks.values()]);
		for (const backend of this.backends) backend.setPresentationActive?.(false);
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
				for (const backend of this.backends) backend.setPresentationActive?.(true);
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
			internal.unsubscribeAssignments?.();
			delete internal.unsubscribeAssignments;
			if (internal.record.teammateName === undefined && internal.backend && internal.record.handle) {
				await internal.backend.dispose(internal.record.handle);
				delete internal.record.handle;
				delete internal.backend;
			}
			this.stopObservingPresentation(internal);
		}
		for (const runtime of this.teammateRuntime.values()) {
			if (!runtime.backend || !runtime.handle) continue;
			try {
				await runtime.backend.dispose(runtime.handle);
			} catch (error) {
				const message = `Child cleanup failed during manager disposal; process receipt retained: ${errorText(error)}`;
				this.teammateRuntime.setRecoveryError(runtime.name, message);
				this.teamService?.setAvailability(runtime.name, "unavailable", message);
				if (runtime.handle && runtime.backend) runtime.backend.detach(runtime.handle);
				const owner = runtime.currentRunId ? this.runs.get(runtime.currentRunId) : undefined;
				if (owner) owner.record.recoveryError = message;
				continue;
			}
			const finalState = runtime.state === "retired" ? "retired" : "released";
			this.teammateRuntime.clearChild(runtime.name, finalState);
			try {
				await this.teamService?.discardPending(runtime.name, "context-reset");
			} catch (error) {
				const message = `Pending mailbox cleanup failed during manager disposal: ${errorText(error)}`;
				this.teammateRuntime.setRecoveryError(runtime.name, message);
				this.teamService?.setAvailability(runtime.name, "unavailable", message);
				continue;
			}
			this.teamService?.setAvailability(runtime.name, "available");
			if (finalState !== "retired") this.teamService?.setLifecycle(runtime.name, "released");
		}
		this.budgetWatcher.clear();
		this.syncRegistry();
		this.clearFocusObservations();
		this.presentationListeners.clear();
		this.runs.clear();
		this.runningSlots = 0;
	}

	// -- durable registry ------------------------------------------------------

	/** Attempt identity-verified disposal of a stale receipt without adopting it. */
	async attemptStaleDisposal(entry: AgentRegistryEntry): Promise<boolean> {
		if (this.disposed || !entry.handle) return false;
		const backend = this.backends.find((candidate) => candidate.kind === "process") as
			| (AgentExecutionBackend & PersistedExecutionBackend)
			| undefined;
		if (!backend?.disposePersisted) return false;
		try {
			return await backend.disposePersisted(entry.handle);
		} catch {
			return false;
		}
	}

	/** Preserve hidden and incompatible rows while the remember setting is off. */
	setPreservedRegistryEntries(entries: readonly PersistedRegistryEntry[]): void {
		this.preservedRegistryEntries = [...entries];
	}

	/** Registry rows owned by other sessions: never adopted, always preserved on rewrite. */
	setForeignRegistryEntries(entries: readonly PersistedRegistryEntry[]): void {
		this.foreignRegistryEntries = [...entries];
	}

	/**
	 * Session teardown (ADR 0007 §1, roadmap T1): teammates die with the
	 * owning session. Every active run gets the abort request first, a
	 * bounded cooperative grace to settle and preserve its partial result
	 * artifact (1.1b), then verified force-termination through the
	 * budget-enforcement path. Worktrees, history and result files survive.
	 */
	async shutdownSession(): Promise<void> {
		if (this.disposed || this.sessionShutdownComplete) return;
		if (this.sessionShutdownOperation) return this.sessionShutdownOperation;
		const operation = this.shutdownSessionCore();
		this.sessionShutdownOperation = operation;
		try {
			await operation;
			this.sessionShutdownComplete = true;
		} finally {
			if (this.sessionShutdownOperation === operation) this.sessionShutdownOperation = undefined;
		}
	}

	private async shutdownSessionCore(): Promise<void> {
		if (this.disposed) return;
		this.shuttingDown = true;
		this.admissionEpoch += 1;
		await Promise.all([...this.teammateLocks.values()]);
		for (const backend of this.backends) backend.setPresentationActive?.(false);
		const active = [...this.runs.values()].filter((internal) => isActiveStatus(internal.record.status));
		// Start every cooperative stop without waiting for its RPC acknowledgement;
		// each independent enforcement deadline runs concurrently below.
		for (const internal of active) void this.stop(internal.record.id).catch(() => false);
		await Promise.allSettled(
			active.map(async (internal) => {
				await internal.launchPromise;
				await this.enforceStopDeadline(internal, this.teardownGraceMs);
			}),
		);
		// Let settlement finalization (worktree preserve, registry/history
		// writes) finish before detaching what is left.
		await Promise.allSettled(
			[...this.runs.values()].map((internal) => internal.finalizePromise).filter((promise) => promise !== undefined),
		);
		const unsettled = [...this.runs.values()].filter((internal) => isActiveStatus(internal.record.status));
		if (unsettled.length > 0) {
			for (const internal of unsettled) {
				const message = "Session shutdown could not confirm child settlement; process receipt retained.";
				internal.record.recoveryError = message;
				if (internal.record.teammateName) {
					this.teammateRuntime.setRecoveryError(internal.record.teammateName, message);
					this.teamService?.setAvailability(internal.record.teammateName, "unavailable", message);
				}
			}
			this.syncRegistry();
			throw new Error(
				`Session shutdown incomplete: ${unsettled.map((internal) => internal.record.id).join(", ")}. Retry cleanup before switching sessions.`,
			);
		}
		const retainedRunIds = new Set<string>();
		let pendingCleanupFailed = false;
		const idleCleanup: Array<() => Promise<void>> = [];
		for (const runtime of this.teammateRuntime.values()) {
			if (!runtime.backend || !runtime.handle) {
				try {
					await this.teamService?.discardPending(runtime.name, "context-reset");
				} catch (error) {
					const message = `Pending mailbox cleanup failed during session shutdown: ${errorText(error)}`;
					this.teammateRuntime.setRecoveryError(runtime.name, message);
					this.teamService?.setAvailability(runtime.name, "unavailable", message);
					pendingCleanupFailed = true;
				}
				continue;
			}
			const ownerId = runtime.currentRunId;
			const owner = ownerId ? this.runs.get(ownerId) : undefined;
			if (!owner || isActiveStatus(owner.record.status)) {
				const message = "Session ended before the teammate child outcome was settled; process receipt retained.";
				this.teammateRuntime.setRecoveryError(runtime.name, message);
				this.teamService?.setAvailability(runtime.name, "unavailable", message);
				if (owner) {
					owner.record.recoveryError = message;
					retainedRunIds.add(owner.record.id);
				}
				continue;
			}
			idleCleanup.push(async () => {
				try {
					await this.withTeammateLock(runtime.name, () => this.releaseCore(owner.record.id, {}, "context-reset"));
				} catch (error) {
					const message = errorText(error);
					this.teammateRuntime.setRecoveryError(runtime.name, message);
					this.teamService?.setAvailability(runtime.name, "unavailable", message);
					retainedRunIds.add(owner.record.id);
				}
			});
		}
		for (let i = 0; i < idleCleanup.length; i += 4)
			await Promise.all(idleCleanup.slice(i, i + 4).map((cleanup) => cleanup()));
		for (const internal of this.runs.values()) {
			if (internal.record.teammateName === undefined && this.liveResource(internal)) {
				await this.disposeTerminalChild(internal);
				if (this.liveResource(internal)) retainedRunIds.add(internal.record.id);
			}
		}
		if (retainedRunIds.size > 0 || pendingCleanupFailed) {
			this.syncRegistry();
			throw new Error(
				`Session shutdown incomplete: child cleanup is unconfirmed for ${[...retainedRunIds].join(", ")}. Retry cleanup before switching sessions.`,
			);
		}
		for (const internal of this.runs.values()) {
			this.detachBudgetWatch(internal);
			internal.unsubscribeBackend?.();
			delete internal.unsubscribeBackend;
			internal.unsubscribeAssignments?.();
			delete internal.unsubscribeAssignments;
			if (internal.backend && internal.record.handle) internal.backend.detach(internal.record.handle);
			this.focusObservations.get(internal.record.id)?.unsubscribe?.();
			this.stopObservingPresentation(internal);
		}
		this.budgetWatcher.clear();
		this.syncRegistry();
		this.clearFocusObservations();
		for (const id of [...this.runs.keys()]) if (!retainedRunIds.has(id)) this.runs.delete(id);
		this.presentationListeners.clear();
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
		this.registry.releaseSnapshot(record.id);
		if (internal.slotAcquired) {
			internal.slotAcquired = false;
			this.runningSlots = Math.max(0, this.runningSlots - 1);
		}
		internal.finalizePromise = this.finalizeTerminalRun(internal);
		const finish = (): void => {
			if (record.teammateName !== undefined) {
				const runtime = this.teammateRuntime.get(record.teammateName);
				const sameMembership =
					runtime !== undefined && (record.membershipId === undefined || runtime.membershipId === record.membershipId);
				if (sameMembership) {
					const nextState: TeammateLifecycle = runtime.handle ? "idle" : "released";
					this.teammateRuntime.setState(record.teammateName, nextState);
					this.teamService?.setLifecycle(record.teammateName, nextState, record.membershipId);
					if (record.recoveryError?.startsWith("Teammate connection unavailable:")) delete record.recoveryError;
					if (runtime.handle && runtime.recoveryError === undefined)
						this.teamService?.setAvailability(record.teammateName, "available", undefined, record.membershipId);
				}
			}
			this.emit(record, lifecycleName(next));
			internal.resolveSettle(record);
			this.drainQueue();
		};
		void internal.finalizePromise.then(finish, (error: unknown) => {
			const message = errorText(error);
			record.recoveryError = message;
			if (record.teammateName !== undefined) {
				const runtime = this.teammateRuntime.get(record.teammateName);
				if (runtime && (record.membershipId === undefined || runtime.membershipId === record.membershipId)) {
					this.teammateRuntime.setRecoveryError(record.teammateName, message);
					this.teamService?.setAvailability(record.teammateName, "unavailable", message, record.membershipId);
				}
			}
			finish();
		});
	}

	private async startRun(internal: RunInternals): Promise<void> {
		await Promise.resolve();
		if (internal.record.status !== "queued") return;
		this.queue = this.queue.filter((id) => id !== internal.record.id);
		this.applyEvent(internal, { type: "start" });
		this.emit(internal.record, "started");
		// A borrowed mailbox handle is committed only after native admission succeeds.
		let handleCommitted = false;

		try {
			const backend = internal.backend;
			if (!backend) throw new Error("Admitted process execution backend is unavailable.");

			let handle: AgentBackendHandle;
			if (internal.plan.kind === "mailbox") {
				if (!internal.record.handle || !backend.admitAssignment)
					throw new Error("Mailbox assignment admission is unavailable");
				handle = internal.record.handle;
				this.beginBudgetClocks(internal);
				await backend.admitAssignment(handle);
				handleCommitted = true;
			} else if (internal.plan.kind === "assignment") {
				if (!backend.assign) throw new Error("Teammate assignment is unavailable");
				const snapshot = this.registry.getActiveSnapshot(internal.record.id);
				if (!snapshot) throw new Error("Assignment snapshot is unavailable");
				if (internal.record.model && backend.controlFocus)
					await backend.controlFocus(internal.plan.handle, { type: "model", model: internal.record.model });
				if (snapshot.resolved.thinking !== undefined && backend.controlFocus)
					await backend.controlFocus(internal.plan.handle, { type: "thinking", thinking: snapshot.resolved.thinking });
				this.beginBudgetClocks(internal);
				handle = await backend.assign(internal.plan.handle, {
					runId: internal.record.id,
					prompt: internal.plan.prompt,
					...(snapshot.resolved.maxTurnLimit !== undefined ? { maxTurns: snapshot.resolved.maxTurnLimit } : {}),
					graceTurns: this.settings.graceTurns,
				});
			} else if (internal.plan.kind === "resume") {
				// Clocks start here — after admission/queue prep, immediately before
				// the resume call itself.
				this.beginBudgetClocks(internal);
				const team = this.currentTeamContext(internal.record);
				handle = await backend.resume({ ...internal.plan.input, runId: internal.record.id, ...(team ? { team } : {}) });
			} else {
				const snapshot = this.registry.getActiveSnapshot(internal.record.id);
				if (!snapshot) throw new Error(`invocation snapshot lost for run "${internal.record.id}"`);
				if (
					this.worktreeService &&
					snapshot.resolved.isolationPolicy === "worktree" &&
					this.settings.worktreeIsolation &&
					internal.worktreeInfo === undefined
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
			handleCommitted = true;
			if (internal.record.teammateName !== undefined) {
				this.teammateRuntime.setChild(internal.record.teammateName, {
					currentRunId: internal.record.id,
					backend,
					handle,
					cwd: internal.cwd,
					...(internal.worktreeInfo !== undefined ? { worktreeInfo: internal.worktreeInfo } : {}),
					...(internal.record.sessionFile !== undefined ? { sessionFile: internal.record.sessionFile } : {}),
				});
			}
			this.connectBudgetOutput(internal);
			if (internal.pendingBudgetStop !== undefined) {
				// The deadline expired while the launch was still in flight; enforce
				// it as soon as a stoppable handle exists.
				delete internal.pendingBudgetStop;
				this.beginEnforcedStop(internal);
				this.syncRegistry();
			}
			this.notifyFocus(internal);
			this.observePresentation(internal);
			internal.unsubscribeBackend = backend.subscribe(handle, (status) => {
				void this.reconcileBackendStatus(internal, status).catch((error: unknown) => {
					const message = errorText(error);
					internal.record.recoveryError = message;
					if (internal.record.teammateName !== undefined) {
						this.teammateRuntime.setRecoveryError(internal.record.teammateName, message);
						this.teamService?.setAvailability(internal.record.teammateName, "unavailable", message);
					}
					this.syncRegistry();
				});
			});
			this.observeAssignments(internal);

			this.syncRegistry();
			await this.reconcileBackendStatus(internal, await backend.status(handle));

			await this.flushPendingControls(internal);
			if (this.shuttingDown) this.syncRegistry();
		} catch (error) {
			if (internal.plan.kind === "mailbox" && internal.record.handle !== undefined && internal.backend) {
				const backend = internal.backend;
				const handle = internal.record.handle;
				internal.unsubscribeBackend = backend.subscribe(handle, (status) => {
					void this.reconcileBackendStatus(internal, status).catch((reconcileError: unknown) => {
						const message = errorText(reconcileError);
						internal.record.recoveryError = message;
						this.teammateRuntime.setRecoveryError(internal.record.teammateName as string, message);
						this.teamService?.setAvailability(internal.record.teammateName as string, "unavailable", message);
						this.syncRegistry();
					});
				});
				this.observeAssignments(internal);
				const code = (error as { code?: unknown } | null)?.code;
				const uncertain =
					!(error instanceof Error && error.name === "ChildProtocolError") ||
					["disconnected", "connection_failed", "request_timeout", "connect_timeout"].includes(String(code));
				if (!uncertain) {
					this.applyEvent(internal, { type: "fail", error: errorText(error) });
					return;
				}
				handleCommitted = true;
				try {
					await this.reconcileBackendStatus(internal, await backend.status(handle));
				} catch {
					// Admission outcome is unknown while disconnected: preserve the active run/slot.
				}
			}
			if (handleCommitted && internal.record.handle !== undefined) {
				// A post-launch RPC failure is connection uncertainty, not job failure.
				const message = errorText(error);
				internal.record.recoveryError = message;
				if (internal.record.teammateName !== undefined) {
					this.teammateRuntime.setRecoveryError(internal.record.teammateName, message);
					this.teamService?.setAvailability(internal.record.teammateName, "unavailable", message);
				}
				this.syncRegistry();
				return;
			}
			if (internal.plan.kind === "assignment") {
				const source = this.runs.get(internal.plan.sourceAgentId);
				if (source && internal.backend) {
					source.record.handle = internal.plan.handle;
					source.backend = internal.backend;
					delete internal.record.handle;
					delete internal.worktreeInfo;
					delete internal.record.worktree;
					this.observeAssignments(source);
				}
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
		if (record.model !== undefined) input.model = record.model;
		if (record.modelFallback !== undefined) input.modelFallback = record.modelFallback;
		if (internal.plan.strict === true) input.strict = true;
		if (resolved.thinking !== undefined) input.thinking = resolved.thinking;
		if (resolved.tools !== undefined) input.tools = [...resolved.tools];
		if (resolved.maxTurnLimit !== undefined) input.maxTurns = resolved.maxTurnLimit;
		const team = this.currentTeamContext(record);
		if (team) input.team = team;
		return input;
	}

	private currentTeamContext(record: AgentRun): TeamBootstrapContext | undefined {
		const service = this.teamService;
		const team = service?.current;
		if (!service || !team || record.teammateName === undefined) return undefined;
		const member = team.members.find((candidate) => candidate.name === record.teammateName);
		if (!member || (record.membershipId !== undefined && member.membershipId !== record.membershipId)) return undefined;
		return {
			teamDir: service.teamDir,
			teamKey: team.teamKey,
			teammateName: record.teammateName,
			membershipId: member.membershipId,
			...(record.teammateColor !== undefined ? { teammateColor: record.teammateColor } : {}),
		};
	}

	private observeAssignments(internal: RunInternals): void {
		if (internal.unsubscribeAssignments || !internal.record.teammateName) return;
		const resource = this.liveResource(internal);
		const backend = resource?.backend;
		const handle = resource?.handle;
		if (!backend?.subscribeAssignments || !handle) return;
		internal.unsubscribeAssignments = backend.subscribeAssignments(handle, ({ runId }) => {
			if (isTerminalStatus(internal.record.status)) this.adoptMailboxAssignment(internal, runId);
			else void internal.settle.then(() => this.adoptMailboxAssignment(internal, runId));
		});
	}

	private adoptMailboxAssignment(source: RunInternals, runId: string): void {
		const name = source.record.teammateName;
		if (name === undefined) return;
		void this.withTeammateLock(name, async () => this.adoptMailboxAssignmentCore(source, runId)).catch(
			(error: unknown) => {
				const message = `Mailbox assignment admission failed: ${errorText(error)}`;
				this.teammateRuntime.setRecoveryError(name, message);
				this.teamService?.setAvailability(name, "unavailable", message);
				this.syncRegistry();
			},
		);
	}

	private adoptMailboxAssignmentCore(source: RunInternals, runId: string): void {
		const name = source.record.teammateName;
		if (name === undefined) return;
		const runtime = this.teammateRuntime.get(name);
		if (runtime?.state === "busy" && runtime.currentRunId) {
			const active = this.runs.get(runtime.currentRunId);
			if (active && isActiveStatus(active.record.status) && this.isMailboxDescendant(active, source.record.id)) {
				const key = `${name}\0${runId}`;
				if (!this.pendingMailboxAssignments.has(key)) {
					this.pendingMailboxAssignments.add(key);
					void active.settle.then(() => {
						this.pendingMailboxAssignments.delete(key);
						// Re-enter admission even if another same-child assignment won the next slot.
						// Ownership checks below reject replaced/released contexts; busy descendants defer again.
						this.adoptMailboxAssignment(source, runId);
					});
				}
				return;
			}
		}
		const owner = runtime?.currentRunId ? this.runs.get(runtime.currentRunId) : undefined;
		const runtimeResource =
			this.liveResource(source) ??
			(owner && this.isMailboxDescendant(owner, source.record.id) && runtime?.backend && runtime.handle
				? { backend: runtime.backend, handle: runtime.handle }
				: undefined);
		if (
			this.shuttingDown ||
			this.disposed ||
			this.shuttingDownTeammates.has(name) ||
			(source.record.membershipId !== undefined && runtime?.membershipId !== source.record.membershipId) ||
			runtime?.state !== "idle" ||
			!runtimeResource ||
			!isTerminalStatus(source.record.status) ||
			this.runs.has(runId)
		)
			return;
		const handle: AgentBackendHandle = { kind: "process", handle: runId };
		const teammateName = name;
		const backend = runtimeResource.backend;
		source.unsubscribeAssignments?.();
		delete source.unsubscribeAssignments;
		source.unsubscribePresentation?.();
		delete source.unsubscribePresentation;
		delete source.presentationHandle;
		delete source.record.handle;
		delete source.backend;
		const previous = source.record;
		const now = this.now();
		const record: AgentRun = {
			id: runId,
			type: previous.type,
			description: previous.description,
			status: "queued",
			teammateName,
			...(previous.membershipId !== undefined ? { membershipId: previous.membershipId } : {}),
			...(previous.teammateColor !== undefined ? { teammateColor: previous.teammateColor } : {}),
			backend: "process",
			handle,
			...(previous.model !== undefined ? { model: previous.model } : {}),
			...(previous.modelFallback !== undefined ? { modelFallback: previous.modelFallback } : {}),
			...(previous.sessionFile !== undefined ? { sessionFile: previous.sessionFile } : {}),
			...(previous.worktree !== undefined ? { worktree: { ...previous.worktree } } : {}),
			...(previous.worktreeResult !== undefined
				? { worktreeResult: { ...previous.worktreeResult, commits: [...previous.worktreeResult.commits] } }
				: {}),
			...(previous.worktreeReleased !== undefined ? { worktreeReleased: previous.worktreeReleased } : {}),
			startedAt: now,
			toolUses: 0,
			turns: 0,
			usage: { ...EMPTY_USAGE },
			owner: { ...previous.owner },
			delivery: previous.delivery,
			isBackground: true,
			...(previous.parentSession !== undefined ? { parentSession: { ...previous.parentSession } } : {}),
			...(previous.budgetTimeout !== undefined ? { budgetTimeout: previous.budgetTimeout } : {}),
			...(previous.budgetIdleTimeout !== undefined ? { budgetIdleTimeout: previous.budgetIdleTimeout } : {}),
		};
		const { promise: settle, resolve: resolveSettle } = Promise.withResolvers<AgentRun>();
		const internal: RunInternals = {
			record,
			backend,
			cwd: source.cwd,
			settle,
			resolveSettle,
			plan: { kind: "mailbox" },
			pendingSteers: [],
			stopRequested: false,
			stopAcknowledged: false,
			slotAcquired: false,
			...(source.worktreeInfo !== undefined ? { worktreeInfo: { ...source.worktreeInfo } } : {}),
		};
		this.runs.set(runId, internal);
		this.teammateRuntime.setChild(teammateName, {
			currentRunId: runId,
			backend,
			handle,
			cwd: source.cwd,
			...(source.worktreeInfo !== undefined ? { worktreeInfo: { ...source.worktreeInfo } } : {}),
			...(previous.sessionFile !== undefined ? { sessionFile: previous.sessionFile } : {}),
		});
		this.teammateRuntime.setState(teammateName, "busy");
		this.teamService?.setLifecycle(teammateName, "busy");
		this.queue.push(runId);
		this.syncRegistry();
		this.drainQueue();
	}

	private isMailboxDescendant(candidate: RunInternals, sourceId: string): boolean {
		let current: RunInternals | undefined = candidate;
		while (current) {
			if (current.record.id === sourceId) return true;
			if (current.plan.kind !== "assignment") return false;
			current = this.runs.get(current.plan.sourceAgentId);
		}
		return false;
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
				if (status.sessionFile !== undefined) {
					record.sessionFile = status.sessionFile;
					if (record.teammateName !== undefined)
						this.teammateRuntime.updateSessionFile(record.teammateName, record.id, status.sessionFile);
				}
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
			if (record.teammateName !== undefined)
				this.teammateRuntime.updateSessionFile(record.teammateName, record.id, status.sessionFile);
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

		if (status.state === "disconnected") {
			if (record.teammateName !== undefined) {
				const detail = status.detail ?? "child control connection is unavailable";
				const message = `Teammate connection unavailable: ${detail}; native outcome and context are uncertain.`;
				record.recoveryError = message;
				this.teammateRuntime.setRecoveryError(record.teammateName, message);
				this.teamService?.setAvailability(record.teammateName, "unavailable", message);
				this.syncRegistry();
			}
			return;
		}
		if (status.state === "starting") return;
		if (status.state === "running") {
			if (record.teammateName !== undefined) {
				this.teammateRuntime.clearRecoveryError(record.teammateName);
				if (record.recoveryError?.startsWith("Teammate connection unavailable:")) delete record.recoveryError;
				this.teamService?.setAvailability(record.teammateName, "available");
				this.syncRegistry();
			}
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
		// The runtime owns a named teammate's settled child/context. The run keeps
		// only outcome artifacts; registry rows project the runtime's receipt.
		this.syncRegistry();
		const name = internal.record.teammateName;
		const runtime = name !== undefined ? this.teammateRuntime.get(name) : undefined;
		if (name !== undefined && runtime?.currentRunId === internal.record.id && runtime.handle && runtime.backend) {
			delete internal.record.handle;
			delete internal.backend;
			this.syncRegistry();
			return;
		}
		await this.disposeTerminalChild(internal);
	}

	private async disposeTerminalChild(internal: RunInternals): Promise<void> {
		const name = internal.record.teammateName;
		const runtime = name !== undefined ? this.teammateRuntime.get(name) : undefined;
		if (name !== undefined && runtime?.currentRunId === internal.record.id && runtime.handle) {
			try {
				await this.withTeammateLock(name, () => this.releaseCore(internal.record.id));
			} catch (error) {
				internal.record.recoveryError = `Child cleanup failed; process receipt retained: ${errorText(error)}`;
			}
			return;
		}
		const backend = internal.backend;
		const handle = internal.record.handle;
		if (!backend || !handle) return;
		const restorable = backend as unknown as PersistedExecutionBackend;
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
		const restorable = backend as unknown as PersistedExecutionBackend;
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
			delete internal.record.handle;
			delete internal.backend;
			this.stopObservingPresentation(internal);
			this.notifyFocus(internal);
			this.notifyPresentation(internal);
			if (
				internal.record.recoveryError?.startsWith("Child cleanup failed;") ||
				internal.record.recoveryError?.startsWith("Session shutdown could not confirm") ||
				internal.record.recoveryError?.startsWith("Session ended before")
			) {
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
		for (const runtime of this.teammateRuntime.values()) {
			if (!runtime.backend || !runtime.handle || !runtime.currentRunId || persistedIds.has(runtime.currentRunId))
				continue;
			const owner = this.runs.get(runtime.currentRunId);
			if (!owner) continue;
			const projected: AgentRun = {
				...owner.record,
				handle: runtime.handle,
				...(runtime.recoveryError !== undefined ? { recoveryError: runtime.recoveryError } : {}),
			};
			const backend = runtime.backend as AgentExecutionBackend & PersistedExecutionBackend;
			const projector: HandleProjector = (handle, sessionFile) => backend.serializeHandle?.(handle, sessionFile);
			const entry = toRegistryEntry(projected, runtime.cwd ?? owner.cwd, this.configCwd, projector);
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
			if (persistedIds.has(preserved.id)) continue;
			// Terminal outcomes may be omitted from the active registry when history is enabled,
			// but serialized handles are unresolved cleanup receipts and must survive sync.
			if (preserved.handle !== undefined || (!this.settings.rememberAgents && isTerminalStatus(preserved.status))) {
				entries.push(preserved);
			}
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
		const restorable = backend as unknown as PersistedExecutionBackend;
		return (handle, sessionFile) => restorable.serializeHandle?.(handle, sessionFile);
	}
	private formatRecord(internal: RunInternals, fullResult?: { text?: string; note?: string }): string {
		const record = internal.record;
		const duration = record.completedAt !== undefined ? Math.max(0, record.completedAt - record.startedAt) : undefined;
		const head =
			`Agent: ${record.id}\n` +
			(record.teammateName !== undefined ? `Teammate: @${record.teammateName}\n` : "") +
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
 * source run (cold resume; 0 = unlimited) > current definition tier >
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
		...(entry.teammateName !== undefined ? { teammateName: entry.teammateName } : {}),
		...(entry.membershipId !== undefined ? { membershipId: entry.membershipId } : {}),
		...(entry.teammateColor !== undefined ? { teammateColor: entry.teammateColor } : {}),
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
