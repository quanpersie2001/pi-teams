// IntegrationService unit tests: strict parsing and request-scoped replies for
// ping/spawn/status/steer/stop/resume/release, ownership and delivery defaults,
// plus malformed/unknown request error envelopes. Replies use an injected sink;
// the full transport cycle lives in test/integration/pi-tasks-rpc.test.ts.

import { describe, expect, it } from "vitest";
import { AgentManager } from "../../extension-src/pi-subagents/app/agent-manager.js";
import { AgentRegistry } from "../../extension-src/pi-subagents/app/agent-registry.js";
import { IntegrationService } from "../../extension-src/pi-subagents/app/integration-service.js";
import type { SubagentsSettings } from "../../extension-src/pi-subagents/domain/config.js";
import { sanitizeSettings } from "../../extension-src/pi-subagents/domain/config.js";
import {
	PROTOCOL_VERSION,
	type RpcReply,
	SUBAGENTS_RPC_OPS,
	subagentsRpcReplyChannel,
} from "../../extension-src/pi-subagents/domain/integration-protocol.js";
import { FakeBackend } from "../helpers/fake-backend.js";

interface CapturedReply {
	channel: string;
	payload: RpcReply<unknown>;
}

/** Loosely-typed view of a captured envelope for assertions. */
type ReplyView = { success: true; data?: unknown } | { success: false; error: string };

interface Fixture {
	manager: AgentManager;
	backend: FakeBackend;
	service: IntegrationService;
	replies: CapturedReply[];
	replyWaiters: Map<string, Array<(reply: CapturedReply) => void>>;
}

function settings(overrides: Partial<SubagentsSettings> = {}): SubagentsSettings {
	return sanitizeSettings({ maxConcurrent: 4, backgroundByDefault: true, ...overrides });
}

async function makeFixture(): Promise<Fixture> {
	const backend = new FakeBackend();
	let nextId = 0;
	const registry = new AgentRegistry({
		sources: [],
		loader: async () => [],
		settings: settings(),
	});
	await registry.load();
	const manager = new AgentManager({
		registry,
		settings: settings(),
		backends: [backend],
		cwd: "/tmp/project",
		configCwd: "/tmp/project",
		getSessionId: () => "session-main",
		idFactory: () => {
			nextId += 1;
			return `run-${nextId}`;
		},
	});
	const replies: CapturedReply[] = [];
	const replyWaiters = new Map<string, Array<(reply: CapturedReply) => void>>();
	const service = new IntegrationService(manager, {
		events: {
			emit() {},
			on() {
				return () => {};
			},
		},
		createReply: (channel) => (payload) => {
			const reply = { channel, payload: payload as RpcReply<unknown> };
			replies.push(reply);
			const waiters = replyWaiters.get(channel);
			waiters?.shift()?.(reply);
			if (waiters?.length === 0) replyWaiters.delete(channel);
		},
	});
	return { manager, backend, service, replies, replyWaiters };
}
async function request(fixture: Fixture, op: string, raw: unknown): Promise<void> {
	let requestId: string | undefined;
	if (
		raw !== null &&
		typeof raw === "object" &&
		"requestId" in raw &&
		typeof raw.requestId === "string" &&
		raw.requestId.length > 0
	) {
		requestId = raw.requestId;
	}
	if (requestId === undefined) {
		fixture.service.handle(op, raw);
		await settle();
		return;
	}
	const channel = subagentsRpcReplyChannel(op, requestId);
	const response = new Promise<void>((resolve) => {
		const waiters = fixture.replyWaiters.get(channel) ?? [];
		waiters.push(() => resolve());
		fixture.replyWaiters.set(channel, waiters);
	});
	fixture.service.handle(op, raw);
	await response;
}

function replyFor(fixture: Fixture, op: string, requestId: string): ReplyView | undefined {
	const channel = subagentsRpcReplyChannel(op, requestId);
	return fixture.replies.find((reply) => reply.channel === channel)?.payload as ReplyView | undefined;
}

function dataOf(reply: ReplyView | undefined): Record<string, unknown> {
	expect(reply?.success).toBe(true);
	return (reply as { success: true; data?: unknown }).data as Record<string, unknown>;
}

async function settle(flushTurns = 32): Promise<void> {
	for (let turn = 0; turn < flushTurns; turn += 1) await Promise.resolve();
}

describe("IntegrationService ping", () => {
	it("replies with the protocol version on the request-scoped reply channel", async () => {
		const fixture = await makeFixture();
		await request(fixture, "ping", { requestId: "p1", version: PROTOCOL_VERSION });
		expect(fixture.replies).toHaveLength(1);
		expect(fixture.replies[0]?.channel).toBe(subagentsRpcReplyChannel("ping", "p1"));
		expect(dataOf(replyFor(fixture, "ping", "p1"))).toEqual({ version: 3 });
	});

	it("accepts a ping without a version field", async () => {
		const fixture = await makeFixture();
		await request(fixture, "ping", { requestId: "p2" });
		expect(dataOf(replyFor(fixture, "ping", "p2"))).toEqual({ version: 3 });
	});
});

describe("IntegrationService spawn", () => {
	it("withholds the RPC reply and run until model admission resolves, then reports the fallback", async () => {
		const fixture = await makeFixture();
		const gate = Promise.withResolvers<void>();
		fixture.backend.admissionGate = gate.promise;
		fixture.backend.admissionResult = { model: "fake/fallback", fallback: "Primary unavailable" };
		const pending = request(fixture, "spawn", {
			requestId: "pending-model",
			type: "general-purpose",
			prompt: "work",
		});
		await settle();
		expect(fixture.backend.admissions).toHaveLength(1);
		expect(replyFor(fixture, "spawn", "pending-model")).toBeUndefined();
		expect(fixture.manager.list()).toEqual([]);
		expect(fixture.backend.launches).toEqual([]);
		gate.resolve();
		await pending;
		expect(dataOf(replyFor(fixture, "spawn", "pending-model"))).toEqual({
			id: "run-1",
			model: "fake/fallback",
			modelFallback: "Primary unavailable",
		});
	});

	it("routes admission rejection as an error without allocating an ID or launching a child", async () => {
		const fixture = await makeFixture();
		fixture.backend.admissionError = new Error("No authenticated model is available");
		await request(fixture, "spawn", { requestId: "rejected-model", type: "general-purpose", prompt: "work" });
		expect(replyFor(fixture, "spawn", "rejected-model")).toEqual({
			success: false,
			error: "No authenticated model is available",
		});
		expect(fixture.manager.list()).toEqual([]);
		expect(fixture.backend.launches).toEqual([]);
		fixture.backend.admissionError = undefined;
		await request(fixture, "spawn", { requestId: "accepted-model", type: "general-purpose", prompt: "work" });
		expect(dataOf(replyFor(fixture, "spawn", "accepted-model")).id).toBe("run-1");
	});

	it("rejects unavailable execution before allocating a run", async () => {
		const fixture = await makeFixture();
		fixture.backend.availableResult = false;
		await request(fixture, "spawn", { requestId: "unavailable", type: "general-purpose", prompt: "work" });
		expect(replyFor(fixture, "spawn", "unavailable")?.success).toBe(false);
		expect(fixture.manager.list()).toEqual([]);
		expect(fixture.backend.admissions).toEqual([]);
		expect(fixture.backend.launches).toEqual([]);
	});

	it("rejects admission completed after shutdown even if a new session has already started", async () => {
		const fixture = await makeFixture();
		const gate = Promise.withResolvers<void>();
		fixture.backend.admissionGate = gate.promise;
		const pending = request(fixture, "spawn", {
			requestId: "shutdown-admission",
			type: "general-purpose",
			prompt: "old session work",
		});
		await settle();
		expect(fixture.backend.admissions).toHaveLength(1);
		await fixture.manager.shutdownSession();
		fixture.manager.beginSession();
		gate.resolve();
		await pending;
		expect(replyFor(fixture, "spawn", "shutdown-admission")?.success).toBe(false);
		expect(fixture.manager.list()).toEqual([]);
		expect(fixture.backend.launches).toEqual([]);
		fixture.backend.admissionGate = undefined;
		await request(fixture, "spawn", { requestId: "new-session", type: "general-purpose", prompt: "new work" });
		expect(dataOf(replyFor(fixture, "spawn", "new-session")).id).toBe("run-1");
	});

	it("maps isBackground → run_in_background and defaults extension owner + event delivery", async () => {
		const fixture = await makeFixture();
		await request(fixture, "spawn", {
			requestId: "s1",
			type: "general-purpose",
			prompt: "do task work",
			options: { description: "a task", isBackground: true, maxTurns: 12, model: "sonnet" },
		});
		const id = String(dataOf(replyFor(fixture, "spawn", "s1")).id);
		const run = fixture.manager.get(id);
		expect(run).toBeDefined();
		expect(run?.isBackground).toBe(true);
		expect(run?.owner).toEqual({ kind: "extension", id: "pi-tasks" });
		expect(run?.delivery).toBe("event");
	});

	it("returns { id } matching the created run and launches through the backend", async () => {
		const fixture = await makeFixture();
		await request(fixture, "spawn", {
			requestId: "s2",
			type: "general-purpose",
			prompt: "launch me",
			options: { isBackground: false },
		});
		expect(dataOf(replyFor(fixture, "spawn", "s2"))).toEqual({ id: "run-1", model: fixture.backend.defaultModel });
		await settle();
		expect(fixture.backend.launches).toHaveLength(1);
		expect(fixture.backend.launches[0]?.background).toBe(false);
	});

	it("rejects malformed payloads with an error envelope instead of throwing", async () => {
		const fixture = await makeFixture();
		await request(fixture, "spawn", { requestId: "s3", prompt: "missing type" });
		const bad = replyFor(fixture, "spawn", "s3");
		expect(bad?.success).toBe(false);
		expect(typeof (bad as { error?: string }).error).toBe("string");

		await request(fixture, "spawn", { requestId: "s4" }); // empty payload
		expect(replyFor(fixture, "spawn", "s4")?.success).toBe(false);

		await request(fixture, "spawn", {
			requestId: "s5",
			type: "general-purpose",
			prompt: "p",
			options: { maxTurns: "many" },
		});
		expect(replyFor(fixture, "spawn", "s5")?.success).toBe(false);
		expect(fixture.manager.list()).toHaveLength(0); // nothing was spawned
	});

	it("drops requests without a usable requestId without crashing", async () => {
		const fixture = await makeFixture();
		await request(fixture, "spawn", { requestId: "", type: "x", prompt: "y" });
		await request(fixture, "spawn", "not-an-object");
		await request(fixture, "spawn", undefined);
		expect(fixture.replies).toHaveLength(0);
	});

	it("honors an explicit protocol-valid owner override", async () => {
		const fixture = await makeFixture();
		await request(fixture, "spawn", {
			requestId: "s6",
			type: "general-purpose",
			prompt: "owned work",
			options: { isBackground: true },
			owner: { kind: "extension", id: "pi-tasks", ref: "task-77" },
		});
		const id = String(dataOf(replyFor(fixture, "spawn", "s6")).id);
		const run = fixture.manager.get(id);
		expect(run?.owner).toEqual({ kind: "extension", id: "pi-tasks", ref: "task-77" });
		expect(run?.delivery).toBe("event"); // INTEGRATION.md §6: task assignment defaults to event
	});
});

describe("IntegrationService status / steer / stop / resume / release", () => {
	it("status returns a run snapshot or null", async () => {
		const fixture = await makeFixture();
		const spawned = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", run_in_background: true });
		await request(fixture, "status", { requestId: "st1", agentId: spawned.id });
		const snapshot = dataOf(replyFor(fixture, "status", "st1"));
		expect(snapshot.id).toBe(spawned.id);

		await request(fixture, "status", { requestId: "st2", agentId: "nope" });
		expect(replyFor(fixture, "status", "st2")?.data).toBeNull();
	});

	it("steer waits for backend acknowledgement and errors for non-steerable agents", async () => {
		const fixture = await makeFixture();
		const spawned = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", run_in_background: true });
		await settle();
		await request(fixture, "steer", { requestId: "d1", agentId: spawned.id, message: "go left" });
		expect(dataOf(replyFor(fixture, "steer", "d1"))).toEqual({ accepted: true, queued: false });
		expect(fixture.backend.steers).toHaveLength(1);

		fixture.backend.steerError = new Error("child cannot accept steer");
		await request(fixture, "steer", { requestId: "d2", agentId: spawned.id, message: "fail" });
		expect(replyFor(fixture, "steer", "d2")?.success).toBe(false);
		fixture.backend.complete(spawned.id, "done");
		await fixture.manager.whenSettled(spawned.id);
	});

	it("reports queued steering acceptance and delivers after a capacity slot opens", async () => {
		const fixture = await makeFixture();
		for (let index = 0; index < 4; index += 1) {
			await fixture.manager.spawn({ type: "general-purpose", prompt: `blocker-${index}`, run_in_background: true });
		}
		const queued = await fixture.manager.spawn({ type: "general-purpose", prompt: "queued", run_in_background: true });
		await settle();
		expect(fixture.manager.get(queued.id)?.status).toBe("queued");

		await request(fixture, "steer", { requestId: "dq", agentId: queued.id, message: "queue this steer" });
		expect(dataOf(replyFor(fixture, "steer", "dq"))).toEqual({ accepted: true, queued: true });
		expect(fixture.backend.steers).toHaveLength(0);

		fixture.backend.complete("run-1", "open slot");
		await settle();
		expect(fixture.backend.steers.some((entry) => entry.message === "queue this steer")).toBe(true);
		for (const run of fixture.manager.list()) {
			if (run.status === "running") fixture.backend.complete(run.id, "done");
		}
		await Promise.all(fixture.manager.list().map((run) => fixture.manager.whenSettled(run.id)));
	});

	it("stop acknowledges backend abort separately from process settlement", async () => {
		const fixture = await makeFixture();
		const spawned = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", run_in_background: true });
		await settle();
		await request(fixture, "stop", { requestId: "x1", agentId: spawned.id });
		expect(dataOf(replyFor(fixture, "stop", "x1"))).toEqual({ stopped: true });
		expect(fixture.backend.stops).toHaveLength(1);
		expect(fixture.manager.get(spawned.id)?.status).toBe("running");

		fixture.backend.settleStopped(spawned.id);
		await fixture.manager.whenSettled(spawned.id);
		expect(fixture.manager.get(spawned.id)?.status).toBe("stopped");
		await request(fixture, "stop", { requestId: "x2", agentId: "ghost" });
		expect(replyFor(fixture, "stop", "x2")?.success).toBe(false);
	});

	it("returns backend stop command failures instead of acknowledging a false abort", async () => {
		const fixture = await makeFixture();
		const spawned = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", run_in_background: true });
		await settle();
		fixture.backend.stopError = new Error("child rejected abort");
		await request(fixture, "stop", { requestId: "x3", agentId: spawned.id });

		expect(replyFor(fixture, "stop", "x3")?.success).toBe(false);
		expect(fixture.manager.get(spawned.id)?.status).toBe("running");
		fixture.backend.complete(spawned.id, "child remained alive");
		await fixture.manager.whenSettled(spawned.id);
	});

	it("resume starts a NEW run and returns its id as agentId", async () => {
		const fixture = await makeFixture();
		const first = await fixture.manager.spawn({ type: "general-purpose", prompt: "v1", run_in_background: true });
		await settle();
		fixture.backend.complete(first.id, "done v1", "/tmp/project/.pi/sessions/first.jsonl");
		await fixture.manager.whenSettled(first.id);

		await request(fixture, "resume", { requestId: "r1", agentId: first.id, prompt: "continue" });
		const resumedId = String(dataOf(replyFor(fixture, "resume", "r1")).agentId);
		expect(resumedId).not.toBe(first.id);
		// The resume reopens the source run's persisted session through the backend:
		expect(fixture.backend.resumes[0]?.sessionFile).toBe("/tmp/project/.pi/sessions/first.jsonl");
		expect(fixture.backend.resumes[0]?.runId).toBe(resumedId);
	});
	it("release acknowledges a terminal run after automatic child cleanup", async () => {
		const fixture = await makeFixture();
		const spawned = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", run_in_background: true });
		await settle();
		fixture.backend.complete(spawned.id, "finished");
		await fixture.manager.whenSettled(spawned.id);
		expect(fixture.backend.disposedHandles).toHaveLength(1);
		expect(fixture.manager.get(spawned.id)?.handle).toBeUndefined();

		await request(fixture, "release", { requestId: "rel1", agentId: spawned.id });
		expect(dataOf(replyFor(fixture, "release", "rel1"))).toEqual({ released: true });
		expect(fixture.backend.disposedHandles).toHaveLength(1);
	});
});

describe("IntegrationService dispatch robustness", () => {
	it("unknown ops produce an error envelope when routable", async () => {
		const fixture = await makeFixture();
		await request(fixture, "teleport", { requestId: "u1", target: "nowhere" });
		const payload = replyFor(fixture, "teleport", "u1");
		expect(payload?.success).toBe(false);
		expect(String((payload as { error?: string }).error)).toContain("teleport");
	});

	it("concurrent requestIds never cross-talk", async () => {
		const fixture = await makeFixture();
		const a = await fixture.manager.spawn({ type: "general-purpose", prompt: "A", run_in_background: true });
		const b = await fixture.manager.spawn({ type: "general-purpose", prompt: "B", run_in_background: true });
		await Promise.all([
			request(fixture, "status", { requestId: "req-a", agentId: a.id }),
			request(fixture, "status", { requestId: "req-b", agentId: b.id }),
		]);
		expect(dataOf(replyFor(fixture, "status", "req-a")).id).toBe(a.id);
		expect(dataOf(replyFor(fixture, "status", "req-b")).id).toBe(b.id);
	});

	it("duplicate requestIds each fire once per received request", async () => {
		const fixture = await makeFixture();
		await request(fixture, "ping", { requestId: "dup" });
		await request(fixture, "ping", { requestId: "dup" });
		const dupReplies = fixture.replies.filter((r) => r.channel === subagentsRpcReplyChannel("ping", "dup"));
		expect(dupReplies).toHaveLength(2);
	});

	it("subscribes exactly the protocol channels and unsubscribes all on dispose", async () => {
		expect(SUBAGENTS_RPC_OPS).toEqual(["ping", "spawn", "status", "steer", "stop", "resume", "release"]);
		const active = new Set<(data: unknown) => void>();
		const service = new IntegrationService(await makeFixture().then((f) => f.manager), {
			events: {
				emit() {},
				on(_channel, handler) {
					active.add(handler);
					return () => {
						active.delete(handler);
					};
				},
			},
		});
		expect(active.size).toBe(SUBAGENTS_RPC_OPS.length);
		service.dispose();
		expect(active.size).toBe(0);
	});
});
