// Synchronous durable task board (ADR 0007 §4).

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMailboxAddress } from "../domain/mailbox.js";
import {
	type BoardTask,
	isTaskCode,
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
		if (!Array.isArray(dependencies) || !dependencies.every(isTaskId))
			throw new Error("Task dependencies must be unique existing task IDs");
		return this.withCodeLock(() => {
			const board = this.scan();
			const resolved = dependencies.map((reference) => {
				const dependency = board.find((task) => task.id === reference || task.code === reference);
				if (!dependency) throw new Error(`Unknown task dependency: ${reference}`);
				return dependency.id;
			});
			if (new Set(resolved).size !== resolved.length)
				throw new Error("Task dependencies must be unique existing task IDs");
			const id = randomUUID();
			const at = this.now();
			const next = board.reduce((max, task) => Math.max(max, task.code ? Number(task.code.slice(1)) : 0), 0) + 1;
			const task: BoardTask = {
				id,
				code: `T${next}`,
				title: input.title,
				...(input.description === undefined ? {} : { description: input.description }),
				status: "pending",
				dependencies: resolved,
				createdAt: at,
				updatedAt: at,
			};
			this.write(task);
			return this.project(task);
		});
	}

	update(input: { id: string; status: TaskStatus }): TaskProjection {
		if (!isTaskId(input.id)) throw new Error("Invalid task ID");
		if (input.status === "cancelled") throw new Error("Task cancellation requires team_task_cancel");
		if (input.status !== "pending" && input.status !== "in_progress" && input.status !== "completed")
			throw new Error("Invalid task status");
		const target = this.resolve(input.id);
		return this.withTaskLock(target.id, () => {
			const task = this.read(target.id);
			if (!task) throw new Error(`Unknown task: ${input.id}`);
			if (task.status === "completed" || task.status === "cancelled")
				throw new Error(`${this.label(task)} is ${task.status} - terminal, no further updates`);
			if (input.status === "in_progress") {
				if (task.status === "pending") {
					const blockedBy = this.blockedBy(task);
					if (blockedBy.length) throw new Error(`${this.label(task)} is blocked by: ${blockedBy.join(", ")}`);
					task.status = "in_progress";
					task.owner = this.self;
				} else if (task.owner !== this.self) {
					throw new Error(`${this.label(task)} is in_progress, owned by @${task.owner} - only the owner can update it`);
				}
			} else if (input.status === "pending") {
				if (task.status !== "in_progress" || task.owner !== this.self) {
					throw new Error(
						task.status === "in_progress"
							? `${this.label(task)} is in_progress - only the owner can release it; owned by ${task.owner}`
							: "Task is not claimed; nothing to release",
					);
				}
				task.status = "pending";
				delete task.owner;
			} else if (task.status !== "in_progress" || task.owner !== this.self) {
				throw new Error(
					task.status === "in_progress"
						? `${this.label(task)} is in_progress - only the owner can complete it; owned by ${task.owner}`
						: 'Task is pending: claim it first with status "in_progress", then complete it',
				);
			} else {
				task.status = "completed";
				delete task.owner;
			}
			task.updatedAt = this.now();
			this.write(task);
			return this.project(task);
		});
	}

	edit(input: { id: string; description: string }): TaskProjection {
		if (!isTaskId(input.id)) throw new Error("Invalid task ID");
		if (typeof input.description !== "string") throw new Error("Task description must be text");
		const target = this.resolve(input.id);
		return this.withTaskLock(target.id, () => {
			const task = this.read(target.id);
			if (!task) throw new Error(`Unknown task: ${input.id}`);
			if (task.status !== "pending")
				throw new Error(`Only pending tasks can be edited: ${this.label(task)} is ${task.status}`);
			task.description = input.description;
			task.updatedAt = this.now();
			this.write(task);
			return this.project(task);
		});
	}

	cancel(input: { id: string }): TaskProjection {
		if (!isTaskId(input.id)) throw new Error("Invalid task ID");
		const target = this.resolve(input.id);
		return this.withTaskLock(target.id, () => {
			const task = this.read(target.id);
			if (!task) throw new Error(`Unknown task: ${input.id}`);
			if (task.status !== "pending")
				throw new Error(`Only pending tasks can be cancelled: ${this.label(task)} is ${task.status}`);
			const dependents = this.scan()
				.filter((other) => other.id !== task.id && other.dependencies.includes(task.id))
				.sort((a, b) => this.compareByCode(a, b))
				.map((other) => other.code ?? other.id);
			if (dependents.length)
				throw new Error(`Cannot cancel ${this.label(task)} - it is a dependency of: ${dependents.join(", ")}`);
			task.status = "cancelled";
			task.updatedAt = this.now();
			this.write(task);
			return this.project(task);
		});
	}

	get(id: string): TaskProjection | undefined {
		if (!isTaskId(id)) throw new Error("Invalid task ID");
		const task = this.find(id);
		return task ? this.project(task) : undefined;
	}

	list(): TaskProjection[] {
		return this.scan()
			.sort((a, b) => this.compareByCode(a, b))
			.map((task) => this.project(task));
	}

	private compareByCode(a: BoardTask, b: BoardTask): number {
		return this.codeNumber(a) - this.codeNumber(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
	}

	private codeNumber(task: BoardTask): number {
		return task.code ? Number(task.code.slice(1)) : Number.MAX_SAFE_INTEGER;
	}

	private label(task: BoardTask): string {
		return `${task.code ?? task.id} "${task.title}"`;
	}

	// Accepts a UUID (exact file read first) or a short code (board scan); throws on unknown references.
	private resolve(idOrCode: string): BoardTask {
		const task = this.find(idOrCode);
		if (!task) throw new Error(`Unknown task: ${idOrCode}`);
		return task;
	}

	private find(idOrCode: string): BoardTask | undefined {
		const direct = this.read(idOrCode);
		if (direct) return direct;
		return isTaskCode(idOrCode) ? this.scan().find((task) => task.code === idOrCode) : undefined;
	}

	private scan(): BoardTask[] {
		return readdirSync(this.taskDir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => this.read(name.slice(0, -5)))
			.filter((task): task is BoardTask => task !== undefined);
	}

	private blockedBy(task: BoardTask): string[] {
		const blocked: string[] = [];
		for (const id of task.dependencies) {
			const dependency = this.read(id);
			if (dependency?.status !== "completed") blocked.push(dependency?.code ?? id);
		}
		return blocked;
	}

	private project(task: BoardTask): TaskProjection {
		return {
			...task,
			dependencies: task.dependencies.map((id) => this.read(id)?.code ?? id),
			blockedBy: this.blockedBy(task),
		};
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

	// Serializes code allocation across concurrent create() calls (scan + write).
	private withCodeLock<T>(operation: () => T): T {
		const lock = join(this.taskDir, "codes.lock");
		try {
			mkdirSync(lock, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST")
				throw new Error("Task creation conflict: task codes are locked");
			throw error;
		}
		try {
			return operation();
		} finally {
			rmSync(lock, { recursive: true, force: true });
		}
	}
}
