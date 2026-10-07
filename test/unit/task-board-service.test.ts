// Durable board behavior and native tool surfaces (ADR 0007 §4).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
		expect(worker.get(next.id)).toMatchObject({ status: "pending", blockedBy: [first.id] });
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
		expect(() => lead.update({ id: task.id, status: "in_progress" })).toThrow(/owned by worker/);
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
