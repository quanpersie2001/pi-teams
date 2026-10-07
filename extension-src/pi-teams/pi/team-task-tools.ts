export const TEAM_TASK_TOOL_NAMES = [
	"team_task_create",
	"team_task_update",
	"team_task_list",
	"team_task_get",
] as const;

// Native task-board tool definitions shared by lead and teammate sessions.

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TaskBoardService } from "../app/task-board-service.js";

function result(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

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
			description: "Create a shared team task, optionally blocked on existing task IDs.",
			parameters: Type.Object({
				title: Type.String({ description: "Task title" }),
				description: Type.Optional(Type.String({ description: "Task description" })),
				dependencies: Type.Optional(
					Type.Array(Type.String(), { description: "Existing task IDs that must complete first" }),
				),
			}),
			execute: async (_id: string, args: { title: string; description?: string; dependencies?: string[] }) => {
				return result(JSON.stringify(active().create(args)));
			},
		}),
		defineTool({
			name: "team_task_update",
			label: "Update Team Task",
			description: "Claim a pending task, release your own task, or complete a task you own.",
			parameters: Type.Object({
				id: Type.String({ description: "Task ID" }),
				status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
			}),
			execute: async (_id: string, args: { id: string; status: "pending" | "in_progress" | "completed" }) => {
				return result(JSON.stringify(active().update(args)));
			},
		}),
		defineTool({
			name: "team_task_get",
			label: "Get Team Task",
			description: "Get a shared team task and its current dependency blockers.",
			parameters: Type.Object({ id: Type.String({ description: "Task ID" }) }),
			execute: async (_id: string, args: { id: string }) => {
				const task = active().get(args.id);
				if (!task) throw new Error(`Unknown task: ${args.id}`);
				return result(JSON.stringify(task));
			},
		}),
		defineTool({
			name: "team_task_list",
			label: "List Team Tasks",
			description: "List shared team tasks and their current dependency blockers.",
			parameters: Type.Object({}),
			execute: async () => {
				return result(JSON.stringify(active().list()));
			},
		}),
	];
}
