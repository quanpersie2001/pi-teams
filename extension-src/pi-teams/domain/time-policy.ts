// Pure, backend-neutral hard time-budget policy (roadmap 1.1: timeout +
// idle-timeout). Mirrors the structure of app/turn-policy.ts.
//
// Two independent clocks bound a run:
//   - `timeout`      — wall-clock seconds for the WHOLE run, measured from
//                      `startedAt` (launch/resume moment, not admission).
//   - `idleTimeout`  — seconds without child OUTPUT, measured from
//                      `lastOutputAt` (last child message / completed tool
//                      result; steers, inbox and usage updates do not count).
// A budget of 0 or undefined means unlimited on that clock.
//
// When both clocks expire in the same tick the wall clock wins: it explains
// the run-wide bound better than the last quiet stretch (same ordering as the
// edxeth reference timeout-budget).
//
// This is the decision table only: no timers, no I/O, no backend imports.
// The runtime watcher (app layer) samples it and owns the actual abort.

/**
 * Upper bound for any budget in whole seconds: values must fit a signed
 * 32-bit millisecond timer (`setTimeout` range), i.e. seconds <=
 * floor(2147483647 / 1000).
 */
export const MAX_BUDGET_SECONDS = Math.floor(2147483647 / 1000);

/** Which budget a run was stopped by, using canonical snake_case names. */
export type TimeBudgetKind = "timeout" | "idle_timeout";

export interface TimeBudgetInput {
	/** Epoch ms when the current launch/resume started its clocks. */
	startedAt: number;
	/** Epoch ms of the last child-produced output (message or tool result). */
	lastOutputAt: number;
	/** Current epoch ms. */
	now: number;
	/** Whole seconds for the whole run; 0/undefined = unlimited. */
	timeout?: number | undefined;
	/** Whole seconds without child output; 0/undefined = unlimited. */
	idleTimeout?: number | undefined;
}

export type TimeBudgetDecision = { action: "continue" } | { action: "abort"; budget: TimeBudgetKind; seconds: number };

/**
 * Decision table (wall budget T, idle budget I, elapsed = now - startedAt,
 * quiet = now - lastOutputAt):
 *
 *   T undefined/0, I undefined/0       → continue (unlimited)
 *   elapsed >= T and quiet >= I        → abort timeout     (tie: wall wins)
 *   elapsed >= T                       → abort timeout
 *   quiet  >= I                        → abort idle_timeout
 *   otherwise                          → continue
 *
 * Boundaries are inclusive: a run is stopped exactly when the elapsed time
 * REACHES the budget (>=, not >) — a 30s timeout fires at elapsed === 30s.
 *
 * Units: `startedAt`/`lastOutputAt`/`now` are epoch MILLISECONDS; `timeout`
 * and `idleTimeout` are SECONDS. Comparisons convert the seconds budgets to
 * milliseconds (budget * 1000) before the inclusive >= check.
 */
export function decideTimeBudget(input: TimeBudgetInput): TimeBudgetDecision {
	const { timeout, idleTimeout } = input;
	const wallActive = timeout !== undefined && timeout > 0;
	const idleActive = idleTimeout !== undefined && idleTimeout > 0;
	if (!wallActive && !idleActive) return { action: "continue" };

	const elapsedMs = input.now - input.startedAt;
	const quietMs = input.now - input.lastOutputAt;
	if (wallActive && elapsedMs >= timeout * 1000) {
		return { action: "abort", budget: "timeout", seconds: timeout };
	}
	if (idleActive && quietMs >= idleTimeout * 1000) {
		return { action: "abort", budget: "idle_timeout", seconds: idleTimeout };
	}
	return { action: "continue" };
}

/**
 * Absolute epoch ms of the next budget expiry, for arming a runtime timer.
 * Returns undefined when both budgets are unlimited. The wall-clock deadline
 * wins ties; the idle deadline is anchored to lastOutputAt.
 */
export function nextBudgetDeadlineAt(input: {
	startedAt: number;
	lastOutputAt: number;
	timeout?: number | undefined;
	idleTimeout?: number | undefined;
}): number | undefined {
	if (input.timeout !== undefined && input.timeout > 0) {
		const wallDeadline = input.startedAt + input.timeout * 1000;
		if (input.idleTimeout !== undefined && input.idleTimeout > 0) {
			return Math.min(wallDeadline, input.lastOutputAt + input.idleTimeout * 1000);
		}
		return wallDeadline;
	}
	if (input.idleTimeout !== undefined && input.idleTimeout > 0) {
		return input.lastOutputAt + input.idleTimeout * 1000;
	}
	return undefined;
}
