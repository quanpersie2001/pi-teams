import { describe, expect, it } from "vitest";
import { AgentManager } from "../../extension-src/pi-teams/app/agent-manager.js";
import { AgentRegistry } from "../../extension-src/pi-teams/app/agent-registry.js";
import { createAgentFocusPort } from "../../extension-src/pi-teams/app/focus-service.js";
import { MessageService } from "../../extension-src/pi-teams/app/message-service.js";
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

async function fixture() {
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
	const run = await manager.spawn({ type: "general-purpose", prompt: "work", run_in_background: true });
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

	it("keeps extension-owned messages in the spawning parent while completion delivery remains event-only", async () => {
		const { manager } = await fixture();
		const messages = new MessageService({
			getRun: (id) => manager.get(id),
			sendToChild: (id, message) => manager.sendInbox(id, message),
		});
		manager.setMessageService(messages);
		const owned = await manager.spawn({
			type: "general-purpose",
			prompt: "extension-owned task",
			owner: { kind: "extension", id: "pi-tasks", ref: "task-1" },
			run_in_background: true,
		});
		const foreign = await manager.spawn({
			type: "general-purpose",
			prompt: "another parent",
			owner: { kind: "conversation", sessionId: "foreign-session" },
			run_in_background: true,
		});
		await messages.sendFromAgent(owned.id, { kind: "parent" }, "EXPLICIT_INBOX_NOT_COMPLETION");
		expect(manager.get(owned.id)?.delivery).toBe("event");
		expect(
			messages.listInbox({ kind: "parent", sessionId: "parent-session" }).map((message) => ({
				text: message.text,
				from: message.from,
			})),
		).toEqual([{ text: "EXPLICIT_INBOX_NOT_COMPLETION", from: { kind: "agent", agentId: owned.id } }]);
		expect(messages.listInbox({ kind: "parent", sessionId: "foreign-session" })).toEqual([]);
		await expect(
			messages.sendFromAgent(owned.id, { kind: "agent", agentId: foreign.id }, "CROSS_SCOPE"),
		).rejects.toBeInstanceOf(Error);
		expect(messages.listInbox({ kind: "agent", agentId: foreign.id })).toEqual([]);
		await manager.shutdownSession();
	});
});
