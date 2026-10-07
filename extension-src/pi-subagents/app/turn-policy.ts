// Pure, backend-neutral soft/hard turn-limit policy (docs/CONFIGURATION.md).
//
// The policy decides what a backend should do at each `turn_end`:
//   - turns <  maxTurnLimit                 → continue;
//   - turns >= maxTurnLimit (once)          → softSteer: send SOFT_STEER_MESSAGE
//     so the agent can wrap up gracefully; the run is then marked "steered";
//   - turns >= maxTurnLimit + graceTurns    → abort: hard-stop the run.
// maxTurnLimit of 0 or undefined means unlimited.
//
// No imports: this module must stay dependency-free and trivially testable.

/** Message sent to the agent when it reaches its soft turn limit. */
export const SOFT_STEER_MESSAGE =
	"You have reached your turn limit. Wrap up immediately — provide your final answer now.";

export interface TurnPolicyInput {
	/** Completed turn count (incremented at every `turn_end`). */
	turns: number;
	/**
	 * Soft limit. 0/undefined = unlimited (the decision is always "continue",
	 * regardless of graceTurns).
	 */
	maxTurnLimit?: number | undefined;
	/** Turns allowed past the soft limit before the hard abort. Default 0. */
	graceTurns?: number | undefined;
	/**
	 * True once the soft steer has already been sent for this run (either by
	 * the turn policy itself or by an external steer). While true the soft
	 * branch does not re-fire — only the abort boundary is still enforced.
	 */
	steered?: boolean | undefined;
}

export type TurnDecisionAction = "continue" | "softSteer" | "abort";

export interface TurnDecision {
	action: TurnDecisionAction;
	/** Human-readable rationale (for transcripts/diagnostics). */
	reason: string;
}

function normalizeCount(value: number | undefined): number | undefined {
	if (value === undefined || value === null || !Number.isFinite(value)) return undefined;
	const n = Math.floor(value);
	return n > 0 ? n : undefined;
}

function clampNonNegative(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	const n = Math.floor(value);
	return n > 0 ? n : 0;
}

/**
 * Decide the backend action for one completed turn.
 *
 * Decision table (maxTurnLimit M, graceTurns G):
 *
 *   M undefined/0        → continue (unlimited)
 *   turns <  M           → continue
 *   turns >= M+G         → abort    (hard limit wins even if never steered)
 *   steered, turns < M+G → continue (already wrapping up)
 *   turns >= M (< M+G)   → softSteer (fires exactly once per run)
 *
 * With G = 0 the soft steer and the abort boundary coincide at turns >= M,
 * so the first turn over the limit aborts immediately (no grace window).
 */
export function decideTurnEvent(input: TurnPolicyInput): TurnDecision {
	const maxTurnLimit = normalizeCount(input.maxTurnLimit);
	if (maxTurnLimit === undefined) {
		return { action: "continue", reason: "unlimited" };
	}
	const turns = clampNonNegative(input.turns, 0);
	const graceTurns = clampNonNegative(input.graceTurns, 0);
	if (turns >= maxTurnLimit + graceTurns) {
		return {
			action: "abort",
			reason: `hard turn limit: ${turns} turns >= ${maxTurnLimit} + ${graceTurns} grace`,
		};
	}
	if (input.steered === true) {
		return { action: "continue", reason: "already steered; inside grace window" };
	}
	if (turns >= maxTurnLimit) {
		return {
			action: "softSteer",
			reason: `soft turn limit reached: ${turns} >= ${maxTurnLimit}`,
		};
	}
	return { action: "continue", reason: `${turns}/${maxTurnLimit} turns` };
}
