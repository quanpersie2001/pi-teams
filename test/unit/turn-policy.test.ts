import { describe, expect, it } from "vitest";
import { decideTurnEvent, SOFT_STEER_MESSAGE } from "../../extension-src/pi-subagents/app/turn-policy.js";

describe("decideTurnEvent", () => {
	describe("unlimited (maxTurnLimit undefined or 0)", () => {
		it("continues forever when maxTurnLimit is undefined", () => {
			for (const turns of [0, 1, 10, 1000]) {
				expect(decideTurnEvent({ turns })).toEqual({ action: "continue", reason: "unlimited" });
			}
		});

		it("continues forever when maxTurnLimit is 0 (pinned unlimited)", () => {
			expect(decideTurnEvent({ turns: 50, maxTurnLimit: 0, graceTurns: 3 }).action).toBe("continue");
		});

		it("ignores negative and non-finite limits as unlimited", () => {
			expect(decideTurnEvent({ turns: 5, maxTurnLimit: -2 }).action).toBe("continue");
			expect(decideTurnEvent({ turns: 5, maxTurnLimit: Number.NaN }).action).toBe("continue");
		});
	});

	describe("soft limit boundary", () => {
		const max = 5;

		it("continues below the limit", () => {
			expect(decideTurnEvent({ turns: max - 1, maxTurnLimit: max, graceTurns: 3 }).action).toBe("continue");
			expect(decideTurnEvent({ turns: 0, maxTurnLimit: max }).action).toBe("continue");
		});

		it("soft-steers exactly at the limit", () => {
			const decision = decideTurnEvent({ turns: max, maxTurnLimit: max, graceTurns: 3 });
			expect(decision.action).toBe("softSteer");
		});

		it("does not re-steer inside the grace window once steered", () => {
			for (const turns of [max, max + 1, max + 2]) {
				const decision = decideTurnEvent({ turns, maxTurnLimit: max, graceTurns: 3, steered: true });
				expect(decision.action).toBe("continue");
			}
		});
	});

	describe("grace / hard boundary", () => {
		const max = 5;

		it("aborts at maxTurnLimit + graceTurns even when steered", () => {
			expect(decideTurnEvent({ turns: 8, maxTurnLimit: max, graceTurns: 3, steered: true }).action).toBe("abort");
		});

		it("aborts past the grace window regardless of steered flag", () => {
			expect(decideTurnEvent({ turns: 9, maxTurnLimit: max, graceTurns: 3 }).action).toBe("abort");
		});

		it("with zero grace, the abort boundary coincides with the soft limit", () => {
			expect(decideTurnEvent({ turns: 5, maxTurnLimit: max, graceTurns: 0 }).action).toBe("abort");
			expect(decideTurnEvent({ turns: 4, maxTurnLimit: max, graceTurns: 0 }).action).toBe("continue");
		});

		it("treats a non-finite graceTurns as 0", () => {
			expect(decideTurnEvent({ turns: 5, maxTurnLimit: max, graceTurns: Number.NaN }).action).toBe("abort");
		});
	});

	describe("input sanitation", () => {
		it("floors fractional turn counts", () => {
			// 4.9 completed turns floor to 4: below the limit of 5.
			expect(decideTurnEvent({ turns: 4.9, maxTurnLimit: 5 }).action).toBe("continue");
			expect(decideTurnEvent({ turns: 5.9, maxTurnLimit: 5, graceTurns: 3 }).action).toBe("softSteer");
		});

		it("clamps negative turn counts to zero", () => {
			expect(decideTurnEvent({ turns: -3, maxTurnLimit: 1 }).action).toBe("continue");
		});
	});

	it("exposes the soft steer wrap-up message", () => {
		expect(SOFT_STEER_MESSAGE.length).toBeGreaterThan(0);
		expect(SOFT_STEER_MESSAGE.toLowerCase()).toContain("wrap up");
	});
});
