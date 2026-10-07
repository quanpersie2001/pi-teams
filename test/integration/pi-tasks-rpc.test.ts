// Compatibility integration test: a FAKE pi-tasks consumer — a faithful
// mirror of pi-tasks' SubagentRuntime rpcCall/probe/lifecycle-listener logic
// (protocol v2) — drives the REAL IntegrationService through the REAL
// composition root over an in-memory pi.events bus.
//
// Cycle under test: ping probe → ready announce → spawn RPC → completed /
// failed broadcast → stop RPC. Also covers malformed/unknown requests and
// concurrent requestId isolation on the shared transport.

import { randomUUID } from "node:crypto";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createPiSubagentsApp } from "../../extension-src/pi-subagents/app/index.js";
import { sanitizeSettings } from "../../extension-src/pi-subagents/domain/config.js";
import type { AgentLifecycleEvent } from "../../extension-src/pi-subagents/domain/integration-protocol.js";
import { PROTOCOL_VERSION } from "../../extension-src/pi-subagents/domain/integration-protocol.js";
import { toLifecycleBroadcast, wireSubagentsRpc } from "../../extension-src/pi-subagents/pi/rpc.js";
import { FakeBackend } from "../helpers/fake-backend.js";

const CHANNEL_SPAWN = "subagents:rpc:spawn";
const CHANNEL_STOP = "subagents:rpc:stop";
const CHANNEL_PING = "subagents:rpc:ping";

/** Envelope shape the real pi-tasks consumer expects (RpcReply). */
type RpcReplyShape<T> = { success: true; data?: T } | { success: false; error: string };

/**
 * Mirror of pi-tasks' SubagentRuntime wire behavior: request-scoped reply
 * listeners, ping version gating (reject non-numeric/older, accept newer),
 * and completed/failed listeners keyed by event.id.
 */
class FakePiTasksConsumer {
	available = false;
	readonly tasksByAgent = new Map<string, string>();
	readonly completions: Array<{ taskId: string; result?: string }> = [];
	readonly failures: Array<{ taskId: string; error: string; status: string }> = [];
	private readonly disposers: Array<() => void> = [];

	constructor(private readonly events: EventBus) {
		this.disposers.push(this.events.on("subagents:ready", () => this.probe()));
		this.disposers.push(
			this.events.on("subagents:completed", (data) => {
				const id = (data as { id?: string })?.id;
				if (!id || !this.tasksByAgent.has(id)) return;
				this.completions.push({
					taskId: this.tasksByAgent.get(id) ?? "",
					result: (data as { result?: string }).result,
				});
				this.tasksByAgent.delete(id);
			}),
		);
		this.disposers.push(
			this.events.on("subagents:failed", (data) => {
				const payload = data as { id?: string; error?: string; status?: string };
				const id = payload?.id;
				if (!id || !this.tasksByAgent.has(id)) return;
				const status = payload.status ?? "error";
				this.failures.push({ taskId: this.tasksByAgent.get(id) ?? "", error: payload.error ?? status, status });
				this.tasksByAgent.delete(id);
			}),
		);
		this.probe();
	}

	/** Same protocol gate as subagent-runtime.probe(). */
	private probe(): void {
		const requestId = randomUUID();
		const timer = setTimeout(() => unsub(), 2_000);
		const unsub = this.events.on(`${CHANNEL_PING}:reply:${requestId}`, (raw: unknown) => {
			unsub();
			clearTimeout(timer);
			const version = (raw as { data?: { version?: number } })?.data?.version;
			if (typeof version !== "number" || !Number.isFinite(version)) return;
			if (version < PROTOCOL_VERSION) return;
			this.available = true;
		});
		this.events.emit(CHANNEL_PING, { requestId, version: PROTOCOL_VERSION });
	}

	/** Same generic call as subagent-runtime.rpcCall(). */
	private rpcCall<T>(channel: string, params: Record<string, unknown>, timeoutMs = 2_000): Promise<T> {
		const requestId = randomUUID();
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsub();
				reject(new Error(`${channel} timeout`));
			}, timeoutMs);
			const unsub = this.events.on(`${channel}:reply:${requestId}`, (raw: unknown) => {
				unsub();
				clearTimeout(timer);
				const reply = raw as RpcReplyShape<T>;
				if (reply.success) resolve(reply.data as T);
				else reject(new Error(reply.error));
			});
			this.events.emit(channel, { requestId, ...params });
		});
	}

	spawn(taskId: string): Promise<string> {
		return this.rpcCall<{ id: string }>(CHANNEL_SPAWN, {
			type: "general-purpose",
			prompt: `work for ${taskId}`,
			options: { description: taskId, isBackground: true, maxTurns: 5 },
		}).then((d) => {
			this.tasksByAgent.set(d.id, taskId);
			return d.id;
		});
	}

	stop(agentId: string): Promise<void> {
		return this.rpcCall<void>(CHANNEL_STOP, { agentId }, 1_000).then(() => undefined);
	}

	dispose(): void {
		for (const off of this.disposers.splice(0)) off();
	}
}

interface Fixture {
	bus: EventBus;
	backend: FakeBackend;
	app: ReturnType<typeof createPiSubagentsApp>;
	rpc: ReturnType<typeof wireSubagentsRpc>;
	broadcasts: Array<{ channel: string; payload: AgentLifecycleEvent & { id: string } }>;
}

async function makeFixture(): Promise<Fixture> {
	const bus = createEventBus();
	const backend = new FakeBackend();
	let nextId = 0;
	const broadcasts: Array<{ channel: string; payload: AgentLifecycleEvent & { id: string } }> = [];
	const app = createPiSubagentsApp({
		sources: [],
		loader: async () => [],
		settings: sanitizeSettings({ backgroundByDefault: true }),
		backends: [backend],
		cwd: "/tmp/project",
		configCwd: "/tmp/project",
		managerOverrides: {
			idFactory: () => {
				nextId += 1;
				return `run-${nextId}`;
			},
		},
	});
	await app.sessionStart();

	// Mirror pi/index.ts session_start wiring exactly: one shared forwarding
	// path (lifecycle broadcasts + RPC subscriptions), ready announce once.
	const rpc = wireSubagentsRpc({ events: bus, manager: app.manager });
	rpc.announceReady();

	// Tap the manager's domain event stream directly for assertions.
	app.subscribe((event) => {
		broadcasts.push({ channel: `subagents:${event.event}`, payload: toLifecycleBroadcast(event) });
	});
	return { bus, backend, app, rpc, broadcasts };
}

async function settle(ms = 50): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("pi-tasks compatibility over pi.events", () => {
	it("runs the full cycle: ready → ping probe → spawn → completed broadcast → stop", async () => {
		const fixture = await makeFixture();
		const consumer = new FakePiTasksConsumer(fixture.bus);
		await settle(10); // probe reply is asynchronous

		expect(consumer.available).toBe(true); // probe answered by the service

		const agentId = await consumer.spawn("task-1");
		await settle(20);
		expect(agentId).toMatch(/^run-/);

		// Ownership/delivery defaults for RPC callers (INTEGRATION.md §6).
		const run = fixture.app.manager.get(agentId);
		expect(run?.owner).toEqual({ kind: "extension", id: "pi-tasks" });
		expect(run?.delivery).toBe("event");
		expect(run?.isBackground).toBe(true);

		fixture.backend.complete(agentId, "task-1 finished");
		await settle();

		expect(consumer.completions).toEqual([{ taskId: "task-1", result: "task-1 finished" }]);
	});

	it("completed broadcasts carry BOTH agentId and id aliases plus result metadata", async () => {
		const fixture = await makeFixture();
		const consumer = new FakePiTasksConsumer(fixture.bus);
		const agentId = await consumer.spawn("task-2");
		await settle(20);

		// Observe exactly what lands on the shared bus (what pi-tasks reads).
		const busPayloads: Array<Record<string, unknown>> = [];
		fixture.bus.on("subagents:completed", (data) => {
			busPayloads.push(data as Record<string, unknown>);
		});

		fixture.backend.complete(agentId, "the answer");
		await settle();

		const seen = fixture.broadcasts.filter((b) => b.channel === "subagents:completed");
		expect(seen).toHaveLength(1);
		const payload = seen[0]?.payload as unknown as Record<string, unknown>;
		// Domain key and public consumer alias are both present:
		expect(payload.agentId).toBe(agentId);
		expect(payload.id).toBe(agentId);
		expect(payload.result).toBe("the answer");
		expect(payload.owner).toEqual({ kind: "extension", id: "pi-tasks" });
		expect(payload.protocolVersion).toBe(PROTOCOL_VERSION);
		expect(busPayloads).toHaveLength(1);
		expect(busPayloads[0]?.id).toBe(agentId);
		expect(busPayloads[0]?.agentId).toBe(agentId);
		expect(busPayloads[0]?.result).toBe("the answer");

		consumer.dispose();
	});

	it("failed broadcasts carry id + error + status for task failure mapping", async () => {
		const fixture = await makeFixture();
		const consumer = new FakePiTasksConsumer(fixture.bus);
		const agentId = await consumer.spawn("task-3");
		await settle(20);
		fixture.backend.fail(agentId, "model exploded");
		await settle();

		expect(consumer.failures).toEqual([{ taskId: "task-3", error: "model exploded", status: "error" }]);
	});

	it("stop RPC returns a success envelope and settles the run", async () => {
		const fixture = await makeFixture();
		const consumer = new FakePiTasksConsumer(fixture.bus);
		const agentId = await consumer.spawn("task-4");
		await settle(20);

		await expect(consumer.stop(agentId)).resolves.toBeUndefined();
		fixture.backend.settleStopped(agentId);
		await fixture.app.manager.whenSettled(agentId);
		expect(fixture.app.manager.get(agentId)?.status).toBe("stopped");
	});

	it("malformed and unknown requests get error envelopes, never crash the service", async () => {
		const fixture = await makeFixture();
		const badSpawn = new Promise<RpcReplyShape<unknown>>((resolve) => {
			const off = fixture.bus.on(`subagents:rpc:spawn:reply:bad-1`, (raw) => {
				off();
				resolve(raw as RpcReplyShape<unknown>);
			});
			fixture.bus.emit(CHANNEL_SPAWN, { requestId: "bad-1", prompt: "no type" });
		});
		await expect(badSpawn).resolves.toMatchObject({ success: false });

		// Unknown op via the fast-path service instance: the guard still routes
		// an error envelope onto the request-scoped reply channel. (Emitted on
		// a bare channel bus there is no wildcard subscription — an unknown op
		// sent only over the wire just times out on the consumer side.)
		const unknownOp = new Promise<RpcReplyShape<unknown>>((resolve) => {
			const off = fixture.bus.on("subagents:rpc:mindmeld:reply:bad-2", (raw) => {
				off();
				resolve(raw as RpcReplyShape<unknown>);
			});
			fixture.rpc.service.handle("mindmeld", { requestId: "bad-2" });
		});
		await expect(unknownOp).resolves.toMatchObject({
			success: false,
			error: expect.stringContaining("mindmeld"),
		});

		// The service still answers well-formed traffic afterwards.
		const consumer = new FakePiTasksConsumer(fixture.bus);
		await settle(10);
		expect(consumer.available).toBe(true);
	});

	it("concurrent spawns keep their replies scoped per requestId", async () => {
		const fixture = await makeFixture();
		const consumerA = new FakePiTasksConsumer(fixture.bus);
		const consumerB = new FakePiTasksConsumer(fixture.bus);
		const [idA, idB] = await Promise.all([consumerA.spawn("task-a"), consumerB.spawn("task-b")]);
		expect(idA).not.toBe(idB);
		expect(consumerA.tasksByAgent.get(idA)).toBe("task-a");
		expect(consumerB.tasksByAgent.get(idB)).toBe("task-b");
		consumerA.dispose();
		consumerB.dispose();
	});
});
