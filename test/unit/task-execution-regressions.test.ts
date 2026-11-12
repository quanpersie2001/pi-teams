import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskBoardService } from "../../extension-src/pi-teams/app/task-board-service.js";
import { TaskExecutionService } from "../../extension-src/pi-teams/app/task-execution-service.js";
import { createTeamTaskTools } from "../../extension-src/pi-teams/pi/team-task-tools.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const teamDir = mkdtempSync(join(tmpdir(), "task-reservation-regression-"));
	roots.push(teamDir);
	const board = new TaskBoardService({ teamDir, self: "lead" });
	const task = board.create({ title: "Reservation", assignee: "worker" });
	const listeners = new Set<(event: unknown) => void>();
	const manager = {
		subscribe: (listener: (event: unknown) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		teammateMembershipId: () => "member-1",
		get: () => undefined,
		getHistoricalRun: () => undefined,
		spawn: vi.fn(async () => ({ id: "run-1", membershipId: "member-1" })),
		stop: vi.fn(async () => true),
	};
	const service = new TaskExecutionService({ board, manager: manager as never });
	return { teamDir, board, task, manager, listeners, service };
}

describe("task reservation membership regressions", () => {
	it("retries a pre-spawn membership conflict without orphaning the reservation", async () => {
		const { board, task, service, manager } = fixture();
		const bind = board.bindOwnerMembership.bind(board);
		vi.spyOn(board, "bindOwnerMembership")
			.mockImplementationOnce(() => {
				throw new Error("Task board conflict");
			})
			.mockImplementation(bind);
		try {
			await service.execute(task.id, { actor: { name: "lead" }, type: "worker" });
			expect(manager.spawn).toHaveBeenCalledOnce();
			expect(board.get(task.id)?.attempts[0]).toMatchObject({ runId: "run-1", status: "running" });
		} finally {
			service.dispose();
		}
	});
	it("rolls back a rejected pre-spawn membership binding", async () => {
		const { board, task, service, manager } = fixture();
		vi.spyOn(board, "bindOwnerMembership").mockImplementation(() => {
			throw new Error("membership rejected");
		});
		try {
			await expect(service.execute(task.id, { actor: { name: "lead" }, type: "worker" })).rejects.toThrow(
				"membership rejected",
			);
			expect(manager.spawn).not.toHaveBeenCalled();
			expect(board.get(task.id)).toMatchObject({ status: "pending", attempts: [{ status: "failed" }] });
		} finally {
			service.dispose();
		}
	});
	it("returns completion during a binding retry without requesting stop", async () => {
		const { board, task, service, manager, listeners } = fixture();
		const bind = board.bindAttempt.bind(board);
		vi.spyOn(board, "bindAttempt")
			.mockImplementationOnce(() => {
				for (const listener of listeners)
					listener({ event: "completed", agentId: "run-1", result: "done", completedAt: 99 });
				throw new Error("Task board conflict");
			})
			.mockImplementation(bind);
		try {
			const result = await service.execute(task.id, { actor: { name: "lead" }, type: "worker" });
			expect(result.task?.attempts[0]).toMatchObject({ runId: "run-1", membershipId: "member-1", status: "completed" });
			expect(manager.stop).not.toHaveBeenCalled();
		} finally {
			service.dispose();
		}
	});
	it("records child-tool claim membership and reconciles it on shutdown", async () => {
		const { teamDir, board, task, service } = fixture();
		const child = new TaskBoardService({ teamDir, self: "worker", selfMembershipId: "member-1" });
		const update = createTeamTaskTools(() => child).find((tool) => tool.name === "tasks_update");
		if (!update) throw new Error("Missing update tool");
		try {
			await update.execute("claim", { id: task.id, status: "in_progress" }, undefined, undefined, undefined as never);
			expect(board.get(task.id)?.ownerMembershipId).toBe("member-1");
			await service.reconcileTeammateShutdown("worker", "member-1");
			expect(board.get(task.id)?.status).toBe("pending");
		} finally {
			service.dispose();
		}
	});
	it("retries post-spawn membership binding atomically with the attempt", async () => {
		const { board, task, service, manager } = fixture();
		manager.teammateMembershipId = () => undefined as never;
		const bind = board.bindAttempt.bind(board);
		vi.spyOn(board, "bindAttempt")
			.mockImplementationOnce(() => {
				throw new Error("Task board conflict");
			})
			.mockImplementation(bind);
		try {
			await service.execute(task.id, { actor: { name: "lead" }, type: "worker" });
			expect(board.get(task.id)).toMatchObject({
				ownerMembershipId: "member-1",
				attempts: [{ membershipId: "member-1", runId: "run-1" }],
			});
			expect(manager.stop).not.toHaveBeenCalled();
		} finally {
			service.dispose();
		}
	});
	it("does not let a reincarnated alias update, rebind, execute, or release a prior claim", async () => {
		const { teamDir, board, task, service, manager } = fixture();
		const original = new TaskBoardService({ teamDir, self: "worker", selfMembershipId: "member-1" });
		original.update({ id: task.id, status: "in_progress" });
		const replacement = new TaskBoardService({ teamDir, self: "worker", selfMembershipId: "member-2" });
		try {
			for (const status of ["in_progress", "pending", "completed"] as const)
				expect(() => replacement.update({ id: task.id, status })).toThrow(/membership/);
			expect(() => board.bindOwnerMembership(task.id, "member-2")).toThrow(/membership/);
			manager.teammateMembershipId = () => "member-2";
			await expect(service.execute(task.id, { actor: { name: "lead" }, type: "worker" })).rejects.toThrow(/membership/);
			expect(manager.spawn).not.toHaveBeenCalled();
			await service.reconcileTeammateShutdown("worker", "member-2");
			expect(board.get(task.id)).toMatchObject({ status: "in_progress", ownerMembershipId: "member-1", attempts: [] });
		} finally {
			service.dispose();
		}
	});
	it("keeps unverifiable legacy claims fenced instead of adopting the new membership", async () => {
		const { teamDir, board, task, service, manager } = fixture();
		new TaskBoardService({ teamDir, self: "worker" }).update({ id: task.id, status: "in_progress" });
		const child = new TaskBoardService({ teamDir, self: "worker", selfMembershipId: "member-1" });
		try {
			expect(() => child.update({ id: task.id, status: "in_progress" })).toThrow(/membership/);
			await expect(service.reconcileTeammateShutdown("worker", "member-1")).rejects.toThrow(/no verifiable membership/);
			await expect(service.execute(task.id, { actor: { name: "lead" }, type: "worker" })).rejects.toThrow(/membership/);
			expect(manager.spawn).not.toHaveBeenCalled();
			expect(board.get(task.id)).toMatchObject({ status: "in_progress", owner: "worker", attempts: [] });
			expect(board.get(task.id)?.ownerMembershipId).toBeUndefined();
		} finally {
			service.dispose();
		}
	});
	it("does not rebind a terminal reservation to a different runtime", () => {
		const { board, task, service } = fixture();
		try {
			board.reserveExecution(task.id, "reservation", "worker", true);
			board.bindAttempt(task.id, "reservation", "run-1", "member-1");
			board.settleAttempt(task.id, "reservation", { status: "completed", settledAt: 99 });
			expect(() => board.bindAttempt(task.id, "reservation", "different-run", "member-1")).toThrow(/no longer active/);
			expect(() => board.bindAttempt(task.id, "reservation", "run-1", "different-member")).toThrow(/membership/);
		} finally {
			service.dispose();
		}
	});
	it("rolls back after transient membership retries are exhausted before spawning", async () => {
		const { board, task, service, manager } = fixture();
		vi.spyOn(board, "bindOwnerMembership").mockImplementation(() => {
			throw new Error("Task board conflict");
		});
		try {
			await expect(service.execute(task.id, { actor: { name: "lead" }, type: "worker" })).rejects.toThrow(
				/Task board conflict/,
			);
			expect(manager.spawn).not.toHaveBeenCalled();
			expect(board.get(task.id)).toMatchObject({ status: "pending", attempts: [{ status: "failed" }] });
		} finally {
			service.dispose();
		}
	});
	it("rolls back a membership retry when admissions freeze", async () => {
		const { board, task, service, manager } = fixture();
		vi.spyOn(board, "bindOwnerMembership").mockImplementationOnce(() => {
			service.freezeAdmissions();
			throw new Error("Task board conflict");
		});
		try {
			await expect(service.execute(task.id, { actor: { name: "lead" }, type: "worker" })).rejects.toThrow(
				/cancelled before spawn/,
			);
			expect(manager.spawn).not.toHaveBeenCalled();
			expect(board.get(task.id)).toMatchObject({ status: "pending", attempts: [{ status: "failed" }] });
		} finally {
			service.dispose();
		}
	});
	it.each([false, true])(
		"waits for a fenced reservation to roll back during shutdown (transfer=%s)",
		async (transfer) => {
			const { board, task, service, manager } = fixture();
			if (transfer) {
				board.update({ id: task.id, status: "in_progress" });
				board.bindOwnerMembership(task.id, "lead-member");
			}
			let shutdown: Promise<void> | undefined;
			let reservedMembership: string | undefined;
			const unsubscribe = board.subscribe((event) => {
				if (event.id !== task.id || !event.task?.attempts.some((attempt) => attempt.status === "running")) return;
				reservedMembership = event.task.ownerMembershipId;
				shutdown = service
					.reconcileTeammateShutdown("worker", "member-1", "fence")
					.then(() => service.reconcileTeammateShutdown("worker", "member-1"));
			});
			try {
				const execution = service.execute(task.id, { actor: { name: "lead" }, type: "worker" });
				const results = await Promise.allSettled([execution, shutdown]);
				expect(reservedMembership).toBe("member-1");
				expect(results[0]).toMatchObject({ status: "rejected", reason: { name: "TaskExecutionCancelledError" } });
				expect(results[1]).toEqual({ status: "fulfilled", value: undefined });
				expect(manager.spawn).not.toHaveBeenCalled();
				expect(board.get(task.id)).toMatchObject({
					status: transfer ? "in_progress" : "pending",
					attempts: [{ status: "failed" }],
				});
				expect(board.get(task.id)?.ownerMembershipId).toBe(transfer ? "lead-member" : undefined);
			} finally {
				unsubscribe();
				service.dispose();
			}
		},
	);
	it("enriches a newly spawned alias after completion during bind retry and permits trusted follow-up", async () => {
		const { teamDir, board, task, service, manager, listeners } = fixture();
		manager.teammateMembershipId = () => undefined as never;
		const bind = board.bindAttempt.bind(board);
		vi.spyOn(board, "bindAttempt")
			.mockImplementationOnce(() => {
				for (const listener of listeners)
					listener({ event: "completed", agentId: "run-1", result: "done", completedAt: 99 });
				throw new Error("Task board conflict");
			})
			.mockImplementation(bind);
		try {
			await service.execute(task.id, { actor: { name: "lead" }, type: "worker" });
			expect(board.get(task.id)?.ownerMembershipId).toBe("member-1");
			const child = new TaskBoardService({ teamDir, self: "worker", selfMembershipId: "member-1" });
			expect(() => child.update({ id: task.id, status: "in_progress" })).not.toThrow();
			manager.teammateMembershipId = () => "member-1";
			await service.execute(task.id, { actor: { name: "lead" }, type: "worker" });
			expect(manager.stop).not.toHaveBeenCalled();
		} finally {
			service.dispose();
		}
	});
	it("rejects both-undefined legacy ownership before spawning a new incarnation", async () => {
		const { teamDir, board, task, service, manager } = fixture();
		manager.teammateMembershipId = () => undefined as never;
		new TaskBoardService({ teamDir, self: "worker" }).update({ id: task.id, status: "in_progress" });
		try {
			await expect(service.execute(task.id, { actor: { name: "lead" }, type: "worker" })).rejects.toThrow(/membership/);
			expect(manager.spawn).not.toHaveBeenCalled();
			expect(board.get(task.id)?.attempts).toEqual([]);
		} finally {
			service.dispose();
		}
	});
	it.each([false, true])(
		"terminal retry preserves a reclaimed incarnation and settled outcome (newAttempt=%s)",
		(newAttempt) => {
			const { teamDir, board, task, service } = fixture();
			try {
				board.reserveExecution(task.id, "old-reservation", "worker", true);
				board.settleAttempt(task.id, "old-reservation", {
					runId: "old-run",
					status: "completed",
					settledAt: 99,
					result: { summary: "original" },
				});
				board.update({ id: task.id, status: "pending" });
				new TaskBoardService({ teamDir, self: "worker", selfMembershipId: "member-2" }).update({
					id: task.id,
					status: "in_progress",
				});
				if (newAttempt)
					board.reserveExecution(task.id, "new-reservation", "worker", true, undefined, undefined, "member-2");
				board.bindAttempt(task.id, "old-reservation", "old-run", "member-1");
				const beforeRetry = board.get(task.id);
				board.bindAttempt(task.id, "old-reservation", "old-run", "member-1");
				expect(board.get(task.id)).toMatchObject({
					owner: "worker",
					ownerMembershipId: "member-2",
					attempts: [
						{ runId: "old-run", status: "completed", settledAt: 99, result: { summary: "original" } },
						...(newAttempt ? [{ runId: "new-reservation", status: "running" }] : []),
					],
				});
				expect(board.get(task.id)?.attempts).toEqual(beforeRetry?.attempts);
			} finally {
				service.dispose();
			}
		},
	);

	it("does not enrich a name-only release/reclaim from a prior terminal attempt", async () => {
		const { teamDir, board, task, service } = fixture();
		try {
			board.reserveExecution(task.id, "old-reservation", "worker", true);
			board.settleAttempt(task.id, "old-reservation", { runId: "old-run", status: "completed", settledAt: 99 });
			board.update({ id: task.id, status: "pending" });
			new TaskBoardService({ teamDir, self: "worker" }).update({ id: task.id, status: "in_progress" });
			board.bindAttempt(task.id, "old-reservation", "old-run", "member-1");
			expect(board.get(task.id)?.ownerMembershipId).toBeUndefined();
			await expect(service.reconcileTeammateShutdown("worker", "member-1")).rejects.toThrow(/no verifiable membership/);
			expect(board.get(task.id)).toMatchObject({ owner: "worker", status: "in_progress" });
			expect(board.get(task.id)?.ownerMembershipId).toBeUndefined();
			expect(board.get(task.id)?.attempts[0]).toMatchObject({
				runId: "old-run",
				status: "completed",
				membershipId: "member-1",
				settledAt: 99,
			});
		} finally {
			service.dispose();
		}
	});
	it.each(["execute", "shutdown"] as const)(
		"uses associated attempt evidence with verified current membership for %s",
		async (operation) => {
			const { board, task, service, manager } = fixture();
			try {
				board.reserveExecution(task.id, "verified-reservation", "worker", true);
				board.settleAttempt(task.id, "verified-reservation", {
					runId: "verified-run",
					membershipId: "member-1",
					status: "completed",
					settledAt: 99,
				});
				expect(board.get(task.id)?.ownerMembershipId).toBeUndefined();
				if (operation === "shutdown") {
					await service.reconcileTeammateShutdown("worker", "member-1");
					expect(board.get(task.id)?.status).toBe("pending");
					expect(manager.spawn).not.toHaveBeenCalled();
				} else {
					await service.execute(task.id, { actor: { name: "lead" }, type: "worker" });
					expect(board.get(task.id)?.ownerMembershipId).toBe("member-1");
					expect(manager.spawn).toHaveBeenCalledOnce();
				}
			} finally {
				service.dispose();
			}
		},
	);
	it("does not enrich a legacy claim without durable reservation association", () => {
		const { board, task, service } = fixture();
		try {
			board.reserveExecution(task.id, "legacy-reservation", "worker", true);
			board.settleAttempt(task.id, "legacy-reservation", { runId: "legacy-run", status: "completed", settledAt: 99 });
			const taskFile = join(board.taskDir, `${task.id}.json`);
			const legacy = JSON.parse(readFileSync(taskFile, "utf8"));
			delete legacy.ownerReservationId;
			writeFileSync(taskFile, JSON.stringify(legacy));
			board.bindAttempt(task.id, "legacy-reservation", "legacy-run", "member-1");
			expect(board.get(task.id)?.ownerMembershipId).toBeUndefined();
			const legacyAttempt = JSON.parse(readFileSync(taskFile, "utf8"));
			delete legacyAttempt.attempts[0].reservationId;
			writeFileSync(taskFile, JSON.stringify(legacyAttempt));
			expect(() =>
				board.reserveExecution(task.id, "new-reservation", "worker", true, undefined, undefined, "member-1"),
			).toThrow(/membership/);
		} finally {
			service.dispose();
		}
	});
	it.each(["in_progress", "pending", "completed"] as const)(
		"rejects membershipless legacy caller update %s while allowing administrative release",
		(status) => {
			const { teamDir, board, task, service } = fixture();
			const legacy = new TaskBoardService({ teamDir, self: "worker" });
			legacy.update({ id: task.id, status: "in_progress" });
			try {
				expect(() => legacy.update({ id: task.id, status })).toThrow(/membership/);
				expect(board.get(task.id)).toMatchObject({ owner: "worker", status: "in_progress" });
				board.update({ id: task.id, status: "pending" });
				expect(board.get(task.id)?.status).toBe("pending");
			} finally {
				service.dispose();
			}
		},
	);
	it.each(["bind", "release", "bind-then-release"] as const)(
		"shutdown leaves a replacement claim untouched after snapshot before %s",
		async (phase) => {
			const { teamDir, board, task, service } = fixture();
			board.reserveExecution(task.id, "reservation-1", "worker", true);
			board.settleAttempt(task.id, "reservation-1", {
				runId: "run-1",
				status: "completed",
				membershipId: "member-1",
				settledAt: 99,
			});
			if (phase === "release") board.bindOwnerMembership(task.id, "member-1");
			const update = board.update.bind(board);
			let replacement: ReturnType<typeof board.get>;
			const replace = () => {
				update({ id: task.id, status: "pending" });
				new TaskBoardService({
					teamDir,
					self: "worker",
					...(phase !== "bind" ? { selfMembershipId: "member-2" } : {}),
				}).update({ id: task.id, status: "in_progress" });
				replacement = board.get(task.id);
			};
			if (phase === "bind") {
				const bind = board.bindOwnerMembership.bind(board);
				vi.spyOn(board, "bindOwnerMembership").mockImplementationOnce((...args) => {
					replace();
					return bind(...args);
				});
			} else {
				vi.spyOn(board, "update").mockImplementationOnce((...args) => {
					replace();
					return update(...args);
				});
			}
			try {
				await expect(service.reconcileTeammateShutdown("worker", "member-1")).rejects.toThrow(/claim changed/);
				expect(replacement).toBeDefined();
				expect(board.get(task.id)).toEqual(replacement);
			} finally {
				service.dispose();
			}
		},
	);
	it("shutdown rechecks associated attempt membership under the binding lock", async () => {
		const { board, task, service } = fixture();
		board.reserveExecution(task.id, "reservation-1", "worker", true);
		board.settleAttempt(task.id, "reservation-1", {
			runId: "run-1",
			status: "completed",
			membershipId: "member-1",
			settledAt: 99,
		});
		const bind = board.bindOwnerMembership.bind(board);
		let changed: ReturnType<typeof board.get>;
		vi.spyOn(board, "bindOwnerMembership").mockImplementationOnce((...args) => {
			const taskFile = join(board.taskDir, `${task.id}.json`);
			const persisted = JSON.parse(readFileSync(taskFile, "utf8"));
			persisted.attempts[0].membershipId = "member-2";
			writeFileSync(taskFile, JSON.stringify(persisted));
			changed = board.get(task.id);
			return bind(...args);
		});
		try {
			await expect(service.reconcileTeammateShutdown("worker", "member-1")).rejects.toThrow(/membership/);
			expect(changed).toBeDefined();
			expect(board.get(task.id)).toEqual(changed);
		} finally {
			service.dispose();
		}
	});
});
