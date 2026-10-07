// Session-scoped restore: runs belong to the conversation that launched
// them. Only rows whose conversation owner matches the current session are
// adopted; foreign rows (other conversations, extension consumers) are
// bookkeeping-only and never surface in this session's manager or UI.

import { describe, expect, it, vi } from "vitest";
import { createPiSubagentsApp, type PiSubagentsApp } from "../../extension-src/pi-teams/app/index.js";
import type {
	AgentRegistryEntry,
	CompletedRunHistoryEntry,
	PersistedRegistryEntry,
	RestoreObservers,
	SubagentRunStore,
} from "../../extension-src/pi-teams/app/run-registry.js";
import { sanitizeSettings } from "../../extension-src/pi-teams/domain/config.js";
import { FakeBackend } from "../helpers/fake-backend.js";

function row(id: string, overrides: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
	return {
		id,
		type: "explore",
		description: "scoped run",
		status: "running",
		backend: "process",
		handle: {
			kind: "process",
			childId: `child-${id}`,
			socketPath: `/tmp/pi-teams/child-${id}.sock`,
			token: `token-${id}`,
			runDir: `/tmp/pi-teams/sessions/child-${id}`,
			launcher: { kind: "headless", childId: `child-${id}`, pid: 4312, identity: { ownerToken: `owner-${id}` } },
		},
		cwd: "/tmp/project",
		configCwd: "/tmp/project",
		owner: { kind: "conversation", sessionId: "session-a" },
		delivery: "conversation",
		startedAt: 1_000,
		...overrides,
	};
}

function memoryStore(initial: readonly PersistedRegistryEntry[]) {
	const registry: PersistedRegistryEntry[] = [...initial];
	const history: CompletedRunHistoryEntry[] = [];
	const store: SubagentRunStore = {
		readRegistry: () => [...registry],
		writeRegistry: (entries) => {
			registry.length = 0;
			registry.push(...entries);
		},
		readHistory: () => [...history],
		recordCompleted: (entry) => {
			const index = history.findIndex((existing) => existing.id === entry.id);
			if (index >= 0) history[index] = entry;
			else history.push(entry);
		},
	};
	return { store, registry, history };
}

function observers(overrides: Partial<RestoreObservers> = {}): RestoreObservers {
	return {
		sessionPresent: () => true,
		detectCompletion: () => ({ finished: false }),
		resourceAlive: () => true,
		...overrides,
	};
}

async function makeApp(options: {
	sessionId: string;
	entries: readonly PersistedRegistryEntry[];
	observers?: Partial<RestoreObservers>;
}): Promise<{
	app: PiSubagentsApp;
	registry: PersistedRegistryEntry[];
	history: CompletedRunHistoryEntry[];
	backend: FakeBackend;
}> {
	const { store, registry, history } = memoryStore(options.entries);
	const backend = new FakeBackend();
	const app = createPiSubagentsApp({
		sources: [],
		loader: async () => [],
		settings: sanitizeSettings({ rememberAgents: true }),
		backends: [backend],
		cwd: "/tmp/project",
		configCwd: "/tmp/project",
		getSessionId: () => options.sessionId,
		runStore: store,
		restoreObservers: observers(options.observers),
		managerOverrides: {
			idFactory: (() => {
				let next = 0;
				return () => {
					next += 1;
					return `spawned-${next}`;
				};
			})(),
		},
	});
	await app.sessionStart();
	return { app, registry, history, backend };
}

describe("session-scoped restore", () => {
	it("archives own leftover active rows stopped (no re-adoption); foreign live rows are retained untouched", async () => {
		const own = row("own-run");
		const foreign = row("foreign-run", { owner: { kind: "conversation", sessionId: "session-b" } });
		const { app, registry, history } = await makeApp({ sessionId: "session-a", entries: [own, foreign] });

		// Session-bound lifetime (ADR 0007): an active own row is never
		// re-adopted — it archives stopped with an honest note and verified
		// disposal of its resource.
		expect(app.manager.get("own-run")).toBeUndefined();
		expect(app.manager.get("foreign-run")).toBeUndefined();
		expect(history).toMatchObject([{ id: "own-run", status: "stopped" }]);
		expect(history[0]?.recoveryError).toMatch(/never re-adopted/);
		expect(registry.some((entry) => "id" in entry && entry.id === "foreign-run")).toBe(true);
		expect(app.manager.list().map((record) => record.id)).toEqual([]);
	});

	it("archives a settled foreign row to history and drops it from the registry", async () => {
		const foreign = row("foreign-settled", {
			owner: { kind: "conversation", sessionId: "session-b" },
		});
		const { app, registry, history } = await makeApp({
			sessionId: "session-a",
			entries: [foreign],
			observers: {
				detectCompletion: () => ({ finished: true, outcome: "completed", result: "done elsewhere" }),
			},
		});

		expect(app.manager.get("foreign-settled")).toBeUndefined();
		expect(history).toMatchObject([{ id: "foreign-settled", status: "completed", result: "done elsewhere" }]);
		expect(history[0]).not.toHaveProperty("handle");
		expect(registry).toEqual([]);
	});

	it("marks a dead foreign child failed in history without adopting it", async () => {
		const foreign = row("foreign-dead", { owner: { kind: "conversation", sessionId: "session-b" } });
		const { app, history, registry } = await makeApp({
			sessionId: "session-a",
			entries: [foreign],
			observers: { resourceAlive: () => false },
		});

		expect(app.manager.get("foreign-dead")).toBeUndefined();
		expect(history).toMatchObject([{ id: "foreign-dead", status: "error" }]);
		expect(registry).toEqual([]);
	});

	it("treats extension-owned rows as foreign", async () => {
		const extension = row("extension-run", { owner: { kind: "extension", id: "pi-tasks" }, delivery: "event" });
		const { app, registry } = await makeApp({ sessionId: "session-a", entries: [extension] });

		expect(app.manager.get("extension-run")).toBeUndefined();
		expect(registry.some((entry) => "id" in entry && entry.id === "extension-run")).toBe(true);
	});

	it("keeps retained foreign rows across this session's own registry rewrites", async () => {
		const foreign = row("foreign-live", { owner: { kind: "conversation", sessionId: "session-b" } });
		const { app, backend, registry } = await makeApp({ sessionId: "session-a", entries: [foreign] });

		// Settle one of this session's own runs; the rewrite must preserve the
		// untouched foreign row.
		const record = await app.manager.spawn({
			type: "explore",
			prompt: "own work",
			run_in_background: true,
		});
		await vi.waitFor(() => expect(app.manager.get(record.id)?.status).toBe("running"));
		backend.complete(record.id, "own result");
		await app.manager.waitForAll();

		expect(app.manager.get(record.id)?.status).toBe("completed");
		expect(registry.some((entry) => "id" in entry && entry.id === "foreign-live")).toBe(true);
		expect(registry.some((entry) => "id" in entry && entry.id === record.id)).toBe(false);
	});
});
