// Tool surfaces and terminal rendering for the native team task tools (ADR 0007 §4).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskBoardService } from "../../extension-src/pi-teams/app/task-board-service.js";
import { createTeamTaskTools } from "../../extension-src/pi-teams/pi/team-task-tools.js";

let root: string | undefined;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function board(): TaskBoardService {
	root = mkdtempSync(join(tmpdir(), "team-task-tools-"));
	return new TaskBoardService({ teamDir: join(root, "team"), self: "lead", now: () => 42 });
}

type ToolResult = { content: Array<{ type: string; text?: string }>; details: unknown };
type TaskTool = {
	name: string;
	renderCall?: (args: unknown, theme: unknown, context: unknown) => { render(width: number): string[] };
	renderResult?: (
		result: ToolResult,
		options: unknown,
		theme: unknown,
		context: unknown,
	) => { render(width: number): string[] };
	execute: (id: string, args: unknown, signal: undefined, onUpdate: undefined, ctx: never) => Promise<ToolResult>;
};

function tool(service: TaskBoardService, name: string): TaskTool {
	const found = createTeamTaskTools(() => service).find((candidate) => candidate.name === name);
	if (!found) throw new Error(`Tool ${name} is unavailable`);
	return found as TaskTool;
}

async function run(service: TaskBoardService, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
	const raw = await tool(service, name).execute("call", args, undefined, undefined, undefined as never);
	const text = raw.content[0];
	if (text?.type !== "text") throw new Error("Tool returned no text");
	return JSON.parse(text.text);
}

function rendered(component: { render(width: number): string[] }): string {
	return component.render(200).join("\n");
}

describe("team task tools", () => {
	it("assigns short codes T1 then T2 on create", async () => {
		const service = board();
		const first = (await run(service, "team_task_create", { title: "First" })) as { code?: string };
		const second = (await run(service, "team_task_create", { title: "Second" })) as { code?: string };
		expect(first.code).toBe("T1");
		expect(second.code).toBe("T2");
	});

	it("resolves create dependencies by short code", async () => {
		const service = board();
		await run(service, "team_task_create", { title: "First" });
		const blocked = (await run(service, "team_task_create", {
			title: "Second",
			dependencies: ["T1"],
		})) as { blockedBy: string[]; dependencies: string[] };
		expect(blocked.dependencies).toEqual(["T1"]);
		expect(blocked.blockedBy).toEqual(["T1"]);
	});

	it("updates by short code and records the owner", async () => {
		const service = board();
		await run(service, "team_task_create", { title: "First" });
		const claimed = (await run(service, "team_task_update", { id: "T1", status: "in_progress" })) as {
			status: string;
			owner?: string;
		};
		expect(claimed.status).toBe("in_progress");
		expect(claimed.owner).toBe("lead");
	});

	it("edits the description of a pending task", async () => {
		const service = board();
		await run(service, "team_task_create", { title: "First", description: "Old" });
		const edited = (await run(service, "team_task_edit", { id: "T1", description: "New plan" })) as {
			description?: string;
		};
		expect(edited.description).toBe("New plan");
	});

	it("cancels a pending task with no dependents", async () => {
		const service = board();
		await run(service, "team_task_create", { title: "First" });
		const cancelled = (await run(service, "team_task_cancel", { id: "T1" })) as { status: string };
		expect(cancelled.status).toBe("cancelled");
	});

	it("lists projections including cancelled tasks, sorted by code", async () => {
		const service = board();
		await run(service, "team_task_create", { title: "First" });
		await run(service, "team_task_create", { title: "Second" });
		await run(service, "team_task_cancel", { id: "T1" });
		const tasks = (await run(service, "team_task_list")) as Array<{ code?: string; status: string }>;
		expect(tasks.map((task) => [task.code, task.status])).toEqual([
			["T1", "cancelled"],
			["T2", "pending"],
		]);
	});

	it("gets a task by short code", async () => {
		const service = board();
		await run(service, "team_task_create", { title: "First" });
		const task = (await run(service, "team_task_get", { id: "T1" })) as { title: string; code?: string };
		expect(task.code).toBe("T1");
		expect(task.title).toBe("First");
	});

	it("throws Unknown task for an unknown short code", async () => {
		const service = board();
		await expect(run(service, "team_task_get", { id: "T9" })).rejects.toThrow("Unknown task: T9");
	});

	it("renders compact one-line calls", () => {
		const service = board();
		const create = tool(service, "team_task_create");
		const update = tool(service, "team_task_update");
		const list = tool(service, "team_task_list");
		if (!create.renderCall || !update.renderCall || !list.renderCall) throw new Error("renderCall is unavailable");
		expect(rendered(create.renderCall({ title: "Ship docs" }, undefined, undefined))).toContain(
			'▸ team_task_create("Ship docs")',
		);
		expect(rendered(update.renderCall({ id: "T1", status: "in_progress" }, undefined, undefined))).toContain(
			"▸ team_task_update(T1 → in_progress)",
		);
		expect(rendered(list.renderCall({}, undefined, undefined))).toContain("▸ team_task_list()");
	});

	it("renders single-task results with status glyph, owner and blockers", async () => {
		const service = board();
		await run(service, "team_task_create", { title: "Endpoint module" });
		const claimed = await tool(service, "team_task_update").execute(
			"call",
			{ id: "T1", status: "in_progress" },
			undefined,
			undefined,
			undefined as never,
		);
		const update = tool(service, "team_task_update");
		if (!update.renderResult) throw new Error("renderResult is unavailable");
		expect(
			rendered(update.renderResult(claimed, { expanded: false, isPartial: false }, undefined, undefined)),
		).toContain("◉ in_progress");

		await run(service, "team_task_create", { title: "Blocked task", dependencies: ["T1"] });
		const detail = await tool(service, "team_task_get").execute(
			"call",
			{ id: "T2" },
			undefined,
			undefined,
			undefined as never,
		);
		const get = tool(service, "team_task_get");
		if (!get.renderResult) throw new Error("renderResult is unavailable");
		const block = rendered(get.renderResult(detail, { expanded: false, isPartial: false }, undefined, undefined));
		expect(block).toContain("◌ blocked by T1");
		expect(block).toContain("Depends on  T1");
		expect(block).toContain("Blocked task");
	});

	it("renders the task list tree and the empty board", async () => {
		const empty = board();
		const listEmpty = tool(empty, "team_task_list");
		if (!listEmpty.renderResult) throw new Error("renderResult is unavailable");
		const emptyRaw = await listEmpty.execute("call", {}, undefined, undefined, undefined as never);
		expect(
			rendered(listEmpty.renderResult(emptyRaw, { expanded: false, isPartial: false }, undefined, undefined)),
		).toContain("No tasks yet");

		const service = board();
		await run(service, "team_task_create", { title: "First" });
		await run(service, "team_task_create", { title: "Second" });
		await run(service, "team_task_cancel", { id: "T2" });
		const list = tool(service, "team_task_list");
		if (!list.renderResult) throw new Error("renderResult is unavailable");
		const raw = await list.execute("call", {}, undefined, undefined, undefined as never);
		const tree = rendered(list.renderResult(raw, { expanded: false, isPartial: false }, undefined, undefined));
		expect(tree).toContain("Team tasks · 2");
		expect(tree).toContain("T1");
		expect(tree).toContain("○ pending");
		expect(tree).toContain("⊘ cancelled");
	});

	it("falls back to the raw text when the result is not task JSON", () => {
		const service = board();
		const get = tool(service, "team_task_get");
		if (!get.renderResult) throw new Error("renderResult is unavailable");
		const fallback = get.renderResult(
			{ content: [{ type: "text", text: "not json" }], details: undefined },
			{ expanded: false, isPartial: false },
			undefined,
			undefined,
		);
		expect(rendered(fallback)).toContain("not json");
	});
});
