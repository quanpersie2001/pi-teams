import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskBoardService } from "../../extension-src/pi-teams/app/task-board-service.js";
import { TaskExecutionService } from "../../extension-src/pi-teams/app/task-execution-service.js";
import { parseBoardTask } from "../../extension-src/pi-teams/domain/task-board.js";
import { createTasksTools } from "../../extension-src/pi-teams/pi/tasks-tools.js";

let root: string | undefined;
function getRoot(): string {
	if (!root) throw new Error("Test root is not initialized");
	return root;
}
interface TestLifecycleEvent {
	event: string;
	agentId: string;
	completedAt?: number;
	result?: string;
	resultFile?: string;
	error?: string;
}
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});
function board(team = "team", self = "lead") {
	root ??= mkdtempSync(join(tmpdir(), "unified-tasks-"));
	return new TaskBoardService({ teamDir: join(root, team), self, now: () => 42 });
}
const resultObject = (result: { content: { text?: string }[] }) => JSON.parse(result.content[0]?.text ?? "null");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("unified task board", () => {
	it("round trips rich typed fields and safely reads legacy per-task JSON", () => {
		const b = board();
		const t = b.create({
			title: "Rich",
			description: "desc",
			spec: {
				acceptanceCriteria: ["test"],
				scope: { paths: ["src"], outOfScope: ["docs"] },
				constraints: ["keep API"],
				expectedOutput: "patch",
			},
			context: {
				background: "why",
				decisions: ["D1"],
				references: [{ kind: "url", target: "https://example.test", note: "untrusted" }],
			},
		});
		expect(JSON.parse(readFileSync(join(b.taskDir, `${t.id}.json`), "utf8")).schemaVersion).toBe(2);
		expect(b.get(t.id)).toMatchObject({
			requirementRevision: 1,
			spec: { acceptanceCriteria: ["test"], scope: { paths: ["src"], outOfScope: ["docs"] } },
			context: { references: [{ kind: "url" }] },
		});
		b.update({ id: t.id, status: "in_progress" });
		const attempt = b.reserveAttempt(t.id, "rich-run");
		expect(attempt.teammateName).toBe("lead");
		expect(b.get(t.id)?.attempts).toMatchObject([{ teammateName: "lead", runId: "rich-run" }]);
		expect(JSON.parse(readFileSync(join(b.taskDir, `${t.id}.json`), "utf8")).attempts[0].teammateName).toBe("lead");
		const legacy = "legacy-task";
		writeFileSync(
			join(b.taskDir, `${legacy}.json`),
			JSON.stringify({ id: legacy, title: "Legacy", status: "pending", dependencies: [], createdAt: 1, updatedAt: 1 }),
		);
		expect(b.get(legacy)).toMatchObject({ id: legacy, requirementRevision: 1, spec: {}, attempts: [] });
	});
	it("rejects malformed attempt evidence and unknown future schema versions", () => {
		const b = board("strict-parser");
		const task = b.create({ title: "Strict" });
		const legacy = { id: "legacy", title: "Legacy", status: "pending", dependencies: [], createdAt: 1, updatedAt: 1 };
		expect(parseBoardTask(legacy)).toMatchObject({ requirementRevision: 1, spec: {}, context: {}, attempts: [] });
		expect(parseBoardTask({ ...legacy, schemaVersion: 99 })).toBeUndefined();
		const malformedAttempt = { ...legacy, attempts: [{ runId: "r", status: "running" }] };
		expect(parseBoardTask(malformedAttempt)).toBeUndefined();
		writeFileSync(
			join(b.taskDir, `${task.id}.json`),
			JSON.stringify({ ...legacy, id: task.id, attempts: [{ runId: "r", status: "running" }] }),
		);
		expect(() => b.get(task.id)).toThrow(/Malformed task file/);
	});
	it("checks DAG references/cycles atomically, enforces atomic claims and review policy", () => {
		const lead = board("dag", "lead"),
			worker = board("dag", "worker");
		const a = lead.create({ title: "A" });
		if (!a.code) throw new Error("Expected task code");
		const b = lead.create({ title: "B", dependencies: [a.code] });
		expect(() => lead.update({ id: a.id, dependencies: [b.id] })).toThrow(/cycle/);
		worker.update({ id: a.id, status: "in_progress" });
		expect(() => lead.update({ id: a.id, status: "in_progress" })).toThrow(/owned by @worker/);
		expect(() => worker.update({ id: a.id, status: "in_review" })).toThrow(/not requested/);
		worker.update({ id: a.id, status: "pending" });
		lead.update({ id: a.id, status: "in_progress" });
		expect(() => lead.update({ id: a.id, spec: { constraints: ["changed"] } })).toThrow(/pending tasks/);
		lead.update({
			id: a.id,
			status: "completed",
			outcome: { summary: "done", verification: [{ check: "test", outcome: "passed" }] },
		});
		expect(lead.get(b.id)?.blockedBy).toEqual([]);
		const reviewed = lead.create({ title: "Review", reviewRequested: true });
		lead.update({ id: reviewed.id, status: "in_progress" });
		expect(() => lead.update({ id: reviewed.id, status: "completed" })).toThrow(/requires review/);
		lead.update({ id: reviewed.id, status: "in_review" });
		lead.update({ id: reviewed.id, status: "completed" });
	});
	it("merges partial spec edits, validates assignees, and supports list filters", () => {
		const b = board("filters");
		const one = b.create({
			title: "Alpha",
			assignee: "worker",
			spec: { acceptanceCriteria: ["AC"], scope: { paths: ["src"], outOfScope: ["docs"] } },
		});
		const two = b.create({ title: "Beta" });
		b.update({ id: one.id, spec: { constraints: ["keep simple"] } });
		expect(() => b.update({ id: one.id, expectedRequirementRevision: 1, title: "Stale" })).toThrow(/revision is stale/);
		expect(b.get(one.id)?.title).toBe("Alpha");
		expect(b.get(one.id)?.spec).toEqual({
			acceptanceCriteria: ["AC"],
			scope: { paths: ["src"], outOfScope: ["docs"] },
			constraints: ["keep simple"],
		});
		expect(() => b.update({ id: two.id, assignee: "not a valid name" })).toThrow(/assignee/);
		expect(() => b.update({ id: two.id, spec: { acceptanceCriteria: "bad" as never } })).toThrow(/Invalid task fields/);
		expect(b.get(two.id)?.spec).toEqual({});
		expect(b.list({ assignee: "worker" }).map((task) => task.code)).toEqual([one.code]);
		expect(b.list({ query: "beta", status: "pending", blocked: false }).map((task) => task.code)).toEqual([two.code]);
	});
	it("guards active attempts and requires explicit manual outcome after failure", () => {
		const b = board("active-guards");
		const task = b.create({ title: "Active" });
		b.update({ id: task.id, status: "in_progress" });
		const attempt = b.reserveAttempt(task.id, "run-guard");
		if (!attempt.reservationId) throw new Error("Expected reservation ID");
		expect(() => b.update({ id: task.id, status: "pending" })).toThrow(/execution is active/);
		expect(() => b.update({ id: task.id, status: "completed" })).toThrow(/execution is active/);
		expect(() => b.update({ id: task.id, description: "mutated" })).toThrow(/execution is active/);
		b.settleAttempt(task.id, attempt.reservationId, { status: "failed", settledAt: 50, error: "failed" });
		expect(() => b.update({ id: task.id, status: "completed" })).toThrow(/explicit outcome/);
		b.update({ id: task.id, status: "completed", outcome: { summary: "Manually verified recovery" } });
		expect(b.get(task.id)?.status).toBe("completed");
	});
	it("exposes one unified tool vocabulary and binds tools to the current session", async () => {
		const taskBoard = board("tools");
		const tools = createTasksTools(() => taskBoard);
		expect(tools.map((t) => t.name)).toEqual([
			"tasks_create",
			"tasks_list",
			"tasks_get",
			"tasks_update",
			"tasks_cancel",
			"tasks_execute",
			"tasks_output",
			"tasks_stop",
		]);
		const create = tools.find((tool) => tool.name === "tasks_create");
		if (!create) throw new Error("tasks_create tool is missing");
		const task = resultObject(
			await create.execute(
				"call",
				{
					title: "Tool task",
					acceptanceCriteria: ["AC"],
					expectedOutput: "initial",
					executionPlan: { type: "reviewer" },
				},
				undefined,
				undefined,
				undefined as never,
			),
		);
		expect(task.spec.acceptanceCriteria).toEqual(["AC"]);
		const update = tools.find((tool) => tool.name === "tasks_update");
		if (!update) throw new Error("tasks_update tool is missing");
		const cleared = resultObject(
			await update.execute(
				"update",
				{ id: task.id, executionPlan: null, expectedOutput: "" },
				undefined,
				undefined,
				undefined as never,
			),
		);
		expect(cleared.executionPlan).toBeUndefined();
		expect(cleared.spec.expectedOutput).toBe("");
		expect(cleared.requirementRevision).toBe(2);
	});
});

describe("task execution bridge", () => {
	function harness(spawn: () => Promise<{ id: string }> = async () => ({ id: "run-1" })) {
		const listeners = new Set<(event: TestLifecycleEvent) => void>();
		const manager = {
			subscribe: (fn: (event: TestLifecycleEvent) => void) => {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
			get: () => undefined,
			getHistoricalRun: () => undefined,
			teammateMembershipId: () => undefined,
			spawn,
			stop: async () => true,
			getResult: async (id: string) => `output ${id}`,
		};
		return { manager, listeners };
	}
	it("rolls back reservation on spawn failure and rejects a duplicate active launch", async () => {
		const b = board("rollback");
		const task = b.create({ title: "Execute" });
		const h = harness(async () => {
			throw new Error("spawn rejected");
		});
		const service = new TaskExecutionService({ board: b, manager: h.manager as never });
		await expect(service.execute(task.id, { actor: { name: "lead" }, type: "worker" })).rejects.toThrow(
			"spawn rejected",
		);
		expect(b.get(task.id)?.attempts[0]?.status).toBe("failed");
		service.dispose();
		const b2 = board("duplicate");
		const t = b2.create({ title: "Duplicate" });
		let resolve!: (x: { id: string }) => void;
		const h2 = harness(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		const s2 = new TaskExecutionService({ board: b2, manager: h2.manager as never });
		const pending = s2.execute(t.id, { actor: { name: "lead" }, type: "worker" });
		await Promise.resolve();
		await expect(s2.execute(t.id, { actor: { name: "lead" }, type: "worker" })).rejects.toThrow(/active attempt/);
		resolve({ id: "run-2" });
		await pending;
		s2.dispose();
	});
	it("rolls back using the claim snapshot taken under the retried reservation lock", async () => {
		const b = board("reservation-preimage");
		const task = b.create({ title: "Reservation race" });
		b.update({ id: task.id, status: "in_progress" });
		writeFileSync(join(b.taskDir, "board.lock"), `${process.pid}:44444444-4444-4444-4444-444444444444`);
		const h = harness(async () => {
			throw new Error("spawn rejected after release");
		});
		const service = new TaskExecutionService({ board: b, manager: h.manager as never });
		const execution = service.execute(task.id, { actor: { name: "lead" }, type: "worker" });
		await pause(2);
		rmSync(join(b.taskDir, "board.lock"), { force: true });
		b.update({ id: task.id, status: "pending" });
		await expect(execution).rejects.toThrow("spawn rejected after release");
		expect(b.get(task.id)).toMatchObject({ status: "pending", attempts: [{ status: "failed" }] });
		expect(b.get(task.id)?.owner).toBeUndefined();
		service.dispose();
	});
	it("freezes task execution before both session shutdown handlers await teardown", () => {
		const source = readFileSync(join(process.cwd(), "extension-src/pi-teams/pi/index.ts"), "utf8");
		const switchStart = source.indexOf('pi.on("session_before_switch"');
		const shutdownStart = source.indexOf('pi.on("session_shutdown"');
		expect(switchStart).toBeGreaterThanOrEqual(0);
		expect(shutdownStart).toBeGreaterThan(switchStart);
		for (const handler of [source.slice(switchStart, shutdownStart), source.slice(shutdownStart)]) {
			const freeze = handler.indexOf("taskExecution?.freezeAdmissions();");
			const teardown = handler.indexOf("await app.sessionShutdown();");
			expect(freeze).toBeGreaterThanOrEqual(0);
			expect(teardown).toBeGreaterThan(freeze);
		}
	});
	it("freezes new admissions across reservation retries and reserved-before-spawn window", async () => {
		const b = board("freeze-retry");
		const task = b.create({ title: "Freeze retry" });
		const lock = join(b.taskDir, "board.lock");
		writeFileSync(lock, `${process.pid}:55555555-5555-5555-5555-555555555555`);
		const h = harness();
		let spawns = 0;
		h.manager.spawn = async () => {
			spawns++;
			return { id: "should-not-spawn" };
		};
		const service = new TaskExecutionService({ board: b, manager: h.manager as never });
		const pending = service.execute(task.id, { actor: { name: "lead" }, type: "worker" });
		service.freezeAdmissions();
		rmSync(lock, { force: true });
		await expect(pending).rejects.toThrow(/cancelled before spawn/);
		expect(spawns).toBe(0);
		expect(b.get(task.id)).toMatchObject({ status: "pending", attempts: [] });
		service.dispose();

		const b2 = board("freeze-reserved");
		const task2 = b2.create({ title: "Reserved before freeze" });
		const h2 = harness();
		let reservedSpawns = 0;
		h2.manager.spawn = async () => {
			reservedSpawns++;
			return { id: "should-not-spawn-reserved" };
		};
		const service2 = new TaskExecutionService({ board: b2, manager: h2.manager as never });
		const unsubscribe = b2.subscribe((event) => {
			if (event.id === task2.id && event.task?.attempts.some((attempt) => attempt.status === "running"))
				service2.freezeAdmissions();
		});
		await expect(service2.execute(task2.id, { actor: { name: "lead" }, type: "worker" })).rejects.toThrow(
			/cancelled before spawn/,
		);
		expect(reservedSpawns).toBe(0);
		expect(b2.get(task2.id)).toMatchObject({ status: "pending", attempts: [{ status: "failed" }] });
		expect(b2.get(task2.id)?.owner).toBeUndefined();
		unsubscribe();
		service2.dispose();
	});
	it("preserves live settlement retries after admission freeze", async () => {
		const b = board("freeze-live-settlement");
		const task = b.create({ title: "Continue settlement" });
		const h = harness();
		const service = new TaskExecutionService({ board: b, manager: h.manager as never });
		await service.execute(task.id, { actor: { name: "lead" }, type: "worker" });
		writeFileSync(join(b.taskDir, "board.lock"), `${process.pid}:66666666-6666-6666-6666-666666666666`);
		for (const listener of h.listeners)
			listener({ event: "completed", agentId: "run-1", completedAt: 77, result: "finished" });
		service.freezeAdmissions();
		setTimeout(() => rmSync(join(b.taskDir, "board.lock"), { force: true }), 5);
		await pause(60);
		expect(b.get(task.id)?.attempts[0]).toMatchObject({ status: "completed", settledAt: 77 });
		service.dispose();
	});
	it("preserves stop/failure outcomes without completing and enforces output authority", async () => {
		const b = board("settle");
		const task = b.create({ title: "Stop", assignee: "worker" });
		const h = harness();
		const service = new TaskExecutionService({ board: b, manager: h.manager as never });
		await service.execute(task.id, { actor: { name: "lead" }, type: "worker" });
		expect(await service.stop(task.id, { actor: { name: "lead", coordinator: true } })).toBe(true);
		expect(b.get(task.id)).toMatchObject({ owner: "worker", assignee: "worker" });
		await expect(service.output(task.id, { actor: { name: "other" } })).rejects.toThrow(/Only the task owner/);
		for (const listener of h.listeners) listener({ event: "stopped", agentId: "run-1", completedAt: 50 });
		expect(b.get(task.id)).toMatchObject({ status: "in_progress", attempts: [{ status: "stopped", runId: "run-1" }] });
		service.dispose();
	});
	it("retries transient binding and lifecycle settlement lock conflicts; dispose cancels pending retries", async () => {
		const b = board("retry-binding");
		const task = b.create({ title: "Retry binding" });
		const h = harness();
		h.manager.spawn = async () => {
			writeFileSync(join(b.taskDir, "board.lock"), `${process.pid}:11111111-1111-1111-1111-111111111111`);
			setTimeout(() => rmSync(join(b.taskDir, "board.lock"), { force: true }), 5);
			return { id: "retry-run" };
		};
		const service = new TaskExecutionService({ board: b, manager: h.manager as never });
		await service.execute(task.id, { actor: { name: "lead" }, type: "worker" });
		expect(b.get(task.id)?.attempts[0]).toMatchObject({ runId: "retry-run", status: "running" });
		writeFileSync(join(b.taskDir, "board.lock"), `${process.pid}:22222222-2222-2222-2222-222222222222`);
		for (const listener of h.listeners)
			listener({ event: "completed", agentId: "retry-run", completedAt: 99, result: "done" });
		setTimeout(() => rmSync(join(b.taskDir, "board.lock"), { force: true }), 5);
		await pause(60);
		expect(b.get(task.id)?.attempts[0]).toMatchObject({ status: "completed", settledAt: 99 });
		service.dispose();

		const b2 = board("retry-cancel");
		const task2 = b2.create({ title: "Cancel retry" });
		const h2 = harness();
		const service2 = new TaskExecutionService({ board: b2, manager: h2.manager as never });
		await service2.execute(task2.id, { actor: { name: "lead" }, type: "worker" });
		writeFileSync(join(b2.taskDir, "board.lock"), `${process.pid}:33333333-3333-3333-3333-333333333333`);
		for (const listener of h2.listeners) listener({ event: "stopped", agentId: "run-1", completedAt: 101 });
		service2.dispose();
		rmSync(join(b2.taskDir, "board.lock"), { force: true });
		await pause(40);
		expect(b2.get(task2.id)?.attempts[0]?.status).toBe("running");
	});
	it("settles a run that becomes terminal before the post-spawn subscription handoff", async () => {
		const b = board("fast-settlement");
		const task = b.create({ title: "Fast" });
		let terminal: unknown;
		const h = harness(async () => {
			terminal = { id: "fast-run", status: "completed", completedAt: 55, result: "done" };
			return { id: "fast-run" };
		});
		h.manager.get = () => terminal as never;
		const service = new TaskExecutionService({ board: b, manager: h.manager as never });
		await service.execute(task.id, { actor: { name: "lead" }, type: "worker" });
		expect(b.get(task.id)).toMatchObject({
			status: "in_progress",
			owner: "task-t1",
			attempts: [{ status: "completed", runId: "fast-run" }],
		});
		service.dispose();
	});
	it("reconciles only manager-verified terminal runs and keeps unknown attempts reserved", async () => {
		const b = board("recovery");
		const task = b.create({ title: "Recover" });
		b.update({ id: task.id, status: "in_progress" });
		const attempt = b.reserveAttempt(task.id, "run-known");
		const unknownTask = b.create({ title: "Unknown" });
		b.update({ id: unknownTask.id, status: "in_progress" });
		b.reserveAttempt(unknownTask.id, "run-unknown");
		const uncertainTask = b.create({ title: "Unverified historical stop" });
		b.update({ id: uncertainTask.id, status: "in_progress" });
		b.reserveAttempt(uncertainTask.id, "run-uncertain");
		const completedTask = b.create({ title: "Completed despite worktree recovery warning" });
		b.update({ id: completedTask.id, status: "in_progress" });
		b.reserveAttempt(completedTask.id, "run-historical-completed");
		const liveTask = b.create({ title: "Live terminal with cleanup warning" });
		b.update({ id: liveTask.id, status: "in_progress" });
		b.reserveAttempt(liveTask.id, "run-live-terminal");
		const listeners = new Set<(event: TestLifecycleEvent) => void>();
		const manager = {
			get: (id: string) =>
				id === "run-live-terminal"
					? { id, status: "stopped", completedAt: 102, recoveryError: "worktree cleanup failed" }
					: undefined,
			getHistoricalRun: (id: string) =>
				id === "run-known"
					? { id: "run-known", status: "stopped", completedAt: 99 }
					: id === "run-uncertain"
						? { id: "run-uncertain", status: "stopped", recoveryError: "process identity was unavailable" }
						: id === "run-historical-completed"
							? { id, status: "completed", completedAt: 103, recoveryError: "worktree cleanup failed" }
							: undefined,
			subscribe: (fn: (event: TestLifecycleEvent) => void) => {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
			teammateMembershipId: () => undefined,
		};
		const service = new TaskExecutionService({ board: b, manager: manager as never });
		expect(b.get(task.id)?.attempts[0]).toMatchObject({ runId: "run-known", status: "stopped", settledAt: 99 });
		expect(b.get(completedTask.id)?.attempts[0]).toMatchObject({ status: "completed", settledAt: 103 });
		expect(b.get(liveTask.id)?.attempts[0]).toMatchObject({ status: "stopped", settledAt: 102 });
		expect(await service.output(unknownTask.id, { actor: { name: "lead", coordinator: true } })).toMatchObject({
			error: expect.stringContaining("remains unverified and reserved"),
		});
		expect(b.get(uncertainTask.id)?.attempts[0]?.status).toBe("running");
		expect(await service.output(uncertainTask.id, { actor: { name: "lead", coordinator: true } })).toMatchObject({
			error: expect.stringContaining("remains unverified and reserved"),
		});
		await expect(service.execute(uncertainTask.id, { actor: { name: "lead" }, type: "worker" })).rejects.toThrow(
			/active attempt/,
		);
		service.dispose();
		expect(attempt.status).toBe("running");
	});
	it("serves durable result artifacts after manager history is unavailable", async () => {
		const b = board("durable-output");
		const task = b.create({ title: "Durable" });
		b.update({ id: task.id, status: "in_progress" });
		const attempt = b.reserveAttempt(task.id, "run-durable");
		if (!attempt.reservationId) throw new Error("Expected reservation ID");
		const artifactRoot = join(getRoot(), "output-artifacts");
		const resultFile = join(artifactRoot, "sessions", "run-durable", "result.md");
		mkdirSync(join(artifactRoot, "sessions", "run-durable"), { recursive: true });
		writeFileSync(resultFile, "full durable answer");
		b.settleAttempt(task.id, attempt.reservationId, {
			status: "completed",
			settledAt: 60,
			resultFile,
			result: { summary: "preview" },
		});
		const h = harness();
		const service = new TaskExecutionService({ board: b, manager: h.manager as never, artifactRoot });
		expect(await service.output(task.id, { actor: { name: "lead", coordinator: true } })).toMatchObject({
			result: "full durable answer",
		});
		service.dispose();
	});
	it("recovers only verified persisted run receipts and rejects stale lock owners", () => {
		const b = board("stale-recovery");
		const task = b.create({ title: "Stale lock" });
		writeFileSync(join(b.taskDir, "board.lock"), "2147483647:deadbeef-0000-0000-0000-000000000000");
		expect(b.create({ title: "After stale lock" }).code).toBe("T2");
		const liveLock = join(b.taskDir, "board.lock");
		writeFileSync(liveLock, "unverifiable-owner");
		expect(() => b.create({ title: "Contested" })).toThrow(/conflict/);
		expect(readFileSync(liveLock, "utf8")).toBe("unverifiable-owner");
		rmSync(liveLock, { force: true });
		expect(task.status).toBe("pending");
	});
	it("defers live-owner release while a stale collector holds the mutation gate", async () => {
		const b = board("release-gate");
		const gate = join(b.taskDir, "board.lock.mutation");
		const unsubscribe = b.subscribe((event) => {
			if (event.type !== "created") return;
			mkdirSync(gate);
			setTimeout(() => rmdirSync(gate), 20);
		});
		const created = b.create({ title: "Release after gate" });
		const lock = join(b.taskDir, "board.lock");
		expect(readFileSync(lock, "utf8")).toMatch(new RegExp(`^${process.pid}:`));
		await pause(80);
		expect(() => readFileSync(lock, "utf8")).toThrow();
		expect(created.code).toBe("T1");
		unsubscribe();
		expect(b.create({ title: "After deferred release" }).code).toBe("T2");
	});
	it("does not remove a normal writer that wins the stale-recovery acquisition gap", () => {
		const b = board("recovery-winner");
		const lock = join(b.taskDir, "board.lock");
		const marker = join(b.taskDir, "board.lock.mutation");
		writeFileSync(lock, "2147483647:stale-0000-0000-0000-000000000000");
		mkdirSync(marker);
		const winner = `${process.pid}:winner-0000-0000-0000-000000000000`;
		writeFileSync(lock, winner);
		expect(() => b.create({ title: "Contender" })).toThrow(/conflict/);
		expect(readFileSync(lock, "utf8")).toBe(winner);
		rmdirSync(marker);
		rmSync(lock);
	});
	it("bounds context packets and isolates session boards", async () => {
		const a = board("session-a"),
			b = board("session-b");
		const task = a.create({ title: "Context", description: "x".repeat(20_000), spec: { acceptanceCriteria: ["AC"] } });
		expect(b.list()).toEqual([]);
		const h = harness();
		let prompt = "";
		h.manager.spawn = async (request: { prompt: string }) => {
			prompt = request.prompt;
			return { id: "context-run" };
		};
		const artifactRoot = join(getRoot(), "artifact-root");
		const resultPath = join(artifactRoot, "sessions", "run-z", "result.md");
		mkdirSync(join(artifactRoot, "sessions", "run-z"), { recursive: true });
		writeFileSync(resultPath, "full durable result");
		const service = new TaskExecutionService({ board: a, manager: h.manager as never, artifactRoot });
		await service.execute(task.id, { actor: { name: "lead" }, type: "worker" });
		expect(prompt.length).toBeLessThan(16_001);
		expect(prompt).toContain("Acceptance criteria");
		expect(prompt).toContain("[goal truncated]");
		expect(prompt).toContain("Do not create nested agents");
		service.dispose();
	});
});
