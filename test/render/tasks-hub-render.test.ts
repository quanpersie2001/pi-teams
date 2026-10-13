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

	it("renders flat rows and colors task identity from exact roster color independently of status", () => {
		const tasks = [
			task({ id: "one", assignee: "reviewer", blockedBy: ["T2"] }),
			task({ id: "two", status: "in_progress", owner: "reviewer" }),
			task({ id: "three", title: "Unblocked", status: "pending" }),
		];
		const colors = new Map([["reviewer", "#E879F9"]]);
		const text = renderTasksHub(data(tasks, { rosterColors: colors }), fg, 110, 20).join("\n");
		expect(text).not.toContain("├─");
		expect(text).not.toContain("└─");
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
		const retriedRow = retriedText.split("\n").find((line) => line.includes("Inspect auth flow")) ?? "";
		expect(retriedRow).not.toContain(fg("error", "!"));
		expect(retriedRow).toContain("\x1b[38;2;59;130;246m◼\x1b[39m");
		expect(retried.attempts[0]?.status).toBe("failed");
		const cancelledText = renderTasksHub(data([cancelled]), fg, 100, 12).join("\n");
		const cancelledRow = cancelledText.split("\n").find((line) => line.includes("Inspect auth flow")) ?? "";
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
		expect(renderTasksHub(data([running], { runs: [run("live", "running", 2048)], now: 5_000, detail: true }), fg, 60, 20).join("\n")).toContain("Run metrics");
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
		const detail = renderTasksHub(data([completed, pending], { rosterColors: colors, detail: true }), fg, 120, 40).join("\n");
		expect(detail).toContain("Artifact: report.md");
		expect(detail).toContain("Remaining issue: Follow up");
		expect(detail).toContain("run-done");
		expect(detail).toContain("T2");
		expect(detail).toContain("result");
		expect(completed.attempts[0]?.resultFile).toBe("/tmp/result.txt");
	});

	it("routes list, preview and detail-only wheel movement to the correct region", () => {
		const wheel: Array<[number, string, number]> = [];
		const tui = { terminal: { rows: 12, columns: 80 } } as never;
		const component = createTasksHubComponent(
			tui,
			theme,
			() => data([task()]),
			undefined,
			(delta, region, max) => wheel.push([delta, region, max]),
		);
		component.render(80);
		component.handleMouse?.({ type: "wheel", wheelDelta: -1, x: 70, y: 4 } as never);
		expect(wheel[0]?.slice(0, 2)).toEqual([-1, "details"]);
		component.handleMouse?.({ type: "wheel", wheelDelta: 1, x: 4, y: 4 } as never);
		expect(wheel[1]?.slice(0, 2)).toEqual([1, "list"]);
		const detailComponent = createTasksHubComponent(
			tui, theme, () => data([task()], { detail: true }), undefined,
			(delta, region, max) => wheel.push([delta, region, max]),
		);
		detailComponent.render(60);
		detailComponent.handleMouse?.({ type: "wheel", wheelDelta: -1, x: 4, y: 4 } as never);
		expect(wheel[2]?.slice(0, 2)).toEqual([-1, "details"]);
	});

	it("maps clicks to the exact visible task lines, including a scrolled first row", () => {
		const tasks = Array.from({ length: 20 }, (_, index) => task({ id: `task-${index}`, code: `T${index}` }));
		const selected: string[] = [];
		const tui = { terminal: { rows: 12, columns: 80 } } as never;
		const component = createTasksHubComponent(tui, theme, () => data(tasks), (id) => selected.push(id));
		component.render(80);
		const event = (y: number) => ({ type: "click", button: "left", x: 3, y }) as never;
		component.handleMouse?.(event(1)); // Search
		component.handleMouse?.(event(9)); // Last visible task
		component.handleMouse?.(event(10)); // Footer
		component.handleMouse?.(event(11)); // Bottom border
		expect(selected).toEqual(["task-7"]);
		const scrolled = createTasksHubComponent(tui, theme, () => data(tasks, { selection: "task-16" }), (id) => selected.push(id));
		scrolled.render(80);
		scrolled.handleMouse?.(event(1)); // Search is scrolled away; first visible task is T8.
		expect(selected.at(-1)).toBe("task-8");
	});

	it("renders structured detail sections with Markdown formatting", () => {
		const selected = task({
			description: "Summary **bold** and multiline\ntext.\n\n| Field | Value |\n| --- | --- |\n| Kind | Markdown |\n\n```ts\nconst ready = true;\n```",
			spec: { acceptanceCriteria: ["First", "Second"], expectedOutput: "A report" },
			outcome: { summary: "Done", verification: [{ check: "typecheck", outcome: "passed", evidence: "clean" }] },
		});
		const text = renderTasksHub(data([selected], { detail: true }), fg, 80, 60).join("\n");
		const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
		expect(plain).toContain("Acceptance criteria");
		expect(plain).toContain("First");
		expect(plain).toContain("┌");
		expect(plain).toContain("Verification");
		expect(plain).toContain("passed");
		expect(plain).toContain("Field");
		expect(plain).toContain("Kind");
		expect(plain).toContain("const ready = true;");
		expect(plain).toContain("```ts");
		expect(text).toContain("\x1b[38;2;215;135;255mconst\x1b[39m");
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
