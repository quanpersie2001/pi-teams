import { describe, expect, it } from "vitest";
import { decideTimeBudget, nextBudgetDeadlineAt } from "../../extension-src/pi-teams/domain/time-policy.js";

const START = 1_000_000;

describe("decideTimeBudget", () => {
	describe("disabled budgets", () => {
		it("continues forever when both budgets are undefined", () => {
			for (const elapsed of [0, 1, 60, 3_600_000]) {
				expect(decideTimeBudget({ startedAt: START, lastOutputAt: START, now: START + elapsed })).toEqual({
					action: "continue",
				});
			}
		});

		it("continues forever when both budgets are 0 (explicit unlimited)", () => {
			expect(
				decideTimeBudget({
					startedAt: START,
					lastOutputAt: START,
					now: START + 999_999,
					timeout: 0,
					idleTimeout: 0,
				}),
			).toEqual({ action: "continue" });
		});

		it("a 0 on one clock disables only that clock", () => {
			// Wall clock unlimited, idle clock active and expired.
			expect(
				decideTimeBudget({ startedAt: START, lastOutputAt: START, now: START + 90_000, timeout: 0, idleTimeout: 30 }),
			).toEqual({ action: "abort", budget: "idle_timeout", seconds: 30 });
			// Idle clock unlimited, wall clock active and expired.
			expect(
				decideTimeBudget({ startedAt: START, lastOutputAt: START, now: START + 90_000, timeout: 60, idleTimeout: 0 }),
			).toEqual({ action: "abort", budget: "timeout", seconds: 60 });
		});
	});

	describe("wall-clock timeout", () => {
		it("continues strictly before the budget", () => {
			expect(decideTimeBudget({ startedAt: START, lastOutputAt: START, now: START + 29_999, timeout: 30 })).toEqual({
				action: "continue",
			});
		});

		it("aborts exactly at the inclusive boundary", () => {
			expect(decideTimeBudget({ startedAt: START, lastOutputAt: START, now: START + 30_000, timeout: 30 })).toEqual({
				action: "abort",
				budget: "timeout",
				seconds: 30,
			});
		});

		it("aborts past the boundary with the exhausted seconds", () => {
			expect(decideTimeBudget({ startedAt: START, lastOutputAt: START, now: START + 65_000, timeout: 30 })).toEqual({
				action: "abort",
				budget: "timeout",
				seconds: 30,
			});
		});

		it("measures from startedAt even with recent output (independent clocks)", () => {
			// Output 1s ago keeps idle happy, but the run is 61s old against a 60s wall.
			expect(
				decideTimeBudget({
					startedAt: START,
					lastOutputAt: START + 60_000,
					now: START + 61_000,
					timeout: 60,
				}),
			).toEqual({ action: "abort", budget: "timeout", seconds: 60 });
		});
	});

	describe("idle timeout", () => {
		it("continues while the child produced output recently", () => {
			expect(
				decideTimeBudget({
					startedAt: START,
					lastOutputAt: START + 45_000,
					now: START + 60_000,
					idleTimeout: 30,
					timeout: 0,
				}),
			).toEqual({ action: "continue" });
		});

		it("aborts at the inclusive idle boundary", () => {
			expect(
				decideTimeBudget({
					startedAt: START,
					lastOutputAt: START + 30_000,
					now: START + 60_000,
					idleTimeout: 30,
					timeout: 0,
				}),
			).toEqual({ action: "abort", budget: "idle_timeout", seconds: 30 });
		});

		it("measures from lastOutputAt, not startedAt (independent clocks)", () => {
			// Long but busy run: 10 minutes old, output 5s ago, idle budget 30s.
			expect(
				decideTimeBudget({
					startedAt: START,
					lastOutputAt: START + 595_000,
					now: START + 600_000,
					idleTimeout: 30,
					timeout: 0,
				}),
			).toEqual({ action: "continue" });
		});
	});

	describe("tie priority", () => {
		it("the wall clock wins when both budgets expire in the same tick", () => {
			const decision = decideTimeBudget({
				startedAt: START,
				lastOutputAt: START,
				now: START + 60_000,
				timeout: 60,
				idleTimeout: 60,
			});
			expect(decision).toEqual({ action: "abort", budget: "timeout", seconds: 60 });
		});

		it("wall clock wins even when the idle budget is the smaller number", () => {
			const decision = decideTimeBudget({
				startedAt: START,
				lastOutputAt: START,
				now: START + 120_000,
				timeout: 120,
				idleTimeout: 5,
			});
			expect(decision).toEqual({ action: "abort", budget: "timeout", seconds: 120 });
		});

		it("an already-expired idle budget aborts on idle before the wall clock", () => {
			expect(
				decideTimeBudget({
					startedAt: START,
					lastOutputAt: START + 10_000,
					now: START + 35_000,
					timeout: 120,
					idleTimeout: 20,
				}),
			).toEqual({ action: "abort", budget: "idle_timeout", seconds: 20 });
		});
	});
});

describe("nextBudgetDeadlineAt", () => {
	it("returns undefined when both budgets are unlimited", () => {
		expect(nextBudgetDeadlineAt({ startedAt: START, lastOutputAt: START })).toBeUndefined();
		expect(nextBudgetDeadlineAt({ startedAt: START, lastOutputAt: START, timeout: 0, idleTimeout: 0 })).toBeUndefined();
	});

	it("returns the wall-clock deadline", () => {
		expect(nextBudgetDeadlineAt({ startedAt: START, lastOutputAt: START, timeout: 30 })).toBe(START + 30_000);
	});

	it("returns the idle deadline anchored to lastOutputAt", () => {
		expect(nextBudgetDeadlineAt({ startedAt: START, lastOutputAt: START + 5_000, idleTimeout: 30 })).toBe(
			START + 35_000,
		);
	});

	it("returns the earliest deadline when both are active", () => {
		expect(
			nextBudgetDeadlineAt({
				startedAt: START,
				lastOutputAt: START + 5_000,
				timeout: 30,
				idleTimeout: 10,
			}),
		).toBe(START + 15_000);
	});
});
