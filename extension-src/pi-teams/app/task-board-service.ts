// Synchronous durable task board (ADR 0007 §4).

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMailboxAddress } from "../domain/mailbox.js";
import {
	type BoardTask,
	isTaskId,
	parseBoardTask,
	type TaskProjection,
	type TaskStatus,
} from "../domain/task-board.js";

export interface TaskBoardServiceOptions {
	teamDir: string;
	self: string;
	now?: () => number;
}

export class TaskBoardService {
	readonly taskDir: string;
	private readonly self: string;
	private readonly now: () => number;

	constructor(options: TaskBoardServiceOptions) {
		if (!isMailboxAddress(options.self)) throw new Error("Invalid task board participant name");
		this.taskDir = join(options.teamDir, "tasks");
		this.self = options.self;
		this.now = options.now ?? (() => Date.now());
		mkdirSync(this.taskDir, { recursive: true, mode: 0o700 });
		chmodSync(this.taskDir, 0o700);
	}

	create(input: { title: string; description?: string; dependencies?: string[] }): TaskProjection {
		if (typeof input.title !== "string" || input.title.length === 0) throw new Error("Task title must not be empty");
		if (input.description !== undefined && typeof input.description !== "string")
			throw new Error("Task description must be text");
		const dependencies = input.dependencies ?? [];
		if (
			!Array.isArray(dependencies) ||
			!dependencies.every(isTaskId) ||
			new Set(dependencies).size !== dependencies.length
		)
			throw new Error("Task dependencies must be unique existing task IDs");
		for (const id of dependencies) if (!this.read(id)) throw new Error(`Unknown task dependency: ${id}`);
		const id = randomUUID();
		const at = this.now();
		const task: BoardTask = {
			id,
			title: input.title,
			...(input.description === undefined ? {} : { description: input.description }),
			status: "pending",
			dependencies,
			createdAt: at,
			updatedAt: at,
		};
		this.write(task);
		return this.project(task);
	}

	update(input: { id: string; status: TaskStatus }): TaskProjection {
		if (!isTaskId(input.id)) throw new Error("Invalid task ID");
		if (input.status !== "pending" && input.status !== "in_progress" && input.status !== "completed")
			throw new Error("Invalid task status");
		return this.withTaskLock(input.id, () => {
			const task = this.read(input.id);
			if (!task) throw new Error(`Unknown task: ${input.id}`);
			if (task.status === "completed") throw new Error("Completed tasks are terminal");
			if (input.status === "in_progress") {
				if (task.status === "pending") {
					const blockedBy = this.blockedBy(task);
					if (blockedBy.length) throw new Error(`Task is blocked by: ${blockedBy.join(", ")}`);
					task.status = "in_progress";
					task.owner = this.self;
				} else if (task.owner !== this.self) throw new Error(`Task is owned by ${task.owner}`);
			} else if (input.status === "pending") {
				if (task.status !== "in_progress" || task.owner !== this.self)
					throw new Error("Only the task owner can release it");
				task.status = "pending";
				delete task.owner;
			} else {
				if (task.status !== "in_progress" || task.owner !== this.self)
					throw new Error("Only the task owner can complete it");
				task.status = "completed";
				delete task.owner;
			}
			task.updatedAt = this.now();
			this.write(task);
			return this.project(task);
		});
	}

	get(id: string): TaskProjection | undefined {
		if (!isTaskId(id)) throw new Error("Invalid task ID");
		const task = this.read(id);
		return task ? this.project(task) : undefined;
	}

	list(): TaskProjection[] {
		return readdirSync(this.taskDir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => this.read(name.slice(0, -5)))
			.filter((task): task is BoardTask => task !== undefined)
			.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
			.map((task) => this.project(task));
	}

	private blockedBy(task: BoardTask): string[] {
		return task.dependencies.filter((id) => this.read(id)?.status !== "completed");
	}

	private project(task: BoardTask): TaskProjection {
		return { ...task, dependencies: [...task.dependencies], blockedBy: this.blockedBy(task) };
	}

	private read(id: string): BoardTask | undefined {
		const file = join(this.taskDir, `${id}.json`);
		try {
			const task = parseBoardTask(JSON.parse(readFileSync(file, "utf8")));
			if (!task || task.id !== id) throw new Error(`Malformed task file: ${file}`);
			return task;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	private write(task: BoardTask): void {
		const target = join(this.taskDir, `${task.id}.json`);
		const temporary = join(this.taskDir, `.${task.id}.${randomUUID()}.tmp`);
		try {
			writeFileSync(temporary, JSON.stringify(task), { mode: 0o600, flag: "wx" });
			chmodSync(temporary, 0o600);
			renameSync(temporary, target);
		} finally {
			rmSync(temporary, { force: true });
		}
	}

	private withTaskLock<T>(id: string, operation: () => T): T {
		const lock = join(this.taskDir, `${id}.lock`);
		try {
			mkdirSync(lock, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Task update conflict: ${id} is locked`);
			throw error;
		}
		try {
			return operation();
		} finally {
			rmSync(lock, { recursive: true, force: true });
		}
	}
}
