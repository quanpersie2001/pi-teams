// Team identity + roster pure decisions (ADR 0007 §2).

import { describe, expect, it } from "vitest";
import {
	deriveTeamId,
	ensureMemberIdentity,
	LEAD_ADDRESS,
	normalizeTeammateColor,
	type TeamRoster,
	teammateNameProblem,
	upsertMember,
} from "../../extension-src/pi-teams/domain/team.js";

function roster(): TeamRoster {
	return { version: 1, teamId: "sess-a", sessionId: "sess-a", createdAt: 1, teamKey: "k", members: [] };
}
describe("teammate names", () => {
	it("accepts plain names and rejects reserved or malformed ones", () => {
		expect(teammateNameProblem("scout")).toBeUndefined();
		expect(teammateNameProblem("code-reviewer_2")).toBeUndefined();
		expect(teammateNameProblem("a.b-c")).toBeUndefined();
		expect(teammateNameProblem(LEAD_ADDRESS)).toMatch(/reserved/);
		expect(teammateNameProblem("")).toBeDefined();
		expect(teammateNameProblem("-nope")).toBeDefined();
		expect(teammateNameProblem("has space")).toBeDefined();
		expect(teammateNameProblem("x".repeat(65))).toBeDefined();
	});
	it("normalizes teammate colors like pi-style and rejects non-RGB values", () => {
		expect(normalizeTeammateColor(" #AbC ")).toBe("#aabbcc");
		expect(normalizeTeammateColor("#12ABef")).toBe("#12abef");
		expect(normalizeTeammateColor("red")).toBeUndefined();
		expect(normalizeTeammateColor("#abcd")).toBeUndefined();
	});
});

describe("deriveTeamId", () => {
	it("derives a safe directory id from the session id", () => {
		expect(deriveTeamId("session-42")).toBe("session-42");
		expect(deriveTeamId("weird/ids:here")).toBe("weird-ids-here");
		expect(deriveTeamId("")).toBe("session");
		expect(deriveTeamId(`x`.repeat(100)).length).toBeLessThanOrEqual(64);
	});
});

describe("upsertMember", () => {
	it("appends a new member and keeps identity across assignments", () => {
		const first = upsertMember(roster(), { name: "scout", type: "scout", runId: "run-1", at: 10 });
		expect(first.members).toHaveLength(1);
		expect(first.members[0]).toMatchObject({ name: "scout", type: "scout", lastRunId: "run-1" });

		const second = upsertMember(first, { name: "scout", type: "explore", runId: "run-2", at: 20 });
		expect(second.members).toHaveLength(1);
		expect(second.members[0]).toMatchObject({
			name: "scout",
			lastRunId: "run-2",
			firstAssignedAt: 10,
			lastAssignedAt: 20,
		});
		// Input roster untouched (pure).
		expect(first.members[0]?.lastRunId).toBe("run-1");
	});
	it("freezes member identity color across assignments", () => {
		const created = ensureMemberIdentity(roster(), { name: "scout", type: "scout", color: "#abcdef" }, 5);
		expect(created.color).toBe("#abcdef");
		const reassigned = upsertMember(created.roster, {
			name: "scout",
			type: "scout",
			runId: "run-1",
			at: 10,
		});
		expect(reassigned.members[0]).toMatchObject({ name: "scout", color: "#abcdef", lastRunId: "run-1" });
		expect(ensureMemberIdentity(reassigned, { name: "scout", type: "scout" }, 20).color).toBe("#abcdef");
		expect(() => ensureMemberIdentity(reassigned, { name: "scout", type: "scout", color: "#123456" }, 30)).toThrow(
			/cannot change/,
		);
	});
});
