import { describe, expect, it } from "vitest";
import { AgentManager } from "../../extension-src/pi-teams/app/agent-manager.js";
import { AgentRegistry } from "../../extension-src/pi-teams/app/agent-registry.js";
import { createAgentFocusPort } from "../../extension-src/pi-teams/app/focus-service.js";
import { TeamService } from "../../extension-src/pi-teams/app/team-service.js";
import type { AgentBackendHandle } from "../../extension-src/pi-teams/domain/backend.js";
import type { ChildState } from "../../extension-src/pi-teams/domain/child-protocol.js";
import { sanitizeSettings } from "../../extension-src/pi-teams/domain/config.js";
import type { TranscriptItem } from "../../extension-src/pi-teams/domain/transcript.js";
import { FakeBackend } from "../helpers/fake-backend.js";

class FocusBackend extends FakeBackend {
	readSnapshot: () => Promise<ChildState | undefined> = async () => undefined;
	private readonly focusListeners = new Set<(state: ChildState) => void>();

	readFocusState(_handle: AgentBackendHandle): Promise<ChildState | undefined> {
		return this.readSnapshot();
	}

	subscribeFocus(_handle: AgentBackendHandle, listener: (state: ChildState) => void): () => void {
		this.focusListeners.add(listener);
		return () => {
			this.focusListeners.delete(listener);
		};
	}

	updateFocus(state: ChildState): void {
		for (const listener of this.focusListeners) listener(state);
	}
}

async function fixture(name?: string, withTeam = false) {
	const backend = new FocusBackend();
	const settings = sanitizeSettings({ maxConcurrent: 2 });
	const registry = new AgentRegistry({ sources: [], loader: async () => [], settings });
	await registry.load();
	const manager = new AgentManager({
		registry,
		settings,
		backends: [backend],
		cwd: "/parent",
		configCwd: "/parent",
		getSessionId: () => "parent-session",
		teardownGraceMs: 10,
	});
	if (withTeam) {
		let saved: string | undefined;
		const team = new TeamService({
			sessionId: "parent-session",
			store: {
				teamDir: "/tmp/focus-team",
				readRoster: () => (saved === undefined ? undefined : JSON.parse(saved)),
				writeRoster: (roster) => {
					saved = JSON.stringify(roster);
				},
			},
		});
		team.sessionStart();
		manager.setTeamService(team);
	}
	const run = await manager.spawn({
		type: "general-purpose",
		prompt: "work",
		run_in_background: true,
		...(name ? { name } : {}),
	});
	for (let step = 0; step < 24; step++) await Promise.resolve();
	expect(manager.get(run.id)?.status).toBe("running");
	const history: TranscriptItem[] = [{ kind: "assistant", timestamp: 4, text: "FINAL_HISTORY" }];
	const focus = createAgentFocusPort({ manager, transcripts: { getTranscript: async () => history } });
	return { manager, backend, run, focus };
}

function childState(runId: string, seq: number, text: string): ChildState {
	return {
		childId: "actual-child",
		pid: 123,
		execution: "running",
		currentRunId: runId,
		seq,
		transcript: {
			items: [{ kind: "assistant", timestamp: 1, text }],
			offset: 4,
			cursor: 5,
			truncated: true,
		},
		focus: {
			cwd: "/child-worktree",
			model: { provider: "child-provider", id: "child-model", name: "Child model" },
			thinking: "high",
			context: { tokens: 256, contextWindow: 4096, percent: 6.25 },
			capabilities: { models: [], thinking: ["high"], commands: ["model", "thinking"] },
		},
	};
}

describe("remote focus freshness", () => {
	it("does not rewind a streamed message when an earlier state request resolves late", async () => {
		const { manager, backend, run, focus } = await fixture();
		const pending = Promise.withResolvers<ChildState>();
		backend.readSnapshot = () => pending.promise;
		const unsubscribe = manager.subscribeFocus(run.id, () => {});
		const read = focus.read(run.id);
		backend.updateFocus(childState(run.id, 2, "NEW_STREAMED_TEXT"));
		pending.resolve(childState(run.id, 1, "OLD_STREAMED_TEXT"));
		const displayed = await read;
		expect(displayed.items.map((item) => item.text)).toEqual(["NEW_STREAMED_TEXT"]);
		expect(displayed.model).toBe("child-provider/child-model");
		expect(displayed.cwd).toBe("/child-worktree");
		expect(displayed.truncatedHead).toBe(true);
		unsubscribe();
		await manager.shutdownSession();
	});

	it("projects selected native metadata and session totals independently of run usage", async () => {
		const { manager, backend, run, focus } = await fixture();
		const state = childState(run.id, 1, "stream");
		const nativeFocus = state.focus;
		if (!nativeFocus?.model) throw new Error("Missing fixture model");
		nativeFocus.model.reasoning = true;
		nativeFocus.stats = {
			userMessages: 1,
			assistantMessages: 2,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 3,
			tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 40, total: 190 },
			cost: 0.42,
		};
		backend.readSnapshot = async () => state;
		expect(await focus.read(run.id)).toMatchObject({
			provider: "child-provider",
			modelName: "Child model",
			reasoning: true,
			sessionUsage: {
				scope: "session",
				inputTokens: 100,
				outputTokens: 20,
				cacheReadTokens: 30,
				cacheWriteTokens: 40,
				cost: 0.42,
			},
		});
		nativeFocus.stats.cost = Number.NaN;
		expect((await focus.read(run.id)).sessionUsage).not.toHaveProperty("cost");
		nativeFocus.stats.cost = 123;
		nativeFocus.sessionUsage = {
			scope: "session",
			inputTokens: 999,
			outputTokens: 2,
			cacheReadTokens: 3,
			cacheWriteTokens: 4,
		};
		expect((await focus.read(run.id)).sessionUsage).toEqual(nativeFocus.sessionUsage);
		delete nativeFocus.stats;
		expect((await focus.read(run.id)).sessionUsage).toEqual(nativeFocus.sessionUsage);
		delete nativeFocus.sessionUsage;
		expect((await focus.read(run.id)).sessionUsage).toBeUndefined();
		await manager.shutdownSession();
	});

	it("refreshes retained idle metadata without granting controls or following a later assignment", async () => {
		const { manager, backend, run, focus } = await fixture("worker");
		backend.readSnapshot = async () => childState(run.id, 1, "stream");
		await focus.read(run.id);
		backend.complete(run.id, "completed", "/child/session.jsonl");
		await manager.whenSettled(run.id);
		backend.readSnapshot = async () => {
			const state = childState(run.id, 2, "settled");
			delete state.currentRunId;
			return { ...state, execution: "idle", lastOutcome: { runId: run.id, status: "completed" } };
		};
		const idle = await focus.read(run.id);
		expect(idle.closed).toBe(false);
		expect(idle.currentRunId).toBe(run.id);
		expect(idle.items.map((item) => item.text)).toEqual(["settled"]);
		expect(idle.capabilities).toEqual([]);
		await expect(focus.control(run.id, { type: "thinking", thinking: "high" })).rejects.toThrow();
		const later = await manager.spawn({
			type: "general-purpose",
			name: "worker",
			prompt: "later",
			run_in_background: true,
		});
		backend.readSnapshot = async () => childState(later.id, 3, "LATER_SECRET");
		const old = await focus.read(run.id);
		expect(old.closed).toBe(true);
		expect(old.items.map((item) => item.text)).toEqual(["FINAL_HISTORY"]);
		await manager.shutdownSession();
	});

	it("discards an in-flight idle refresh after alias reincarnation and never reads the replacement for history", async () => {
		const { manager, backend, run, focus } = await fixture("worker", true);
		backend.readSnapshot = async () => childState(run.id, 1, "original");
		await focus.read(run.id);
		backend.complete(run.id, "completed", "/child/session.jsonl");
		await manager.whenSettled(run.id);
		const pending = Promise.withResolvers<ChildState>();
		backend.readSnapshot = () => pending.promise;
		const refresh = focus.read(run.id);
		await manager.shutdownTeammate("worker");
		const replacement = await manager.spawn({
			type: "general-purpose",
			name: "worker",
			prompt: "new identity",
			run_in_background: true,
		});
		expect(replacement.membershipId).not.toBe(run.membershipId);
		pending.resolve(childState(replacement.id, 99, "REPLACEMENT_SECRET"));
		expect(await refresh).toMatchObject({ closed: true, currentRunId: null });
		let reads = 0;
		backend.readSnapshot = async () => {
			reads++;
			return childState(replacement.id, 100, "REPLACEMENT_SECRET");
		};
		const history = await focus.read(run.id);
		expect(reads).toBe(0);
		expect(history.items.map((item) => item.text)).toEqual(["FINAL_HISTORY"]);
		await manager.shutdownSession();
	});

	it("rejects another run's authenticated state instead of projecting its transcript", async () => {
		const { manager, backend, focus, run } = await fixture();
		backend.readSnapshot = async () => childState("other-run", 1, "OTHER_RUN_SECRET");
		let displayed: readonly TranscriptItem[] | undefined;
		await expect(
			focus.read(run.id).then((snapshot) => {
				displayed = snapshot.items;
			}),
		).rejects.toBeInstanceOf(Error);
		expect(displayed).toBeUndefined();
		await manager.shutdownSession();
	});

	it("fails closed for idle state without an assignment receipt and rejects another outcome", async () => {
		const { manager, backend, focus, run } = await fixture();
		const state = childState(run.id, 1, "unassigned");
		delete state.currentRunId;
		state.execution = "idle";
		backend.readSnapshot = async () => state;
		expect(await focus.read(run.id)).toMatchObject({ closed: true, currentRunId: null, capabilities: [] });
		state.lastOutcome = { runId: "other", status: "completed" };
		await expect(focus.read(run.id)).rejects.toThrow("different run");
		await manager.shutdownSession();
	});

	it("does not publish a pending child snapshot after the parent session has shut down", async () => {
		const { manager, backend, focus, run } = await fixture();
		const pending = Promise.withResolvers<ChildState>();
		backend.readSnapshot = () => pending.promise;
		let displayed: readonly TranscriptItem[] | undefined;
		const read = focus.read(run.id).then((snapshot) => {
			displayed = snapshot.items;
		});
		await manager.shutdownSession();
		pending.resolve(childState(run.id, 1, "FORMER_SESSION_TEXT"));
		await expect(read).rejects.toBeInstanceOf(Error);
		expect(displayed).toBeUndefined();
		expect(manager.get(run.id)).toBeUndefined();
	});

	it("shows finalized cold history and removes live controls after child cleanup", async () => {
		const { manager, backend, focus, run } = await fixture();
		backend.readSnapshot = async () => childState(run.id, 1, "INCOMPLETE_STREAM");
		await focus.read(run.id);
		backend.complete(run.id, "completed", "/child/session.jsonl");
		await manager.whenSettled(run.id);
		const displayed = await focus.read(run.id);
		expect(displayed.closed).toBe(true);
		expect(displayed.currentRunId).toBeNull();
		expect(displayed.items.map((item) => item.text)).toEqual(["FINAL_HISTORY"]);
		expect(displayed.capabilities).toEqual([]);
		expect(manager.get(run.id)?.handle).toBeUndefined();
		await manager.shutdownSession();
	});
});
