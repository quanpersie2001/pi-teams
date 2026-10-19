import { defineTool, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { TaskBoardService } from "../app/task-board-service.js";
import type { TaskExecutionService } from "../app/task-execution-service.js";
import type { TaskContext, TaskSpec } from "../domain/task-board.js";
import { renderTaskList, type TaskRowView, taskRow } from "../features/tasks/index.js";
import { bindThemeFg } from "../shared/theme.js";

const defined = <T extends object>(value: T): T =>
	Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
const spec = (a: {
	acceptanceCriteria?: string[];
	scope?: { paths?: string[]; outOfScope?: string[] };
	constraints?: string[];
	expectedOutput?: string;
}): TaskSpec =>
	defined({
		acceptanceCriteria: a.acceptanceCriteria,
		scope: a.scope,
		constraints: a.constraints,
		expectedOutput: a.expectedOutput,
	}) as unknown as TaskSpec;
const context = (a: {
	background?: string;
	decisions?: string[];
	references?: { kind: "file" | "url" | "artifact"; target: string; note?: string }[];
}): TaskContext =>
	defined({ background: a.background, decisions: a.decisions, references: a.references }) as unknown as TaskContext;

const idSchema = Type.String({ description: "Task short code (T3) or UUID" });
const text = (value: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(value) }],
	details: undefined,
});

/** Text payload of a tool result (the model-facing contract). */
function resultText(result: { content?: readonly unknown[] }): string {
	const part = result.content?.[0];
	return part && typeof part === "object" && (part as { type?: unknown }).type === "text"
		? String((part as { text?: unknown }).text ?? "")
		: "";
}

function parseJson(textValue: string): unknown {
	try {
		return JSON.parse(textValue);
	} catch {
		return undefined;
	}
}

/** Tolerant projection of a task JSON payload onto the structural row view the
 *  shared task formatters consume. Unknown shapes return undefined so every
 *  renderer degrades to the verbatim text. */
function rowView(value: unknown): TaskRowView | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const task = value as Record<string, unknown>;
	if (typeof task.title !== "string" || typeof task.status !== "string") return undefined;
	const strings = (input: unknown): string[] | undefined =>
		Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : undefined;
	const attempts = Array.isArray(task.attempts)
		? task.attempts.flatMap((item) => {
				if (!item || typeof item !== "object") return [];
				const attempt = item as Record<string, unknown>;
				return typeof attempt.status === "string"
					? [
							{
								status: attempt.status,
								...(typeof attempt.teammateName === "string" ? { teammateName: attempt.teammateName } : {}),
								...(typeof attempt.runId === "string" ? { runId: attempt.runId } : {}),
							},
						]
					: [];
			})
		: undefined;
	const blockedBy = strings(task.blockedBy);
	return {
		id: typeof task.id === "string" ? task.id : "",
		...(typeof task.code === "string" ? { code: task.code } : {}),
		title: task.title,
		status: task.status,
		...(typeof task.assignee === "string" ? { assignee: task.assignee } : {}),
		...(typeof task.owner === "string" ? { owner: task.owner } : {}),
		...(blockedBy !== undefined ? { blockedBy } : {}),
		...(attempts !== undefined ? { attempts } : {}),
		...(typeof task.createdAt === "number" ? { createdAt: task.createdAt } : {}),
	};
}

function colorIndex(entries: readonly { name: string; color?: string | undefined }[]): Map<string, string> {
	const index = new Map<string, string>();
	for (const entry of entries) if (entry.color) index.set(entry.name, entry.color);
	return index;
}

/** Single hanging row: `<└─> <glyph> T3 @owner Title`. */
function rowCard(row: TaskRowView, colors: ReadonlyMap<string, string>, theme: Theme, suffix = ""): Component {
	const fg = bindThemeFg(theme);
	return new Text(`${fg("dim", "└─")} ${taskRow(row, colors, fg)}${suffix}`, 0, 0);
}

/** Bounded task list card; the width-aware renderer keeps branches aligned. */
function listCard(
	rows: readonly TaskRowView[],
	colors: ReadonlyMap<string, string>,
	theme: Theme,
	limit: number,
): Component {
	const fg = bindThemeFg(theme);
	return {
		invalidate() {},
		render: (width: number) => renderTaskList(rows, colors, fg, width, limit),
	};
}
export const TASK_TOOL_NAMES = [
	"tasks_create",
	"tasks_list",
	"tasks_get",
	"tasks_update",
	"tasks_cancel",
	"tasks_execute",
	"tasks_output",
	"tasks_stop",
] as const;
const scopeSchema = Type.Object({
	paths: Type.Optional(Type.Array(Type.String())),
	outOfScope: Type.Optional(Type.Array(Type.String())),
});
const referenceSchema = Type.Object({
	kind: Type.Union([Type.Literal("file"), Type.Literal("url"), Type.Literal("artifact")]),
	target: Type.String(),
	note: Type.Optional(Type.String()),
});
const verificationSchema = Type.Object({
	check: Type.String(),
	outcome: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_run")]),
	evidence: Type.Optional(Type.String()),
});
const executionPlanSchema = Type.Object({
	type: Type.String({ minLength: 1 }),
	name: Type.Optional(Type.String()),
	color: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
});
const outcomeSchema = Type.Object({
	summary: Type.Optional(Type.String()),
	artifacts: Type.Optional(Type.Array(Type.String())),
	verification: Type.Optional(Type.Array(verificationSchema)),
	remainingIssues: Type.Optional(Type.Array(Type.String())),
});

export function createTasksTools(
	getBoard: () => TaskBoardService | undefined,
	getExecution?: () => TaskExecutionService | undefined,
	getColors?: () => readonly { name: string; color?: string | undefined }[],
) {
	const board = () => {
		const value = getBoard();
		if (!value) throw new Error("No active team");
		return value;
	};
	const execution = () => {
		const value = getExecution?.();
		if (!value) throw new Error("Task execution unavailable");
		return value;
	};
	const colors = () => colorIndex(getColors?.() ?? []);
	return [
		defineTool({
			name: "tasks_create",
			label: "Create Task",
			description: "Create a task with requirements, context and prerequisites.",
			parameters: Type.Object({
				title: Type.String(),
				description: Type.Optional(Type.String()),
				dependencies: Type.Optional(Type.Array(Type.String())),
				acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
				scope: Type.Optional(scopeSchema),
				constraints: Type.Optional(Type.Array(Type.String())),
				expectedOutput: Type.Optional(Type.String()),
				background: Type.Optional(Type.String()),
				decisions: Type.Optional(Type.Array(Type.String())),
				references: Type.Optional(Type.Array(referenceSchema)),
				assignee: Type.Optional(Type.String()),
				reviewRequested: Type.Optional(Type.Boolean()),
				executionPlan: Type.Optional(executionPlanSchema),
			}),
			renderCall: (args) => new Text(`▸ tasks_create · ${String(args.title)}`, 0, 0),
			renderResult: (result, options, theme) => {
				const row = rowView(parseJson(resultText(result)));
				if (!row || options.expanded) return new Text(resultText(result), 0, 0);
				return rowCard(row, colors(), theme);
			},
			execute: async (_id, args) =>
				text(
					board().create({
						title: args.title,
						...(args.description !== undefined ? { description: args.description } : {}),
						...(args.dependencies !== undefined ? { dependencies: args.dependencies } : {}),
						spec: spec(args),
						context: context(args),
						...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
						...(args.reviewRequested !== undefined ? { reviewRequested: args.reviewRequested } : {}),
						...(args.executionPlan !== undefined ? { executionPlan: args.executionPlan } : {}),
					}),
				),
		}),
		defineTool({
			name: "tasks_list",
			label: "List Tasks",
			description: "List unified session tasks with optional status, assignee, owner, blocker, and text filters.",
			parameters: Type.Object({
				status: Type.Optional(
					Type.Union([
						Type.Literal("pending"),
						Type.Literal("in_progress"),
						Type.Literal("in_review"),
						Type.Literal("completed"),
						Type.Literal("cancelled"),
					]),
				),
				assignee: Type.Optional(Type.String()),
				owner: Type.Optional(Type.String()),
				blocked: Type.Optional(Type.Boolean()),
				query: Type.Optional(Type.String()),
			}),
			renderCall: (args) => new Text(`▸ tasks_list${args.status ? ` · ${String(args.status)}` : ""}`, 0, 0),
			renderResult: (result, options, theme) => {
				const value = parseJson(resultText(result));
				const rows = Array.isArray(value)
					? value.flatMap((item) => {
							const row = rowView(item);
							return row ? [row] : [];
						})
					: [];
				if (!rows.length) return new Text(resultText(result), 0, 0);
				return listCard(rows, colors(), theme, options.expanded ? rows.length : 3);
			},
			execute: async (_id, args) => text(board().list(args)),
		}),
		defineTool({
			name: "tasks_get",
			label: "Get Task",
			description: "Get a task and attempt history.",
			parameters: Type.Object({ id: idSchema }),
			renderCall: (args) => new Text(`▸ tasks_get ${String(args.id)}`, 0, 0),
			renderResult: (result, options, theme) => {
				const row = rowView(parseJson(resultText(result)));
				if (!row || options.expanded) return new Text(resultText(result), 0, 0);
				return rowCard(row, colors(), theme);
			},
			execute: async (_id, args) => {
				const task = board().get(args.id);
				if (!task) throw new Error(`Unknown task: ${args.id}`);
				return text(task);
			},
		}),
		defineTool({
			name: "tasks_update",
			label: "Update Task",
			description:
				"Update pending requirements/dependencies or transition status. Only the owner may release or submit; lead may accept. Active requirements cannot change.",
			parameters: Type.Object({
				id: idSchema,
				expectedRequirementRevision: Type.Optional(Type.Integer({ minimum: 1 })),
				status: Type.Optional(
					Type.Union([
						Type.Literal("pending"),
						Type.Literal("in_progress"),
						Type.Literal("in_review"),
						Type.Literal("completed"),
					]),
				),
				title: Type.Optional(Type.String()),
				description: Type.Optional(Type.String()),
				dependencies: Type.Optional(Type.Array(Type.String())),
				acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
				scope: Type.Optional(scopeSchema),
				constraints: Type.Optional(Type.Array(Type.String())),
				expectedOutput: Type.Optional(Type.String()),
				background: Type.Optional(Type.String()),
				decisions: Type.Optional(Type.Array(Type.String())),
				references: Type.Optional(Type.Array(referenceSchema)),
				assignee: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				reviewRequested: Type.Optional(Type.Boolean()),
				executionPlan: Type.Optional(Type.Union([executionPlanSchema, Type.Null()])),
				outcome: Type.Optional(outcomeSchema),
			}),
			renderCall: (args) =>
				new Text(`▸ tasks_update ${String(args.id)}${args.status ? ` · ${String(args.status)}` : ""}`, 0, 0),
			renderResult: (result, options, theme) => {
				const row = rowView(parseJson(resultText(result)));
				if (!row || options.expanded) return new Text(resultText(result), 0, 0);
				return rowCard(row, colors(), theme);
			},
			execute: async (_id, args) =>
				text(
					board().update({
						id: args.id,
						...(args.expectedRequirementRevision !== undefined
							? { expectedRequirementRevision: args.expectedRequirementRevision }
							: {}),
						...(args.status !== undefined ? { status: args.status } : {}),
						...(args.title !== undefined ? { title: args.title } : {}),
						...(args.description !== undefined ? { description: args.description } : {}),
						...(args.dependencies !== undefined ? { dependencies: args.dependencies } : {}),
						...(args.acceptanceCriteria !== undefined ||
						args.scope !== undefined ||
						args.constraints !== undefined ||
						args.expectedOutput !== undefined
							? { spec: spec(args) }
							: {}),
						...(args.background !== undefined || args.decisions !== undefined || args.references !== undefined
							? { context: context(args) }
							: {}),
						...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
						...(args.reviewRequested !== undefined ? { reviewRequested: args.reviewRequested } : {}),
						...(args.executionPlan !== undefined ? { executionPlan: args.executionPlan } : {}),
						...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
					}),
				),
		}),
		defineTool({
			name: "tasks_cancel",
			label: "Cancel Task",
			description: "Cancel a pending task without dependents.",
			parameters: Type.Object({ id: idSchema }),
			renderCall: (args) => new Text(`▸ tasks_cancel ${String(args.id)}`, 0, 0),
			renderResult: (result, options, theme) => {
				const row = rowView(parseJson(resultText(result)));
				if (!row || options.expanded) return new Text(resultText(result), 0, 0);
				return rowCard(row, colors(), theme);
			},
			execute: async (_id, args) => text(board().cancel({ id: args.id })),
		}),
		defineTool({
			name: "tasks_execute",
			label: "Execute Task",
			description:
				"Execute an unblocked pending or claimed task through the existing runtime. Reservation and teammate handoff are atomic; completion requires explicit acceptance.",
			parameters: Type.Object({
				id: idSchema,
				type: Type.String({ description: "Agent definition type" }),
				name: Type.Optional(Type.String()),
				color: Type.Optional(Type.String()),
				additionalContext: Type.Optional(Type.String()),
				model: Type.Optional(Type.String()),
				maxTurns: Type.Optional(Type.Number({ minimum: 1 })),
			}),
			renderCall: (args) => new Text(`▸ tasks_execute ${String(args.id)} → ${String(args.type)}`, 0, 0),
			renderResult: (result, options, theme) => {
				const value = parseJson(resultText(result));
				const task = value && typeof value === "object" ? (value as { task?: unknown }).task : undefined;
				const row = rowView(task);
				if (!row || options.expanded) return new Text(resultText(result), 0, 0);
				const teammate = row.attempts?.at(-1)?.teammateName;
				return rowCard(row, colors(), theme, teammate ? ` ${bindThemeFg(theme)("dim", `→ @${teammate}`)}` : "");
			},
			execute: async (_id, args) =>
				text(
					await execution().execute(args.id, {
						actor: { name: board().self, coordinator: board().self === "lead" },
						type: args.type,
						...(args.name !== undefined ? { name: args.name } : {}),
						...(args.color !== undefined ? { color: args.color } : {}),
						...(args.additionalContext !== undefined ? { additionalContext: args.additionalContext } : {}),
						...(args.model !== undefined ? { model: args.model } : {}),
						...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
					}),
				),
		}),
		defineTool({
			name: "tasks_output",
			label: "Task Output",
			description: "Read output from the latest execution attempt.",
			parameters: Type.Object({ id: idSchema, wait: Type.Optional(Type.Boolean()) }),
			renderCall: (args) => new Text(`▸ tasks_output ${String(args.id)}${args.wait === true ? " · wait" : ""}`, 0, 0),
			renderResult: (result, options, theme) => {
				const value = parseJson(resultText(result));
				if (!value || typeof value !== "object" || Array.isArray(value)) return new Text(resultText(result), 0, 0);
				const output = value as { attempt?: unknown; result?: unknown; error?: unknown };
				const attempt = output.attempt && typeof output.attempt === "object" ? output.attempt : {};
				const status =
					typeof (attempt as { status?: unknown }).status === "string"
						? String((attempt as { status?: unknown }).status)
						: "";
				const teammate =
					typeof (attempt as { teammateName?: unknown }).teammateName === "string"
						? String((attempt as { teammateName?: unknown }).teammateName)
						: "";
				if (!status) return new Text(resultText(result), 0, 0);
				const fg = bindThemeFg(theme);
				const lines = [
					`${fg("dim", "└─")} ${fg("text", status)}${teammate ? ` · ${fg("muted", `@${teammate}`)}` : ""}`,
				];
				if (typeof output.error === "string") lines.push(`  ${fg("error", `ERROR ${output.error}`)}`);
				if (typeof output.result === "string" && output.result.trim()) {
					const body = output.result
						.split("\n")
						.map((line) => line.trimEnd())
						.filter(Boolean);
					const shown = options.expanded ? body : body.slice(0, 2);
					lines.push(...shown.map((line) => `  ${fg("dim", line)}`));
					if (body.length > shown.length) lines.push(`  ${fg("dim", `… ${body.length - shown.length} more`)}`);
				}
				return new Text(lines.join("\n"), 0, 0);
			},
			execute: async (_id, args, signal) =>
				text(
					await execution().output(args.id, {
						actor: { name: board().self, coordinator: board().self === "lead" },
						...(args.wait !== undefined ? { wait: args.wait } : {}),
						...(signal !== undefined ? { signal } : {}),
					}),
				),
		}),
		defineTool({
			name: "tasks_stop",
			label: "Stop Task",
			description: "Request stop of a running execution; stop does not complete the task.",
			parameters: Type.Object({ id: idSchema }),
			renderCall: (args) => new Text(`▸ tasks_stop ${String(args.id)}`, 0, 0),
			renderResult: (result, _options, theme) => {
				const value = parseJson(resultText(result));
				const stopped = value && typeof value === "object" && (value as { stopped?: unknown }).stopped === true;
				const fg = bindThemeFg(theme);
				return new Text(
					`${fg("dim", "└─")} ${fg(stopped ? "dim" : "muted", stopped ? "stop requested" : "no running attempt")}`,
					0,
					0,
				);
			},
			execute: async (_id, args) =>
				text({
					stopped: await execution().stop(args.id, {
						actor: { name: board().self, coordinator: board().self === "lead" },
					}),
				}),
		}),
	];
}
