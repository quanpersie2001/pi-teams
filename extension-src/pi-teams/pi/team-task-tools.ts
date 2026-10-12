// Child-session task tools use the same board but never launch nested execution.
import { createTasksTools } from "./tasks-tools.js";
export const TEAM_TASK_TOOL_NAMES = [
	"tasks_create",
	"tasks_list",
	"tasks_get",
	"tasks_update",
	"tasks_cancel",
] as const;
export function createTeamTaskTools(getBoard: Parameters<typeof createTasksTools>[0]) {
	return createTasksTools(getBoard).filter((tool) => (TEAM_TASK_TOOL_NAMES as readonly string[]).includes(tool.name));
}
