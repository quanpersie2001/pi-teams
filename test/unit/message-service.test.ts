import { describe, expect, it } from "vitest";
import { MessageService } from "../../extension-src/pi-teams/app/message-service.js";
import type { AgentRun } from "../../extension-src/pi-teams/domain/agent-run.js";

function makeRun(id: string, sessionId?: string): AgentRun {
	return {
		id,
		type: "worker",
		description: id,
		status: "running",
		backend: "process",
		startedAt: 1,
		toolUses: 0,
		turns: 0,
		usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
		owner: { kind: "extension", id: "caller" },
		delivery: "event",
		...(sessionId === undefined ? {} : { parentSession: { sessionId } }),
	};
}

function fixture(options: { maxMessages?: number; maxConsumedHistory?: number; initiallyCold?: boolean } = {}) {
	const runs = new Map<string, AgentRun>([
		["child-a", makeRun("child-a", "session-a")],
		["child-b", makeRun("child-b", "session-a")],
		["foreign-child", makeRun("foreign-child", "session-b")],
		["legacy-child", makeRun("legacy-child")],
	]);
	const sent: Array<{ agentId: string; text: string }> = [];
	let nextId = 0;
	let now = 10;
	let live = options.initiallyCold !== true;
	const service = new MessageService({
		getRun: (agentId) => runs.get(agentId),
		async sendToChild(agentId, message) {
			if (!live) return false;
			sent.push({ agentId, text: message.text });
			return true;
		},
		idFactory: () => `message-${++nextId}`,
		now: () => now++,
		...(options.maxMessages === undefined ? {} : { maxMessages: options.maxMessages }),
		...(options.maxConsumedHistory === undefined ? {} : { maxConsumedHistory: options.maxConsumedHistory }),
	});
	return { service, runs, sent, activateChild: () => (live = true) };
}

describe("MessageService", () => {
	it("rejects wrong-session targets and agents without trusted parent scope", async () => {
		const { service } = fixture();
		await expect(service.sendFromParent("session-a", "foreign-child", "no")).rejects.toThrow(
			/outside this parent session/,
		);
		await expect(service.sendFromParent("session-a", "legacy-child", "no")).rejects.toThrow(
			/outside this parent session/,
		);
		await expect(service.sendFromAgent("legacy-child", { kind: "parent" }, "no")).rejects.toThrow(
			/no parent session scope/,
		);
		expect(service.listInbox({ kind: "parent", sessionId: "session-b" })).toEqual([]);
	});

	it("derives child sender identity and restricts sibling delivery to the shared owner session", async () => {
		const { service } = fixture();
		const message = await service.sendFromAgent("child-a", { kind: "agent", agentId: "child-b" }, "hello sibling");
		expect(message.from).toEqual({ kind: "agent", agentId: "child-a" });
		expect(message.to).toEqual({ kind: "agent", agentId: "child-b" });
		expect(service.listInbox({ kind: "agent", agentId: "child-b" })).toEqual([message]);
		await expect(service.sendFromAgent("child-a", { kind: "agent", agentId: "foreign-child" }, "no")).rejects.toThrow(
			/outside this parent session/,
		);
	});

	it("queues, exposes, consumes and retains inspectable messages without steering or completion delivery", async () => {
		const { service, sent } = fixture();
		const message = await service.sendFromParent("session-a", "child-a", "work status?");
		expect(sent).toEqual([{ agentId: "child-a", text: "work status?" }]);
		expect(service.listInbox({ kind: "agent", agentId: "child-a" }).map(({ id, text }) => ({ id, text }))).toEqual([
			{ id: message.id, text: message.text },
		]);
		const consumed = service.consumeInbox({ kind: "agent", agentId: "child-a" }, message.id);
		expect(consumed.consumedAt).toBe(12);
		expect(message.consumedAt).toBeUndefined();
		expect(service.listInbox({ kind: "agent", agentId: "child-a" })).toEqual([]);
		expect(service.listMessages({ kind: "agent", agentId: "child-a" })).toEqual([
			expect.objectContaining({ id: message.id, text: message.text, consumedAt: consumed.consumedAt }),
		]);
		// Child-to-parent messages enter the dedicated inbox queue rather than
		// the child delivery hook; inbox records have no completion status/result.
		const parentMessage = await service.sendFromAgent("child-a", { kind: "parent" }, "progress update");
		expect(parentMessage.from).toEqual({ kind: "agent", agentId: "child-a" });
		expect(service.listInbox({ kind: "parent", sessionId: "session-a" })).toEqual([parentMessage]);
		expect(service.listSessionMessages("session-a")).toEqual([
			expect.objectContaining({ id: message.id, text: message.text, consumedAt: consumed.consumedAt }),
			expect.objectContaining({ id: parentMessage.id, text: parentMessage.text }),
		]);
		expect(service.listSessionMessages("session-b")).toEqual([]);
		expect(parentMessage).not.toHaveProperty("status");
		expect(parentMessage).not.toHaveProperty("result");
	});

	it("retains pending entries across a same-session continuation even after its source leaves the live run registry", async () => {
		const { service, runs, sent } = fixture();
		const message = await service.sendFromParent("session-a", "child-a", "continue this");
		runs.delete("child-a");
		runs.set("child-a-resumed", makeRun("child-a-resumed", "session-a"));
		await service.continueInbox("child-a", "child-a-resumed");
		expect(service.listInbox({ kind: "agent", agentId: "child-a-resumed" })).toEqual([
			expect.objectContaining({
				id: message.id,
				to: { kind: "agent", agentId: "child-a" },
				deliveredAt: 12,
			}),
		]);
		expect(sent).toHaveLength(2);
		await service.sendFromParent("session-a", "child-a", "after resume");
		expect(sent[2]).toEqual({ agentId: "child-a-resumed", text: "after resume" });
		await expect(service.continueInbox("child-a", "foreign-child")).rejects.toThrow(/original parent session/);
		await expect(service.continueInbox("unknown-old-id", "child-a-resumed")).resolves.toBeUndefined();
	});
	it("retains cold-target messages and delivers them when explicitly flushed after launch", async () => {
		const { service, sent, activateChild } = fixture({ initiallyCold: true });
		const message = await service.sendFromParent("session-a", "child-a", "queued while cold");
		expect(message.deliveredAt).toBeUndefined();
		expect(sent).toEqual([]);
		expect(service.listInbox({ kind: "agent", agentId: "child-a" })).toHaveLength(1);
		activateChild();
		await service.deliverPending("child-a");
		expect(sent).toEqual([{ agentId: "child-a", text: "queued while cold" }]);
		expect(service.listInbox({ kind: "agent", agentId: "child-a" })[0]?.deliveredAt).toBeDefined();
	});

	it("rejects queue overflow without changing pending messages and opens capacity when consumed", async () => {
		const { service } = fixture({ maxMessages: 1 });
		const first = await service.sendFromAgent("child-a", { kind: "parent" }, "first");
		await expect(service.sendFromParent("session-a", "child-a", "second")).rejects.toThrow();
		expect(service.listInbox({ kind: "parent", sessionId: "session-a" }).map(({ id, text }) => ({ id, text }))).toEqual(
			[{ id: first.id, text: first.text }],
		);
		const consumed = service.consumeInbox({ kind: "parent", sessionId: "session-a" }, first.id);
		expect(consumed.consumedAt).toBeDefined();
		await expect(service.sendFromParent("session-a", "child-a", "second")).resolves.toMatchObject({
			text: "second",
		});
	});
	it("bounds consumed history without removing unread inbox entries", async () => {
		const { service } = fixture({ maxConsumedHistory: 1 });
		const first = await service.sendFromAgent("child-a", { kind: "parent" }, "first");
		const second = await service.sendFromAgent("child-a", { kind: "parent" }, "second");
		service.consumeInbox({ kind: "parent", sessionId: "session-a" }, first.id);
		const secondConsumed = service.consumeInbox({ kind: "parent", sessionId: "session-a" }, second.id);
		const history = service.listMessages({ kind: "parent", sessionId: "session-a" });
		expect(history.map(({ id, text }) => ({ id, text }))).toEqual([{ id: second.id, text: second.text }]);
		expect(history[0]?.consumedAt).toBe(secondConsumed.consumedAt);
		expect(first.consumedAt).toBeUndefined();
		const unread = await service.sendFromAgent("child-a", { kind: "parent" }, "unread");
		const unreadTwo = await service.sendFromAgent("child-a", { kind: "parent" }, "still unread");
		const consumedUnread = service.consumeInbox({ kind: "parent", sessionId: "session-a" }, unread.id);
		expect(consumedUnread.consumedAt).toBeDefined();
		expect(service.listInbox({ kind: "parent", sessionId: "session-a" }).map(({ id, text }) => ({ id, text }))).toEqual(
			[{ id: unreadTwo.id, text: unreadTwo.text }],
		);
	});
	it("rejects empty and oversized content while accepting the maximum length", async () => {
		const { service } = fixture();
		await expect(service.sendFromAgent("child-a", { kind: "parent" }, " \n ")).rejects.toThrow(/must not be empty/);
		const maximum = await service.sendFromAgent("child-a", { kind: "parent" }, "x".repeat(32_000));
		expect(maximum.text).toHaveLength(32_000);
		await expect(service.sendFromAgent("child-a", { kind: "parent" }, "x".repeat(32_001))).rejects.toThrow();
		expect(service.listInbox({ kind: "parent", sessionId: "session-a" }).map(({ id }) => id)).toContain(maximum.id);
	});
	it("serves authenticated child send/list/consume RPCs from the authoritative inbox", async () => {
		const { service } = fixture();
		const sentReply = await service.handleChildMessage("child-a", {
			action: "send",
			target: { kind: "parent" },
			text: "hello parent",
		});
		expect(sentReply.action).toBe("sent");
		if (sentReply.action !== "sent") throw new Error("Expected a sent receipt.");
		expect(sentReply.message.from).toEqual({ kind: "agent", agentId: "child-a" });
		expect(service.listInbox({ kind: "parent", sessionId: "session-a" })).toEqual([sentReply.message]);

		const inbound = await service.sendFromParent("session-a", "child-a", "reply");
		const listReply = await service.handleChildMessage("child-a", { action: "list" });
		expect(listReply).toEqual({ action: "listed", messages: [inbound] });
		const consumeReply = await service.handleChildMessage("child-a", {
			action: "consume",
			messageId: inbound.id,
		});
		expect(consumeReply).toEqual({
			action: "consumed",
			message: expect.objectContaining({ id: inbound.id, consumedAt: expect.any(Number) }),
		});
		expect(service.listInbox({ kind: "agent", agentId: "child-a" })).toEqual([]);
	});
	it("reports live delivery failure without losing the already queued inbox message", async () => {
		const child = makeRun("child-a", "session-a");
		const service = new MessageService({
			getRun: (agentId) => (agentId === child.id ? child : undefined),
			async sendToChild() {
				throw new Error("socket closed");
			},
			idFactory: () => "message-queued",
			now: () => 1,
		});
		await expect(service.sendFromParent("session-a", "child-a", "retained")).rejects.toThrow(
			/message-queued was queued, but live delivery failed: socket closed/,
		);
		const queued = service.listInbox({ kind: "agent", agentId: "child-a" });
		expect(queued).toEqual([expect.objectContaining({ id: "message-queued", text: "retained" })]);
		expect(queued[0]?.deliveredAt).toBeUndefined();
	});
	it("reports parent delivery failure while retaining a consumable inbox message", async () => {
		const child = makeRun("child-a", "session-a");
		const service = new MessageService({
			getRun: (agentId) => (agentId === child.id ? child : undefined),
			async sendToChild() {
				return false;
			},
			async sendToParent() {
				throw new Error("parent transport closed");
			},
			idFactory: () => "parent-message-queued",
			now: () => 1,
		});
		await expect(service.sendFromAgent("child-a", { kind: "parent" }, "retained parent update")).rejects.toThrow(
			/parent-message-queued was queued, but live delivery failed: parent transport closed/,
		);
		const pending = service.listInbox({ kind: "parent", sessionId: "session-a" });
		expect(pending).toEqual([
			expect.objectContaining({
				id: "parent-message-queued",
				text: "retained parent update",
				from: { kind: "agent", agentId: "child-a" },
				to: { kind: "parent" },
			}),
		]);
		expect(pending[0]?.deliveredAt).toBeUndefined();
		const consumed = service.consumeInbox({ kind: "parent", sessionId: "session-a" }, "parent-message-queued");
		expect(consumed.consumedAt).toBe(1);
		expect(service.listInbox({ kind: "parent", sessionId: "session-a" })).toEqual([]);
		expect(service.listMessages({ kind: "parent", sessionId: "session-a" })).toEqual([
			expect.objectContaining({ id: consumed.id, text: consumed.text, consumedAt: 1 }),
		]);
	});
});
