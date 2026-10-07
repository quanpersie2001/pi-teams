// TimeBudgetWatcher unit tests: timer armature over the pure domain policy.
// The clock is injected; setTimeout comes from vitest fake timers, so every
// expiry is deterministic without real waiting.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BudgetExpiry, TimeBudgetWatcher } from "../../extension-src/pi-teams/app/time-budget-watcher.js";

describe("TimeBudgetWatcher", () => {
	let clock: number;
	let expiries: Array<{ runId: string; decision: BudgetExpiry }>;
	let watcher: TimeBudgetWatcher;

	beforeEach(() => {
		vi.useFakeTimers();
		clock = 1_000_000;
		expiries = [];
		watcher = new TimeBudgetWatcher({
			now: () => clock,
			onExpiry: (runId, decision) => {
				expiries.push({ runId, decision });
			},
		});
	});

	afterEach(() => {
		watcher.clear();
		vi.useRealTimers();
	});

	async function advance(ms: number): Promise<void> {
		clock += ms;
		await vi.advanceTimersByTimeAsync(ms);
	}

	it("fires the wall budget once at its deadline", async () => {
		watcher.watch("run-1", { timeout: 30, startedAt: clock, lastOutputAt: clock });
		await advance(29_999);
		expect(expiries).toEqual([]);
		await advance(1);
		expect(expiries).toEqual([{ runId: "run-1", decision: { action: "abort", budget: "timeout", seconds: 30 } }]);
		// One-shot: no further expiries and output observation is inert.
		await advance(60_000);
		watcher.observeOutput("run-1", clock);
		expect(expiries).toHaveLength(1);
	});

	it("counts output from the idle clock and re-arms", async () => {
		watcher.watch("run-1", { idleTimeout: 5, startedAt: clock, lastOutputAt: clock });
		await advance(4_000);
		expect(expiries).toEqual([]);
		watcher.observeOutput("run-1", clock);
		await advance(4_000);
		expect(expiries).toEqual([]);
		watcher.observeOutput("run-1", clock);
		await advance(4_999);
		expect(expiries).toEqual([]);
		await advance(1);
		expect(expiries).toEqual([{ runId: "run-1", decision: { action: "abort", budget: "idle_timeout", seconds: 5 } }]);
	});

	it("ignores output that does not move the idle clock forward", async () => {
		watcher.watch("run-1", { idleTimeout: 5, startedAt: clock, lastOutputAt: clock });
		const before = clock;
		await advance(2_000);
		watcher.observeOutput("run-1", before - 1);
		await advance(3_000);
		expect(expiries).toEqual([{ runId: "run-1", decision: { action: "abort", budget: "idle_timeout", seconds: 5 } }]);
	});

	it("the wall clock wins a simultaneous expiry", async () => {
		watcher.watch("run-1", { timeout: 10, idleTimeout: 10, startedAt: clock, lastOutputAt: clock });
		await advance(10_000);
		expect(expiries).toEqual([{ runId: "run-1", decision: { action: "abort", budget: "timeout", seconds: 10 } }]);
	});

	it("unlimited budgets arm nothing", async () => {
		watcher.watch("run-1", { startedAt: clock, lastOutputAt: clock });
		watcher.watch("run-2", { timeout: 0, idleTimeout: 0, startedAt: clock, lastOutputAt: clock });
		await advance(3_600_000);
		expect(expiries).toEqual([]);
	});

	it("stop() and clear() disarm without expiries", async () => {
		watcher.watch("run-1", { timeout: 1, startedAt: clock, lastOutputAt: clock });
		watcher.watch("run-2", { timeout: 2, startedAt: clock, lastOutputAt: clock });
		watcher.stop("run-1");
		await advance(1_000);
		expect(expiries).toEqual([]);
		watcher.clear();
		await advance(10_000);
		expect(expiries).toEqual([]);
	});

	it("watch() replaces an existing armature instead of double-firing", async () => {
		watcher.watch("run-1", { timeout: 1, startedAt: clock, lastOutputAt: clock });
		watcher.watch("run-1", { timeout: 5, startedAt: clock, lastOutputAt: clock });
		await advance(1_000);
		expect(expiries).toEqual([]);
		await advance(4_000);
		expect(expiries).toEqual([{ runId: "run-1", decision: { action: "abort", budget: "timeout", seconds: 5 } }]);
	});

	it("re-arms when a coarse timer fires before the injected clock", async () => {
		watcher.watch("run-1", { timeout: 1, startedAt: clock, lastOutputAt: clock });
		// Force a fire while the clock has not reached the deadline yet.
		clock += 500;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(expiries).toEqual([]);
		await advance(500);
		expect(expiries).toEqual([{ runId: "run-1", decision: { action: "abort", budget: "timeout", seconds: 1 } }]);
	});
});
