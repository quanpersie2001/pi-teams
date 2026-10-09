// DeliveryService unit tests: lifecycle routing, owner rules, guard refusal
// recoverability, session-switch invalidation, stale-context swallow and the
// decision audit trail. Manager driven by FakeBackend — no model calls, no Pi.

import { describe, expect, it } from "vitest";
import { AgentManager } from "../../extension-src/pi-teams/app/agent-manager.js";
import { AgentRegistry } from "../../extension-src/pi-teams/app/agent-registry.js";
import type {
	CompletionNotification,
	DeliveryHost,
	SessionSnapshot,
} from "../../extension-src/pi-teams/app/delivery-service.js";
import { DeliveryService } from "../../extension-src/pi-teams/app/delivery-service.js";
import { sanitizeSettings } from "../../extension-src/pi-teams/domain/config.js";
import type { AgentLifecycleEvent } from "../../extension-src/pi-teams/domain/integration-protocol.js";
import { isStaleExtensionCtxError } from "../../extension-src/pi-teams/shared/stale-context.js";
import { FakeBackend } from "../helpers/fake-backend.js";

interface Fixture {
	manager: AgentManager;
	backend: FakeBackend;
	service: DeliveryService;
	notifications: CompletionNotification[];
	session: SessionSnapshot & { setSessionId?(id: string): void };
	sendError?: Error;
}

async function makeFixture(
	options: {
		initialSession?: SessionSnapshot;
		/** Throw from sendNotification (e.g. stale ctx). */
		sendError?: Error;
		holdMs?: number;
		groupTimeoutMs?: number;
		stragglerTimeoutMs?: number;
	} = {},
): Fixture {
	const backend = new FakeBackend();
	let nextId = 0;
	const registry = new AgentRegistry({
		sources: [],
		loader: async () => [],
		settings: sanitizeSettings({ backgroundByDefault: true }),
	});
	const manager = new AgentManager({
		registry,
		settings: sanitizeSettings({ backgroundByDefault: true }),
		backends: [backend],
		cwd: "/tmp/project",
		configCwd: "/tmp/project",
		getSessionId: () => "session-a",
		idFactory: () => {
			nextId += 1;
			return `run-${nextId}`;
		},
	});
	const notifications: CompletionNotification[] = [];
	const sessionState: SessionSnapshot = { ...(options.initialSession ?? { sessionId: "session-a" }) };
	const host: DeliveryHost = {
		sendNotification(notification) {
			if (options.sendError) throw options.sendError;
			notifications.push(notification);
		},
		currentSession() {
			return sessionState;
		},
	};
	const service = new DeliveryService(manager, host, {
		holdMs: options.holdMs ?? 0,
		...(options.groupTimeoutMs !== undefined ? { groupTimeoutMs: options.groupTimeoutMs } : {}),
		...(options.stragglerTimeoutMs !== undefined ? { stragglerTimeoutMs: options.stragglerTimeoutMs } : {}),
	});
	await registry.load();
	return {
		manager,
		backend,
		service,
		notifications,
		session: sessionState as SessionSnapshot & { setSessionId?(id: string): void },
	};
}

async function settle(flushTurns = 32): Promise<void> {
	for (let turn = 0; turn < flushTurns; turn += 1) await Promise.resolve();
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function spawnBackground(manager: AgentManager, request: Record<string, unknown> = {}): Promise<string> {
	const record = await manager.spawn({
		type: "general-purpose",
		prompt: "work",
		run_in_background: true,
		...request,
	});
	return record.id;
}

describe("DeliveryService", () => {
	it("joins a launch batch into one message and filters results fetched before dispatch", async () => {
		const fixture = await makeFixture({ holdMs: 30 });
		const ids = await Promise.all([
			spawnBackground(fixture.manager),
			spawnBackground(fixture.manager),
			spawnBackground(fixture.manager),
		]);
		for (const id of ids) fixture.service.trackSpawn(id);
		fixture.service.finishSpawnBatch();
		await settle(20);
		for (const [index, id] of ids.entries()) fixture.backend.complete(id, `report ${index}`);
		await settle();
		await fixture.manager.getResult(ids[1] ?? "missing", { wait: true });
		await delay(60);
		expect(fixture.notifications).toHaveLength(1);
		expect([
			fixture.notifications[0]?.agentId,
			...(fixture.notifications[0]?.others ?? []).map((item) => item.agentId),
		]).toEqual([ids[0], ids[2]]);
		expect(fixture.service.getDecisionLog().filter((item) => item.reason === "delivered")).toHaveLength(2);
		expect(fixture.service.getDecisionLog().filter((item) => item.reason === "result-consumed-inline")).toHaveLength(1);
		fixture.service.dispose();
	});

	it("joins a child that settles before its Agent tool returns", async () => {
		const fixture = await makeFixture({ holdMs: 30 });
		const ids = await Promise.all([spawnBackground(fixture.manager), spawnBackground(fixture.manager)]);
		await settle(20);
		fixture.backend.complete(ids[0] ?? "missing", "fast result");
		await settle();
		for (const id of ids) fixture.service.trackSpawn(id);
		fixture.service.finishSpawnBatch();
		fixture.backend.complete(ids[1] ?? "missing", "slow result");
		await delay(60);
		expect(fixture.notifications).toHaveLength(1);
		expect(fixture.notifications[0]?.others).toHaveLength(1);
		fixture.service.dispose();
	});

	it("does not notify when every result in the batch was fetched", async () => {
		const fixture = await makeFixture({ holdMs: 25 });
		const ids = await Promise.all([spawnBackground(fixture.manager), spawnBackground(fixture.manager)]);
		for (const id of ids) fixture.service.trackSpawn(id);
		fixture.service.finishSpawnBatch();
		await settle(20);
		for (const id of ids) fixture.backend.complete(id, `report ${id}`);
		await Promise.all(ids.map((id) => fixture.manager.getResult(id, { wait: true })));
		await delay(50);
		expect(fixture.notifications).toHaveLength(0);
		fixture.service.dispose();
	});

	it("suppresses a single queued completion after get_subagent_result", async () => {
		const fixture = await makeFixture({ holdMs: 25 });
		const id = await spawnBackground(fixture.manager);
		await settle(20);
		fixture.backend.complete(id, "already read");
		await fixture.manager.getResult(id, { wait: true });
		await delay(50);
		expect(fixture.notifications).toHaveLength(0);
		expect(fixture.service.getDecisionLog()[0]?.reason).toBe("result-consumed-inline");
		fixture.service.dispose();
	});

	it("rechecks the active branch during the notification hold", async () => {
		const fixture = await makeFixture({ holdMs: 25, initialSession: { sessionId: "session-a", leafId: "leaf-1" } });
		const id = await spawnBackground(fixture.manager, { parentSession: { sessionId: "session-a", leafId: "leaf-1" } });
		await settle(20);
		fixture.backend.complete(id, "result");
		await settle();
		fixture.session.leafId = "leaf-2";
		fixture.session.branchIds = ["root", "leaf-2"];
		await delay(50);
		expect(fixture.notifications).toHaveLength(0);
		expect(fixture.service.getDecisionLog()[0]?.reason).toBe("guard-refused:branch-moved");
		fixture.service.dispose();
	});

	it("sends partial groups after timeout, then a later straggler", async () => {
		const fixture = await makeFixture({ holdMs: 5, groupTimeoutMs: 25, stragglerTimeoutMs: 20 });
		const ids = await Promise.all([
			spawnBackground(fixture.manager),
			spawnBackground(fixture.manager),
			spawnBackground(fixture.manager),
		]);
		for (const id of ids) fixture.service.trackSpawn(id);
		fixture.service.finishSpawnBatch();
		await settle(20);
		fixture.backend.complete(ids[0] ?? "missing", "first");
		fixture.backend.complete(ids[1] ?? "missing", "second");
		await delay(50);
		expect(fixture.notifications).toHaveLength(1);
		expect(fixture.notifications[0]?.others).toHaveLength(1);
		fixture.backend.complete(ids[2] ?? "missing", "late");
		await delay(40);
		expect(fixture.notifications).toHaveLength(2);
		expect(fixture.notifications[1]?.agentId).toBe(ids[2]);
		fixture.service.dispose();
	});

	it("clears a queued notification when the parent session switches", async () => {
		const fixture = await makeFixture({ holdMs: 30 });
		const id = await spawnBackground(fixture.manager);
		await settle(20);
		fixture.backend.complete(id, "old session");
		await settle();
		fixture.service.handleSessionSwitch();
		await delay(60);
		expect(fixture.notifications).toHaveLength(0);
		fixture.service.dispose();
	});
	it("delivers a completion notification for conversation-owned background runs", async () => {
		const fixture = await makeFixture();
		const id = await spawnBackground(fixture.manager);
		await settle(20);

		fixture.backend.complete(id, "found 8 auth files");
		await settle();

		expect(fixture.notifications).toHaveLength(1);
		const notification = fixture.notifications[0];
		expect(notification.agentId).toBe(id);
		expect(notification.outcome).toBe("completed");
		expect(notification.preview).toContain("8 auth files");

		const log = fixture.service.getDecisionLog();
		expect(log).toHaveLength(1);
		expect(log[0]).toMatchObject({ agentId: id, event: "completed", delivered: true, reason: "delivered" });
	});

	it("routes failed and stopped settlements too", async () => {
		const fixture = await makeFixture();
		const failedId = await spawnBackground(fixture.manager);
		const stoppedId = await spawnBackground(fixture.manager);
		await settle(20);

		fixture.backend.fail(failedId, "boom");
		await fixture.manager.stop(stoppedId);
		fixture.backend.settleStopped(stoppedId);
		await fixture.manager.whenSettled(stoppedId);

		const outcomes = fixture.notifications.map((notification) => notification.outcome).sort();
		expect(outcomes).toEqual(["failed", "stopped"]);
		const failure = fixture.notifications.find((notification) => notification.outcome === "failed");
		expect(failure?.preview).toBe("boom");
	});

	it("never notifies the conversation for extension-owned runs even when policy says conversation (owner rules win)", async () => {
		const fixture = await makeFixture();
		const id = await spawnBackground(fixture.manager, {
			owner: { kind: "extension", id: "pi-tasks", ref: "task-123" },
			delivery: "conversation",
		});
		await settle(20);
		fixture.backend.complete(id, "task work done");
		await settle();

		expect(fixture.notifications).toHaveLength(0);
		expect(fixture.service.getDecisionLog()[0]?.reason).toMatch(/^policy-blocked:/);
		// The lifecycle event still carried everything an extension consumer needs.
	});

	it("honors delivery none (caller polls status/getResult)", async () => {
		const fixture = await makeFixture();
		const id = await spawnBackground(fixture.manager, {
			owner: { kind: "conversation", sessionId: "session-a" },
			delivery: "none",
		});
		await settle(20);
		fixture.backend.complete(id, "polled later");
		await settle();

		expect(fixture.notifications).toHaveLength(0);
		expect(fixture.manager.get(id)?.result).toBe("polled later");
	});

	it("refuses delivery after a session switch but keeps the result recoverable", async () => {
		const fixture = await makeFixture({ initialSession: { sessionId: "session-a" } });
		const id = await spawnBackground(fixture.manager);
		await settle(20);

		// /new or /resume happened while the run was in flight.
		fixture.session.sessionId = "session-b";
		fixture.service.handleSessionSwitch();

		fixture.backend.complete(id, "result of the old conversation");
		await settle();

		expect(fixture.notifications).toHaveLength(0);
		const log = fixture.service.getDecisionLog()[0];
		expect(log?.delivered).toBe(false);
		expect(log?.reason).toBe("guard-refused:session-switched");
		expect(fixture.service.getSessionSwitchCount()).toBe(1);
		// Recoverability: nothing was deleted — result still on the run record.
		expect(fixture.manager.get(id)?.result).toBe("result of the old conversation");
		expect(fixture.manager.get(id)?.status).toBe("completed");
	});

	it("re-evaluates the guard at delivery time, not at spawn time", async () => {
		const fixture = await makeFixture({ initialSession: { sessionId: "session-a", leafId: "leaf-1" } });
		const id = await spawnBackground(fixture.manager, {
			parentSession: { sessionId: "session-a", leafId: "leaf-1" },
		});
		await settle(20);

		// User continues the conversation; parent leaf stays on the branch path.
		fixture.session.leafId = "leaf-2";
		fixture.session.branchIds = ["root", "leaf-1", "leaf-2"];
		fixture.backend.complete(id, "still deliverable");
		await settle();

		expect(fixture.notifications).toHaveLength(1);
	});

	it("skips foreground runs whose result was already consumed inline", async () => {
		const backend = new FakeBackend();
		let nextId = 0;
		const registry = new AgentRegistry({
			sources: [],
			loader: async () => [],
			settings: sanitizeSettings({}),
		});
		const manager = new AgentManager({
			registry,
			settings: sanitizeSettings({ backgroundByDefault: false }),
			backends: [backend],
			cwd: "/tmp/project",
			configCwd: "/tmp/project",
			getSessionId: () => "session-a",
			idFactory: () => {
				nextId += 1;
				return `run-${nextId}`;
			},
		});
		const notifications: CompletionNotification[] = [];
		const service = new DeliveryService(
			manager,
			{
				sendNotification: (notification) => notifications.push(notification),
				currentSession: () => ({ sessionId: "session-a" }),
			},
			{ holdMs: 0 },
		);
		await registry.load();

		const pending = manager.spawnAndWait({ type: "general-purpose", prompt: "inline please" });
		await settle(20);
		backend.complete("run-1", "inline answer");
		await pending;
		manager.markResultConsumed("run-1");
		await settle();

		expect(notifications).toHaveLength(0);
		expect(service.getDecisionLog()[0]?.reason).toBe("result-consumed-inline");
		service.dispose();
	});

	it("swallows stale-context errors from the transport without breaking settlement", async () => {
		const staleError = new Error("this extension ctx is stale after session replacement");
		expect(isStaleExtensionCtxError(staleError)).toBe(true);
		const fixture = await makeFixture({ sendError: staleError });
		const id = await spawnBackground(fixture.manager);
		await settle(20);

		fixture.backend.complete(id, "survives a stale ctx");
		await settle();

		expect(fixture.notifications).toHaveLength(0);
		expect(fixture.service.getDecisionLog()[0]?.reason).toBe("stale-ctx-swallowed");
		expect(fixture.manager.get(id)?.status).toBe("completed");
	});

	it("degrades to permissive when the host cannot read a session at all (headless)", async () => {
		const backend = new FakeBackend();
		let nextId = 0;
		const registry = new AgentRegistry({ sources: [], loader: async () => [], settings: sanitizeSettings({}) });
		const manager = new AgentManager({
			registry,
			settings: sanitizeSettings({ backgroundByDefault: true }),
			backends: [backend],
			cwd: "/tmp/project",
			configCwd: "/tmp/project",
			getSessionId: () => "unknown-session",
			idFactory: () => {
				nextId += 1;
				return `run-${nextId}`;
			},
		});
		const notifications: CompletionNotification[] = [];
		const service = new DeliveryService(
			manager,
			{
				sendNotification: (notification) => notifications.push(notification),
				currentSession: () => undefined,
			},
			{ holdMs: 0 },
		);
		await registry.load();

		const id = await spawnBackground(manager, { parentSession: { sessionId: "unknown-session" } });
		await settle(20);
		backend.complete(id, "headless completion");
		await settle();

		expect(notifications).toHaveLength(1);
		service.dispose();
	});

	it("dispose detaches from the lifecycle stream", async () => {
		const fixture = await makeFixture();
		fixture.service.dispose();
		const id = await spawnBackground(fixture.manager);
		await settle(20);
		fixture.backend.complete(id, "after dispose");
		await settle();

		expect(fixture.notifications).toHaveLength(0);
		expect(fixture.service.getDecisionLog()).toHaveLength(0);
	});

	it("lifecycle events carry owner-aware payloads for extension consumers", async () => {
		const fixture = await makeFixture();
		const events: AgentLifecycleEvent[] = [];
		fixture.manager.subscribe((event) => events.push(event));
		const id = await spawnBackground(fixture.manager, {
			owner: { kind: "extension", id: "pi-tasks", ref: "task-9" },
			delivery: "event",
		});
		await settle(20);
		fixture.backend.complete(id, "event payload check");
		await settle();

		const terminal = events.filter((event) => event.event === "completed");
		expect(terminal).toHaveLength(1);
		expect(terminal[0].owner).toEqual({ kind: "extension", id: "pi-tasks", ref: "task-9" });
		expect(terminal[0].delivery).toBe("event");
		expect(terminal[0].result).toBe("event payload check");
		expect(terminal[0].protocolVersion).toBeTypeOf("number");
	});
});
