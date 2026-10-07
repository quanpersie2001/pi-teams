// Integration: pi/delivery-host.ts wired through the real composition root
// (createPiSubagentsApp with a deliveryHost), driven by FakePiHost +
// FakeBackend. Verifies end-to-end conversation notification injection,
// owner-aware event payloads on pi.events, and session-switch invalidation.
// No real model calls, no real Pi.

import { describe, expect, it } from "vitest";
import { createPiSubagentsApp, type PiSubagentsApp } from "../../extension-src/pi-teams/app/index.js";
import { sanitizeSettings } from "../../extension-src/pi-teams/domain/config.js";
import type { AgentLifecycleEvent } from "../../extension-src/pi-teams/domain/integration-protocol.js";
import { TEAMMATE_NOTIFICATION_TYPE } from "../../extension-src/pi-teams/features/notifications/index.js";
import { createPiDeliveryHost } from "../../extension-src/pi-teams/pi/delivery-host.js";
import { FakeBackend } from "../helpers/fake-backend.js";
import { FakePiHost } from "../helpers/fake-pi-host.js";

interface Fixture {
	host: FakePiHost;
	backend: FakeBackend;
	app: PiSubagentsApp;
	piEvents: Array<{ channel: string; payload: AgentLifecycleEvent }>;
}

async function makeFixture(sessionView?: {
	sessionId?: string;
	leafId?: string | null;
	branch?: Array<{ id: string }>;
}): Promise<Fixture> {
	const host = new FakePiHost({ mode: "rpc", sessionView });
	const latestCtx = host.extensionContext;
	const backend = new FakeBackend();
	let nextId = 0;
	const piEvents: Array<{ channel: string; payload: AgentLifecycleEvent }> = [];
	const app = createPiSubagentsApp({
		sources: [],
		loader: async () => [],
		settings: sanitizeSettings({ backgroundByDefault: true }),
		backends: [backend],
		cwd: "/tmp/project",
		configCwd: "/tmp/project",
		deliveryHost: createPiDeliveryHost(host.extensionApi, () => latestCtx),
		managerOverrides: {
			idFactory: () => {
				nextId += 1;
				return `run-${nextId}`;
			},
			getSessionId: () => host.sessionView.sessionId ?? "session-a",
		},
	});
	// Mirror pi/index.ts lifecycle forwarding onto pi.events channels.
	app.subscribe((event) => {
		piEvents.push({ channel: `subagents:${event.event}`, payload: event });
	});
	await app.sessionStart();
	return {
		host,
		backend,
		app,
		piEvents,
	};
}

async function settle(ms = 60): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("delivery host integration", () => {
	it("delivers a new conversation-owned completion after shutdown then session start", async () => {
		const fixture = await makeFixture({ sessionId: "session-a" });
		await fixture.app.sessionShutdown();
		fixture.host.sessionView.sessionId = "session-b";
		await fixture.app.sessionStart();
		const launched = Promise.withResolvers<void>();
		const launch = fixture.backend.launch.bind(fixture.backend);
		fixture.backend.launch = async (input) => {
			const handle = await launch(input);
			launched.resolve();
			return handle;
		};
		const record = await fixture.app.manager.spawn({
			type: "general-purpose",
			prompt: "work in the new conversation",
			run_in_background: true,
		});
		await launched.promise;
		fixture.backend.complete(record.id, "RESULT_AFTER_SWITCH");
		await fixture.app.manager.waitForAll();
		expect(fixture.host.sentMessages.map((sent) => sent.message.content)).toEqual([
			expect.stringContaining("RESULT_AFTER_SWITCH"),
		]);
		expect(fixture.host.sentMessages[0]?.message.details).toMatchObject({
			agentId: record.id,
			outcome: "completed",
		});
		await fixture.app.sessionShutdown();
		fixture.app.delivery?.dispose();
	});

	it("injects a teammate-notification custom message into the conversation on completion", async () => {
		const fixture = await makeFixture({ sessionId: "session-a" });
		const record = await fixture.app.manager.spawn({
			type: "general-purpose",
			prompt: "find auth files",
			run_in_background: true,
		});
		await settle(20);
		fixture.backend.complete(record.id, "Found 8 authentication-related files.");
		await settle();

		expect(fixture.host.sentMessages).toHaveLength(1);
		const sent = fixture.host.sentMessages[0];
		expect(sent.message.customType).toBe(TEAMMATE_NOTIFICATION_TYPE);
		expect(sent.message.display).toBe(true);
		expect(String(sent.message.content)).toContain("Found 8 authentication-related files.");
		expect(sent.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		const details = sent.message.details as Record<string, unknown>;
		expect(details).toMatchObject({ agentId: record.id, outcome: "completed", status: "completed" });
	});

	it("extension-owned runs emit pi.events but never inject a conversation message", async () => {
		const fixture = await makeFixture({ sessionId: "session-a" });
		const record = await fixture.app.manager.spawn({
			type: "general-purpose",
			prompt: "task work",
			run_in_background: true,
			owner: { kind: "extension", id: "pi-tasks", ref: "task-123" },
			delivery: "event",
		});
		await settle(20);
		fixture.backend.complete(record.id, "task finished");
		await settle();

		expect(fixture.host.sentMessages).toHaveLength(0);
		const completed = fixture.piEvents.filter((entry) => entry.channel === "subagents:completed");
		expect(completed).toHaveLength(1);
		expect(completed[0].payload.owner).toEqual({ kind: "extension", id: "pi-tasks", ref: "task-123" });
		expect(completed[0].payload.result).toBe("task finished");
	});

	it("conversation-owned runs reach pi.events AND the conversation (policy conversation)", async () => {
		const fixture = await makeFixture({ sessionId: "session-a" });
		const record = await fixture.app.manager.spawn({
			type: "general-purpose",
			prompt: "both paths",
			run_in_background: true,
		});
		await settle(20);
		fixture.backend.complete(record.id, "dual delivery");
		await settle();

		expect(fixture.piEvents.some((entry) => entry.channel === "subagents:completed")).toBe(true);
		expect(fixture.host.sentMessages).toHaveLength(1);
	});

	it("session switch invalidates pending conversation delivery; result stays recoverable", async () => {
		const fixture = await makeFixture({ sessionId: "session-a" });
		const record = await fixture.app.manager.spawn({
			type: "general-purpose",
			prompt: "long run",
			run_in_background: true,
		});
		await settle(20);

		// /new or /resume: fake host now reports a different session.
		fixture.host.sessionView.sessionId = "session-b";
		fixture.app.delivery?.handleSessionSwitch();

		fixture.backend.complete(record.id, "finished after the switch");
		await settle();

		expect(fixture.host.sentMessages).toHaveLength(0);
		expect(fixture.app.manager.get(record.id)?.result).toBe("finished after the switch");
		expect(fixture.app.manager.get(record.id)?.status).toBe("completed");
	});

	it("headless hosts (no session manager methods) degrade to permissive delivery", async () => {
		const fixture = await makeFixture(); // no sessionView → no getSessionId
		const record = await fixture.app.manager.spawn({
			type: "general-purpose",
			prompt: "headless work",
			run_in_background: true,
		});
		await settle(20);
		fixture.backend.complete(record.id, "delivered headlessly");
		await settle();

		expect(fixture.host.sentMessages).toHaveLength(1);
	});

	it("stale-context rejections from pi.sendMessage are swallowed", async () => {
		const fixture = await makeFixture({ sessionId: "session-a" });
		fixture.host.extensionApi.sendMessage = () => {
			throw new Error("this extension ctx is stale after session replacement");
		};
		const record = await fixture.app.manager.spawn({
			type: "general-purpose",
			prompt: "races a session reload",
			run_in_background: true,
		});
		await settle(20);
		fixture.backend.complete(record.id, "still recoverable");
		await settle();

		// No crash; settlement completed; result recoverable via the manager.
		expect(fixture.app.manager.get(record.id)?.status).toBe("completed");
		expect(fixture.app.manager.get(record.id)?.result).toBe("still recoverable");
	});
});
