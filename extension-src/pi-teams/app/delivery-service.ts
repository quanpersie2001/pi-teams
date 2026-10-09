// DeliveryService — owner-aware completion delivery + delivery guard
// (docs/ARCHITECTURE.md and docs/INTEGRATION.md).
//
// Pure app-layer orchestration: the concrete conversation-notification
// transport and the live session snapshot come from an injected DeliveryHost
// adapter built by pi/delivery-host.ts (ARCH-004/005). The service subscribes
// to AgentManager lifecycle events and, for terminal settlements, decides:
//
//   1. policy routing — does run.delivery allow a conversation notification?
//   2. owner rules    — extension-owned runs NEVER get conversation
//                       notifications (pi-tasks renders its own; prevents the
//                       duplicate task+agent message), even if the policy says
//                       "conversation". Owner rules win over policy.
//   3. delivery guard — is the conversation that would receive the
//                       notification still the one that spawned the run?
//
// Guard refusals never touch run state: the result stays in the run record,
// history and session file, recoverable via get_subagent_result / status.
// The guard is evaluated at DELIVERY time against the live session — not at
// spawn time — so a session switch (/new, /resume) invalidates pending
// deliveries automatically.

import type { AgentRunStatus } from "../domain/agent-run.js";
import type { AgentOwner } from "../domain/delivery.js";
import type { AgentLifecycleEvent, AgentLifecycleEventName } from "../domain/integration-protocol.js";
import { isStaleExtensionCtxError } from "../shared/stale-context.js";
import { type AgentManager, budgetStopNote } from "./agent-manager.js";
import { CompletionQueue, type CompletionQueueOptions } from "./completion-queue.js";

// -- session snapshot ----------------------------------------------------------

/**
 * Live conversation state as observed by the host at delivery time. Missing
 * fields mean "the host cannot expose this" — the guard degrades permissively
 * for a wholly absent snapshot/session id (headless harnesses) and refuses
 * only on positive evidence of a switch or branch move.
 */
export interface SessionSnapshot {
	/** Current session id; undefined/empty when unavailable (headless). */
	sessionId?: string;
	/** Current leaf entry id, when the host exposes tree position. */
	leafId?: string | null;
	/** Entry ids along the active branch path (root → leaf), when exposed. */
	branchIds?: readonly string[];
}

/** Outcome of a terminal lifecycle settlement worth notifying about. */
export type DeliveryOutcome = "completed" | "failed" | "stopped";

export interface CompletionNotification {
	agentId: string;
	/** Teammate address the run was spawned under; the header uses @name when present. */
	teammateName?: string;
	teammateColor?: string;
	agentType: string;
	description: string;
	status: AgentRunStatus;
	outcome: DeliveryOutcome;
	/** Truncated result preview ("completed") or error text ("failed"). */
	preview: string;
	/** Absolute path of the full-result artifact; absent when the child wrote none. */
	resultFile?: string;
	/** Wall-clock run duration; absent while unknown. */
	durationMs?: number;
	/** totalTokens at settlement (cacheRead excluded), when usage was observed. */
	totalTokens?: number;
	/** Additional completions from the same Agent launch batch. */
	others?: CompletionNotification[];
}

/**
 * Host port implemented by pi/delivery-host.ts. `sendNotification` injects a
 * custom message into the current conversation; stale-context failures must
 * propagate so the service can record suppression without breaking settlement.
 */
export interface DeliveryHost {
	sendNotification(notification: CompletionNotification): void;
	/** Live conversation state; undefined = headless/no session manager. */
	currentSession(): SessionSnapshot | undefined;
}

// -- delivery guard ------------------------------------------------------------

export interface DeliveryGuardInput {
	/** Session recorded at spawn (run.parentSession / conversation owner). */
	parentSessionId?: string;
	/** Leaf recorded at spawn (/tree position when the run started). */
	parentLeafId?: string;
	/** Live session state at delivery time; undefined = headless. */
	session?: SessionSnapshot;
}

export type DeliveryGuardReason =
	| "same-session"
	| "branch-descendant"
	| "permissive-headless"
	| "session-switched"
	| "branch-moved"
	| "leaf-unverifiable";

export interface DeliveryGuardResult {
	allowed: boolean;
	reason: DeliveryGuardReason;
}

const PERMISSIVE: DeliveryGuardResult = { allowed: true, reason: "permissive-headless" };

/**
 * Pure delivery-guard decision table (docs/INTEGRATION.md):
 *
 *   parent session unknown/absent            → permissive-headless (allow)
 *   no live session snapshot or session id   → permissive-headless (allow)
 *   live session ≠ parent session            → refuse (session-switched)
 *   same session, branch info available      → allow iff parent leaf is still
 *                                              on the active branch path
 *                                              (/tree moves to a sibling
 *                                              branch refuse; natural
 *                                              progression stays allowed)
 *   same session, no branch info             → compare leaves directly: equal
 *                                              allows; different refuses
 *                                              (branch-moved); unknown current
 *                                              leaf refuses (leaf-unverifiable)
 */
export function evaluateDeliveryGuard(input: DeliveryGuardInput): DeliveryGuardResult {
	const parentSessionId = input.parentSessionId;
	if (!parentSessionId || parentSessionId === "unknown-session") return PERMISSIVE;

	const session = input.session;
	if (!session) return PERMISSIVE;
	const currentSessionId = session.sessionId;
	if (!currentSessionId) return PERMISSIVE;

	if (currentSessionId !== parentSessionId) {
		return { allowed: false, reason: "session-switched" };
	}

	const parentLeafId = input.parentLeafId;
	if (!parentLeafId) return { allowed: true, reason: "same-session" };

	const branchIds = session.branchIds;
	if (branchIds !== undefined && branchIds.length > 0) {
		return branchIds.includes(parentLeafId)
			? { allowed: true, reason: "branch-descendant" }
			: { allowed: false, reason: "branch-moved" };
	}

	const currentLeafId = session.leafId;
	if (currentLeafId === undefined || currentLeafId === null || currentLeafId.length === 0) {
		// Parent tracked a leaf but nothing can verify ancestry: prefer
		// refuse-over-deliver; the result remains recoverable either way.
		return { allowed: false, reason: "leaf-unverifiable" };
	}
	return currentLeafId === parentLeafId
		? { allowed: true, reason: "same-session" }
		: { allowed: false, reason: "branch-moved" };
}

// -- policy routing ------------------------------------------------------------

/**
 * Whether a conversation notification may be sent for a settled run.
 *
 * Routing rules (docs/INTEGRATION.md, ownership overrides delivery policy):
 *   - policy "none"                        → never (caller polls status);
 *   - extension owner                      → NEVER, regardless of policy
 *     (owner rules win: events already carry the result; pi-tasks owns any
 *     user-facing notification — duplicate prevention);
 *   - policy "event"                       → events only;
 *   - policy "conversation" | "both"       → only if the guard allows.
 */
export function shouldDeliverToConversation(
	owner: AgentOwner,
	policy: AgentLifecycleEvent["delivery"],
	guard: DeliveryGuardResult,
): boolean {
	if (policy === "none") return false;
	if (owner.kind === "extension") return false;
	if (policy === "event") return false;
	return guard.allowed;
}

/** Terminal lifecycle event names that trigger a delivery decision. */
const NOTIFIABLE_EVENTS: readonly AgentLifecycleEventName[] = ["completed", "failed", "stopped"];

function outcomeOf(event: AgentLifecycleEventName): DeliveryOutcome {
	switch (event) {
		case "failed":
			return "failed";
		case "stopped":
			return "stopped";
		default:
			return "completed";
	}
}

/** Single-line preview for the notification body. */
export function previewOf(text: string | undefined, maxLength = 400): string {
	const trimmed = (text ?? "").trim();
	if (trimmed.length === 0) return "";
	return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}…`;
}

// -- audit trail -----------------------------------------------------------------

/** One delivery decision, kept for tests/audit; run data is never mutated. */
export interface DeliveryDecisionRecord {
	agentId: string;
	event: AgentLifecycleEventName;
	delivered: boolean;
	/** Why: a guard/policy reason, or "result-consumed-inline". */
	reason: string;
	at: number;
}

export interface DeliveryServiceOptions extends CompletionQueueOptions {
	now?: () => number;
}

/**
 * Subscribes to manager lifecycle events and routes conversation delivery
 * through the host adapter. The manager keeps emitting owner-aware lifecycle
 * events unconditionally — those feed pi.events (`subagents:<name>`) for
 * extension consumers; this service only adds the direct-conversation path.
 */
export class DeliveryService {
	private readonly decisions: DeliveryDecisionRecord[] = [];
	private readonly unsubscribe: () => void;
	private readonly now: () => number;
	private readonly queue: CompletionQueue;
	private switchCount = 0;

	constructor(
		private readonly manager: AgentManager,
		private readonly host: DeliveryHost,
		options: DeliveryServiceOptions = {},
	) {
		this.now = options.now ?? (() => Date.now());
		this.queue = new CompletionQueue((events) => this.deliver(events), options);
		this.unsubscribe = manager.subscribe((event) => this.handle(event));
	}

	/** Decision audit trail (oldest first). */
	getDecisionLog(): readonly DeliveryDecisionRecord[] {
		return [...this.decisions];
	}

	/** How many session switches this service observed. */
	getSessionSwitchCount(): number {
		return this.switchCount;
	}

	/**
	 * Session-switch hook (pi `session_before_switch`, covering /new and
	 * /resume). Runs keep executing — detached process-backed runs survive a
	 * switch — but the guard re-evaluates against the NEW live session at
	 * delivery time, so pending conversation deliveries are invalidated by
	 * construction. Nothing is cached between spawn and delivery.
	 */
	handleSessionSwitch(): void {
		this.switchCount += 1;
		this.queue.clear();
	}

	/** Drop queued conversation notifications at the end of an owning session. */
	clearPending(): void {
		this.queue.clear();
	}

	/** Successful background Agent tool launches in the current model turn. */
	trackSpawn(id: string): void {
		this.queue.trackSpawn(id);
	}

	/** Finish grouping after Pi has executed the turn's parallel tool calls. */
	finishSpawnBatch(): void {
		this.queue.finishBatch();
	}

	dispose(): void {
		this.unsubscribe();
		this.queue.clear();
	}

	// -- internals -----------------------------------------------------------------

	private handle(event: AgentLifecycleEvent): void {
		if (!NOTIFIABLE_EVENTS.includes(event.event)) return;
		// Non-conversation events and inline calls do not participate in a join.
		if (
			event.owner.kind === "extension" ||
			event.delivery === "event" ||
			event.delivery === "none" ||
			this.manager.get(event.agentId)?.isBackground === false
		) {
			this.deliver([event]);
			return;
		}
		this.queue.add(event);
	}

	private deliver(events: AgentLifecycleEvent[]): void {
		const notifications: CompletionNotification[] = [];
		const accepted: Array<(reason: string) => void> = [];
		for (const event of events) {
			const notification = this.prepare(event);
			if (notification) {
				notifications.push(notification.notification);
				accepted.push(notification.markDelivered);
			}
		}
		if (notifications.length === 0) return;
		try {
			const [first, ...others] = notifications;
			if (!first) return;
			this.host.sendNotification(others.length > 0 ? { ...first, others } : first);
		} catch (error) {
			for (const mark of accepted) mark(isStaleExtensionCtxError(error) ? "stale-ctx-swallowed" : "send-failed");
			if (!isStaleExtensionCtxError(error)) {
				console.warn(
					`[pi-teams] delivery of agents ${notifications.map((item) => item.agentId).join(", ")} failed: ${String(error)}`,
				);
			}
			return;
		}
		for (const mark of accepted) mark("delivered");
	}

	private prepare(
		event: AgentLifecycleEvent,
	): { notification: CompletionNotification; markDelivered: (reason: string) => void } | undefined {
		const record = (reason: string): void => {
			this.decisions.push({
				agentId: event.agentId,
				event: event.event,
				delivered: reason === "delivered",
				reason,
				at: this.now(),
			});
		};

		// A foreground Agent call blocks on the tool result and the tool marks it
		// consumed right after settlement — a completion notification would
		// duplicate what the caller already received inline.
		const run = this.manager.get(event.agentId);
		if (run?.isBackground === false || run?.resultConsumed === true) {
			record("result-consumed-inline");
			return undefined;
		}

		const parentSessionId =
			event.parentSession?.sessionId ?? (event.owner.kind === "conversation" ? event.owner.sessionId : undefined);
		let session: SessionSnapshot | undefined;
		try {
			session = this.host.currentSession();
		} catch {
			session = undefined; // unreadable session state degrades to permissive
		}

		const guardInput: DeliveryGuardInput = {};
		if (parentSessionId !== undefined) guardInput.parentSessionId = parentSessionId;
		if (event.parentSession?.leafId !== undefined) guardInput.parentLeafId = event.parentSession.leafId;
		if (session !== undefined) guardInput.session = session;
		const guard = evaluateDeliveryGuard(guardInput);
		if (!shouldDeliverToConversation(event.owner, event.delivery, guard)) {
			record(guard.allowed ? `policy-blocked:${event.delivery}` : `guard-refused:${guard.reason}`);
			return undefined;
		}

		const previewSource = event.event === "completed" ? event.result : (event.error ?? event.result);
		const preview = previewOf(previewSource);
		// A budget-stopped run must tell the parent exactly which limit fired,
		// that the work may be incomplete, and that resume re-applies the limit.
		const budgetNote = budgetStopNote({
			id: event.agentId,
			...(event.budgetExhausted !== undefined ? { budgetExhausted: event.budgetExhausted } : {}),
			...(event.budgetSeconds !== undefined ? { budgetSeconds: event.budgetSeconds } : {}),
		});
		const notification: CompletionNotification = {
			agentId: event.agentId,
			...(event.teammateName !== undefined ? { teammateName: event.teammateName } : {}),
			...(event.teammateColor !== undefined ? { teammateColor: event.teammateColor } : {}),
			agentType: event.type,
			description: event.description,
			status: event.status,
			outcome: outcomeOf(event.event),
			preview: budgetNote !== undefined ? (preview.length > 0 ? `${preview}\n${budgetNote}` : budgetNote) : preview,
			...(event.resultFile !== undefined ? { resultFile: event.resultFile } : {}),
			...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
			...(event.usage !== undefined ? { totalTokens: event.usage.totalTokens } : {}),
		};
		return { notification, markDelivered: record };
	}
}
