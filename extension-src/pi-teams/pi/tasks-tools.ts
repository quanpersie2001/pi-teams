import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TaskBoardService } from "../app/task-board-service.js";
import type { TaskExecutionService } from "../app/task-execution-service.js";
import type { TaskContext, TaskSpec } from "../domain/task-board.js";

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
			execute: async (_id, args) => text(board().list(args)),
		}),
		defineTool({
			name: "tasks_get",
			label: "Get Task",
			description: "Get a task and attempt history.",
			parameters: Type.Object({ id: idSchema }),
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
			execute: async (_id, args) =>
				text({
					stopped: await execution().stop(args.id, {
						actor: { name: board().self, coordinator: board().self === "lead" },
					}),
				}),
		}),
	];
}
