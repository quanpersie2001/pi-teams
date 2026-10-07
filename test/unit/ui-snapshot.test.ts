// Unit: app/ui-snapshot.ts — immutable snapshot builders, ordering, owner
// refs, capability gating (incl. restored run without a valid handle), the
// ~400-item transcript tail and transcript-derived stats.

import { describe, expect, it } from "vitest";
import {
	activityFromTranscript,
	agentRowFromRecord,
	buildAgentListView,
	buildAgentTranscriptView,
	TRANSCRIPT_TAIL_ITEMS,
} from "../../extension-src/pi-subagents/app/ui-snapshot.js";
import type { AgentRun } from "../../extension-src/pi-subagents/domain/agent-run.js";
import { EMPTY_USAGE } from "../../extension-src/pi-subagents/domain/agent-run.js";
import type { TranscriptItem } from "../../extension-src/pi-subagents/domain/transcript.js";

let nextId = 0;

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
	nextId += 1;
	return {
		id: `run-${nextId}`,
		type: "explore",
		description: "Find auth files",
		status: "running",
		backend: "process",
		startedAt: 1_000_000 + nextId,
		toolUses: 0,
		turns: 0,
		usage: { ...EMPTY_USAGE },
		owner: { kind: "conversation", sessionId: "session-a" },
		delivery: "conversation",
		isBackground: true,
		...overrides,
	};
}

function managerOf(runs: readonly AgentRun[]): { list(): AgentRun[] } {
	// Mirror AgentManager.list(): newest-first by startedAt; the builder must
	// re-order into active-then-finished regardless.
	return {
		list: () => [...runs].sort((a, b) => b.startedAt - a.startedAt),
	};
}

describe("buildAgentListView", () => {
	it("orders active runs by spawn order first, then finished runs newest-first", () => {
		const early = makeRun({ id: "early", startedAt: 100, status: "running" });
		const late = makeRun({ id: "late", startedAt: 200, status: "running" });
		const doneOld = makeRun({ id: "done-old", startedAt: 50, completedAt: 300, status: "completed" });
		const doneNew = makeRun({ id: "done-new", startedAt: 60, completedAt: 400, status: "completed" });
		const view = buildAgentListView(managerOf([late, doneNew, doneOld, early]), { now: () => 1_000 });
		expect(view.rows.map((row) => row.id)).toEqual(["early", "late", "done-new", "done-old"]);
		expect(view.runningCount).toBe(2);
	});

	it("keeps a completed result when a cold continuation appends to the same native session", () => {
		const sessionFile = "/runs/shared/session.jsonl";
		const first = makeRun({ id: "first", status: "completed", result: "First outcome", sessionFile });
		const continuation = makeRun({ id: "next", status: "running", sessionFile });
		const view = buildAgentListView(managerOf([first, continuation]), {
			activityByRunId: new Map([
				[first.id, "Continuation activity"],
				[continuation.id, "Continuation activity"],
			]),
		});
		expect(view.rows.find((row) => row.id === first.id)?.activity).toBe("First outcome");
		expect(view.rows.find((row) => row.id === continuation.id)?.activity).toBe("Continuation activity");
	});

	it("projects owner reference, worktree branch and backend onto the row", () => {
		const run = makeRun({
			backend: "process",
			owner: { kind: "extension", id: "pi-tasks", ref: "task-123" },
			worktreeResult: {
				branch: "agent/auth-fix-a1b2",
				hasChanges: true,
				baseSha: "base",
				commitSha: "commit",
				commits: ["commit"],
				path: "/repo/.worktrees/run-1",
			},
		});
		const view = buildAgentListView(managerOf([run]));
		expect(view.rows[0]?.ownerRef).toBe("pi-tasks:task-123");
		expect(view.rows[0]?.branch).toBe("agent/auth-fix-a1b2");
		expect(view.rows[0]?.backend).toBe("process");
	});

	it("collapses task owners to the compact task:<ref> label", () => {
		const run = makeRun({ owner: { kind: "extension", id: "task", ref: "auth-fix" } });
		expect(agentRowFromRecord(run, { now: 1 }).ownerRef).toBe("task:auth-fix");
	});

	it("hides dismissed finished rows but never active ones", () => {
		const active = makeRun({ id: "active", status: "running" });
		const done = makeRun({ id: "done", status: "completed", completedAt: 500 });
		const view = buildAgentListView(managerOf([active, done]), { now: () => 1_000, dismissedIds: new Set(["done"]) });
		expect(view.rows.map((row) => row.id)).toEqual(["active"]);
		const viewActiveDismissed = buildAgentListView(managerOf([active, done]), {
			now: () => 1_000,
			dismissedIds: new Set(["active"]),
		});
		expect(viewActiveDismissed.rows.map((row) => row.id)).toEqual(["active", "done"]);
	});

	it("gates capabilities honestly: restored run without a valid handle is view-only", () => {
		const restored = makeRun({
			id: "restored",
			status: "running",
			backend: "process",
			sessionFile: "/runs/restored/session.jsonl",
			// handle deliberately absent: identity validation failed at restore
		});
		const row = agentRowFromRecord(restored, { now: 1_000 });
		expect(row.capabilities).toEqual({
			attachable: false,
			viewable: true,
			steerable: false,
			stoppable: false,
			resumable: false,
		});
	});
	it("projects only manager-confirmed native pane capability", () => {
		const run = makeRun({ handle: { kind: "process", handle: "live" } });
		const view = buildAgentListView(
			{ ...managerOf([run]), canAttachPane: (agentId: string) => agentId === run.id },
			{ now: () => 1 },
		);
		expect(view.rows[0]?.capabilities.attachable).toBe(true);
		expect(agentRowFromRecord(run, { now: 1 }).capabilities.attachable).toBe(false);
	});

	it("marks queued runs steerable/stoppable without a handle, live runs with one", () => {
		const queued = agentRowFromRecord(makeRun({ status: "queued" }), { now: 1 });
		expect(queued.capabilities.steerable).toBe(true);
		expect(queued.capabilities.stoppable).toBe(true);
		expect(queued.capabilities.viewable).toBe(false);

		const running = agentRowFromRecord(makeRun({ status: "running", handle: { kind: "process", handle: "h1" } }), {
			now: 1,
		});
		expect(running.capabilities.steerable).toBe(true);
		expect(running.capabilities.viewable).toBe(true);

		const finished = agentRowFromRecord(
			makeRun({
				status: "completed",
				completedAt: 900,
				handle: { kind: "process", handle: "h1" },
				sessionFile: "/s.jsonl",
			}),
			{ now: 1_000 },
		);
		expect(finished.capabilities.steerable).toBe(false);
		expect(finished.capabilities.resumable).toBe(true);
	});
});

function item(kind: TranscriptItem["kind"], extra: Partial<TranscriptItem> = {}): TranscriptItem {
	return { kind, timestamp: 1, ...extra };
}

describe("activityFromTranscript", () => {
	it("derives activity from the last tool call arguments when it comes after text", () => {
		const items = [
			item("assistant", { text: "Working" }),
			item("toolCall", { toolName: "bash", toolCallId: "b1", args: { command: "npm test" } }),
		];
		expect(activityFromTranscript(items)).toBe("bash npm test");
	});

	it("caps multi-line bash scripts to a one-line preview (no script paste into panel)", () => {
		const items = [
			item("toolCall", {
				toolName: "bash",
				toolCallId: "b2",
				args: {
					command:
						"node -e \"const rows = runTests();\nfor (const f of files) {\n  console.log(f, '=>', rows, 'rows');\n}\"",
				},
			}),
		];
		const activity = activityFromTranscript(items);
		expect(activity).toContain("bash node -e");
		expect(activity?.includes("\n")).toBe(false);
		expect(activity?.length ?? 0).toBeLessThanOrEqual(48 + "bash ".length);
	});
});

describe("buildAgentTranscriptView", () => {
	it("keeps only the tail window and flags truncation", () => {
		const run = makeRun();
		const items: TranscriptItem[] = Array.from({ length: TRANSCRIPT_TAIL_ITEMS + 10 }, (_, i) =>
			item("assistant", { text: `m${i}`, timestamp: i }),
		);
		const view = buildAgentTranscriptView(run, items, { now: () => 5_000 });
		expect(view.items).toHaveLength(TRANSCRIPT_TAIL_ITEMS);
		expect(view.truncatedHead).toBe(true);
		expect(view.items[0]?.text).toBe("m10");
		expect(view.items[view.items.length - 1]?.text).toBe(`m${TRANSCRIPT_TAIL_ITEMS + 9}`);
	});

	it("reports no truncation below the window and carries capabilities", () => {
		const run = makeRun({ handle: { kind: "process", handle: "child-1" }, sessionFile: "/s.jsonl" });
		const view = buildAgentTranscriptView(run, [item("user", { text: "hi" })], { now: () => 1 });
		expect(view.truncatedHead).toBe(false);
		expect(view.capabilities.stoppable).toBe(true);
		expect(view.toolUses).toBe(0);
		expect(view.capabilities.attachable).toBe(false);
	});
});
