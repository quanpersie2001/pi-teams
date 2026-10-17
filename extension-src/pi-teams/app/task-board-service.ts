// Durable, session-scoped unified task board. Per-task writes are atomic; the
// board lock serializes DAG validation, code allocation, claims and reservations.
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isMailboxAddress } from "../domain/mailbox.js";
import {
	type BoardTask,
	isTaskCode,
	isTaskId,
	parseBoardTask,
	TASK_SCHEMA_VERSION,
	type TaskAttempt,
	type TaskContext,
	type TaskExecutionPlan,
	type TaskOutcome,
	type TaskProjection,
	type TaskSpec,
	type TaskStatus,
} from "../domain/task-board.js";
export interface TaskBoardServiceOptions {
	teamDir: string;
	self: string;
	now?: () => number;
}
export type TaskBoardChange = { type: "created" | "updated" | "removed"; task?: TaskProjection; id: string };
export interface TaskFilters {
	status?: TaskStatus;
	assignee?: string;
	owner?: string;
	blocked?: boolean;
	query?: string;
}
const clone = <T>(v: T): T => structuredClone(v);
export class TaskBoardService {
	readonly taskDir: string;
	readonly self: string;
	private readonly now: () => number;
	private listeners = new Set<(event: TaskBoardChange) => void>();
	private fsWatcher: ReturnType<typeof watch> | undefined;
	private watchListeners = new Set<() => void>();
	constructor(options: TaskBoardServiceOptions) {
		if (!isMailboxAddress(options.self)) throw new Error("Invalid task board participant name");
		this.taskDir = join(options.teamDir, "tasks");
		this.self = options.self;
		this.now = options.now ?? (() => Date.now());
		mkdirSync(this.taskDir, { recursive: true, mode: 0o700 });
		chmodSync(this.taskDir, 0o700);
	}
	create(input: {
		title: string;
		description?: string;
		dependencies?: string[];
		spec?: TaskSpec;
		context?: TaskContext;
		executionPlan?: TaskExecutionPlan;
		assignee?: string;
		reviewRequested?: boolean;
	}): TaskProjection {
		if (typeof input.title !== "string" || !input.title.trim()) throw new Error("Task title must not be empty");
		return this.withBoardLock(() => {
			const board = this.scan();
			const deps = this.resolveDependencies(input.dependencies ?? [], board);
			const at = this.now();
			const code = `T${board.reduce((n, t) => Math.max(n, t.code ? Number(t.code.slice(1)) : 0), 0) + 1}`;
			if (input.assignee !== undefined && !isMailboxAddress(input.assignee)) throw new Error("Invalid task assignee");
			const task: BoardTask = {
				id: randomUUID(),
				code,
				title: input.title,
				...(input.description !== undefined ? { description: input.description } : {}),
				status: "pending",
				dependencies: deps,
				...(input.assignee ? { assignee: input.assignee } : {}),
				...(input.reviewRequested !== undefined ? { reviewRequested: input.reviewRequested } : {}),
				...(input.executionPlan !== undefined ? { executionPlan: clone(input.executionPlan) } : {}),
				requirementRevision: 1,
				spec: clone(input.spec ?? {}),
				context: clone(input.context ?? {}),
				attempts: [],
				createdAt: at,
				updatedAt: at,
			};
			const validated = parseBoardTask({ schemaVersion: TASK_SCHEMA_VERSION, ...task });
			if (!validated) throw new Error("Invalid task fields");
			this.write(validated);
			this.emit({ type: "created", id: task.id, task: this.project(validated) });
			return this.project(validated);
		});
	}
	update(input: {
		id: string;
		expectedRequirementRevision?: number;
		status?: TaskStatus;
		title?: string;
		description?: string;
		dependencies?: string[];
		spec?: TaskSpec;
		context?: TaskContext;
		executionPlan?: TaskExecutionPlan | null;
		assignee?: string | null;
		reviewRequested?: boolean;
		outcome?: TaskOutcome;
	}): TaskProjection {
		return this.withBoardLock(() => {
			const task = this.require(input.id);
			if (
				input.expectedRequirementRevision !== undefined &&
				task.requirementRevision !== input.expectedRequirementRevision
			)
				throw new Error(
					`Task revision is stale (expected ${input.expectedRequirementRevision}, current ${task.requirementRevision})`,
				);
			if (["completed", "cancelled"].includes(task.status))
				throw new Error(`${this.label(task)} is ${task.status} - terminal`);
			const requirementsChanged =
				input.title !== undefined ||
				input.description !== undefined ||
				input.spec !== undefined ||
				input.context !== undefined ||
				input.dependencies !== undefined ||
				input.assignee !== undefined ||
				input.reviewRequested !== undefined ||
				input.executionPlan !== undefined;
			if (requirementsChanged && task.attempts.some((attempt) => attempt.status === "running"))
				throw new Error("Cannot edit task requirements while an execution is active");
			if (requirementsChanged && task.status !== "pending" && input.status !== "pending")
				throw new Error(`Only pending tasks can be edited: ${this.label(task)} is ${task.status}`);
			if (input.outcome !== undefined) {
				if (task.owner !== this.self && this.self !== "lead")
					throw new Error(`Only task owner @${task.owner} or lead may update the outcome`);
				if (task.attempts.some((attempt) => attempt.status === "running"))
					throw new Error("Cannot update outcome while a task execution is active");
			}
			if (input.dependencies !== undefined)
				task.dependencies = this.resolveDependencies(input.dependencies, this.scan(), task.id);
			if (input.status !== undefined) this.transition(task, input.status, input.outcome);
			if (input.title !== undefined) {
				if (!input.title.trim()) throw new Error("Task title must not be empty");
				task.title = input.title;
			}
			if (input.description !== undefined) task.description = input.description;
			if (input.spec !== undefined) task.spec = this.mergeSpec(task.spec, input.spec);
			if (input.context !== undefined) task.context = { ...task.context, ...clone(input.context) };
			if (input.assignee !== undefined) {
				if (input.assignee === null) delete task.assignee;
				else {
					if (!isMailboxAddress(input.assignee)) throw new Error("Invalid task assignee");
					task.assignee = input.assignee;
				}
			}
			if (input.reviewRequested !== undefined) task.reviewRequested = input.reviewRequested;
			if (input.executionPlan === null) delete task.executionPlan;
			else if (input.executionPlan !== undefined) task.executionPlan = clone(input.executionPlan);
			if (input.outcome !== undefined) task.outcome = clone(input.outcome);
			if (requirementsChanged) task.requirementRevision++;
			task.updatedAt = this.now();
			const validated = parseBoardTask({ schemaVersion: TASK_SCHEMA_VERSION, ...task });
			if (!validated) throw new Error("Invalid task fields");
			this.write(validated);
			this.emit({ type: "updated", id: task.id, task: this.project(validated) });
			return this.project(validated);
		});
	}
	private hasExplicitOutcome(outcome: TaskOutcome | undefined): boolean {
		return (
			!!outcome &&
			((outcome.summary?.trim().length ?? 0) > 0 ||
				(outcome.verification?.length ?? 0) > 0 ||
				(outcome.artifacts?.length ?? 0) > 0 ||
				(outcome.remainingIssues?.length ?? 0) > 0)
		);
	}
	private mergeSpec(current: TaskSpec, patch: TaskSpec): TaskSpec {
		return {
			...current,
			...clone(patch),
			...(patch.scope !== undefined ? { scope: { ...current.scope, ...patch.scope } } : {}),
		};
	}
	private transition(task: BoardTask, status: TaskStatus, outcome?: TaskOutcome): void {
		if (status === "in_progress") {
			if (task.status === "pending") {
				const blockers = this.blockedBy(task);
				if (blockers.length) throw new Error(`${this.label(task)} is blocked by: ${blockers.join(", ")}`);
				task.status = status;
				task.owner = this.self;
				return;
			}
			if (task.status !== "in_progress") throw new Error(`Cannot claim task while it is ${task.status}`);
			if (task.owner !== this.self)
				throw new Error(`${this.label(task)} is in_progress, owned by @${task.owner} - only the owner can update it`);
			return;
		}
		if (status === "pending") {
			if (task.attempts.some((attempt) => attempt.status === "running"))
				throw new Error("Cannot release a task while an execution is active");
			if (!["in_progress", "in_review"].includes(task.status) || (task.owner !== this.self && this.self !== "lead"))
				throw new Error("Only the current owner or lead coordinator can release a claim");
			task.status = status;
			delete task.owner;
			delete task.ownerMembershipId;
			return;
		}
		if (status === "in_review") {
			if (task.attempts.some((attempt) => attempt.status === "running"))
				throw new Error("Cannot request review while a task execution is active");
			if (task.status !== "in_progress" || (task.owner !== this.self && this.self !== "lead"))
				throw new Error("Only the current owner or lead coordinator may request review");
			if (task.reviewRequested !== true) throw new Error("Task review was not requested");
			task.status = status;
			return;
		}
		if (status === "completed") {
			if (task.attempts.some((attempt) => attempt.status === "running"))
				throw new Error("Cannot accept completion while a task execution is active");
			const lastAttempt = task.attempts.at(-1);
			if (lastAttempt && lastAttempt.status !== "completed" && !this.hasExplicitOutcome(outcome))
				throw new Error("Failed/stopped execution requires an explicit outcome for manual acceptance");
			if (task.owner !== this.self && this.self !== "lead")
				throw new Error(`Only owner @${task.owner} or lead may accept completion`);
			if (task.status !== "in_progress" && task.status !== "in_review")
				throw new Error('Task is pending: claim it first with status "in_progress", then complete it');
			if (task.reviewRequested === true && task.status !== "in_review")
				throw new Error("Task requires review before completion");
			task.outcome = clone(outcome ?? task.outcome ?? {});
			task.status = status;
			delete task.owner;
			delete task.ownerMembershipId;
			return;
		}
		if (status === "cancelled") throw new Error("Task cancellation requires tasks_cancel");
	}
	cancel(input: { id: string }): TaskProjection {
		return this.withBoardLock(() => {
			const task = this.require(input.id);
			if (task.attempts.some((attempt) => attempt.status === "running"))
				throw new Error("Cannot cancel a task while an execution is active");
			if (task.status !== "pending")
				throw new Error(`Only pending tasks can be cancelled: ${this.label(task)} is ${task.status}`);
			const deps = this.scan()
				.filter((x) => x.id !== task.id && x.dependencies.includes(task.id))
				.sort(
					(a, b) =>
						(Number(a.code?.slice(1)) || Number.MAX_SAFE_INTEGER) -
						(Number(b.code?.slice(1)) || Number.MAX_SAFE_INTEGER),
				)
				.map((x) => x.code ?? x.id);
			if (deps.length) throw new Error(`Cannot cancel ${this.label(task)} - it is a dependency of: ${deps.join(", ")}`);
			task.status = "cancelled";
			task.updatedAt = this.now();
			this.write(task);
			this.emit({ type: "updated", id: task.id, task: this.project(task) });
			return this.project(task);
		});
	}
	edit(input: { id: string; description: string }): TaskProjection {
		return this.update({ id: input.id, description: input.description });
	}
	get(id: string): TaskProjection | undefined {
		const t = this.find(id);
		return t ? this.project(t) : undefined;
	}
	list(filters: TaskFilters = {}): TaskProjection[] {
		const query = filters.query?.trim().toLocaleLowerCase();
		return this.scan()
			.filter((task) => {
				if (filters.status !== undefined && task.status !== filters.status) return false;
				if (filters.assignee !== undefined && task.assignee !== filters.assignee) return false;
				if (filters.owner !== undefined && task.owner !== filters.owner) return false;
				if (filters.blocked !== undefined && this.blockedBy(task).length > 0 !== filters.blocked) return false;
				return (
					!query ||
					`${task.code ?? task.id} ${task.title} ${task.description ?? ""}`.toLocaleLowerCase().includes(query)
				);
			})
			.sort(
				(a, b) =>
					(Number(a.code?.slice(1)) || Number.MAX_SAFE_INTEGER) -
						(Number(b.code?.slice(1)) || Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt,
			)
			.map((t) => this.project(t));
	}
	subscribe(listener: (event: TaskBoardChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	dispose(): void {
		this.fsWatcher?.close();
		this.fsWatcher = undefined;
		this.watchListeners.clear();
		this.listeners.clear();
	}
	watch(listener: () => void): () => void {
		this.watchListeners.add(listener);
		if (!this.fsWatcher)
			this.fsWatcher = watch(this.taskDir, () => {
				for (const observer of this.watchListeners) {
					try {
						observer();
					} catch (error) {
						console.warn(
							`[pi-teams] Task board watcher failed: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
			});
		return () => {
			this.watchListeners.delete(listener);
			if (this.watchListeners.size === 0) {
				this.fsWatcher?.close();
				this.fsWatcher = undefined;
			}
		};
	}
	bindOwnerMembership(id: string, membershipId: string | undefined): TaskProjection {
		return this.withBoardLock(() => {
			const task = this.require(id);
			if (task.status !== "in_progress" && task.status !== "in_review")
				throw new Error("Task owner membership requires an active claim");
			if (membershipId !== undefined) task.ownerMembershipId = membershipId;
			task.updatedAt = this.now();
			this.write(task);
			return this.project(task);
		});
	}

	reserveAttempt(id: string, runId: string): TaskAttempt {
		return this.withBoardLock(() => {
			const t = this.require(id);
			if (t.status !== "in_progress" || t.owner !== this.self)
				throw new Error("Execution requires an in_progress task owned by the caller");
			return this.reserveAttemptCore(t, runId);
		});
	}
	reserveExecution(
		id: string,
		reservationId: string,
		owner: string,
		coordinator: boolean,
		expectedRequirementRevision?: number,
		expectedStatus?: TaskStatus,
	): {
		attempt: TaskAttempt;
		task: TaskProjection;
		previous: { status: "pending" | "in_progress"; owner?: string; ownerMembershipId?: string };
	} {
		return this.withBoardLock(() => {
			const task = this.require(id);
			if (expectedStatus !== undefined && task.status !== expectedStatus)
				throw new Error(`Task status is stale (expected ${expectedStatus}, current ${task.status})`);
			if (expectedRequirementRevision !== undefined && task.requirementRevision !== expectedRequirementRevision)
				throw new Error(
					`Task revision is stale (expected ${expectedRequirementRevision}, current ${task.requirementRevision})`,
				);
			const previous = {
				status: task.status === "pending" ? ("pending" as const) : ("in_progress" as const),
				...(task.owner !== undefined ? { owner: task.owner } : {}),
				...(task.ownerMembershipId !== undefined ? { ownerMembershipId: task.ownerMembershipId } : {}),
			};
			if (task.status === "pending") {
				const blockers = this.blockedBy(task);
				if (blockers.length) throw new Error(`${this.label(task)} is blocked by: ${blockers.join(", ")}`);
				task.status = "in_progress";
				task.owner = owner;
			} else if (task.status !== "in_progress")
				throw new Error(`Task must be pending or in_progress to execute (${task.status})`);
			else if (task.owner !== owner) {
				if (!coordinator || task.owner !== this.self)
					throw new Error(`Task is claimed by @${task.owner}; only that owner may execute it`);
				task.owner = owner;
			}
			const attempt = this.reserveAttemptCore(task, reservationId);
			return { attempt, task: this.project(task), previous };
		});
	}
	private reserveAttemptCore(t: BoardTask, runId: string): TaskAttempt {
		if (t.attempts.some((a) => a.status === "running")) throw new Error("Task already has an active attempt");
		const a: TaskAttempt = {
			runId,
			...(t.owner !== undefined ? { teammateName: t.owner } : {}),
			reservationId: runId,
			startedAt: this.now(),
			status: "running",
			requirementRevision: t.requirementRevision,
			requirementSnapshot: {
				title: t.title,
				...(t.description !== undefined ? { description: t.description } : {}),
				dependencies: [...t.dependencies],
				...(t.executionPlan !== undefined ? { executionPlan: clone(t.executionPlan) } : {}),
				spec: clone(t.spec),
				context: clone(t.context),
			},
		};
		t.attempts.push(a);
		t.updatedAt = this.now();
		this.write(t);
		this.emit({ type: "updated", id: t.id, task: this.project(t) });
		return clone(a);
	}
	rollbackReservation(
		id: string,
		reservationId: string,
		error: string,
		previous: { status: "pending" | "in_progress"; owner?: string; ownerMembershipId?: string },
	): TaskProjection {
		return this.withBoardLock(() => {
			const task = this.require(id);
			const attempt = task.attempts.find((item) => item.reservationId === reservationId);
			if (attempt?.status === "running")
				Object.assign(attempt, { status: "failed" as const, error, settledAt: this.now() });
			task.status = previous.status;
			if (previous.owner !== undefined) task.owner = previous.owner;
			else delete task.owner;
			if (previous.ownerMembershipId !== undefined) task.ownerMembershipId = previous.ownerMembershipId;
			else delete task.ownerMembershipId;
			task.updatedAt = this.now();
			this.write(task);
			this.emit({ type: "updated", id: task.id, task: this.project(task) });
			return this.project(task);
		});
	}
	bindAttempt(id: string, reservationId: string, runId: string, membershipId?: string): TaskProjection {
		return this.withBoardLock(() => {
			const t = this.require(id);
			const a = t.attempts.find((x) => x.reservationId === reservationId);
			if (a?.status !== "running") throw new Error("Task execution reservation is no longer active");
			a.runId = runId;
			if (membershipId !== undefined) a.membershipId = membershipId;
			t.updatedAt = this.now();
			this.write(t);
			this.emit({ type: "updated", id: t.id, task: this.project(t) });
			return this.project(t);
		});
	}
	settleAttempt(id: string, runId: string, result: Partial<TaskAttempt>): TaskProjection {
		return this.withBoardLock(() => {
			const t = this.require(id);
			const a = t.attempts.find((x) => x.runId === runId || x.reservationId === runId);
			if (a?.status !== "running") return this.project(t);
			Object.assign(a, clone(result));
			if (a.status === "running") throw new Error("Attempt settlement must be terminal");
			t.updatedAt = this.now();
			this.write(t);
			this.emit({ type: "updated", id: t.id, task: this.project(t) });
			return this.project(t);
		});
	}
	private resolveDependencies(refs: string[], board: BoardTask[], selfId?: string): string[] {
		if (!Array.isArray(refs) || !refs.every(isTaskId)) throw new Error("Dependencies must reference existing task IDs");
		const ids = refs.map((ref) => {
			const dep = board.find((t) => t.id === ref || t.code === ref);
			if (!dep) throw new Error(`Unknown task dependency: ${ref}`);
			return dep.id;
		});
		if (new Set(ids).size !== ids.length) throw new Error("Duplicate task dependency");
		if (selfId && ids.includes(selfId)) throw new Error("Task dependency cycle detected");
		const graph = new Map(board.map((t) => [t.id, t.dependencies]));
		if (selfId) graph.set(selfId, ids);
		for (const id of ids)
			if (this.reaches(id, selfId ?? "", graph, new Set())) throw new Error("Task dependency cycle detected");
		return ids;
	}
	private reaches(from: string, target: string, graph: Map<string, string[]>, seen: Set<string>): boolean {
		if (from === target) return true;
		if (seen.has(from)) return false;
		seen.add(from);
		return (graph.get(from) ?? []).some((n) => this.reaches(n, target, graph, seen));
	}
	private blockedBy(t: BoardTask): string[] {
		return t.dependencies.flatMap((id) => {
			const d = this.read(id);
			return d?.status === "completed" ? [] : [d?.code ?? id];
		});
	}
	private project(t: BoardTask): TaskProjection {
		return {
			...clone(t),
			dependencies: t.dependencies.map((id) => this.read(id)?.code ?? id),
			blockedBy: this.blockedBy(t),
		};
	}
	private require(id: string): BoardTask {
		const t = this.find(id);
		if (!t) throw new Error(`Unknown task: ${id}`);
		return t;
	}
	private find(id: string): BoardTask | undefined {
		const direct = this.read(id);
		return direct ?? (isTaskCode(id) ? this.scan().find((t) => t.code === id) : undefined);
	}
	private scan(): BoardTask[] {
		return readdirSync(this.taskDir)
			.filter((n) => n.endsWith(".json") && n !== "board.json")
			.map((n) => this.read(n.slice(0, -5)))
			.filter((t): t is BoardTask => !!t);
	}
	private read(id: string): BoardTask | undefined {
		try {
			const value = JSON.parse(readFileSync(join(this.taskDir, `${id}.json`), "utf8"));
			const parsed = parseBoardTask(value);
			if (!parsed || parsed.id !== id) throw new Error(`Malformed task file ${id}`);
			return parsed;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw e;
		}
	}
	private write(t: BoardTask): void {
		const target = join(this.taskDir, `${t.id}.json`),
			tmp = join(this.taskDir, `.${t.id}.${randomUUID()}.tmp`);
		try {
			writeFileSync(tmp, JSON.stringify({ schemaVersion: TASK_SCHEMA_VERSION, ...t }), { mode: 0o600, flag: "wx" });
			chmodSync(tmp, 0o600);
			renameSync(tmp, target);
		} finally {
			rmSync(tmp, { force: true });
		}
	}
	/**
	 * Serializes every board.lock unlink. This marker is never auto-recovered:
	 * after a crash, remove it only when all task-board writers are stopped.
	 */
	private withRecoveryMarker<T>(fn: () => T): T {
		const gate = join(this.taskDir, "board.lock.mutation");
		try {
			mkdirSync(gate, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST")
				throw new Error("Task board conflict: board.lock.mutation exists; inspect it only after all writers stop");
			throw error;
		}
		try {
			return fn();
		} finally {
			try {
				rmdirSync(gate);
			} catch (error) {
				console.warn(
					`[pi-teams] Could not remove task-board mutation gate ${gate}; operations will fail closed until all writers stop and it is removed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
	private releaseBoardLock(lock: string, token: string, retry = 0): void {
		try {
			this.withRecoveryMarker(() => {
				try {
					if (readFileSync(lock, "utf8") === token) rmSync(lock);
				} catch {
					// Preserve operation errors; an unreadable lock is left for safe recovery.
				}
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("board.lock.mutation exists") && retry < 6) {
				const timer = setTimeout(() => this.releaseBoardLock(lock, token, retry + 1), 10 * 2 ** retry);
				timer.unref?.();
				return;
			}
			console.warn(`[pi-teams] Could not release task-board lock ${token}; leaving it fail-closed: ${message}`);
		}
	}
	private withBoardLock<T>(fn: () => T): T {
		const lock = join(this.taskDir, "board.lock");
		const token = `${process.pid}:${randomUUID()}`;
		const acquire = (): boolean => {
			try {
				writeFileSync(lock, token, { mode: 0o600, flag: "wx" });
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				return false;
			}
		};
		if (!acquire()) {
			let existing: string | undefined;
			try {
				existing = readFileSync(lock, "utf8");
			} catch {
				/* A just-created lock may not be readable yet; fail without stealing it. */
			}
			if (!existing) throw new Error("Task board conflict: another update is in progress");
			const acquired = this.withRecoveryMarker(() => {
				try {
					if (readFileSync(lock, "utf8") !== existing) return false;
				} catch {
					return false;
				}
				const match = /^(\d+):[0-9a-f-]+$/i.exec(existing);
				const pid = match?.[1] ? Number(match[1]) : undefined;
				if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return false;
				try {
					process.kill(pid, 0);
					return false;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
				}
				rmSync(lock);
				// Keep the exclusive marker through wx acquisition. A normal writer may
				// win the gap; in that case leave its new lock untouched and fail.
				return acquire();
			});
			if (!acquired) throw new Error("Task board conflict: another update is in progress");
		}
		try {
			return fn();
		} finally {
			this.releaseBoardLock(lock, token);
		}
	}
	private label(t: BoardTask): string {
		return `${t.code ?? t.id} "${t.title}"`;
	}
	private emit(event: TaskBoardChange): void {
		for (const listener of this.listeners) listener(event);
	}
}
