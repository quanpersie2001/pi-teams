// Task board contracts and validation (ADR 0007 §4).

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface BoardTask {
	id: string;
	title: string;
	description?: string;
	status: TaskStatus;
	dependencies: string[];
	owner?: string;
	createdAt: number;
	updatedAt: number;
}

export interface TaskProjection extends BoardTask {
	blockedBy: string[];
}

export function isTaskId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

export function parseBoardTask(value: unknown): BoardTask | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (
		!isTaskId(raw.id) ||
		typeof raw.title !== "string" ||
		raw.title.length === 0 ||
		(raw.description !== undefined && typeof raw.description !== "string") ||
		(raw.status !== "pending" && raw.status !== "in_progress" && raw.status !== "completed") ||
		!Array.isArray(raw.dependencies) ||
		!raw.dependencies.every(isTaskId) ||
		(raw.owner !== undefined &&
			(typeof raw.owner !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw.owner))) ||
		!Number.isSafeInteger(raw.createdAt) ||
		!Number.isSafeInteger(raw.updatedAt)
	)
		return undefined;
	if ((raw.status === "in_progress") !== (raw.owner !== undefined)) return undefined;
	return {
		id: raw.id,
		title: raw.title,
		...(raw.description === undefined ? {} : { description: raw.description }),
		status: raw.status,
		dependencies: [...raw.dependencies] as string[],
		...(raw.owner === undefined ? {} : { owner: raw.owner as string }),
		createdAt: raw.createdAt as number,
		updatedAt: raw.updatedAt as number,
	};
}
