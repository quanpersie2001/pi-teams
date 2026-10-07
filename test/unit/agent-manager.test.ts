// AgentManager unit tests: event-driven process execution, global foreground/
// background capacity, FIFO queues, stop/abortAll, lifecycle events, ownership
// defaults and result-consumption semantics. All runs use the deterministic
// process FakeBackend — no external model calls.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../../extension-src/pi-teams/app/agent-manager.js";
import { AgentRegistry, type LoadedAgentFile } from "../../extension-src/pi-teams/app/agent-registry.js";
import type {
	AgentRegistryEntry,
	PersistedRegistryEntry,
	SubagentRunStore,
} from "../../extension-src/pi-teams/app/run-registry.js";
import type { SubagentsSettings } from "../../extension-src/pi-teams/domain/config.js";
import { sanitizeSettings } from "../../extension-src/pi-teams/domain/config.js";
import type { AgentLifecycleEvent } from "../../extension-src/pi-teams/domain/integration-protocol.js";
import { FakeBackend } from "../helpers/fake-backend.js";

interface ManagerFixture {
	manager: AgentManager;
	backend: FakeBackend;
	registry: AgentRegistry;
	store: MemoryRunStore;
	events: AgentLifecycleEvent[];
}

class MemoryRunStore implements SubagentRunStore {
	registry: PersistedRegistryEntry[] = [];
	history: CompletedRunHistoryEntry[] = [];

	readRegistry(): PersistedRegistryEntry[] {
		return [...this.registry];
	}
	writeRegistry(entries: readonly PersistedRegistryEntry[]): void {
		this.registry = [...entries];
	}
	readHistory(): CompletedRunHistoryEntry[] {
		return [...this.history];
	}
	recordCompleted(entry: CompletedRunHistoryEntry): void {
		const index = this.history.findIndex((existing) => existing.id === entry.id);
		if (index < 0) this.history.push(entry);
		else this.history[index] = entry;
	}
}

function settings(overrides: Partial<SubagentsSettings> = {}): SubagentsSettings {
	return sanitizeSettings({ maxConcurrent: 4, backgroundByDefault: true, ...overrides });
}

function makeManager(
	options: {
		settingsOverrides?: Partial<SubagentsSettings>;
		files?: LoadedAgentFile[];
		getSessionId?: () => string;
		now?: () => number;
		store?: MemoryRunStore;
		teardownGraceMs?: number;
	} = {},
): ManagerFixture {
	const store = options.store ?? new MemoryRunStore();
	const backend = new FakeBackend();
	let nextId = 0;
	const registry = new AgentRegistry({
		sources: [],
		loader: async () => options.files ?? [],
		settings: settings(options.settingsOverrides),
	});
	const manager = new AgentManager({
		registry,
		settings: settings(options.settingsOverrides),
		backends: [backend],
		cwd: "/tmp/project",
		configCwd: "/tmp/project",
		getSessionId: options.getSessionId ?? (() => "session-main"),
		registryStore: store,
		idFactory: () => {
			nextId += 1;
			return `run-${nextId}`;
		},
		...(options.now !== undefined ? { now: options.now } : {}),
		...(options.teardownGraceMs !== undefined ? { teardownGraceMs: options.teardownGraceMs } : {}),
	});
	const events: AgentLifecycleEvent[] = [];
	manager.subscribe((event) => events.push(event));
	return { manager, backend, registry, store, events };
}

function persistedRun(id: string, status: AgentRegistryEntry["status"]): AgentRegistryEntry {
	const childId = `child-${id}`;
	return {
		id,
		type: "general-purpose",
		description: "legacy child",
		status,
		backend: "process",
		handle: {
			kind: "process",
			childId,
			socketPath: `/tmp/${childId}.sock`,
			token: `token-${childId}`,
			runDir: `/tmp/${childId}`,
			launcher: { kind: "tmux", childId, paneId: `%${id}` },
		},
		sessionFile: `/tmp/sessions/${id}.jsonl`,
		cwd: "/tmp/project",
		configCwd: "/tmp/project",
		owner: { kind: "conversation", sessionId: "session-main" },
		delivery: "conversation",
		startedAt: 1,
	};
}

async function load(fixture: ManagerFixture): Promise<void> {
	await fixture.registry.load();
}

async function spawnBg(manager: AgentManager, prompt = "work"): Promise<{ id: string }> {
	const record = await manager.spawn({ type: "general-purpose", prompt, run_in_background: true });
	return { id: record.id };
}

async function settle(_manager?: AgentManager, _ms?: number): Promise<void> {
	for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}

describe("AgentManager concurrency", () => {
	it("enforces maxConcurrent on background runs and drains FIFO on settle", async () => {
		const fixture = makeManager({ settingsOverrides: { maxConcurrent: 2 } });
		await load(fixture);

		const ids = [
			await spawnBg(fixture.manager),
			await spawnBg(fixture.manager),
			await spawnBg(fixture.manager),
			await spawnBg(fixture.manager),
		];
		await settle(fixture.manager, 20);

		// First two launched immediately, rest queued in order.
		expect(fixture.backend.launches.map((launch) => launch.runId)).toEqual(["run-1", "run-2"]);
		expect(fixture.manager.get(ids[2].id)?.status).toBe("queued");
		expect(fixture.manager.get(ids[3].id)?.status).toBe("queued");

		// Settle the first run → run-3 starts; settle the second → run-4.
		fixture.backend.complete("run-1", "first done");
		await settle(fixture.manager);
		expect(fixture.backend.launches.map((launch) => launch.runId)).toEqual(["run-1", "run-2", "run-3"]);
		fixture.backend.complete("run-2", "second done");
		await settle(fixture.manager);
		expect(fixture.backend.launches.length).toBe(4);
		expect(fixture.manager.get(ids[3].id)?.status).toBe("running");
	});

	it("foreground and background runs share the configured capacity", async () => {
		const fixture = makeManager({ settingsOverrides: { maxConcurrent: 1 } });
		await load(fixture);

		const first = await spawnBg(fixture.manager);
		const second = await spawnBg(fixture.manager);
		const foreground = fixture.manager.spawnAndWait({
			type: "general-purpose",
			prompt: "foreground work",
			description: "foreground",
		});
		await settle(fixture.manager, 20);
		expect(fixture.backend.launches.map((launch) => launch.runId)).toEqual([first.id]);
		expect(fixture.manager.get(second.id)?.status).toBe("queued");

		fixture.backend.complete(first.id, "first done");
		await settle(fixture.manager, 20);
		expect(fixture.backend.launches.map((launch) => launch.runId)).toEqual([first.id, second.id]);
		expect(fixture.manager.get("run-3")?.status).toBe("queued");
		fixture.backend.complete(second.id, "second done");
		await settle(fixture.manager, 20);
		expect(fixture.backend.launches.map((launch) => launch.runId)).toEqual([first.id, second.id, "run-3"]);

		fixture.backend.complete("run-3", "inline result");
		const settled = await foreground;
		expect(settled.status).toBe("completed");
		expect(settled.result).toBe("inline result");
		expect(settled.isBackground).toBe(false);
	});

	it("waitForAll resolves only after queued runs drain and finish", async () => {
		const fixture = makeManager({ settingsOverrides: { maxConcurrent: 1 } });
		await load(fixture);

		const first = await spawnBg(fixture.manager);
		const second = await spawnBg(fixture.manager);
		const waitPromise = fixture.manager.waitForAll();
		await settle(fixture.manager);
		expect(fixture.backend.launches.map((launch) => launch.runId)).toEqual([first.id]);
		fixture.backend.complete(first.id, "one");
		await settle(fixture.manager);
		expect(fixture.backend.launches.map((launch) => launch.runId)).toEqual([first.id, second.id]);
		fixture.backend.complete(second.id, "two");
		await waitPromise;
		expect(fixture.manager.hasRunning()).toBe(false);
	});
});

describe("AgentManager stop and abortAll", () => {
	it("backend stop acknowledgement does not settle the run before child settlement", async () => {
		const fixture = makeManager();
		await load(fixture);

		const record = await spawnBg(fixture.manager);
		await settle(fixture.manager, 20);
		expect(await fixture.manager.stop(record.id)).toBe(true);
		expect(fixture.manager.get(record.id)?.status).toBe("running");
		expect(fixture.backend.stops).toHaveLength(1);

		fixture.backend.settleStopped(record.id);
		await fixture.manager.whenSettled(record.id);
		expect(fixture.manager.get(record.id)?.status).toBe("stopped");
		expect(fixture.events.some((event) => event.event === "stopped")).toBe(true);
		expect(await fixture.manager.stop(record.id)).toBe(false);
	});

	it("stop removes a queued run without consuming or releasing a pool slot", async () => {
		const fixture = makeManager({ settingsOverrides: { maxConcurrent: 1 } });
		await load(fixture);

		const active = await spawnBg(fixture.manager);
		const queued = await spawnBg(fixture.manager);
		await settle(fixture.manager, 20);
		expect(fixture.manager.get(queued.id)?.status).toBe("queued");

		expect(await fixture.manager.stop(queued.id)).toBe(true);
		expect(fixture.manager.get(queued.id)?.status).toBe("stopped");
		expect(fixture.backend.stops).toHaveLength(0);
		expect(fixture.backend.launches).toHaveLength(1);

		fixture.backend.complete(active.id, "release exactly one slot");
		await settle(fixture.manager, 20);
		expect(fixture.backend.launches).toHaveLength(1);
	});

	it("stop during launch waits for the handle, sends one abort and awaits child settlement", async () => {
		const fixture = makeManager();
		await load(fixture);
		const { promise: launchGate, resolve: releaseLaunch } = Promise.withResolvers<void>();
		fixture.backend.launchGate = launchGate;

		const record = await spawnBg(fixture.manager);
		await settle(fixture.manager, 10);
		expect(fixture.manager.get(record.id)?.status).toBe("starting");
		expect(await fixture.manager.stop(record.id)).toBe(true);
		expect(fixture.backend.stops).toHaveLength(0);

		releaseLaunch();
		await settle(fixture.manager, 20);
		expect(fixture.backend.stops).toHaveLength(1);
		expect(fixture.manager.get(record.id)?.status).toBe("running");
		fixture.backend.settleStopped(record.id);
		await fixture.manager.whenSettled(record.id);
		expect(fixture.manager.get(record.id)?.status).toBe("stopped");
	});

	it("abortAll requests every active stop but only settles on backend events", async () => {
		const fixture = makeManager({ settingsOverrides: { maxConcurrent: 2 } });
		await load(fixture);

		for (let i = 0; i < 4; i++) await spawnBg(fixture.manager);
		await settle(fixture.manager, 20);
		expect(fixture.manager.abortAll()).toBe(4);
		expect(fixture.backend.stops).toHaveLength(2);
		for (const record of fixture.manager.list()) {
			if (record.status === "running") fixture.backend.settleStopped(record.id);
		}
		await Promise.all(fixture.manager.list().map((record) => fixture.manager.whenSettled(record.id)));
		expect(fixture.manager.list().every((record) => record.status === "stopped")).toBe(true);
	});
});

describe("AgentManager steer and stop commands", () => {
	it("queues a steer before launch, delivers it after start, and permits settlement after steering", async () => {
		const fixture = makeManager({ settingsOverrides: { maxConcurrent: 1 } });
		await load(fixture);

		const blocker = await spawnBg(fixture.manager);
		const parked = await spawnBg(fixture.manager);
		await settle(fixture.manager);
		expect(await fixture.manager.steer(parked.id, "queue me")).toBe(true);
		fixture.backend.complete(blocker.id, "blocker done");
		await settle(fixture.manager, 30);
		expect(fixture.backend.steers.some((entry) => entry.message === "queue me")).toBe(true);

		expect(await fixture.manager.steer(parked.id, "pivot now")).toBe(true);
		expect(fixture.backend.steers.some((entry) => entry.message === "pivot now")).toBe(true);
		fixture.backend.complete(parked.id, "settled after steer");
		await fixture.manager.whenSettled(parked.id);
		expect(fixture.manager.get(parked.id)?.status).toBe("completed");
		expect(fixture.manager.get(parked.id)?.result).toBe("settled after steer");
		expect(await fixture.manager.steer("nope", "hi")).toBe(false);
	});

	it("propagates a rejected backend steer command", async () => {
		const fixture = makeManager();
		await load(fixture);
		const record = await spawnBg(fixture.manager);
		await settle(fixture.manager, 20);
		fixture.backend.steerError = new Error("child rejected steer");
		await expect(fixture.manager.steer(record.id, "pivot")).rejects.toThrow("child rejected steer");
		fixture.backend.complete(record.id, "done");
		await fixture.manager.whenSettled(record.id);
	});
	it("propagates a rejected backend stop command without settling locally", async () => {
		const fixture = makeManager();
		await load(fixture);
		const record = await spawnBg(fixture.manager);
		await settle(fixture.manager);
		fixture.backend.stopError = new Error("child rejected abort");
		await expect(fixture.manager.stop(record.id)).rejects.toThrow("child rejected abort");
		expect(fixture.manager.get(record.id)?.status).toBe("running");
		fixture.backend.complete(record.id, "still running after rejected abort");
		await fixture.manager.whenSettled(record.id);
	});
});

describe("AgentManager state machine integration", () => {
	it("walks queued → starting → running → completed with result and events", async () => {
		const fixture = makeManager();
		await load(fixture);

		const record = await fixture.manager.spawn({ type: "explore", prompt: "find code", run_in_background: true });
		await settle(fixture.manager, 20);

		const running = fixture.manager.get(record.id);
		expect(running?.status).toBe("running");

		fixture.backend.complete(record.id, "found it", "/tmp/sessions/run.jsonl");
		await fixture.manager.whenSettled(record.id);

		const done = fixture.manager.get(record.id);
		expect(done?.status).toBe("completed");
		expect(done?.result).toBe("found it");
		expect(done?.sessionFile).toBe("/tmp/sessions/run.jsonl");
		expect(done?.completedAt).toBeDefined();
		expect(done?.handle).toBeUndefined();
		expect(fixture.backend.disposedHandles).toHaveLength(1);
		expect(fixture.store.registry).toEqual([]);
		expect(fixture.store.history).toMatchObject([
			{ id: record.id, status: "completed", result: "found it", sessionFile: "/tmp/sessions/run.jsonl" },
		]);
		expect(fixture.store.history[0]).not.toHaveProperty("handle");

		const names = fixture.events.map((event) => event.event);
		expect(names).toContain("started");
		expect(names.filter((name) => name === "completed").length).toBe(1);
		const completed = fixture.events.find((event) => event.event === "completed");
		expect(completed?.agentId).toBe(record.id);
		expect(completed?.result).toBe("found it");
		expect(completed?.protocolVersion).toBe(3);
		expect(completed?.owner).toEqual({ kind: "conversation", sessionId: "session-main" });
	});

	it("maps backend failure to error status + failed event", async () => {
		const fixture = makeManager();
		await load(fixture);

		const record = await spawnBg(fixture.manager);
		await settle(fixture.manager, 20);
		fixture.backend.fail(record.id, "provider exploded");
		await fixture.manager.whenSettled(record.id);

		expect(fixture.manager.get(record.id)?.status).toBe("error");
		expect(fixture.manager.get(record.id)?.error).toBe("provider exploded");
		expect(fixture.events.some((event) => event.event === "failed")).toBe(true);
	});
});

describe("AgentManager backgroundByDefault and ownership", () => {
	it("spawns detached when neither the call nor the file pins the flag", async () => {
		const fixture = makeManager({ settingsOverrides: { backgroundByDefault: true } });
		await load(fixture);

		const record = await fixture.manager.spawn({ type: "general-purpose", prompt: "work" });
		expect(record.isBackground).toBe(true);
	});

	it("a definition pinning run_in_background false wins over the setting", async () => {
		const fixture = makeManager({
			settingsOverrides: { backgroundByDefault: true },
			files: [
				{
					sourcePath: "/fake/foreground-agent.md",
					frontmatter: { name: "foreground-agent", description: "pinned foreground", run_in_background: false },
					body: "specialist body",
					filenameStem: "foreground-agent",
				},
			],
		});
		await load(fixture);

		const record = await fixture.manager.spawn({ type: "foreground-agent", prompt: "work" });
		expect(record.isBackground).toBe(false);
	});
});

describe("AgentManager resume", () => {
	it("refuses active runs and cold-resumes from the persisted session after child cleanup", async () => {
		const fixture = makeManager();
		await load(fixture);

		const active = await spawnBg(fixture.manager);
		await settle(fixture.manager, 20);
		await expect(fixture.manager.resume(active.id, "continue")).rejects.toThrow(/still running/);

		fixture.backend.complete(active.id, "done", "/tmp/sessions/run.jsonl");
		await fixture.manager.whenSettled(active.id);
		expect(fixture.manager.get(active.id)?.handle).toBeUndefined();
		expect(fixture.backend.disposedHandles).toHaveLength(1);

		const resumed = await fixture.manager.resume(active.id, "continue");
		await settle(fixture.manager);
		expect(resumed.id).not.toBe(active.id);
		expect(fixture.backend.resumes[0]?.sessionFile).toBe("/tmp/sessions/run.jsonl");
	});

	it("cold-resumes a completed run as a NEW run from its original JSONL", async () => {
		const fixture = makeManager();
		await load(fixture);

		const original = await spawnBg(fixture.manager);
		await settle(fixture.manager, 20);
		fixture.backend.complete(original.id, "done", "/tmp/sessions/orig.jsonl");
		await fixture.manager.whenSettled(original.id);

		const resumed = await fixture.manager.resume(original.id, "keep going");
		expect(resumed.id).not.toBe(original.id);
		await settle(fixture.manager, 30);

		expect(fixture.backend.resumes).toHaveLength(1);
		expect(fixture.backend.resumes[0]?.sessionFile).toBe("/tmp/sessions/orig.jsonl");
		expect(fixture.backend.resumes[0]?.prompt).toBe("keep going");
		expect(fixture.manager.get(original.id)?.status).toBe("completed");
	});
});

describe("AgentManager terminal cleanup failures", () => {
	it("retains the handle and registry recovery receipt when child disposal fails", async () => {
		const fixture = makeManager();
		await load(fixture);
		const record = await spawnBg(fixture.manager);
		await settle(fixture.manager);
		const handle = fixture.manager.get(record.id)?.handle;
		fixture.backend.disposeError = new Error("verified pane close failed");

		fixture.backend.complete(record.id, "done", "/tmp/sessions/failed-close.jsonl");
		await fixture.manager.whenSettled(record.id);

		expect(fixture.backend.disposeAttempts).toHaveLength(1);
		expect(fixture.backend.disposedHandles).toHaveLength(0);
		expect(fixture.manager.get(record.id)?.handle).toEqual(handle);
		expect(fixture.manager.get(record.id)?.recoveryError).toMatch(/verified pane close failed/);
		expect(fixture.store.registry).toMatchObject([
			{
				id: record.id,
				status: "completed",
				handle: { childId: "child-run-1" },
				recoveryError: expect.stringMatching(/verified pane close failed/),
			},
		]);
		expect(fixture.store.history[0]).not.toHaveProperty("handle");
		expect(fixture.store.history[0]?.sessionFile).toBe("/tmp/sessions/failed-close.jsonl");
		await expect(fixture.manager.resume(record.id, "continue")).rejects.toThrow(/retained child/);
	});
});

describe("AgentManager pane attachment capability", () => {
	it("advertises native-pane attachment only for an owned native launcher handle", async () => {
		const headless = makeManager();
		await load(headless);
		const headlessRun = await spawnBg(headless.manager);
		await settle(headless.manager);
		expect(headless.manager.canAttachPane(headlessRun.id)).toBe(false);
		expect(await headless.manager.attachPane(headlessRun.id)).toBe(false);

		const native = makeManager();
		native.backend.launcherKind = "tmux";
		await load(native);
		const nativeRun = await spawnBg(native.manager);
		await settle(native.manager);
		expect(native.manager.canAttachPane(nativeRun.id)).toBe(true);
		expect(await native.manager.attachPane(nativeRun.id)).toBe(true);
		native.backend.complete(nativeRun.id, "finished");
		await native.manager.whenSettled(nativeRun.id);
		expect(native.manager.canAttachPane(nativeRun.id)).toBe(false);
	});
});

describe("AgentManager restored terminal cleanup", () => {
	for (const [persistedStatus, nativeStatus, expectedStatus] of [
		["completed", { state: "completed", result: "done" }, "completed"],
		["stopped", { state: "stopped" }, "stopped"],
		["error", { state: "failed", error: "failed" }, "error"],
	] as const) {
		it(`closes an authenticated restored ${persistedStatus} child`, async () => {
			const fixture = makeManager();
			await load(fixture);
			const row = persistedRun(`old-${persistedStatus}`, persistedStatus);
			fixture.backend.setStatus(row.id, { ...nativeStatus, sessionFile: row.sessionFile });

			const result = await fixture.manager.restoreReconnectedRun(row);

			expect(result).toEqual({ state: "closed" });
			expect(fixture.backend.disposeAttempts).toEqual([`fake-restored-${row.id}`]);
			expect(fixture.backend.disposedHandles).toEqual([`fake-restored-${row.id}`]);
			expect(fixture.manager.get(row.id)?.status).toBe(expectedStatus);
			expect(fixture.manager.get(row.id)?.handle).toBeUndefined();
			expect(fixture.store.history[0]?.status).toBe(expectedStatus);
			expect(fixture.store.history[0]).not.toHaveProperty("handle");
			expect(fixture.store.registry).toEqual([]);
		});
	}

	it("does not close an active restored child", async () => {
		const fixture = makeManager();
		await load(fixture);
		const active = persistedRun("old-active", "running");
		fixture.backend.setStatus(active.id, { state: "running" });

		const activeResult = await fixture.manager.restoreReconnectedRun(active);

		expect(activeResult.state).toBe("retained");
		expect(fixture.backend.disposeAttempts).toEqual([]);
		expect(fixture.manager.get(active.id)?.handle).toBeDefined();
	});
});

describe("get_subagent_result full-result channel", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("re-reads the full result file on every call; consume only suppresses the notification", async () => {
		const fixture = makeManager();
		await load(fixture);
		tempDir = mkdtempSync(join(tmpdir(), "teams-result-"));
		const resultFile = join(tempDir, "result.md");
		const fullAnswer = "the full answer ".repeat(1_000);
		writeFileSync(resultFile, fullAnswer);

		const record = await spawnBg(fixture.manager);
		await settle(fixture.manager, 20);
		fixture.backend.complete(record.id, "the full answer ".repeat(1_000).slice(0, 8_000), undefined, {
			resultFile,
			resultTruncated: true,
			resultOriginalLength: fullAnswer.length,
		});
		await fixture.manager.whenSettled(record.id);

		const first = await fixture.manager.getResult(record.id);
		expect(first).toContain(fullAnswer.trim());
		expect(first).toContain(`full result: ${resultFile}`);
		const second = await fixture.manager.getResult(record.id);
		expect(second).toContain(fullAnswer.trim());
		expect(fixture.manager.get(record.id)?.resultConsumed).toBe(true);
	});

	it("falls back to the inline copy with an honest note when the result file is unreadable", async () => {
		const fixture = makeManager();
		await load(fixture);
		tempDir = mkdtempSync(join(tmpdir(), "teams-result-"));

		const record = await spawnBg(fixture.manager);
		await settle(fixture.manager, 20);
		const inline = "the inline answer";
		fixture.backend.complete(record.id, inline, undefined, { resultFile: join(tempDir, "missing.md") });
		await fixture.manager.whenSettled(record.id);

		const text = await fixture.manager.getResult(record.id);
		expect(text).toContain(inline);
		expect(text).toMatch(/unreadable/);
	});

	it("labels the inline copy as truncated with the full-result pointer when no file was re-read", async () => {
		const fixture = makeManager();
		await load(fixture);
		tempDir = mkdtempSync(join(tmpdir(), "teams-result-"));
		const resultFile = join(tempDir, "result.md");
		writeFileSync(resultFile, "");

		const record = await spawnBg(fixture.manager);
		await settle(fixture.manager, 20);
		const inline = "x".repeat(8_193); // 8192 chars + truncation ellipsis
		fixture.backend.complete(record.id, inline, undefined, {
			resultFile,
			resultTruncated: true,
			resultOriginalLength: 20_000,
		});
		await fixture.manager.whenSettled(record.id);

		const text = await fixture.manager.getResult(record.id);
		// Empty file → not "showingFull" → inline copy + truncation note path.
		expect(text).toMatch(new RegExp(`Result truncated at 8192/20000 chars — full: ${escapeRegExp(resultFile)}`));
	});

	it("wait: true blocks until settlement; aborting keeps the result unconsumed", async () => {
		const fixture = makeManager();
		await load(fixture);

		const record = await spawnBg(fixture.manager);
		await settle(fixture.manager, 20);
		expect(fixture.manager.get(record.id)?.status).toBe("running");

		const controller = new AbortController();
		const abortedWait = fixture.manager.getResult(record.id, { wait: true, signal: controller.signal });
		controller.abort();
		const abortedText = await abortedWait;
		expect(abortedText).toMatch(/still running/);
		expect(fixture.manager.get(record.id)?.resultConsumed).toBeFalsy();

		const waitedResult = fixture.manager.getResult(record.id, { wait: true });
		fixture.backend.complete(record.id, "late answer");
		const waited = await waitedResult;
		expect(waited).toContain("late answer");
		expect(fixture.manager.get(record.id)?.resultConsumed).toBe(true);
	});

	it("reports unknown agents with a clear message", async () => {
		const fixture = makeManager();
		await load(fixture);
		expect(await fixture.manager.getResult("ghost")).toMatch(/Agent not found/);
	});
});

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("session teardown (ADR 0007 §1)", () => {
	it("cooperatively stops an active child at shutdown without force-kill", async () => {
		const fixture = makeManager({ teardownGraceMs: 5_000 });
		await load(fixture);
		const record = await spawnBg(fixture.manager);
		await settle(fixture.manager);
		expect(fixture.manager.get(record.id)?.status).toBe("running");

		const shutdown = fixture.manager.shutdownSession();
		// The child honors the abort request inside the grace window.
		fixture.backend.settleStopped(record.id);
		await shutdown;

		expect(fixture.backend.stops).toHaveLength(1);
		expect(fixture.backend.enforced).toEqual([]);
		expect(fixture.store.history[0]).toMatchObject({ id: record.id, status: "stopped" });
		expect(fixture.manager.list()).toEqual([]);
	});

	it("force-kills an uncooperative child through the enforcement path after the grace", async () => {
		const fixture = makeManager({ teardownGraceMs: 10 });
		await load(fixture);
		const record = await spawnBg(fixture.manager);
		await settle(fixture.manager);

		await fixture.manager.shutdownSession();

		expect(fixture.backend.stops).toHaveLength(1);
		expect(fixture.backend.enforced).toHaveLength(1);
		expect(fixture.store.history[0]).toMatchObject({ id: record.id, status: "stopped" });
	});
});

describe("AgentManager dispose", () => {
	it("stops everything and disposes backend handles", async () => {
		const fixture = makeManager({ settingsOverrides: { maxConcurrent: 2 } });
		await load(fixture);

		for (let i = 0; i < 3; i++) await spawnBg(fixture.manager);
		await settle(fixture.manager, 20);

		const disposing = fixture.manager.dispose();
		await settle(fixture.manager);
		for (const run of fixture.manager.list()) {
			if (run.status === "running") fixture.backend.settleStopped(run.id);
		}
		await disposing;
		expect(fixture.manager.hasRunning()).toBe(false);
		expect(fixture.backend.disposedHandles.length).toBe(2);
		await expect(fixture.manager.spawn({ type: "general-purpose", prompt: "x" })).rejects.toThrow(/disposed/);
	});
});

describe("AgentManager hard time budgets", () => {
	let clock: number;

	beforeEach(() => {
		vi.useFakeTimers();
		clock = 1_000_000;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function timedManager(options: Parameters<typeof makeManager>[0] = {}): ManagerFixture {
		return makeManager({ ...options, now: () => clock });
	}

	async function advance(ms: number): Promise<void> {
		clock += ms;
		await vi.advanceTimersByTimeAsync(ms);
	}

	function item(kind: "assistant" | "toolResult" | "user" | "toolCall" | "system", at: number) {
		return { kind, timestamp: at, text: kind };
	}

	it("freezes effective budgets at admission: invocation > definition > settings", async () => {
		const fixture = timedManager({
			settingsOverrides: { defaultTimeout: 30, defaultIdleTimeout: 15 },
			files: [
				{
					sourcePath: "/fake/budgeted.md",
					frontmatter: { name: "budgeted", description: "definition budgets", timeout: 120, idle_timeout: 45 },
					body: "body",
					filenameStem: "budgeted",
				},
			],
		});
		await load(fixture);

		// Settings tier only.
		const fromSettings = await spawnBg(fixture.manager);
		expect(fixture.manager.get(fromSettings.id)?.budgetTimeout).toBe(30);
		expect(fixture.manager.get(fromSettings.id)?.budgetIdleTimeout).toBe(15);

		// Definition tier beats settings.
		const fromDefinition = await fixture.manager.spawn({ type: "budgeted", prompt: "work" });
		expect(fixture.manager.get(fromDefinition.id)?.budgetTimeout).toBe(120);
		expect(fixture.manager.get(fromDefinition.id)?.budgetIdleTimeout).toBe(45);

		// Invocation tier beats both.
		const fromInvocation = await fixture.manager.spawn({
			type: "budgeted",
			prompt: "work",
			timeout: 60,
			idle_timeout: 10,
		});
		expect(fixture.manager.get(fromInvocation.id)?.budgetTimeout).toBe(60);
		expect(fixture.manager.get(fromInvocation.id)?.budgetIdleTimeout).toBe(10);
	});

	it("rejects malformed invocation budgets before allocating anything", async () => {
		const fixture = timedManager();
		await load(fixture);

		for (const bad of [0, -5, 1.5, null, "30"]) {
			await expect(
				fixture.manager.spawn({ type: "general-purpose", prompt: "work", timeout: bad as unknown as number }),
			).rejects.toThrow(/invalid timeout/);
		}
		await expect(fixture.manager.spawn({ type: "general-purpose", prompt: "work", idle_timeout: 0 })).rejects.toThrow(
			/invalid idleTimeout/,
		);
		expect(fixture.backend.launches).toHaveLength(0);
		expect([...fixture.manager.list()]).toEqual([]);
	});

	it("queued runs spend no budget; clocks start only at launch", async () => {
		const fixture = timedManager({ settingsOverrides: { maxConcurrent: 1 } });
		await load(fixture);

		const blocker = await spawnBg(fixture.manager);
		const queued = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", timeout: 60 });
		await settle(fixture.manager, 20);
		expect(fixture.manager.get(queued.id)?.status).toBe("queued");
		expect(fixture.manager.get(queued.id)?.budgetTimeout).toBe(60);
		expect(fixture.manager.get(queued.id)?.budgetStartedAt).toBeUndefined();

		await advance(600_000);
		expect(fixture.manager.get(queued.id)?.status).toBe("queued");

		fixture.backend.complete(blocker.id, "blocker done");
		await settle(fixture.manager, 20);
		expect(fixture.backend.launches.map((launch) => launch.runId)).toEqual([blocker.id, queued.id]);
		expect(fixture.manager.get(queued.id)?.status).toBe("running");
		expect(fixture.manager.get(queued.id)?.budgetStartedAt).toBe(clock);
		expect(fixture.manager.get(queued.id)?.budgetLastOutputAt).toBe(clock);
	});

	it("wall expiry hard-stops, records the budget, and keeps the annotation through settlement", async () => {
		const fixture = timedManager();
		await load(fixture);

		const record = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", timeout: 1 });
		await settle(fixture.manager, 20);
		expect(fixture.manager.get(record.id)?.budgetStartedAt).toBe(clock);

		await advance(1_000);
		expect(fixture.manager.get(record.id)?.budgetExhausted).toBe("timeout");
		expect(fixture.manager.get(record.id)?.budgetSeconds).toBe(1);
		// Stop acknowledgement is not settlement.
		expect(fixture.backend.stops).toHaveLength(1);
		expect(fixture.manager.get(record.id)?.status).toBe("running");

		fixture.backend.settleStopped(record.id);
		await fixture.manager.whenSettled(record.id);
		const settled = fixture.manager.get(record.id);
		expect(settled?.status).toBe("stopped");
		expect(settled?.budgetExhausted).toBe("timeout");

		const reported = await fixture.manager.getResult(record.id);
		expect(reported).toMatch(/Stopped by timeout budget after 1s/);
		expect(reported).toMatch(/partial work may be incomplete/);
		expect(reported).toMatch(new RegExp(`Resume with Agent\\(resume: "${record.id}"\\)`));

		expect(fixture.store.history[0]).toMatchObject({
			id: record.id,
			status: "stopped",
			budgetTimeout: 1,
			budgetIdleTimeout: 0,
			budgetExhausted: "timeout",
			budgetSeconds: 1,
		});
		expect(fixture.events.find((event) => event.event === "stopped")?.budgetExhausted).toBe("timeout");
	});

	it("completed tool results reset idle on arrival; the idle clock uses arrival, not creation timestamps", async () => {
		const fixture = timedManager();
		await load(fixture);

		const record = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", idle_timeout: 5 });
		const id = record.id;
		await settle(fixture.manager, 20);
		const startedAt = fixture.manager.get(id)?.budgetStartedAt;
		if (startedAt === undefined) throw new Error("budget clocks did not start");

		// Baseline snapshot counts as history even with a fresh-looking timestamp.
		fixture.backend.emitFocus(id, [item("system", startedAt)]);

		await advance(3_000);
		// A completed tool result whose creation timestamp predates its arrival:
		// the idle clock must move to the ARRIVAL time (now), not the timestamp.
		fixture.backend.emitFocus(id, [{ kind: "toolResult", id: "t1", timestamp: startedAt + 1_000 }]);
		expect(fixture.manager.get(id)?.budgetLastOutputAt).toBe(startedAt + 3_000);

		await advance(4_900);
		expect(fixture.manager.get(id)?.status).toBe("running");
		await advance(100);
		expect(fixture.manager.get(id)?.budgetExhausted).toBe("idle_timeout");
		expect(fixture.manager.get(id)?.budgetSeconds).toBe(5);
	});

	it("a steady assistant stream survives the idle budget; silence expires it", async () => {
		const fixture = timedManager();
		await load(fixture);

		const record = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", idle_timeout: 3 });
		const id = record.id;
		await settle(fixture.manager, 20);
		const startedAt = fixture.manager.get(id)?.budgetStartedAt;
		if (startedAt === undefined) throw new Error("budget clocks did not start");
		fixture.backend.emitFocus(id, [item("system", startedAt)]);

		for (let second = 1; second <= 6; second += 1) {
			await advance(1_000);
			// Same message id, unchanged creation timestamp, newer partial revision:
			// only the revision arrival keeps the run alive.
			fixture.backend.emitFocus(id, [
				{
					kind: "assistant",
					id: "stream",
					revision: second,
					partial: true,
					timestamp: startedAt,
					text: `chunk ${second}`,
				},
			]);
			expect(fixture.manager.get(id)?.status).toBe("running");
			expect(fixture.manager.get(id)?.budgetLastOutputAt).toBe(startedAt + second * 1_000);
		}

		await advance(2_900);
		expect(fixture.manager.get(id)?.status).toBe("running");
		await advance(100);
		expect(fixture.manager.get(id)?.budgetExhausted).toBe("idle_timeout");
		expect(fixture.manager.get(id)?.budgetSeconds).toBe(3);
	});

	it("partial tool updates, tool-call starts and empty assistant upserts never buy idle", async () => {
		const fixture = timedManager();
		await load(fixture);

		const record = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", idle_timeout: 2 });
		const id = record.id;
		await settle(fixture.manager, 20);
		const startedAt = fixture.manager.get(id)?.budgetStartedAt;
		if (startedAt === undefined) throw new Error("budget clocks did not start");
		fixture.backend.emitFocus(id, [item("system", startedAt)]);

		for (let half = 1; half <= 3; half += 1) {
			await advance(500);
			fixture.backend.emitFocus(id, [
				{
					kind: "toolResult",
					id: "partial-tool",
					revision: half,
					partial: true,
					timestamp: startedAt + half * 500,
					result: { chunk: half },
				},
				{ kind: "toolCall", id: `call-${half}`, timestamp: startedAt + half * 500, toolName: "bash" },
				{
					kind: "assistant",
					id: "empty-upsert",
					revision: half,
					partial: true,
					timestamp: startedAt + half * 500,
					text: "",
				},
			]);
			fixture.backend.setStatus(id, { state: "running", turns: half, toolUses: half });
			await settle(fixture.manager, 10);
		}

		await advance(500);
		expect(fixture.manager.get(id)?.budgetExhausted).toBe("idle_timeout");
		expect(fixture.manager.get(id)?.budgetSeconds).toBe(2);
	});

	it("steers, user items and usage refreshes never reset the idle clock", async () => {
		const fixture = timedManager();
		await load(fixture);

		const record = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", idle_timeout: 1 });
		const id = record.id;
		await settle(fixture.manager, 20);
		const startedAt = fixture.manager.get(id)?.budgetStartedAt;
		if (startedAt === undefined) throw new Error("budget clocks did not start");

		await advance(500);
		expect(await fixture.manager.steer(id, "pivot")).toBe(true);
		fixture.backend.emitFocus(id, [item("user", startedAt + 500), item("toolCall", startedAt + 500)]);
		fixture.backend.setStatus(id, { state: "running", turns: 4, toolUses: 9 });
		await settle(fixture.manager, 20);

		await advance(500);
		expect(fixture.manager.get(id)?.budgetExhausted).toBe("idle_timeout");
		expect(fixture.manager.get(id)?.budgetSeconds).toBe(1);
	});

	it("a child that ignores the abort is force-terminated after the bounded grace", async () => {
		const fixture = timedManager();
		await load(fixture);

		const record = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", timeout: 1 });
		const id = record.id;
		await settle(fixture.manager, 20);
		await advance(1_000);
		expect(fixture.manager.get(id)?.status).toBe("running");
		expect(fixture.backend.stops).toHaveLength(1);

		// Bounded cooperative window: enforcement fires at expiry+2s.
		await advance(1_900);
		expect(fixture.backend.enforced).toHaveLength(0);
		await advance(100);
		expect(fixture.backend.enforced).toHaveLength(1);

		const settled = await fixture.manager.whenSettled(id);
		expect(settled.status).toBe("stopped");
		expect(settled.budgetExhausted).toBe("timeout");
		expect(settled.budgetSeconds).toBe(1);
		expect(settled.recoveryError).toBeUndefined();
		expect(settled.handle).toBeUndefined();
		expect(fixture.store.registry).toEqual([]);
		expect(fixture.store.history[0]).toMatchObject({
			id,
			status: "stopped",
			budgetExhausted: "timeout",
			budgetSeconds: 1,
		});
	});

	it("enforcement failure stays visible: run active, receipt retained, no fake settlement", async () => {
		const fixture = timedManager();
		await load(fixture);
		fixture.backend.enforceTerminateError = new Error("owned group survived SIGTERM and SIGKILL");

		const record = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", timeout: 1 });
		const id = record.id;
		await settle(fixture.manager, 20);
		await advance(3_000);

		expect(fixture.backend.enforced).toHaveLength(1);
		const record2 = fixture.manager.get(id);
		expect(record2?.status).toBe("running");
		expect(record2?.budgetExhausted).toBe("timeout");
		expect(record2?.budgetSeconds).toBe(1);
		expect(record2?.recoveryError).toMatch(/Budget enforcement failed: owned group survived/);
		expect(fixture.store.registry[0]).toMatchObject({ id, handle: { childId: "child-run-1" } });
		expect(fixture.store.history).toEqual([]);
	});

	it("settlement during the grace window skips enforcement entirely", async () => {
		const fixture = timedManager();
		await load(fixture);

		const record = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", timeout: 1 });
		const id = record.id;
		await settle(fixture.manager, 20);
		await advance(1_000);
		fixture.backend.complete(id, "finished inside the grace window");
		await fixture.manager.whenSettled(id);
		await advance(5_000);

		expect(fixture.backend.enforced).toHaveLength(0);
		expect(fixture.manager.get(id)?.status).toBe("completed");
		expect(fixture.manager.get(id)?.budgetExhausted).toBeUndefined();
	});

	it("backends without the enforcement port keep cooperative-only semantics", async () => {
		const fixture = timedManager();
		await load(fixture);
		fixture.backend.enforceTerminate = undefined;

		const record = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", timeout: 1 });
		const id = record.id;
		await settle(fixture.manager, 20);
		await advance(10_000);

		expect(fixture.backend.enforced).toHaveLength(0);
		expect(fixture.manager.get(id)?.status).toBe("running");
		expect(fixture.manager.get(id)?.budgetExhausted).toBe("timeout");
		expect(fixture.manager.get(id)?.budgetSeconds).toBe(1);
		expect(fixture.backend.stops).toHaveLength(1);

		fixture.backend.settleStopped(id);
		await fixture.manager.whenSettled(id);
		expect(fixture.manager.get(id)?.status).toBe("stopped");
	});

	it("enforcement also terminates a disconnected owned child and settles it as budget-stopped", async () => {
		const fixture = timedManager();
		await load(fixture);

		const record = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", timeout: 1 });
		const id = record.id;
		await settle(fixture.manager, 20);
		// Verified connection loss: the child is unreachable for the abort.
		fixture.backend.setStatus(id, { state: "disconnected", detail: "Child control connection lost" });
		await settle(fixture.manager, 20);
		await advance(3_000);

		expect(fixture.backend.enforced).toHaveLength(1);
		const settled = await fixture.manager.whenSettled(id);
		expect(settled.status).toBe("stopped");
		expect(settled.budgetExhausted).toBe("timeout");
	});

	it("simultaneous wall and idle expiry reports the wall budget", async () => {
		const fixture = timedManager();
		await load(fixture);

		const record = await fixture.manager.spawn({
			type: "general-purpose",
			prompt: "work",
			timeout: 2,
			idle_timeout: 2,
		});
		await settle(fixture.manager, 20);
		await advance(2_000);
		expect(fixture.manager.get(record.id)?.budgetExhausted).toBe("timeout");
		expect(fixture.manager.get(record.id)?.budgetSeconds).toBe(2);
	});

	it("enforces an expiry that happens while the launch is still in flight", async () => {
		const fixture = timedManager();
		await load(fixture);
		const { promise: launchGate, resolve: releaseLaunch } = Promise.withResolvers<void>();
		fixture.backend.launchGate = launchGate;

		const record = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", timeout: 1 });
		const id = record.id;
		await settle(fixture.manager, 10);
		await advance(2_000);
		expect(fixture.manager.get(id)?.budgetExhausted).toBe("timeout");
		expect(fixture.backend.stops).toHaveLength(0);

		releaseLaunch();
		await settle(fixture.manager, 30);
		expect(fixture.backend.stops).toHaveLength(1);
		expect(fixture.manager.get(id)?.status).toBe("running");
		fixture.backend.settleStopped(id);
		await fixture.manager.whenSettled(id);
		expect(fixture.manager.get(id)?.status).toBe("stopped");
	});

	it("a completion racing the watchdog drops the budget annotation", async () => {
		const fixture = timedManager();
		await load(fixture);

		const record = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", timeout: 1 });
		const id = record.id;
		await settle(fixture.manager, 20);
		await advance(1_000);
		fixture.backend.complete(id, "finished just in time");
		await fixture.manager.whenSettled(id);

		const settled = fixture.manager.get(id);
		expect(settled?.status).toBe("completed");
		expect(settled?.budgetExhausted).toBeUndefined();
		expect(settled?.budgetSeconds).toBeUndefined();
		expect(await fixture.manager.getResult(id)).not.toMatch(/Stopped by/);
	});

	it("watchdogs never survive settlement, release or dispose", async () => {
		const fixture = timedManager();
		await load(fixture);

		const settledRun = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", timeout: 1 });
		fixture.backend.complete(settledRun.id, "done");
		await fixture.manager.whenSettled(settledRun.id);
		await advance(60_000);
		expect(fixture.backend.stops).toHaveLength(0);

		const releasedRun = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", timeout: 1 });
		await settle(fixture.manager, 20);
		fixture.backend.complete(releasedRun.id, "done", "/tmp/sessions/released.jsonl");
		await fixture.manager.whenSettled(releasedRun.id);
		await fixture.manager.release(releasedRun.id);
		await advance(60_000);
		expect(fixture.backend.stops).toHaveLength(0);

		const disposedRun = await fixture.manager.spawn({ type: "general-purpose", prompt: "work", timeout: 3_600 });
		await settle(fixture.manager, 20);
		const stopsBeforeDispose = fixture.backend.stops.length;
		const disposing = fixture.manager.dispose();
		await settle(fixture.manager, 20);
		fixture.backend.settleStopped(disposedRun.id);
		await disposing;
		// dispose() itself aborts the active run; the budget watchdog must NOT
		// have fired (no budgetExhausted) and must not fire after disposal.
		expect(fixture.manager.get(disposedRun.id)?.budgetExhausted).toBeUndefined();
		expect(fixture.backend.stops.length).toBe(stopsBeforeDispose + 1);
		await advance(3_700_000);
		expect(fixture.backend.stops.length).toBe(stopsBeforeDispose + 1);
	});

	it("warm resume replays the frozen budgets with fresh clocks", async () => {
		const definition = [
			{
				sourcePath: "/fake/budgeted.md",
				frontmatter: { name: "budgeted", description: "definition budgets", timeout: 5 },
				body: "body",
				filenameStem: "budgeted",
			},
		] satisfies LoadedAgentFile[];
		const fixture = timedManager({ settingsOverrides: { defaultTimeout: 30 }, files: definition });
		await load(fixture);

		const original = await fixture.manager.spawn({ type: "budgeted", prompt: "work", timeout: 60 });
		await settle(fixture.manager, 20);
		fixture.backend.setStatus(original.id, { state: "stopped", sessionFile: "/tmp/sessions/warm.jsonl" });
		await fixture.manager.whenSettled(original.id);
		const resumeAt = clock + 500_000;
		await advance(500_000);

		const resumed = await fixture.manager.resume(original.id, "continue");
		await settle(fixture.manager, 20);
		// Frozen 60 wins over the (still loaded) definition 5 and settings 30.
		expect(resumed.budgetTimeout).toBe(60);
		expect(resumed.budgetIdleTimeout).toBe(0);
		// The pre-start clone carries only the frozen limits; the clocks live on
		// the actual run once it launches.
		const running = fixture.manager.get(resumed.id);
		expect(running?.budgetStartedAt).toBe(resumeAt);
		expect(running?.budgetLastOutputAt).toBe(resumeAt);
		expect(fixture.backend.launches.at(-1)?.runId).toBe(resumed.id);
	});

	it("cold resume preserves frozen unlimited budgets against changed settings", async () => {
		const first = timedManager();
		await load(first);
		const original = await spawnBg(first.manager);
		await settle(first.manager, 20);
		expect(first.manager.get(original.id)?.budgetTimeout).toBe(0);
		expect(first.manager.get(original.id)?.budgetIdleTimeout).toBe(0);
		first.backend.complete(original.id, "done", "/tmp/sessions/cold.jsonl");
		await first.manager.whenSettled(original.id);

		// A later session resolves budgets from defaultTimeout 999, but the cold
		// history row replays as explicitly unlimited.
		const later = makeManager({
			settingsOverrides: { defaultTimeout: 999, defaultIdleTimeout: 999 },
			now: () => clock,
			store: first.store,
		});
		await load(later);

		const resumed = await later.manager.resume(original.id, "continue");
		await settle(later, 20);
		expect(resumed.budgetTimeout).toBe(0);
		expect(resumed.budgetIdleTimeout).toBe(0);
		// Clocks live on the launched run, not on the pre-start clone.
		expect(later.manager.get(resumed.id)?.budgetStartedAt).toBe(clock);
	});

	it("resume-request overrides beat the frozen budgets", async () => {
		const fixture = timedManager({ settingsOverrides: { defaultTimeout: 30 } });
		await load(fixture);

		const original = await spawnBg(fixture.manager);
		await settle(fixture.manager, 20);
		fixture.backend.setStatus(original.id, { state: "stopped", sessionFile: "/tmp/sessions/override.jsonl" });
		await fixture.manager.whenSettled(original.id);

		const resumed = await fixture.manager.resume(original.id, "continue", { timeout: 7, idle_timeout: 3 });
		expect(resumed.budgetTimeout).toBe(7);
		expect(resumed.budgetIdleTimeout).toBe(3);
		await expect(fixture.manager.resume(original.id, "again", { timeout: 0 })).rejects.toThrow(/invalid timeout/);
	});

	it("a reconnected retained child re-derives idle output from the transcript", async () => {
		const fixture = timedManager();
		await load(fixture);
		const launchedAt = clock;
		const row = persistedRun("budgeted-restore", "running");
		row.budgetTimeout = 120;
		row.budgetIdleTimeout = 30;
		row.budgetStartedAt = launchedAt;
		row.budgetLastOutputAt = launchedAt + 5_000;
		fixture.backend.setStatus(row.id, { state: "running" });

		const result = await fixture.manager.restoreReconnectedRun(row);
		expect(result.state).toBe("retained");
		const restored = fixture.manager.get(row.id);
		expect(restored?.budgetStartedAt).toBe(launchedAt);

		// The child produced output while the parent was away: the idle clock
		// re-derives from the authenticated transcript instead of firing on the
		// stale persisted value (t0+35s).
		fixture.backend.emitFocus(row.id, [item("assistant", launchedAt + 40_000)]);
		await settle(fixture.manager, 20);
		await advance(34_000);
		expect(fixture.manager.get(row.id)?.status).toBe("running");
		expect(fixture.manager.get(row.id)?.budgetLastOutputAt).toBe(launchedAt + 40_000);

		// Quiet since t0+40s: the corrected idle deadline (t0+70s) fires, not
		// the stale persisted one (t0+35s), and the 120s wall clock is untouched.
		await advance(35_000);
		expect(fixture.manager.get(row.id)?.status).toBe("running");
		await advance(1_000);
		expect(fixture.manager.get(row.id)?.budgetExhausted).toBe("idle_timeout");
		expect(fixture.manager.get(row.id)?.budgetSeconds).toBe(30);
		expect(fixture.backend.stops).toHaveLength(1);
	});

	it("a reconnected retained child keeps the original wall clock across restart", async () => {
		const fixture = timedManager();
		await load(fixture);
		const launchedAt = clock;
		const row = persistedRun("wall-restore", "running");
		row.budgetTimeout = 60;
		row.budgetIdleTimeout = 0;
		row.budgetStartedAt = launchedAt;
		row.budgetLastOutputAt = launchedAt;
		fixture.backend.setStatus(row.id, { state: "running" });

		const result = await fixture.manager.restoreReconnectedRun(row);
		expect(result.state).toBe("retained");

		// The parent was away for 50s of the child's 60s wall budget: only 10s
		// may remain. A fresh-clock restore would have fired 60s from now.
		// (advance moves the injected clock AND the fake timer queue in lockstep
		// — exactly like a real clock driving both.)
		await advance(50_000);
		expect(fixture.manager.get(row.id)?.status).toBe("running");
		await advance(9_000);
		expect(fixture.manager.get(row.id)?.status).toBe("running");
		await advance(1_000);
		expect(fixture.manager.get(row.id)?.budgetExhausted).toBe("timeout");
		expect(fixture.manager.get(row.id)?.budgetSeconds).toBe(60);
		expect(fixture.backend.stops).toHaveLength(1);
	});
});
