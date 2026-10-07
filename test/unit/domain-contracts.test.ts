import { describe, expect, it } from "vitest";
import { resolveAgentSnapshot } from "../../extension-src/pi-subagents/domain/agent-definition.js";
import { EMPTY_USAGE } from "../../extension-src/pi-subagents/domain/agent-run.js";
import {
	isConversationOwner,
	isExtensionOwner,
	type ParentSessionRef,
} from "../../extension-src/pi-subagents/domain/delivery.js";
import {
	PROTOCOL_VERSION,
	rpcError,
	rpcSuccess,
	subagentsRpcChannel,
	subagentsRpcReplyChannel,
	toRunSnapshot,
} from "../../extension-src/pi-subagents/domain/integration-protocol.js";
import { type TranscriptSnapshot, transcriptItemsAfter } from "../../extension-src/pi-subagents/domain/transcript.js";
import {
	supportsChangedFiles,
	type WorktreeInfo,
	type WorktreeResult,
} from "../../extension-src/pi-subagents/domain/worktree.js";

describe("transcript contract", () => {
	it("returns only transcript items after the supplied cursor", () => {
		const snapshot: TranscriptSnapshot = {
			cursor: 5,
			items: [
				{ kind: "user", timestamp: 1, text: "go" },
				{ kind: "assistant", timestamp: 2, text: "on it" },
				{ kind: "toolCall", timestamp: 3, toolName: "read", toolCallId: "t1", args: { path: "a.ts" } },
				{ kind: "toolResult", timestamp: 4, toolCallId: "t1", result: "ok" },
				{ kind: "system", timestamp: 5, text: "turn limit reached", isError: false },
			],
		};
		const tail = transcriptItemsAfter(snapshot, 3);
		expect(tail.map((item) => item.kind)).toEqual(["toolResult", "system"]);
		expect(transcriptItemsAfter(snapshot, 99)).toEqual([]);
	});

	it("uses absolute cursors after older transcript entries have been evicted", () => {
		const snapshot: TranscriptSnapshot = {
			offset: 40,
			cursor: 43,
			truncated: true,
			items: [
				{ kind: "user", timestamp: 1, text: "resume" },
				{ kind: "toolCall", timestamp: 2, toolName: "bash", toolCallId: "recent" },
				{ kind: "assistant", timestamp: 3, text: "finished" },
			],
		};
		expect(transcriptItemsAfter(snapshot, 41).map((item) => item.kind)).toEqual(["toolCall", "assistant"]);
		expect(transcriptItemsAfter(snapshot, 0).map((item) => item.kind)).toEqual(["user", "toolCall", "assistant"]);
		expect(transcriptItemsAfter(snapshot, 43)).toEqual([]);
	});
});

describe("owner and delivery contracts", () => {
	it("narrows conversation and extension owners", () => {
		const conversation = { kind: "conversation" as const, sessionId: "s-1" };
		const extension = { kind: "extension" as const, id: "pi-tasks", ref: "task-123" };
		expect(isConversationOwner(conversation)).toBe(true);
		expect(isExtensionOwner(conversation)).toBe(false);
		expect(isExtensionOwner(extension)).toBe(true);
		expect(extension.ref).toBe("task-123");
	});

	it("models a parent session ref with optional leaf", () => {
		const parent: ParentSessionRef = { sessionId: "s-1" };
		expect(parent.leafId).toBeUndefined();
		expect({ ...parent, leafId: "leaf-9" }).toEqual({ sessionId: "s-1", leafId: "leaf-9" });
	});
});

describe("worktree contracts", () => {
	it("reports changed-file support only once a branch exists", () => {
		const info: WorktreeInfo = { baseRepo: "/repo", path: "/repo/.worktrees/run-1" };
		expect(supportsChangedFiles(info)).toBe(false);
		expect(supportsChangedFiles({ branch: "agent/task-123-a1b2c3d4" })).toBe(true);
	});

	it("shapes retained worktree preservation metadata without an automatic merge command", () => {
		const branch = "agent/task-123-a1b2c3d4";
		const result: WorktreeResult = {
			branch,
			hasChanges: true,
			baseSha: "a1b2c3d4",
			commitSha: "b2c3d4e5",
			commits: ["b2c3d4e5"],
			cherryPickCommand: "git cherry-pick b2c3d4e5",
			path: "/repo/.worktrees/run-1",
		};
		expect(result.cherryPickCommand).toBe("git cherry-pick b2c3d4e5");
		expect(result.path).toBe("/repo/.worktrees/run-1");
	});
});

describe("definition snapshots", () => {
	it("merges requested overrides over the definition immutably", () => {
		const definition = {
			type: "implementer",
			description: "Implementation specialist",
			systemPrompt: "Implement bounded changes.",
			model: "sonnet",
			thinking: "medium" as const,
			tools: ["read", "edit"],
			maxTurnLimit: 40,
			promptMode: "append" as const,
			defaultBackground: true,
			isolationPolicy: "worktree" as const,
			enabled: true,
			resolvedAt: 100,
		};
		const first = resolveAgentSnapshot(definition, { model: "haiku", maxTurnLimit: 10 });
		expect(first.resolved.model).toBe("haiku");
		expect(first.resolved.thinking).toBe("medium");
		expect(first.resolved.maxTurnLimit).toBe(10);
		expect(first.resolved.tools).toEqual(["read", "edit"]);
		expect(first.definition).toBe(definition);

		// Overrides are copied — mutating the array afterwards cannot leak in.
		const tools = ["read"];
		const second = resolveAgentSnapshot(definition, { tools });
		tools.push("write");
		expect(second.resolved.tools).toEqual(["read"]);

		const bare = resolveAgentSnapshot(definition);
		expect(bare.resolved.model).toBe("sonnet");
		expect(bare.overrides).toEqual({});
	});
});

describe("integration protocol", () => {
	it("pins protocol version and channel naming for the pi-tasks consumer", () => {
		expect(PROTOCOL_VERSION).toBe(3);
		expect(subagentsRpcChannel("spawn")).toBe("subagents:rpc:spawn");
		expect(subagentsRpcReplyChannel("status", "req-7")).toBe("subagents:rpc:status:reply:req-7");
	});

	it("envelopes replies as success/error", () => {
		expect(rpcSuccess()).toEqual({ success: true });
		expect(rpcSuccess({ agentId: "run-1" })).toEqual({ success: true, data: { agentId: "run-1" } });
		expect(rpcError(new Error("nope"))).toEqual({ success: false, error: "nope" });
		expect(rpcError("plain")).toEqual({ success: false, error: "plain" });
	});

	it("projects an AgentRun into an owner-aware snapshot", () => {
		const run = {
			id: "run-1",
			type: "explore",
			description: "Explore the repo",
			status: "completed" as const,
			backend: "process" as const,
			sessionFile: "/sessions/run-1.jsonl",
			result: "found it",
			startedAt: 1_000,
			completedAt: 4_000,
			toolUses: 5,
			turns: 8,
			usage: EMPTY_USAGE,
			owner: { kind: "extension", id: "pi-tasks", ref: "task-123" } as const,
			delivery: "event" as const,
			parentSession: { sessionId: "s-1" },
			worktree: { baseRepo: "/repo", path: "/wt", branch: "agent/x" },
			worktreeResult: {
				branch: "agent/x",
				hasChanges: true,
				baseSha: "base",
				commitSha: "commit",
				commits: ["commit"],
				path: "/wt",
			},
		};
		const snapshot = toRunSnapshot(run);
		expect(snapshot.durationMs).toBe(3_000);
		expect(snapshot.owner).toEqual({ kind: "extension", id: "pi-tasks", ref: "task-123" });
		expect(snapshot.worktree).toEqual(run.worktree);
		expect(snapshot.worktreeResult).toEqual(run.worktreeResult);
		expect(snapshot.usage).not.toBe(run.usage);

		const minimal = toRunSnapshot({
			...run,
			completedAt: undefined,
			sessionFile: undefined,
			result: undefined,
			error: undefined,
			parentSession: undefined,
			worktree: undefined,
			worktreeResult: undefined,
		});
		expect(minimal.durationMs).toBeUndefined();
		expect(minimal.sessionFile).toBeUndefined();
	});
});
