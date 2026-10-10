// Durable board behavior and native tool surfaces (ADR 0007 §4).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskBoardService } from "../../extension-src/pi-teams/app/task-board-service.js";
import { createTeamTaskTools } from "../../extension-src/pi-teams/pi/team-task-tools.js";

let root: string | undefined;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});
function board(team: string, self: string) {
	if (!root) throw new Error("Board fixture root is not initialized");
	return new TaskBoardService({ teamDir: join(root, team), self, now: () => 42 });
}

describe("TaskBoardService", () => {
	it("persists owner-only task files and makes dependency blockers disappear on completion", () => {
		root = mkdtempSync(join(tmpdir(), "task-board-"));
		const lead = board("team-a", "lead");
		const worker = board("team-a", "worker");
		const first = lead.create({ title: "First" });
		const next = lead.create({ title: "Next", dependencies: [first.id] });
		expect(statSync(join(lead.taskDir, `${first.id}.json`)).mode & 0o777).toBe(0o600);
		expect(worker.get(next.id)).toMatchObject({ status: "pending", blockedBy: [first.code] });
		expect(() => worker.update({ id: next.id, status: "in_progress" })).toThrow(/blocked/);
		worker.update({ id: first.id, status: "in_progress" });
		worker.update({ id: first.id, status: "completed" });
		expect(lead.get(next.id)).toMatchObject({ status: "pending", blockedBy: [] });
		worker.update({ id: next.id, status: "in_progress" });
	});

	it("admits exactly one claimant, enforces owner release/completion, and reports lock conflicts", () => {
		root = mkdtempSync(join(tmpdir(), "task-board-"));
		const lead = board("team-a", "lead");
		const worker = board("team-a", "worker");
		const task = lead.create({ title: "Claim me" });
		worker.update({ id: task.id, status: "in_progress" });
		expect(() => lead.update({ id: task.id, status: "in_progress" })).toThrow(/owned by @worker/);
		expect(() => lead.update({ id: task.id, status: "completed" })).toThrow(/owner/);
		worker.update({ id: task.id, status: "pending" });
		lead.update({ id: task.id, status: "in_progress" });
		lead.update({ id: task.id, status: "completed" });
		expect(() => worker.update({ id: task.id, status: "in_progress" })).toThrow(/terminal/);

		const contested = lead.create({ title: "Locked" });
		const lock = join(lead.taskDir, `${contested.id}.lock`);
		mkdirSync(lock, { mode: 0o700 });
		try {
			expect(() => worker.update({ id: contested.id, status: "in_progress" })).toThrow(/conflict/);
		} finally {
			rmSync(lock, { recursive: true, force: true });
		}
	});

	it("isolates teams and validates dependencies against the current board", () => {
		root = mkdtempSync(join(tmpdir(), "task-board-"));
		const oldTeam = board("old", "lead");
		const task = oldTeam.create({ title: "Old team" });
		const newTeam = board("new", "lead");
		expect(newTeam.get(task.id)).toBeUndefined();
		expect(() => newTeam.create({ title: "Invalid dependency", dependencies: [task.id] })).toThrow(
			/Unknown task dependency/,
		);
		oldTeam.update({ id: task.id, status: "in_progress" });
		expect(JSON.parse(readFileSync(join(oldTeam.taskDir, `${task.id}.json`), "utf8")).owner).toBe("lead");
		expect(newTeam.list()).toEqual([]);
	});

	it("allocates sequential codes and accepts codes or UUIDs interchangeably", () => {
		root = mkdtempSync(join(tmpdir(), "task-board-"));
		const lead = board("team-a", "lead");
		const first = lead.create({ title: "First" });
		const second = lead.create({ title: "Second", dependencies: ["T1"] });
		const third = lead.create({ title: "Third", dependencies: [first.id, "T2"] });
		expect([first.code, second.code, third.code]).toEqual(["T1", "T2", "T3"]);
		expect(second.dependencies).toEqual(["T1"]);
		expect(JSON.parse(readFileSync(join(lead.taskDir, `${second.id}.json`), "utf8")).dependencies).toEqual([first.id]);
		expect(() => lead.create({ title: "Bad", dependencies: ["T9"] })).toThrow("Unknown task dependency: T9");
		expect(() => lead.update({ id: "T9", status: "in_progress" })).toThrow("Unknown task: T9");
		lead.update({ id: "T1", status: "in_progress" });
		expect(lead.get(first.id)).toMatchObject({ status: "in_progress", owner: "lead" });
		lead.update({ id: first.id, status: "completed" });
		expect(lead.get("T3")).toMatchObject({ blockedBy: ["T2"] });
	});

	it("edits descriptions while pending only", () => {
		root = mkdtempSync(join(tmpdir(), "task-board-"));
		const lead = board("team-a", "lead");
		const worker = board("team-a", "worker");
		lead.create({ title: "Draft", description: "Old" });
		expect(worker.edit({ id: "T1", description: "New" })).toMatchObject({ code: "T1", description: "New" });
		worker.update({ id: "T1", status: "in_progress" });
		expect(() => lead.edit({ id: "T1", description: "Later" })).toThrow(
			'Only pending tasks can be edited: T1 "Draft" is in_progress',
		);
	});

	it("cancels pending tasks without dependents and keeps them listed", () => {
		root = mkdtempSync(join(tmpdir(), "task-board-"));
		const lead = board("team-a", "lead");
		const first = lead.create({ title: "First" });
		lead.create({ title: "Second", dependencies: [first.id] });
		lead.create({ title: "Third", dependencies: ["T1"] });
		lead.create({ title: "Fourth" });
		expect(() => lead.cancel({ id: "T1" })).toThrow('Cannot cancel T1 "First" - it is a dependency of: T2, T3');
		lead.update({ id: "T4", status: "in_progress" });
		expect(() => lead.cancel({ id: "T4" })).toThrow('Only pending tasks can be cancelled: T4 "Fourth" is in_progress');
		expect(lead.cancel({ id: "T3" })).toMatchObject({ code: "T3", status: "cancelled" });
		expect(lead.list().map((task) => [task.code, task.status])).toEqual([
			["T1", "pending"],
			["T2", "pending"],
			["T3", "cancelled"],
			["T4", "in_progress"],
		]);
	});

	it("rejects cancelling through update", () => {
		root = mkdtempSync(join(tmpdir(), "task-board-"));
		const lead = board("team-a", "lead");
		lead.create({ title: "No shortcuts" });
		expect(() => lead.update({ id: "T1", status: "cancelled" })).toThrow(/team_task_cancel/);
		expect(lead.get("T1")).toMatchObject({ status: "pending" });
	});

	it("teaches recovery for pending complete/release errors and retires via cancel", () => {
		root = mkdtempSync(join(tmpdir(), "task-board-"));
		const lead = board("team-a", "lead");
		const mistaken = lead.create({ title: "Mistaken" });
		expect(() => lead.update({ id: mistaken.id, status: "completed" })).toThrow(/claim it first/);
		expect(() => lead.update({ id: mistaken.id, status: "pending" })).toThrow(/nothing to release/);
		expect(lead.cancel({ id: mistaken.id })).toMatchObject({ status: "cancelled" });

		const claimed = lead.create({ title: "Claimed then retired" });
		lead.update({ id: claimed.id, status: "in_progress" });
		expect(() => lead.cancel({ id: claimed.id })).toThrow(/Only pending tasks can be cancelled/);
		lead.update({ id: claimed.id, status: "pending" });
		expect(lead.cancel({ id: claimed.id })).toMatchObject({ status: "cancelled" });

		const blocker = lead.create({ title: "Blocker" });
		lead.create({ title: "Dependent", dependencies: [blocker.id] });
		expect(() => lead.cancel({ id: blocker.id })).toThrow(/dependency of/);
	});

	it("keeps legacy codeless task files addressable by UUID", () => {
		root = mkdtempSync(join(tmpdir(), "task-board-"));
		const lead = board("legacy-team", "lead");
		const legacyId = "legacy-0001";
		writeFileSync(
			join(lead.taskDir, `${legacyId}.json`),
			JSON.stringify({
				id: legacyId,
				title: "Legacy",
				status: "pending",
				dependencies: [],
				createdAt: 1,
				updatedAt: 1,
			}),
			{ mode: 0o600 },
		);
		const modern = lead.create({ title: "Modern", dependencies: [legacyId] });
		expect(modern.code).toBe("T1");
		expect(modern.dependencies).toEqual([legacyId]);
		expect(lead.get(legacyId)).toMatchObject({ id: legacyId, title: "Legacy" });
		expect(modern.blockedBy).toEqual([legacyId]);
		lead.update({ id: legacyId, status: "in_progress" });
		lead.update({ id: legacyId, status: "completed" });
		expect(lead.get(modern.id)?.blockedBy).toEqual([]);
		expect(lead.list().map((task) => task.code ?? task.id)).toEqual([modern.code, legacyId]);
	});

	it("binds tool mutations to the current team after a session switch", async () => {
		root = mkdtempSync(join(tmpdir(), "task-board-"));
		const previous = board("previous", "lead");
		const task = previous.create({ title: "Owned in the previous session" });
		previous.update({ id: task.id, status: "in_progress" });
		let current: TaskBoardService | undefined = previous;
		const update = createTeamTaskTools(() => current).find((tool) => tool.name === "team_task_update");
		if (!update) throw new Error("Task update tool is unavailable");
		current = board("current", "lead");
		await expect(
			update.execute("call", { id: task.id, status: "completed" }, undefined, undefined, undefined as never),
		).rejects.toThrow();
		expect(previous.get(task.id)).toMatchObject({ status: "in_progress", owner: "lead" });
		current = undefined;
		await expect(
			update.execute("call", { id: task.id, status: "completed" }, undefined, undefined, undefined as never),
		).rejects.toThrow();
	});
});
