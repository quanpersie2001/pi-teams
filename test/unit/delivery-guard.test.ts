// Delivery guard decision table and policy routing (docs/INTEGRATION.md).
// Pure functions — no manager, no host.

import { describe, expect, it } from "vitest";
import {
	type DeliveryGuardInput,
	evaluateDeliveryGuard,
	previewOf,
	shouldDeliverToConversation,
} from "../../extension-src/pi-teams/app/delivery-service.js";

function guard(overrides: Partial<DeliveryGuardInput> = {}) {
	return evaluateDeliveryGuard({
		parentSessionId: "session-a",
		session: { sessionId: "session-a" },
		...overrides,
	});
}

describe("delivery guard decision table", () => {
	it("allows when the live session equals the parent session", () => {
		expect(guard()).toEqual({ allowed: true, reason: "same-session" });
	});

	it("refuses when the session switched (/new, /resume)", () => {
		expect(guard({ session: { sessionId: "session-b" } })).toEqual({ allowed: false, reason: "session-switched" });
	});

	it("is permissive when the parent spawned without a session id (headless spawn)", () => {
		expect(evaluateDeliveryGuard({})).toEqual({ allowed: true, reason: "permissive-headless" });
		expect(evaluateDeliveryGuard({ parentSessionId: "unknown-session", session: { sessionId: "s" } })).toEqual({
			allowed: true,
			reason: "permissive-headless",
		});
	});

	it("is permissive when no live session snapshot exists (no session manager)", () => {
		expect(evaluateDeliveryGuard({ parentSessionId: "session-a", session: undefined })).toEqual({
			allowed: true,
			reason: "permissive-headless",
		});
	});

	it("is permissive when the live snapshot exposes no session id (partial manager)", () => {
		expect(evaluateDeliveryGuard({ parentSessionId: "session-a", session: {} })).toEqual({
			allowed: true,
			reason: "permissive-headless",
		});
	});

	it("allows natural conversation progression: leaf moved but parent leaf still on branch", () => {
		const result = guard({
			parentLeafId: "leaf-1",
			session: { sessionId: "session-a", leafId: "leaf-3", branchIds: ["root", "leaf-1", "leaf-2", "leaf-3"] },
		});
		expect(result).toEqual({ allowed: true, reason: "branch-descendant" });
	});

	it("allows when the current leaf still IS the parent leaf on the branch", () => {
		const result = guard({
			parentLeafId: "leaf-2",
			session: { sessionId: "session-a", leafId: "leaf-2", branchIds: ["root", "leaf-1", "leaf-2"] },
		});
		expect(result).toEqual({ allowed: true, reason: "branch-descendant" });
	});

	it("refuses a /tree move onto a sibling branch that dropped the parent leaf", () => {
		const result = guard({
			parentLeafId: "leaf-2a",
			session: { sessionId: "session-a", leafId: "leaf-3b", branchIds: ["root", "leaf-1", "leaf-2b", "leaf-3b"] },
		});
		expect(result).toEqual({ allowed: false, reason: "branch-moved" });
	});

	it("without branch info: equal leaves allow", () => {
		const result = guard({
			parentLeafId: "leaf-1",
			session: { sessionId: "session-a", leafId: "leaf-1" },
		});
		expect(result).toEqual({ allowed: true, reason: "same-session" });
	});

	it("without branch info: different leaves refuse (ancestry unverifiable)", () => {
		const result = guard({
			parentLeafId: "leaf-1",
			session: { sessionId: "session-a", leafId: "leaf-9" },
		});
		expect(result).toEqual({ allowed: false, reason: "branch-moved" });
	});

	it("without any leaf info: tracked parent leaf cannot be verified → refuse-over-deliver", () => {
		const result = guard({ parentLeafId: "leaf-1", session: { sessionId: "session-a" } });
		expect(result).toEqual({ allowed: false, reason: "leaf-unverifiable" });
	});

	it("ignores leaf tracking when the parent never recorded a leaf", () => {
		expect(
			guard({
				session: { sessionId: "session-a", leafId: "other-leaf", branchIds: ["root", "other-leaf"] },
			}),
		).toEqual({ allowed: true, reason: "same-session" });
	});
});

describe("policy routing (owner rules win)", () => {
	const allow = { allowed: true as const, reason: "same-session" as const };
	const refuse = { allowed: false as const, reason: "session-switched" as const };
	const conversationOwner = { kind: "conversation" as const, sessionId: "session-a" };
	const extensionOwner = { kind: "extension" as const, id: "pi-tasks", ref: "task-123" };

	it.each([
		["conversation owner + conversation + guard allows", conversationOwner, "conversation", allow, true],
		["conversation owner + both + guard allows", conversationOwner, "both", allow, true],
		["conversation owner + conversation + guard refuses", conversationOwner, "conversation", refuse, false],
		["conversation owner + both + guard refuses", conversationOwner, "both", refuse, false],
		["conversation owner + event", conversationOwner, "event", allow, false],
		["conversation owner + none", conversationOwner, "none", allow, false],
		["extension owner + conversation (even with guard allowing)", extensionOwner, "conversation", allow, false],
		["extension owner + both (even with guard allowing)", extensionOwner, "both", allow, false],
		["extension owner + event", extensionOwner, "event", allow, false],
		["extension owner + none", extensionOwner, "none", allow, false],
	])("%s", (_name, owner, policy, verdict, expected) => {
		expect(shouldDeliverToConversation(owner, policy, verdict)).toBe(expected);
	});
});

describe("previewOf", () => {
	it("trims and truncates long results with an ellipsis", () => {
		expect(previewOf("  hello  ")).toBe("hello");
		const long = "x".repeat(500);
		const preview = previewOf(long, 400);
		expect(preview.length).toBe(401);
		expect(preview.endsWith("…")).toBe(true);
	});

	it("maps empty results to an empty string", () => {
		expect(previewOf(undefined)).toBe("");
		expect(previewOf("   \n  ")).toBe("");
	});
});
