import { describe, expect, it } from "vitest";
import {
	AGENT_RUN_TRANSITIONS,
	type AgentRunEvent,
	isActiveStatus,
	isTerminalStatus,
	transition,
} from "../../extension-src/pi-subagents/domain/agent-run.js";

describe("AgentRun process lifecycle state machine", () => {
	it("walks queued → starting → running → completed", () => {
		let state = transition("queued", { type: "start" });
		expect(state).toBe("starting");
		state = transition(state, { type: "launched" });
		expect(state).toBe("running");
		expect(transition(state, { type: "complete", result: "done" })).toBe("completed");
	});

	it.each([
		["completed", { type: "complete", result: "done" }],
		["stopped", { type: "stop" }],
		["aborted", { type: "abort" }],
		["error", { type: "fail", error: "boom" }],
	] as const)("accepts child settlement as %s from running", (status, event) => {
		expect(transition("running", event)).toBe(status);
	});

	it.each(["queued", "starting"] as const)("allows local stop from %s", (state) => {
		expect(transition(state, { type: "stop" })).toBe("stopped");
	});

	it.each(["starting", "running"] as const)("allows RPC abort settlement from %s", (state) => {
		expect(transition(state, { type: "abort" })).toBe("aborted");
	});

	it.each([
		["queued", "complete"],
		["queued", "launched"],
		["starting", "start"],
		["running", "launched"],
	] as const)("rejects invalid transition %s + %s", (status, eventType) => {
		expect(() => transition(status, { type: eventType } as AgentRunEvent)).toThrow(
			new RegExp(`^invalid AgentRun transition: ${status} cannot accept event "${eventType}"$`),
		);
	});

	it("classifies only terminal run outcomes as terminal", () => {
		for (const terminal of ["completed", "stopped", "aborted", "error"] as const) {
			expect(isTerminalStatus(terminal)).toBe(true);
			expect(isActiveStatus(terminal)).toBe(false);
			expect(() => transition(terminal, { type: "start" })).toThrow();
		}
		for (const active of ["queued", "starting", "running"] as const) {
			expect(isTerminalStatus(active)).toBe(false);
			expect(isActiveStatus(active)).toBe(true);
		}
	});

	it("contains every process status and no outgoing edges from terminal states", () => {
		const statuses = ["queued", "starting", "running", "completed", "stopped", "aborted", "error"] as const;
		for (const status of statuses) {
			expect(AGENT_RUN_TRANSITIONS).toHaveProperty(status);
			if (isTerminalStatus(status)) expect(AGENT_RUN_TRANSITIONS[status]).toEqual({});
		}
	});
});
