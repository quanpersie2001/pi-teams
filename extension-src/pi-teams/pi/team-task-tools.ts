export const TEAM_TASK_TOOL_NAMES = [
	"team_task_create",
	"team_task_update",
	"team_task_edit",
	"team_task_cancel",
	"team_task_get",
	"team_task_list",
] as const;

// Native task-board tool definitions shared by lead and teammate sessions.
// Results stay machine-readable JSON for the model; renderCall/renderResult do
// all terminal prettifying from the same data.

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { TaskBoardService } from "../app/task-board-service.js";

function result(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

// --- rendering --------------------------------------------------------------

const ID_DESCRIPTION = "Task short code (T3) or UUID";

// ANSI 24-bit colors for the glyph + status text only; titles stay default.
const PENDING_COLOR = "128;138;155"; // #808A9B
const BLOCKED_COLOR = "224;164;88"; // #E0A458
const IN_PROGRESS_COLOR = "79;195;247"; // #4FC3F7
const COMPLETED_COLOR = "126;224;129"; // #7EE081

/** Renderer-side shape of a TaskProjection, parsed defensively from result JSON. */
interface RenderedTask {
	code: string;
	title: string;
	description: string | undefined;
	status: "pending" | "in_progress" | "completed" | "cancelled";
	dependencies: string[];
	blockedBy: string[];
	owner: string | undefined;
}

function bold(text: string): string {
	return `\u001b[1m${text}\u001b[22m`;
}

function dim(text: string): string {
	return `\u001b[2m${text}\u001b[22m`;
}

function statusPaint(task: RenderedTask): { glyph: string; label: string; rgb: string } {
	if (task.status === "completed") return { glyph: "✓", label: "completed", rgb: COMPLETED_COLOR };
	if (task.status === "in_progress") return { glyph: "◉", label: "in_progress", rgb: IN_PROGRESS_COLOR };
	if (task.status === "cancelled") return { glyph: "⊘", label: "cancelled", rgb: PENDING_COLOR };
	if (task.blockedBy.length > 0) return { glyph: "◌", label: "blocked", rgb: BLOCKED_COLOR };
	return { glyph: "○", label: "pending", rgb: PENDING_COLOR };
}

function paintStatus(task: RenderedTask, withBlockers = false): string {
	const { glyph, label, rgb } = statusPaint(task);
	const painted = `\u001b[38;2;${rgb}m${glyph} ${label}${withBlockers ? blockedSuffix(task) : ""}\u001b[39m`;
	return task.status === "cancelled" ? dim(painted) : painted;
}

function statusWidth(task: RenderedTask, withBlockers: boolean): number {
	const { glyph, label } = statusPaint(task);
	return glyph.length + 1 + label.length + (withBlockers ? blockedSuffix(task).length : 0);
}

function blockedSuffix(task: RenderedTask): string {
	return task.blockedBy.length > 0 ? ` by ${task.blockedBy.join(", ")}` : "";
}

/** One-line summary: `T1  ◉ in_progress · @owner · blocked by T2`. */
function renderTaskLine(task: RenderedTask): string {
	const segments = [paintStatus(task)];
	if (task.owner !== undefined) segments.push(`· @${task.owner}`);
	if (task.blockedBy.length > 0) segments.push(`· blocked by ${task.blockedBy.join(", ")}`);
	return `${bold(task.code)}  ${segments.join(" ")}`;
}

/** Detail block for team_task_get. */
function renderTaskDetail(task: RenderedTask): string {
	const entries: Array<[string, string]> = [
		["Status", paintStatus(task, true)],
		["Owner", task.owner !== undefined ? `@${task.owner}` : "—"],
		["Depends on", task.dependencies.length > 0 ? task.dependencies.join(", ") : "—"],
	];
	if (task.description !== undefined) entries.push(["Description", task.description]);
	const lines = [`● ${bold(task.code)} · ${task.title}`];
	entries.forEach(([label, value], index) => {
		const branch = index === entries.length - 1 ? "└─ " : "│  ";
		lines.push(`${branch}${label.padEnd(12)}${value}`);
	});
	return lines.join("\n");
}

/** Task tree for team_task_list, newest (highest code) last. */
function renderTaskTree(tasks: RenderedTask[]): string {
	if (tasks.length === 0) return "● Team tasks\n└─ No tasks yet";
	const sorted = [...tasks].sort((a, b) => {
		const left = /^T(\d+)$/.exec(a.code);
		const right = /^T(\d+)$/.exec(b.code);
		if (left && right) return Number(left[1]) - Number(right[1]);
		if (left) return -1;
		if (right) return 1;
		return a.code.localeCompare(b.code);
	});
	const rows = sorted.map((task) => ({
		task,
		status: paintStatus(task, true),
		statusWidth: statusWidth(task, true),
		owner: task.owner !== undefined ? `@${task.owner}` : "—",
	}));
	const codeWidth = Math.max(...sorted.map((task) => task.code.length)) + 2;
	const statusColumn = Math.max(...rows.map((row) => row.statusWidth)) + 2;
	const ownerWidth = Math.max(...rows.map((row) => row.owner.length)) + 2;
	const lines = [`● Team tasks · ${sorted.length}`];
	rows.forEach((row, index) => {
		const branch = index === rows.length - 1 ? "└─ " : "├─ ";
		const content =
			`${bold(row.task.code)}${" ".repeat(codeWidth - row.task.code.length)}` +
			`${row.status}${" ".repeat(statusColumn - row.statusWidth)}` +
			`${row.owner.padEnd(ownerWidth)}${row.task.title}`;
		lines.push(`${branch}${row.task.status === "cancelled" ? dim(content) : content}`);
	});
	return lines.join("\n");
}

function asRenderedTask(value: unknown): RenderedTask | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.title !== "string") return undefined;
	if (
		raw.status !== "pending" &&
		raw.status !== "in_progress" &&
		raw.status !== "completed" &&
		raw.status !== "cancelled"
	)
		return undefined;
	const codes = (input: unknown): string[] =>
		Array.isArray(input) && input.every((item) => typeof item === "string") ? [...input] : [];
	return {
		code: typeof raw.code === "string" && raw.code.length > 0 ? raw.code : String(raw.id ?? "?"),
		title: raw.title,
		description: typeof raw.description === "string" ? raw.description : undefined,
		status: raw.status,
		dependencies: codes(raw.dependencies),
		blockedBy: codes(raw.blockedBy),
		owner: typeof raw.owner === "string" ? raw.owner : undefined,
	};
}

function parseTaskText(text: string): RenderedTask | RenderedTask[] | undefined {
	try {
		const value: unknown = JSON.parse(text);
		if (!Array.isArray(value)) return asRenderedTask(value);
		const tasks: RenderedTask[] = [];
		for (const item of value) {
			const task = asRenderedTask(item);
			if (!task) return undefined;
			tasks.push(task);
		}
		return tasks;
	} catch {
		return undefined;
	}
}

type TextResult = { content: ReadonlyArray<{ type: string; text?: string }> };

function resultText(result: TextResult): string {
	const first = result.content[0];
	return first !== undefined && first.type === "text" && typeof first.text === "string" ? first.text : "";
}

/** Render from the result JSON; on any surprise, fall back to the raw text. */
function renderTaskResult(result: TextResult, renderSingle: (task: RenderedTask) => string): string {
	const text = resultText(result);
	try {
		const parsed = parseTaskText(text);
		if (parsed === undefined) return text;
		if (Array.isArray(parsed)) return renderTaskTree(parsed);
		return renderSingle(parsed);
	} catch {
		return text;
	}
}

// --- tools ------------------------------------------------------------------

export function createTeamTaskTools(getBoard: () => TaskBoardService | undefined) {
	const active = () => {
		const board = getBoard();
		if (!board) throw new Error("No active team");
		return board;
	};
	return [
		defineTool({
			name: "team_task_create",
			label: "Create Team Task",
			description:
				"Create a shared team task, optionally blocked on existing tasks. Create prerequisite tasks first and pass their returned IDs in dependencies; a task with incomplete dependencies stays blocked and cannot be claimed until every prerequisite is completed. To retire a mistaken task, cancel it with team_task_cancel while it is pending (release the claim first if needed).",
			parameters: Type.Object({
				title: Type.String({ description: "Task title" }),
				description: Type.Optional(Type.String({ description: "Task description" })),
				dependencies: Type.Optional(
					Type.Array(Type.String(), { description: `Existing tasks (${ID_DESCRIPTION}) that must complete first` }),
				),
			}),
			renderCall: (args) =>
				new Text(`▸ team_task_create("${typeof args.title === "string" ? args.title : "?"}")`, 0, 0),
			renderResult: (result) => new Text(renderTaskResult(result, renderTaskLine), 0, 0),
			execute: async (_id: string, args: { title: string; description?: string; dependencies?: string[] }) => {
				return result(JSON.stringify(active().create(args)));
			},
		}),
		defineTool({
			name: "team_task_update",
			label: "Update Team Task",
			description:
				"Update a task's status along the lifecycle pending → in_progress (claim; you become the owner) → completed (terminal; cancelled via team_task_cancel is also terminal). A task must be claimed before it can be completed, and only the current owner can release or complete it. Set in_progress to claim a pending, unblocked task (or keep one you already own), pending to release your own claim, completed to finish a task you own.",
			parameters: Type.Object({
				id: Type.String({ description: ID_DESCRIPTION }),
				status: Type.Union([
					Type.Literal("pending", { description: "Release my own claim; the task returns to pending" }),
					Type.Literal("in_progress", { description: "Claim a pending, unblocked task; I become the owner" }),
					Type.Literal("completed", { description: "Finish a task I own; terminal" }),
				]),
			}),
			renderCall: (args) => {
				const id = typeof args.id === "string" ? args.id : "?";
				const status = typeof args.status === "string" ? args.status : "?";
				return new Text(`▸ team_task_update(${id} → ${status})`, 0, 0);
			},
			renderResult: (result) => new Text(renderTaskResult(result, renderTaskLine), 0, 0),
			execute: async (_id: string, args: { id: string; status: "pending" | "in_progress" | "completed" }) => {
				return result(JSON.stringify(active().update(args)));
			},
		}),
		defineTool({
			name: "team_task_edit",
			label: "Edit Team Task",
			description: "Edit the description of a pending team task.",
			parameters: Type.Object({
				id: Type.String({ description: ID_DESCRIPTION }),
				description: Type.String({ description: "New task description" }),
			}),
			renderCall: (args) => new Text(`▸ team_task_edit(${typeof args.id === "string" ? args.id : "?"})`, 0, 0),
			renderResult: (result) => new Text(renderTaskResult(result, renderTaskLine), 0, 0),
			execute: async (_id: string, args: { id: string; description: string }) => {
				return result(JSON.stringify(active().edit(args)));
			},
		}),
		defineTool({
			name: "team_task_cancel",
			label: "Cancel Team Task",
			description: "Cancel a pending team task that no other task depends on (release an in_progress claim first).",
			parameters: Type.Object({ id: Type.String({ description: ID_DESCRIPTION }) }),
			renderCall: (args) => new Text(`▸ team_task_cancel(${typeof args.id === "string" ? args.id : "?"})`, 0, 0),
			renderResult: (result) => new Text(renderTaskResult(result, renderTaskLine), 0, 0),
			execute: async (_id: string, args: { id: string }) => {
				return result(JSON.stringify(active().cancel({ id: args.id })));
			},
		}),
		defineTool({
			name: "team_task_get",
			label: "Get Team Task",
			description:
				"Get a shared team task and its current state; blockedBy lists prerequisite task IDs that are not yet completed.",
			parameters: Type.Object({ id: Type.String({ description: ID_DESCRIPTION }) }),
			renderCall: (args) => new Text(`▸ team_task_get(${typeof args.id === "string" ? args.id : "?"})`, 0, 0),
			renderResult: (result) => new Text(renderTaskResult(result, renderTaskDetail), 0, 0),
			execute: async (_id: string, args: { id: string }) => {
				const task = active().get(args.id);
				if (!task) throw new Error(`Unknown task: ${args.id}`);
				return result(JSON.stringify(task));
			},
		}),
		defineTool({
			name: "team_task_list",
			label: "List Team Tasks",
			description:
				"List shared team tasks and their current state; each task's blockedBy lists prerequisite task IDs that are not yet completed.",
			parameters: Type.Object({}),
			renderCall: () => new Text("▸ team_task_list()", 0, 0),
			renderResult: (result) => new Text(renderTaskResult(result, renderTaskLine), 0, 0),
			execute: async () => {
				return result(JSON.stringify(active().list()));
			},
		}),
	];
}
