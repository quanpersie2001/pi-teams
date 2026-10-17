import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskAutomationService } from "../../extension-src/pi-teams/app/task-automation-service.js";
import { TaskBoardService } from "../../extension-src/pi-teams/app/task-board-service.js";
import type { TaskExecutionService as TaskExecutionServiceType } from "../../extension-src/pi-teams/app/task-execution-service.js";
import { TaskExecutionService } from "../../extension-src/pi-teams/app/task-execution-service.js";
import { parseBoardTask } from "../../extension-src/pi-teams/domain/task-board.js";
import { summarizeRelevantTasks, TaskReminderCadence } from "../../extension-src/pi-teams/pi/task-reminders.js";

let root: string | undefined;
const disposables: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposables.splice(0).reverse()) dispose();
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});
function createBoard(): TaskBoardService {
	root = mkdtempSync(join(tmpdir(), "task-automation-"));
	return new TaskBoardService({ teamDir: root, self: "lead", now: () => 42 });
}
async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
function finish(board: TaskBoardService, id: string): void {
	board.update({ id, status: "in_progress" });
	board.update({ id, status: "completed" });
}
function executor(fn: (id: string, input: unknown) => Promise<unknown>) {
	return { execute: vi.fn(fn) } as unknown as TaskExecutionServiceType;
}
function automate(board: TaskBoardService, run: TaskExecutionServiceType, enabled: boolean): TaskAutomationService {
	const service = new TaskAutomationService(board, run, enabled);
	disposables.push(() => service.dispose());
	return service;
}

describe("task execution plan contract", () => {
	it("validates, persists, snapshots and preserves legacy tasks without plans", () => {
		const board = createBoard();
		const task = board.create({ title: "Planned", executionPlan: { type: "reviewer", maxTurns: 12 } });
		expect(task.executionPlan).toEqual({ type: "reviewer", maxTurns: 12 });
		const reopened = new TaskBoardService({ teamDir: root as string, self: "lead", now: () => 42 });
		expect(reopened.get(task.id)?.executionPlan).toEqual(task.executionPlan);
		board.update({ id: task.id, status: "in_progress" });
		expect(board.reserveAttempt(task.id, "run-1").requirementSnapshot.executionPlan).toEqual(task.executionPlan);
		expect(() => board.create({ title: "Invalid", executionPlan: { type: "", maxTurns: 0 } as never })).toThrow(
			/Invalid task fields/,
		);
		const legacy = { id: "legacy", title: "Legacy", status: "pending", dependencies: [], createdAt: 1, updatedAt: 1 };
		expect(parseBoardTask(legacy)?.executionPlan).toBeUndefined();
		expect(parseBoardTask({ ...legacy, executionPlan: { type: "reviewer", maxTurns: 0 } })).toBeUndefined();
	});
});

describe("TaskAutomationService", () => {
	it("is off by default and only reacts to accepted completion events", async () => {
		const board = createBoard();
		const prerequisite = board.create({ title: "Prerequisite" });
		board.create({ title: "Planned", dependencies: [prerequisite.id], executionPlan: { type: "reviewer" } });
		const run = executor(async () => ({}));
		automate(board, run, false);
		finish(board, prerequisite.id);
		await flush();
		expect(run.execute).not.toHaveBeenCalled();
	});

	it("gates DAG dependents on every completed prerequisite and skips missing plans", async () => {
		const board = createBoard();
		const a = board.create({ title: "A" });
		const b = board.create({ title: "B" });
		const planned = board.create({ title: "Planned", dependencies: [a.id, b.id], executionPlan: { type: "reviewer" } });
		const noPlan = board.create({ title: "No plan", dependencies: [a.id, b.id] });
		const run = executor(async () => ({}));
		automate(board, run, true);
		finish(board, a.id);
		await flush();
		expect(run.execute).not.toHaveBeenCalled();
		finish(board, b.id);
		await flush();
		expect(run.execute).toHaveBeenCalledTimes(1);
		expect(run.execute).toHaveBeenCalledWith(
			planned.id,
			expect.objectContaining({
				actor: { name: "lead", coordinator: true },
				type: "reviewer",
			}),
		);
		expect(board.get(noPlan.id)?.status).toBe("pending");
	});

	it("clearing a pending execution plan revisions the task and prevents auto-cascade", async () => {
		const board = createBoard();
		const prerequisite = board.create({ title: "Prerequisite" });
		const dependent = board.create({
			title: "Opted out",
			dependencies: [prerequisite.id],
			executionPlan: { type: "reviewer" },
		});
		const run = executor(async () => ({}));
		automate(board, run, true);
		const cleared = board.update({ id: dependent.id, executionPlan: null, expectedRequirementRevision: 1 });
		expect(cleared.requirementRevision).toBe(2);
		expect(cleared.executionPlan).toBeUndefined();
		finish(board, prerequisite.id);
		await flush();
		expect(run.execute).not.toHaveBeenCalled();
	});

	it("coalesces repeated completion scans and does not retry failed launches", async () => {
		const board = createBoard();
		const prerequisite = board.create({ title: "Prerequisite" });
		const dependent = board.create({
			title: "Planned",
			dependencies: [prerequisite.id],
			executionPlan: { type: "reviewer" },
		});
		const unrelated = board.create({ title: "Unrelated", executionPlan: { type: "unrelated-agent" } });
		const run = executor(async () => {
			throw new Error("admission failed");
		});
		automate(board, run, true);
		finish(board, prerequisite.id);
		await flush();
		finish(board, unrelated.id);
		await flush();
		expect(run.execute).toHaveBeenCalledTimes(1);
		expect(run.execute).toHaveBeenCalledWith(dependent.id, expect.anything());
		expect(board.get(dependent.id)?.status).toBe("pending");
	});

	it("retries a peer completion observed while a child process holds the board lock", async () => {
		const board = createBoard();
		const prerequisite = board.create({ title: "Child-process prerequisite" });
		const dependent = board.create({
			title: "Retry reservation",
			dependencies: [prerequisite.id],
			executionPlan: { type: "reviewer" },
		});
		const lockPath = join(board.taskDir, "board.lock");
		const manager = {
			subscribe: () => () => {},
			teammateMembershipId: () => undefined,
			spawn: vi.fn(async () => {
				expect(existsSync(lockPath)).toBe(false);
				return { id: "run-child-lock-test" };
			}),
			get: () => undefined,
		};
		const execution = new TaskExecutionService({ board, manager: manager as never });
		const service = automate(board, execution, true);
		let watchNotifications = 0;
		let completionObservedWithLock = false;
		const unwatch = board.watch(() => {
			watchNotifications += 1;
			if (board.get(prerequisite.id)?.status === "completed") completionObservedWithLock = existsSync(lockPath);
		});
		disposables.push(unwatch);
		const script = [
			"const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');",
			"const [dir,id]=process.argv.slice(-2),lock=path.join(dir,'board.lock');",
			"fs.writeFileSync(lock,String(process.pid)+':'+crypto.randomUUID(),{flag:'wx',mode:0o600});",
			"const file=path.join(dir,id+'.json'),task=JSON.parse(fs.readFileSync(file,'utf8'));",
			"task.status='completed';delete task.owner;task.outcome??={};task.updatedAt+=1;",
			"const tmp=path.join(dir,'.'+id+'.child.tmp');fs.writeFileSync(tmp,JSON.stringify({...task,schemaVersion:2}));fs.renameSync(tmp,file);",
			"process.stdout.write('UPDATED\\n');",
			"setTimeout(()=>{fs.unlinkSync(lock);process.stdout.write('RELEASED\\n');},900);",
		].join("");
		const child = spawn(process.execPath, ["--input-type=commonjs", "-e", script, board.taskDir, prerequisite.id]);
		let output = "";
		const updated = new Promise<void>((resolve, reject) => {
			child.stdout?.on("data", (chunk: Buffer) => {
				output += chunk.toString();
				if (output.includes("UPDATED\n")) resolve();
			});
			child.once("error", reject);
			child.once("exit", (code) => {
				if (code !== 0) reject(new Error(`lock holder exited ${code}: ${output}`));
			});
		});
		await updated;
		await vi.waitFor(() => expect(board.get(prerequisite.id)?.status).toBe("completed"));
		await vi.waitFor(() => expect(watchNotifications).toBeGreaterThan(0));
		await vi.waitFor(() => expect(completionObservedWithLock).toBe(true));
		await vi.waitFor(() => expect(manager.spawn).toHaveBeenCalledTimes(1), { timeout: 6_000 });
		await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 3_000 });
		expect(board.get(dependent.id)?.attempts).toHaveLength(1);
		service.dispose();
		execution.dispose();
	}, 15_000);

	it("detects a newly created-and-completed peer prerequisite after coalesced filesystem events", async () => {
		const parent = createBoard();
		const peer = new TaskBoardService({ teamDir: root as string, self: "worker", now: () => 43 });
		const run = executor(async () => ({}));
		automate(parent, run, true);
		const prerequisite = peer.create({ title: "Burst prerequisite" });
		const dependent = peer.create({
			title: "Burst dependent",
			dependencies: [prerequisite.id],
			executionPlan: { type: "reviewer" },
		});
		peer.create({ title: "Standalone must not run", executionPlan: { type: "other" } });
		finish(peer, prerequisite.id);
		await vi.waitFor(() => expect(run.execute).toHaveBeenCalledTimes(1));
		expect(run.execute).toHaveBeenCalledWith(dependent.id, expect.anything());
	});

	it("observes accepted completions from peer board services alongside UI watchers exactly once", async () => {
		const parent = createBoard();
		const peer = new TaskBoardService({ teamDir: root as string, self: "worker", now: () => 43 });
		const prerequisite = parent.create({ title: "Peer prerequisite" });
		const planned = parent.create({
			title: "Planned from peer completion",
			dependencies: [prerequisite.id],
			executionPlan: { type: "reviewer" },
		});
		const run = executor(async () => ({}));
		const service = automate(parent, run, true);
		let uiNotifications = 0;
		const unwatchUi = parent.watch(() => {
			uiNotifications += 1;
		});
		disposables.push(unwatchUi);
		peer.update({ id: prerequisite.id, status: "in_progress" });
		peer.update({ id: prerequisite.id, status: "completed" });
		await vi.waitFor(() => expect(run.execute).toHaveBeenCalledTimes(1));
		expect(run.execute).toHaveBeenCalledWith(planned.id, expect.anything());
		expect(uiNotifications).toBeGreaterThan(0);

		service.dispose();
		const another = parent.create({ title: "Second peer prerequisite" });
		parent.create({ title: "Second dependent", dependencies: [another.id], executionPlan: { type: "reviewer" } });
		peer.update({ id: another.id, status: "in_progress" });
		peer.update({ id: another.id, status: "completed" });
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(run.execute).toHaveBeenCalledTimes(1);
		expect(uiNotifications).toBeGreaterThan(1);
		unwatchUi();
	});

	it("does not spawn a stale plan when the task is cleared during reservation retries", async () => {
		const board = createBoard();
		const prerequisite = board.create({ title: "Prerequisite" });
		const dependent = board.create({
			title: "Plan may change",
			dependencies: [prerequisite.id],
			executionPlan: { type: "old-plan" },
		});
		const manager = {
			subscribe: () => () => {},
			teammateMembershipId: () => undefined,
			spawn: vi.fn(async () => ({ id: "stale-plan-run" })),
			get: () => undefined,
		};
		const execution = new TaskExecutionService({ board, manager: manager as never });
		automate(board, execution, true);
		const lockPath = join(board.taskDir, "board.lock");
		const originalReserve = board.reserveExecution.bind(board);
		let markFirstConflict!: () => void;
		const firstConflict = new Promise<void>((resolve) => {
			markFirstConflict = resolve;
		});
		const reserve = vi.spyOn(board, "reserveExecution").mockImplementation((...args) => {
			try {
				return originalReserve(...args);
			} catch (error) {
				markFirstConflict();
				throw error;
			}
		});
		finish(board, prerequisite.id);
		writeFileSync(lockPath, `${process.pid}:11111111-1111-1111-1111-111111111111`);
		await firstConflict;
		rmSync(lockPath, { force: true });
		board.update({ id: dependent.id, executionPlan: null });
		writeFileSync(lockPath, `${process.pid}:22222222-2222-2222-2222-222222222222`);
		const callsBeforeRetry = reserve.mock.calls.length;
		await vi.waitFor(() => expect(reserve.mock.calls.length).toBeGreaterThan(callsBeforeRetry));
		rmSync(lockPath, { force: true });
		await vi.waitFor(() => {
			const last = reserve.mock.results.at(-1);
			expect(last?.type).toBe("throw");
			if (last?.type === "throw")
				expect(last.value).toMatchObject({ message: expect.stringMatching(/^Task revision is stale/) });
		});
		expect(manager.spawn).not.toHaveBeenCalled();
		expect(board.get(dependent.id)?.status).toBe("pending");
		expect(board.get(dependent.id)?.attempts).toEqual([]);
		expect(board.get(dependent.id)?.executionPlan).toBeUndefined();
		execution.dispose();
	});

	it("does not dispatch changed type/name/model after a lock-held reservation retry", async () => {
		const board = createBoard();
		const prerequisite = board.create({ title: "Prerequisite" });
		const dependent = board.create({
			title: "Plan identity may change",
			dependencies: [prerequisite.id],
			executionPlan: { type: "old-type", name: "old-agent", model: "provider/old-model" },
		});
		const manager = {
			subscribe: () => () => {},
			teammateMembershipId: () => undefined,
			spawn: vi.fn(async () => ({ id: "stale-identity-run" })),
			get: () => undefined,
		};
		const execution = new TaskExecutionService({ board, manager: manager as never });
		automate(board, execution, true);
		const lockPath = join(board.taskDir, "board.lock");
		const originalReserve = board.reserveExecution.bind(board);
		let markFirstConflict!: () => void;
		const firstConflict = new Promise<void>((resolve) => {
			markFirstConflict = resolve;
		});
		const reserve = vi.spyOn(board, "reserveExecution").mockImplementation((...args) => {
			try {
				return originalReserve(...args);
			} catch (error) {
				markFirstConflict();
				throw error;
			}
		});
		finish(board, prerequisite.id);
		writeFileSync(lockPath, `${process.pid}:33333333-3333-3333-3333-333333333333`);
		await firstConflict;
		rmSync(lockPath, { force: true });
		board.update({
			id: dependent.id,
			executionPlan: { type: "new-type", name: "new-agent", model: "provider/new-model" },
		});
		writeFileSync(lockPath, `${process.pid}:44444444-4444-4444-4444-444444444444`);
		const callsBeforeRetry = reserve.mock.calls.length;
		await vi.waitFor(() => expect(reserve.mock.calls.length).toBeGreaterThan(callsBeforeRetry));
		rmSync(lockPath, { force: true });
		await vi.waitFor(() => {
			const last = reserve.mock.results.at(-1);
			expect(last?.type).toBe("throw");
			if (last?.type === "throw")
				expect(last.value).toMatchObject({ message: expect.stringMatching(/^Task revision is stale/) });
		});
		expect(manager.spawn).not.toHaveBeenCalled();
		expect(board.get(dependent.id)?.attempts).toEqual([]);
		expect(board.get(dependent.id)?.executionPlan).toEqual({
			type: "new-type",
			name: "new-agent",
			model: "provider/new-model",
		});
		execution.dispose();
	});

	it("does not override a manual claim made during a lock-held reservation retry", async () => {
		const board = createBoard();
		const peer = new TaskBoardService({ teamDir: root as string, self: "worker", now: () => 43 });
		const prerequisite = board.create({ title: "Prerequisite" });
		const dependent = board.create({
			title: "Manual claim wins",
			dependencies: [prerequisite.id],
			executionPlan: { type: "reviewer" },
		});
		const manager = {
			subscribe: () => () => {},
			teammateMembershipId: () => undefined,
			spawn: vi.fn(async () => ({ id: "auto-overrode-manual-claim" })),
			get: () => undefined,
		};
		const execution = new TaskExecutionService({ board, manager: manager as never });
		automate(board, execution, true);
		const lockPath = join(board.taskDir, "board.lock");
		const originalReserve = board.reserveExecution.bind(board);
		let markFirstConflict!: () => void;
		const firstConflict = new Promise<void>((resolve) => {
			markFirstConflict = resolve;
		});
		const reserve = vi.spyOn(board, "reserveExecution").mockImplementation((...args) => {
			try {
				return originalReserve(...args);
			} catch (error) {
				markFirstConflict();
				throw error;
			}
		});
		finish(board, prerequisite.id);
		writeFileSync(lockPath, `${process.pid}:55555555-5555-5555-5555-555555555555`);
		await firstConflict;
		rmSync(lockPath, { force: true });
		peer.update({ id: dependent.id, status: "in_progress" });
		writeFileSync(lockPath, `${process.pid}:66666666-6666-6666-6666-666666666666`);
		const callsBeforeRetry = reserve.mock.calls.length;
		await vi.waitFor(() => expect(reserve.mock.calls.length).toBeGreaterThan(callsBeforeRetry));
		rmSync(lockPath, { force: true });
		await vi.waitFor(() => {
			const last = reserve.mock.results.at(-1);
			expect(last?.type).toBe("throw");
			if (last?.type === "throw")
				expect(last.value).toMatchObject({ message: expect.stringMatching(/^Task status is stale/) });
		});
		expect(manager.spawn).not.toHaveBeenCalled();
		expect(board.get(dependent.id)).toMatchObject({ status: "in_progress", owner: "worker", attempts: [] });
		execution.dispose();
	});

	it("cancels a pending reservation retry before session shutdown can spawn", async () => {
		const board = createBoard();
		const prerequisite = board.create({ title: "Prerequisite" });
		const dependent = board.create({
			title: "Cancelled during shutdown",
			dependencies: [prerequisite.id],
			executionPlan: { type: "reviewer" },
		});
		const manager = {
			subscribe: () => () => {},
			teammateMembershipId: () => undefined,
			spawn: vi.fn(async () => ({ id: "run-after-shutdown" })),
			get: () => undefined,
		};
		const execution = new TaskExecutionService({ board, manager: manager as never });
		const automation = automate(board, execution, true);
		const reserve = vi.spyOn(board, "reserveExecution");
		finish(board, prerequisite.id);
		writeFileSync(join(board.taskDir, "board.lock"), `${process.pid}:11111111-1111-1111-1111-111111111111`);
		await vi.waitFor(() => expect(reserve).toHaveBeenCalled());
		automation.dispose();
		await new Promise((resolve) => setTimeout(resolve, 30));
		rmSync(join(board.taskDir, "board.lock"), { force: true });
		await flush();
		expect(manager.spawn).not.toHaveBeenCalled();
		expect(board.get(dependent.id)).toMatchObject({ status: "pending", attempts: [] });
		execution.dispose();
	});

	it("joins a fenced pre-spawn reservation through conflicting rollback writes", async () => {
		const board = createBoard();
		const task = board.create({ title: "Reserved before spawn" });
		let releaseSpawn!: () => void;
		let enteredSpawn!: () => void;
		const spawnEntered = new Promise<void>((resolve) => {
			enteredSpawn = resolve;
		});
		const spawnGate = new Promise<void>((resolve) => {
			releaseSpawn = resolve;
		});
		let reconcile!: (name: string, membershipId?: string, phase?: "fence" | "reconcile") => Promise<void>;
		const manager = {
			registerTaskShutdownReconciler: (callback: typeof reconcile) => {
				reconcile = callback;
				return () => {};
			},
			subscribe: () => () => {},
			teammateMembershipId: () => undefined,
			spawn: vi.fn(async () => {
				enteredSpawn();
				await spawnGate;
				throw new Error("shutdown fenced admission");
			}),
			get: () => undefined,
		};
		const execution = new TaskExecutionService({ board, manager: manager as never });
		const attempt = execution.execute(task.id, {
			actor: { name: "lead", coordinator: true },
			type: "reviewer",
			name: "worker",
		});
		await spawnEntered;
		await reconcile("worker", undefined, "fence");
		const lock = join(board.taskDir, "board.lock");
		writeFileSync(lock, `${process.pid}:11111111-1111-1111-1111-111111111111`);
		let reconciliationFinished = false;
		const reconciliation = reconcile("worker", undefined, "reconcile").then(() => {
			reconciliationFinished = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(reconciliationFinished).toBe(false);
		releaseSpawn();
		const unlockTimer = setTimeout(() => rmSync(lock, { force: true }), 120);
		await expect(attempt).rejects.toThrow(/shutdown fenced admission/);
		clearTimeout(unlockTimer);
		rmSync(lock, { force: true });
		await reconciliation;
		expect(board.get(task.id)).toMatchObject({ status: "pending", attempts: [{ status: "failed" }] });
		execution.dispose();
	});

	it("surfaces malformed peer files without crashing or suppressing other watchers", async () => {
		const board = createBoard();
		const run = executor(async () => ({}));
		automate(board, run, true);
		let uiNotifications = 0;
		const unwatch = board.watch(() => {
			uiNotifications += 1;
		});
		disposables.push(unwatch);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const malformed = join(board.taskDir, "malformed.json");
		writeFileSync(malformed, "{");
		await vi.waitFor(() => expect(warning).toHaveBeenCalled());
		expect(uiNotifications).toBeGreaterThan(0);
		expect(existsSync(malformed)).toBe(true);
		expect(run.execute).not.toHaveBeenCalled();
		warning.mockRestore();
	});

	it("cancels queued work on disposal and defers launch until the completion write returns", async () => {
		const board = createBoard();
		const prerequisite = board.create({ title: "Prerequisite" });
		const planned = board.create({
			title: "Planned",
			dependencies: [prerequisite.id],
			executionPlan: { type: "reviewer" },
		});
		const run = executor(async () => {
			board.create({ title: "No nested lock conflict" });
			return {};
		});
		const service = automate(board, run, true);
		finish(board, prerequisite.id);
		await flush();
		expect(run.execute).toHaveBeenCalledWith(planned.id, expect.anything());
		service.dispose();

		const another = board.create({ title: "Another prerequisite" });
		board.create({ title: "Another planned", dependencies: [another.id], executionPlan: { type: "reviewer" } });
		finish(board, another.id);
		service.dispose();
		await flush();
		expect(run.execute).toHaveBeenCalledTimes(1);
	});
});

describe("task reminder cadence", () => {
	it("reminds every fourth lead turn and resets after task tool use", () => {
		const cadence = new TaskReminderCadence();
		cadence.turnStart();
		cadence.turnStart();
		cadence.turnStart();
		expect(cadence.consume()).toBe(false);
		cadence.taskToolUsed();
		for (let i = 0; i < 3; i += 1) cadence.turnStart();
		expect(cadence.consume()).toBe(false);
		cadence.turnStart();
		expect(cadence.consume()).toBe(true);
		expect(cadence.consume()).toBe(false);
	});

	it("warns and skips reminders for malformed tasks, then recovers after repair", () => {
		const board = createBoard();
		board.create({ title: "Valid task" });
		const malformed = join(board.taskDir, "malformed.json");
		writeFileSync(malformed, "{");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(summarizeRelevantTasks(board)).toBeUndefined();
			expect(warning).toHaveBeenCalledWith(expect.stringContaining("Could not build task reminder"));
			expect(existsSync(malformed)).toBe(true);
			rmSync(malformed);
			expect(summarizeRelevantTasks(board)).toContain("Valid task");
		} finally {
			warning.mockRestore();
		}
	});

	it("summarizes only relevant tasks, blockers, and bounded untrusted content", () => {
		const board = createBoard();
		const blocker = board.create({ title: "A blocker" });
		board.create({ title: "Owned pending", dependencies: [blocker.id] });
		board.create({ title: "Other owner", assignee: "worker" });
		const summary = summarizeRelevantTasks(board);
		expect(summary).toContain("Owned pending");
		expect(summary).toContain(blocker.code);
		expect(summary).not.toContain("Other owner");
		expect(summary).toContain("untrusted");
		const huge = board.create({ title: "x".repeat(5_000) });
		board.update({ id: huge.id, status: "in_progress" });
		expect(summarizeRelevantTasks(board)?.length).toBeLessThan(2_200);
	});
});
