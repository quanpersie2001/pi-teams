import { describe, expect, it } from "vitest";
import { childSessionStats } from "../../extension-src/pi-teams/pi/child-session-stats.js";

const usage = (n: number, cost: unknown = n / 100) => ({
	input: n,
	output: n * 2,
	cacheRead: n * 3,
	cacheWrite: n * 4,
	cost: { total: cost },
});

describe("native child session stats", () => {
	it("includes all native entries, not just the current branch or assignment", () => {
		const entries = [
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall" }], usage: usage(1) } },
			{ type: "message", message: { role: "toolResult", usage: usage(2) } },
			{ type: "usage", usage: usage(3) },
			{ type: "compaction", usage: usage(4) },
			{ type: "branch_summary", usage: usage(5) },
		];
		expect(childSessionStats(entries)).toEqual({
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 1,
			toolResults: 1,
			totalMessages: 3,
			tokens: { input: 15, output: 30, cacheRead: 45, cacheWrite: 60, total: 150 },
			cost: expect.closeTo(0.15),
		});
		// Reloading the same native log preserves cumulative cold-continuation totals.
		expect(childSessionStats(JSON.parse(JSON.stringify(entries)))).toEqual(childSessionStats(entries));
		expect(childSessionStats([])?.tokens.total).toBe(0);
		expect(childSessionStats([])).not.toHaveProperty("cost");
		expect(childSessionStats([{ type: "message", message: { role: "user" } }])).not.toHaveProperty("cost");
		expect(childSessionStats([{ type: "usage", usage: usage(0, 0) }])?.cost).toBe(0);
	});

	it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, "0.5"])(
		"omits incomplete/invalid recorded cost %s",
		(cost) => {
			const invalid = usage(2, cost);
			if (cost === undefined) delete (invalid as { cost?: unknown }).cost;
			expect(
				childSessionStats([
					{ type: "usage", usage: usage(1) },
					{ type: "compaction", usage: invalid },
				]),
			).not.toHaveProperty("cost");
		},
	);

	it("keeps absent native stats unavailable", () => {
		expect(childSessionStats(undefined)).toBeUndefined();
	});
});
