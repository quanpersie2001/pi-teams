import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { TaskProjection } from "../../extension-src/pi-teams/domain/task-board.js";
import type { AgentListRow } from "../../extension-src/pi-teams/domain/ui-view.js";
import {
	createTasksHubComponent,
	inlineTasks,
	renderInlineTasks,
	renderTasksHub,
	type TasksHubData,
	taskHeader,
} from "../../extension-src/pi-teams/features/tasks/index.js";
import { renderTheme } from "../helpers/render-theme.js";

const theme = renderTheme();
const fg = theme.fg.bind(theme);
function task(overrides: Partial<TaskProjection> = {}): TaskProjection {
	return {
		id: "id-1",
		code: "T1",
		title: "Inspect auth flow",
		status: "pending",
		dependencies: [],
		blockedBy: [],
		requirementRevision: 1,
		spec: {},
		context: {},
		attempts: [],
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}
function run(id: string, status: AgentListRow["status"] = "running", totalTokens = 1234): AgentListRow {
	return {
		id,
		type: "task",
		description: "task agent",
		status,
		backend: "process",
		resourceState: "open",
		startedAt: 1_000,
		toolUses: 2,
		turns: 3,
		totalTokens,
		isBackground: true,
		capabilities: { attachable: false, viewable: true, steerable: false, stoppable: true, resumable: false },
	};
}
function data(tasks: TaskProjection[], overrides: Partial<TasksHubData> = {}): TasksHubData {
	return {
		tasks,
		selection: tasks[0]?.id ?? null,
		filter: "all",
		query: "",
		detail: false,
		rosterColors: new Map(),
		...overrides,
	};
}
function assertWidth(lines: string[], width: number) {
	for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

describe("unified tasks presentation", () => {
	it("uses an accent divider and pads details without clipping wrapped text", () => {
		const selected = task({ description: "Z".repeat(120) });
		const divider = fg("accent", "│");
		for (const width of [76, 100, 120]) {
			const lines = renderTasksHub(data([selected]), fg, width, 24);
			const cells = lines.slice(1, -2).map((line) => line.split(divider));
			for (const cell of cells) {
				expect(cell).toHaveLength(4);
				expect(cell[2]?.startsWith(" ")).toBe(true);
			}
			expect(cells[0]?.[2]?.startsWith(`  ${fg("text", "T1")}`)).toBe(true);
			expect(
				cells
					.map((cell) => cell[2])
					.join("")
					.match(/Z/g),
			).toHaveLength(120);
			assertWidth(lines, width);
		}
	});

	it("uses exact count groups, omits zero groups and counts blocked pending as open", () => {
		const tasks = [
			task({ id: "a", status: "completed" }),
			task({ id: "b", status: "in_progress", owner: "lead" }),
			task({ id: "c", blockedBy: ["T1"] }),
			task({ id: "d", status: "in_review", owner: "lead" }),
			task({ id: "e", status: "cancelled" }),
		];
		expect(taskHeader(tasks)).toBe("● 5 tasks (1 done, 1 in progress, 1 open, 1 in review, 1 cancelled)");
		expect(taskHeader([task()])).toBe("● 1 tasks (1 open)");
	});

	it("filters inline tasks to visible nonterminal states and counts review separately", () => {
		const active = task({ id: "active", code: "T1", status: "in_progress", owner: "executor" });
		const open = task({ id: "open", code: "T2", assignee: "opener" });
		const review = task({ id: "review", code: "T3", status: "in_review", owner: "reviewer" });
		const completed = task({ id: "done", code: "T4", status: "completed", outcome: { summary: "Done" } });
		const cancelled = task({ id: "cancelled", code: "T5", status: "cancelled" });
		const tasks = [active, open, review, completed, cancelled];
		expect(inlineTasks(tasks)).toEqual([active, open, review]);
		const colors = new Map([
			["executor", "#E879F9"],
			["opener", "#22AA44"],
			["reviewer", "#AA22CC"],
		]);
		const inline = renderInlineTasks(tasks, colors, fg, 100);
		expect(inline[0]).toContain("● 3 tasks (1 in progress, 1 in review, 1 open)");
		expect(inline.join("\n")).toContain("\x1b[38;2;232;121;249m@executor\x1b[39m");
		expect(inline.join("\n")).not.toContain("T4");
		expect(inline.join("\n")).not.toContain("T5");
		expect(inline.at(-1)).toContain("+1 more tasks");
		assertWidth(inline, 100);
		const reviewOnly = renderInlineTasks([review], colors, fg, 100).join("\n");
		expect(reviewOnly).toContain("● 1 tasks (1 in review)");
		expect(reviewOnly).toContain("\x1b[38;2;168;85;247m◇\x1b[39m");
		expect(reviewOnly).toContain("\x1b[38;2;170;34;204m@reviewer\x1b[39m");
		expect(renderInlineTasks([completed, cancelled], colors, fg, 100)).toEqual([]);
		expect(renderInlineTasks([], colors, fg, 100)).toEqual([]);
	});

	it("keeps terminal tasks, outcomes and history in the Hub", () => {
		const completed = task({
			id: "done",
			code: "T1",
			status: "completed",
			outcome: { summary: "Accepted", artifacts: ["report.md"] },
		});
		const cancelled = task({ id: "cancelled", code: "T2", status: "cancelled" });
		const text = renderTasksHub(data([completed, cancelled]), fg, 100, 16).join("\n");
		expect(text).toContain("T1");
		expect(text).toContain("T2");
		expect(text).toContain("1 done");
		expect(text).toContain("1 cancelled");
		expect(text).toContain("Outcome");
		expect(text).toContain("Accepted");
		expect(text).toContain("Artifact: report.md");
	});

	it("renders branch tree and colors task identity from exact roster color independently of status", () => {
		const tasks = [
			task({ id: "one", assignee: "reviewer", blockedBy: ["T2"] }),
			task({ id: "two", status: "in_progress", owner: "reviewer" }),
			task({ id: "three", title: "Unblocked", status: "pending" }),
		];
		const colors = new Map([["reviewer", "#E879F9"]]);
		const text = renderTasksHub(data(tasks, { rosterColors: colors }), fg, 110, 20).join("\n");
		expect(text).toContain("├─");
		expect(text).toContain("└─");
		expect(text).toContain("\x1b[38;2;232;121;249m@reviewer\x1b[39m");
		expect(text).toContain(fg("warning", "← T2"));
		expect(text).toContain(fg("text", "○"));
		expect(text).toContain("\x1b[38;2;59;130;246m◼\x1b[39m");
		assertWidth(renderTasksHub(data(tasks), fg, 110, 20), 110);
	});

	it("distinguishes active, claimed, blocked, review, done, cancelled, and failed-attempt glyphs", () => {
		const tasks = [
			task({
				id: "active",
				status: "in_progress",
				owner: "lead",
				attempts: [
					{
						runId: "r",
						startedAt: 1,
						status: "running",
						requirementRevision: 1,
						requirementSnapshot: { title: "x", dependencies: [], spec: {}, context: {} },
					},
				],
			}),
			task({ id: "claimed", status: "in_progress", owner: "lead" }),
			task({ id: "blocked", blockedBy: ["T1"] }),
			task({ id: "review", status: "in_review", owner: "lead" }),
			task({ id: "done", status: "completed" }),
			task({ id: "cancelled", status: "cancelled" }),
			task({
				id: "failed",
				attempts: [
					{
						runId: "r2",
						startedAt: 1,
						status: "failed",
						requirementRevision: 1,
						requirementSnapshot: { title: "x", dependencies: [], spec: {}, context: {} },
					},
				],
			}),
		];
		const text = renderTasksHub(data(tasks, { runs: [run("r")] }), fg, 120, 30).join("\n");
		expect(text).toContain("\x1b[38;2;0;215;255m◉\x1b[39m");
		expect(text).toContain("\x1b[38;2;59;130;246m◼\x1b[39m");
		expect(text).toContain("\x1b[38;2;245;158;11m◌\x1b[39m");
		expect(text).toContain("\x1b[38;2;168;85;247m◇\x1b[39m");
		expect(text).toContain(fg("success", "✓"));
		expect(text).toContain(fg("dim", "⊘"));
		expect(text).toContain(fg("error", "!"));
	});

	it("does not retain a historical failure glyph after a successful retry or terminal state", () => {
		const retried = task({
			status: "in_progress",
			owner: "worker",
			attempts: [
				{
					runId: "old",
					startedAt: 1,
					status: "failed",
					requirementRevision: 1,
					requirementSnapshot: { title: "x", dependencies: [], spec: {}, context: {} },
				},
				{
					runId: "new",
					startedAt: 2,
					status: "completed",
					requirementRevision: 1,
					requirementSnapshot: { title: "x", dependencies: [], spec: {}, context: {} },
				},
			],
		});
		const cancelled = task({ id: "cancelled", status: "cancelled", attempts: retried.attempts.slice(0, 1) });
		const retriedText = renderTasksHub(data([retried]), fg, 100, 12).join("\n");
		const retriedRow = retriedText.split("\n").find((line) => line.includes("└─")) ?? "";
		expect(retriedRow).not.toContain(fg("error", "!"));
		expect(retriedRow).toContain("\x1b[38;2;59;130;246m◼\x1b[39m");
		expect(retriedText).toContain("attempt failed");
		const cancelledText = renderTasksHub(data([cancelled]), fg, 100, 12).join("\n");
		const cancelledRow = cancelledText.split("\n").find((line) => line.includes("└─")) ?? "";
		expect(cancelledRow).toContain(fg("dim", "⊘"));
		expect(cancelledRow).not.toContain(fg("error", "!"));
	});

	it("uses only live AgentRun snapshots for spinner and muted run metrics, and wraps multiline details", () => {
		const running = task({
			status: "in_progress",
			owner: "worker",
			description: "First line\nSecond line with a long description that must wrap across the detail pane.",
			attempts: [
				{
					runId: "live",
					startedAt: 1_000,
					status: "running",
					requirementRevision: 1,
					requirementSnapshot: { title: "x", dependencies: [], spec: {}, context: {} },
				},
			],
		});
		const text = renderTasksHub(
			data([running], { runs: [run("live", "running", 2048)], now: 5_000, detail: true }),
			fg,
			32,
			12,
		).join("\n");
		expect(text).toContain("First line");
		expect(text).toContain("Second line");
		expect(text).toContain("Run metrics: 4.0s");
		expect(text).toContain("2048 to");
		const noRuntime = renderTasksHub(data([running]), fg, 100, 12).join("\n");
		expect(noRuntime).not.toContain("\x1b[38;2;0;215;255m◉\x1b[39m");
		const inline = renderInlineTasks([running], new Map(), fg, 100, [run("live", "running", 2048)], 5_000).join("\n");
		expect(inline).toContain("4.0s · ↓ 2048 tokens");
	});

	it("retains completed executor identity, planned pending assignee, outcome artifacts and attempt history", () => {
		const completed = task({
			id: "done",
			status: "completed",
			assignee: "planned-worker",
			dependencies: ["T2"],
			outcome: { summary: "Finished", artifacts: ["report.md"], remainingIssues: ["Follow up"] },
			attempts: [
				{
					runId: "run-done",
					resultFile: "/tmp/result.txt",
					teammateName: "actual-worker",
					startedAt: 1,
					status: "completed",
					requirementRevision: 1,
					requirementSnapshot: { title: "x", dependencies: [], spec: {}, context: {} },
				},
			],
		});
		const pending = task({
			id: "next",
			code: "T2",
			status: "pending",
			assignee: "planned-worker",
			dependencies: ["T1"],
			title: "Next step",
			attempts: [
				{
					runId: "old-run",
					teammateName: "past-worker",
					startedAt: 1,
					status: "failed",
					requirementRevision: 1,
					requirementSnapshot: { title: "x", dependencies: [], spec: {}, context: {} },
				},
			],
		});
		const colors = new Map([
			["actual-worker", "#E879F9"],
			["planned-worker", "#22AA44"],
			["past-worker", "#AA2222"],
		]);
		const text = renderTasksHub(data([completed, pending], { rosterColors: colors }), fg, 120, 24).join("\n");
		expect(text).toContain("\x1b[38;2;232;121;249m@actual-worker\x1b[39m");
		expect(text).toContain("\x1b[38;2;34;170;68m@planned-worker\x1b[39m");
		expect(text).not.toContain("@past-worker");
		expect(text).toContain("Artifact: report.md");
		expect(text).toContain("Remaining issue: Follow up");
		expect(text).toContain("run-done");
		expect(text).toContain("Prerequisites: T2");
		expect(text).toContain("Dependents: T2");
		expect(text).toContain("result /tmp");
		expect(text).toContain("/result.txt");
		expect(text).toContain("result.txt");
	});

	it("routes task-list wheel movement to the host callback", () => {
		const wheel: number[] = [];
		const tui = { terminal: { rows: 12, columns: 80 } } as never;
		const component = createTasksHubComponent(
			tui,
			theme,
			() => data([task()]),
			undefined,
			(delta) => wheel.push(delta),
		);
		component.render(80);
		component.handleMouse?.({ type: "wheel", wheelDelta: -1 } as never);
		expect(wheel).toEqual([-1]);
	});

	it("retains explicit list/detail layouts and bounds narrow or short terminals", () => {
		const tasks = [task({ description: "Long context" }), task({ id: "second", title: "Other task" })];
		for (const [width, height] of [
			[100, 24],
			[60, 12],
			[20, 6],
			[8, 3],
			[1, 1],
		]) {
			assertWidth(renderTasksHub(data(tasks), fg, width, height), width);
			assertWidth(renderTasksHub(data(tasks, { detail: true }), fg, width, height), width);
		}
		const details = renderTasksHub(data(tasks, { detail: true }), fg, 40, 10).join("\n");
		expect(details).toContain("Inspect auth flow");
	});
});
