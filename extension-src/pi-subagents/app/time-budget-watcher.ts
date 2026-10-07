// Runtime timer armature for hard time budgets (roadmap 1.1).
//
// The decision itself stays pure in domain/time-policy.ts (decideTimeBudget);
// this module only owns the scheduling: one unref'd timer per watched run,
// anchored to nextBudgetDeadlineAt, re-armed when counted child output moves
// the idle deadline. Expiry is reported once per run via onExpiry; the caller
// (AgentManager) decides what a stop means.
//
// Timers never outlive their run: stop()/clear() disarm, fired entries are
// removed before onExpiry runs, and every timer is unref'd so a pending
// watchdog can never hold the parent process open.

import { decideTimeBudget, nextBudgetDeadlineAt, type TimeBudgetDecision } from "../domain/time-policy.js";

export interface BudgetClocks {
	/** Whole seconds for the whole run; 0/undefined = unlimited. */
	timeout?: number | undefined;
	/** Whole seconds without counted child output; 0/undefined = unlimited. */
	idleTimeout?: number | undefined;
	/** Epoch ms the clocks started (immediately before backend.launch/resume). */
	startedAt: number;
	/** Epoch ms of the last counted child output. */
	lastOutputAt: number;
}

export type BudgetExpiry = Extract<TimeBudgetDecision, { action: "abort" }>;

export interface TimeBudgetWatcherOptions {
	/** Injectable clock (manager `now`); sampled at arm and fire time. */
	now: () => number;
	/** Called once per run when a budget expires. Must never throw. */
	onExpiry: (runId: string, decision: BudgetExpiry) => void;
}

interface WatchEntry extends BudgetClocks {
	timer?: NodeJS.Timeout;
}

export class TimeBudgetWatcher {
	private readonly entries = new Map<string, WatchEntry>();

	constructor(private readonly options: TimeBudgetWatcherOptions) {}

	/** Arm (or re-arm) the watchdog for one run; unlimited/0 budgets arm nothing. */
	watch(runId: string, clocks: BudgetClocks): void {
		this.stop(runId);
		const entry: WatchEntry = { ...clocks };
		this.entries.set(runId, entry);
		this.arm(runId, entry);
	}

	/**
	 * Record counted child output and re-arm. Output only moves the idle
	 * deadline later, so the wall deadline can only win ties — the decision is
	 * always re-evaluated through decideTimeBudget at fire time.
	 */
	observeOutput(runId: string, at: number): void {
		const entry = this.entries.get(runId);
		if (!entry || at <= entry.lastOutputAt) return;
		entry.lastOutputAt = at;
		this.arm(runId, entry);
	}

	/** Disarm one run (settlement, dispose, replacement). */
	stop(runId: string): void {
		const entry = this.entries.get(runId);
		if (!entry) return;
		this.entries.delete(runId);
		clearTimeout(entry.timer);
	}

	/** Disarm every run (manager dispose / session shutdown). */
	clear(): void {
		for (const [runId, entry] of [...this.entries]) {
			this.entries.delete(runId);
			clearTimeout(entry.timer);
		}
	}

	private arm(runId: string, entry: WatchEntry): void {
		clearTimeout(entry.timer);
		const deadline = nextBudgetDeadlineAt(entry);
		if (deadline === undefined) return;
		const delay = Math.max(0, deadline - this.options.now());
		const timer = setTimeout(() => {
			this.fire(runId);
		}, delay);
		timer.unref?.();
		entry.timer = timer;
	}

	private fire(runId: string): void {
		const entry = this.entries.get(runId);
		if (!entry) return;
		const decision = decideTimeBudget({
			startedAt: entry.startedAt,
			lastOutputAt: entry.lastOutputAt,
			now: this.options.now(),
			timeout: entry.timeout,
			idleTimeout: entry.idleTimeout,
		});
		if (decision.action === "continue") {
			// Fired before the clock reached the deadline (coarse timers, clock
			// adjustments): re-arm for the remaining window.
			this.arm(runId, entry);
			return;
		}
		this.entries.delete(runId);
		this.options.onExpiry(runId, decision);
	}
}
