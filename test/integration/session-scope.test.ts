// Startup archives this session's stale receipts without inspecting foreign owners.

import { describe, expect, it, vi } from "vitest";
import { createPiSubagentsApp, type PiSubagentsApp } from "../../extension-src/pi-teams/app/index.js";
import type {
	AgentRegistryEntry,
	CompletedRunHistoryEntry,
	PersistedRegistryEntry,
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

async function makeApp(options: { sessionId: string; entries: readonly PersistedRegistryEntry[] }): Promise<{
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

describe("session-start registry cleanup", () => {
	it("archives stale owned rows while leaving foreign rows untouched", async () => {
		const own = row("own-run");
		const foreign = row("foreign-run", { owner: { kind: "conversation", sessionId: "session-b" } });
		const { app, registry, history } = await makeApp({ sessionId: "session-a", entries: [own, foreign] });
		expect(app.manager.get("own-run")).toBeUndefined();
		expect(app.manager.get("foreign-run")).toBeUndefined();
		expect(history).toMatchObject([{ id: "own-run", status: "stopped" }]);
		expect(registry.some((entry) => "id" in entry && entry.id === "foreign-run")).toBe(true);
		expect(app.manager.list().map((record) => record.id)).toEqual([]);
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
