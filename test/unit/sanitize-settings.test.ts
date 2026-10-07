import { describe, expect, it } from "vitest";
import {
	DEFAULT_SUBAGENTS_SETTINGS,
	MAX_MAX_CONCURRENT,
	MIN_MAX_CONCURRENT,
	sanitizeSettings,
} from "../../extension-src/pi-subagents/domain/config.js";

describe("sanitizeSettings", () => {
	it("keeps valid values as-is", () => {
		expect(
			sanitizeSettings({
				maxConcurrent: 8,
				defaultMaxTurns: 50,
				graceTurns: 0,
				defaultTimeout: 600,
				defaultIdleTimeout: 45,
				backgroundByDefault: false,
				worktreeIsolation: false,
				rememberAgents: false,
				strictAgentFiles: true,
				fallbackSubagent: "general-purpose",
				agentPanel: false,
				backend: "headless",
			}),
		).toEqual({
			maxConcurrent: 8,
			defaultMaxTurns: 50,
			graceTurns: 0,
			defaultTimeout: 600,
			defaultIdleTimeout: 45,
			backgroundByDefault: false,
			worktreeIsolation: false,
			rememberAgents: false,
			strictAgentFiles: true,
			fallbackSubagent: "general-purpose",
			agentPanel: false,
			backend: "headless",
		});
	});

	it("accepts only auto|headless for backend; anything else falls back to auto", () => {
		expect(sanitizeSettings({ backend: "auto" }).backend).toBe("auto");
		expect(sanitizeSettings({ backend: "headless" }).backend).toBe("headless");
		expect(sanitizeSettings({}).backend).toBe("auto");
		// herdr/tmux forcing is env-only (PI_SUBAGENTS_BACKEND); settings reject it.
		expect(sanitizeSettings({ backend: "herdr" }).backend).toBe("auto");
		expect(sanitizeSettings({ backend: "tmux" }).backend).toBe("auto");
		expect(sanitizeSettings({ backend: " TMUX " }).backend).toBe("auto");
		expect(sanitizeSettings({ backend: 1 }).backend).toBe("auto");
	});

	it("clamps maxConcurrent into [1, 1024]", () => {
		expect(sanitizeSettings({ maxConcurrent: 0 }).maxConcurrent).toBe(MIN_MAX_CONCURRENT);
		expect(sanitizeSettings({ maxConcurrent: -5 }).maxConcurrent).toBe(MIN_MAX_CONCURRENT);
		expect(sanitizeSettings({ maxConcurrent: 1.9 }).maxConcurrent).toBe(1);
		expect(sanitizeSettings({ maxConcurrent: 5000 }).maxConcurrent).toBe(MAX_MAX_CONCURRENT);
		expect(sanitizeSettings({ maxConcurrent: Number.NaN }).maxConcurrent).toBe(
			DEFAULT_SUBAGENTS_SETTINGS.maxConcurrent,
		);
		expect(sanitizeSettings({ maxConcurrent: "12" }).maxConcurrent).toBe(DEFAULT_SUBAGENTS_SETTINGS.maxConcurrent);
	});

	it("clamps turn limits to >= 0", () => {
		expect(sanitizeSettings({ defaultMaxTurns: -10 }).defaultMaxTurns).toBe(0);
		expect(sanitizeSettings({ defaultMaxTurns: 7.7 }).defaultMaxTurns).toBe(7);
		expect(sanitizeSettings({ graceTurns: -1 }).graceTurns).toBe(0);
		expect(sanitizeSettings({ graceTurns: 99 }).graceTurns).toBe(99);
	});

	it("sanitizes default time budgets: 0 = unlimited, fractions invalid, cap enforced", () => {
		// Absent/mistyped → 0 (unlimited; budgets are opt-in).
		expect(sanitizeSettings({}).defaultTimeout).toBe(0);
		expect(sanitizeSettings({ defaultIdleTimeout: "90" }).defaultIdleTimeout).toBe(0);
		expect(sanitizeSettings({ defaultTimeout: Number.NaN }).defaultTimeout).toBe(0);
		// Negatives clamp to 0.
		expect(sanitizeSettings({ defaultTimeout: -30 }).defaultTimeout).toBe(0);
		expect(sanitizeSettings({ defaultIdleTimeout: -1 }).defaultIdleTimeout).toBe(0);
		// Positive fractions are invalid → fallback 0, not silently truncated.
		expect(sanitizeSettings({ defaultTimeout: 7.5 }).defaultTimeout).toBe(0);
		expect(sanitizeSettings({ defaultIdleTimeout: 0.5 }).defaultIdleTimeout).toBe(0);
		// Whole seconds are kept and capped at the timer range.
		const kept = sanitizeSettings({ defaultTimeout: 600, defaultIdleTimeout: 45 });
		expect(kept.defaultTimeout).toBe(600);
		expect(kept.defaultIdleTimeout).toBe(45);
		expect(sanitizeSettings({ defaultTimeout: 10_000_000 }).defaultTimeout).toBe(Math.floor(2147483647 / 1000));
	});

	it("drops unknown keys without pinning an incidental key count", () => {
		const result = sanitizeSettings({
			maxConcurrent: 2,
			nestedAgents: true,
			taskPriority: "high",
			memoryScope: "project",
		});
		expect(result).not.toHaveProperty("nestedAgents");
		expect(result).not.toHaveProperty("taskPriority");
		expect(result).not.toHaveProperty("memoryScope");
		// The known keys survive unknown-key stripping.
		expect(result.maxConcurrent).toBe(2);
		expect(result.defaultTimeout).toBe(0);
		expect(result.defaultIdleTimeout).toBe(0);
	});
});
