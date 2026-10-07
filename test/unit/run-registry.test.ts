// Unit: durable registry/history file I/O (pi/registry-host.ts).
// Real fs against temp dirs — roundtrip, corrupt tolerance, atomicity.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRegistryEntry, CompletedRunHistoryEntry } from "../../extension-src/pi-teams/app/run-registry.js";
import {
	coerceRegistryEntry,
	isIncompatibleRegistryEntry,
	isSerializableBackendHandle,
} from "../../extension-src/pi-teams/app/run-registry.js";
import {
	createSubagentRunStore,
	historyFilePath,
	registryFilePath,
} from "../../extension-src/pi-teams/pi/registry-host.js";

const tempRoots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

async function makeProject(): Promise<{ root: string; cwd: string; piDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-teams-registry-"));
	tempRoots.push(root);
	mkdirSync(join(root, ".pi"), { recursive: true });
	const cwd = join(root, "work");
	mkdirSync(cwd);
	return { root, cwd, piDir: join(root, ".pi") };
}

function entry(overrides: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
	return {
		id: "run-1",
		type: "explore",
		description: "explore",
		status: "running",
		backend: "process",
		handle: {
			kind: "process",
			childId: "child-1",
			socketPath: "/tmp/teams/child-1.sock",
			token: "opaque-test-token",
			runDir: "/proj/.pi/teams/sessions/child-1",
			launcher: {
				kind: "headless",
				childId: "child-1",
				pid: 4312,
				identity: { startTime: "now", ownerToken: "owner-1" },
			},
		},
		sessionFile: "/proj/.pi/teams/sessions/run-1/agent-run-explore-run1.jsonl",
		cwd: "/proj/work",
		configCwd: "/proj",
		owner: { kind: "conversation", sessionId: "sess-1" },
		delivery: "conversation",
		startedAt: 1000,
		...overrides,
	};
}

describe("registry roundtrip", () => {
	it("writes and reads entries at .pi/teams/registry.json", async () => {
		const project = await makeProject();
		const store = createSubagentRunStore(project.cwd);
		store.writeRegistry([entry(), entry({ id: "run-2", status: "running" })]);

		expect(registryFilePath(project.cwd)).toBe(join(project.piDir, "teams", "registry.json"));
		expect(store.readRegistry()).toHaveLength(2);
		expect(store.readRegistry()[0]).toMatchObject({ id: "run-1", status: "running" });
	});

	it("write is idempotent: rewriting with the same content yields the same file", async () => {
		const project = await makeProject();
		const store = createSubagentRunStore(project.cwd);
		const rows = [entry()];
		store.writeRegistry(rows);
		const first = readFileSync(registryFilePath(project.cwd), "utf8");
		store.writeRegistry(rows);
		expect(readFileSync(registryFilePath(project.cwd), "utf8")).toBe(first);
	});

	it("leaves no tmp marker behind after an atomic write", async () => {
		const project = await makeProject();
		const store = createSubagentRunStore(project.cwd);
		store.writeRegistry([entry()]);

		expect(existsSync(`${registryFilePath(project.cwd)}.${process.pid}.tmp`)).toBe(false);
	});
});

describe("fail-closed registry persistence", () => {
	it("preserves corrupt registry bytes instead of rewriting the file", async () => {
		const project = await makeProject();
		mkdirSync(join(project.piDir, "teams"), { recursive: true });
		const original = "{ this is not json";
		writeFileSync(registryFilePath(project.cwd), original, "utf8");

		const store = createSubagentRunStore(project.cwd);
		expect(() => store.readRegistry()).toThrow();
		expect(readFileSync(registryFilePath(project.cwd), "utf8")).toBe(original);
	});

	it("preserves non-array registry bytes instead of rewriting the file", async () => {
		const project = await makeProject();
		mkdirSync(join(project.piDir, "teams"), { recursive: true });
		const original = JSON.stringify({ oops: true });
		writeFileSync(registryFilePath(project.cwd), original, "utf8");

		expect(() => createSubagentRunStore(project.cwd).readRegistry()).toThrow();
		expect(readFileSync(registryFilePath(project.cwd), "utf8")).toBe(original);
	});

	it("retains incompatible rows without adopting or dropping their raw data", async () => {
		const project = await makeProject();
		mkdirSync(join(project.piDir, "teams"), { recursive: true });
		const rawRows = [entry(), { nope: true }, "junk"];
		writeFileSync(registryFilePath(project.cwd), JSON.stringify(rawRows), "utf8");

		const store = createSubagentRunStore(project.cwd);
		const rows = store.readRegistry();
		expect(rows).toHaveLength(3);
		expect(rows[0]).toMatchObject({ id: "run-1" });
		const incompatibleObject = rows[1];
		const incompatibleString = rows[2];
		if (!incompatibleObject || !incompatibleString) throw new Error("expected both incompatible registry rows");
		expect(isIncompatibleRegistryEntry(incompatibleObject)).toBe(true);
		expect(incompatibleObject).toMatchObject({ kind: "incompatible", raw: { nope: true } });
		expect(isIncompatibleRegistryEntry(incompatibleString)).toBe(true);
		expect(incompatibleString).toMatchObject({ kind: "incompatible", raw: "junk" });
		store.writeRegistry(rows);
		expect(store.readRegistry()).toEqual(rows);
	});
});

describe("history upsert", () => {
	it("records completed runs into history.json, deduplicating by id", async () => {
		const project = await makeProject();
		const store = createSubagentRunStore(project.cwd);
		const completed: CompletedRunHistoryEntry = {
			...entry(),
			status: "completed",
			completedAt: 2000,
			result: "all done",
			isBackground: true,
		};

		store.recordCompleted(completed);
		store.recordCompleted({ ...completed, result: "updated after retry" });

		expect(historyFilePath(project.cwd)).toBe(join(project.piDir, "teams", "history.json"));
		const history = store.readHistory();
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({ id: "run-1", completedAt: 2000, result: "updated after retry" });
		expect(history[0]).not.toHaveProperty("handle");
	});

	it("tolerates a missing history file", async () => {
		const project = await makeProject();
		expect(createSubagentRunStore(project.cwd).readHistory()).toEqual([]);
	});

	it("skips history rows without completedAt", async () => {
		const project = await makeProject();
		mkdirSync(join(project.piDir, "teams"), { recursive: true });
		writeFileSync(historyFilePath(project.cwd), JSON.stringify([{ id: "x" }]), "utf8");
		vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(createSubagentRunStore(project.cwd).readHistory()).toEqual([]);
	});
});

describe("process handle serialization", () => {
	it("roundtrips durable process identity and rejects legacy backend handles", async () => {
		const project = await makeProject();
		const store = createSubagentRunStore(project.cwd);
		const processEntry = entry();
		expect(isSerializableBackendHandle(processEntry.handle)).toBe(true);

		store.writeRegistry([processEntry]);
		const read = store.readRegistry();
		expect(read).toHaveLength(1);
		expect(read[0]).toMatchObject({
			id: "run-1",
			backend: "process",
			handle: processEntry.handle,
		});
		expect(coerceRegistryEntry(read[0])).toMatchObject(processEntry);

		const legacyEntry = {
			...processEntry,
			backend: "terminal",
			handle: { kind: "tmux", paneId: "%9" },
		};
		expect(isSerializableBackendHandle(legacyEntry.handle)).toBe(false);
		const incompatible = coerceRegistryEntry(legacyEntry);
		expect(isIncompatibleRegistryEntry(incompatible)).toBe(true);
		expect(incompatible).toMatchObject({ kind: "incompatible", raw: legacyEntry });

		store.writeRegistry([processEntry, incompatible]);
		expect(store.readRegistry()).toEqual([processEntry, incompatible]);
	});
});

describe("time budget durability", () => {
	it("round-trips frozen budgets, clocks and exhaustion through registry and history", async () => {
		const project = await makeProject();
		const store = createSubagentRunStore(project.cwd);
		const row = entry({
			status: "stopped",
			budgetTimeout: 60,
			budgetIdleTimeout: 0,
			budgetStartedAt: 5_000,
			budgetLastOutputAt: 12_345,
			budgetExhausted: "idle_timeout",
			budgetSeconds: 30,
		});
		store.writeRegistry([row]);

		const reloaded = store.readRegistry()[0];
		expect(reloaded).toMatchObject({
			id: "run-1",
			budgetTimeout: 60,
			budgetIdleTimeout: 0,
			budgetStartedAt: 5_000,
			budgetLastOutputAt: 12_345,
			budgetExhausted: "idle_timeout",
			budgetSeconds: 30,
		});
		expect(isIncompatibleRegistryEntry(coerceRegistryEntry(reloaded))).toBe(false);

		const { handle: _dropped, ...withoutHandle } = row;
		store.recordCompleted({ ...withoutHandle, completedAt: 99_999 });
		const history = store.readHistory()[0];
		expect(history).toMatchObject({
			id: "run-1",
			budgetTimeout: 60,
			budgetIdleTimeout: 0,
			budgetExhausted: "idle_timeout",
			budgetSeconds: 30,
			completedAt: 99_999,
		});
	});

	it("cold rows keep explicit unlimited (0) distinct from absent legacy budgets", async () => {
		const project = await makeProject();
		const store = createSubagentRunStore(project.cwd);
		store.writeRegistry([entry({ budgetTimeout: 0, budgetIdleTimeout: 0 })]);
		const zeroed = store.readRegistry()[0];
		expect(zeroed?.budgetTimeout).toBe(0);
		expect(zeroed?.budgetIdleTimeout).toBe(0);
		expect(zeroed?.budgetExhausted).toBeUndefined();

		const legacy = coerceRegistryEntry(JSON.parse(JSON.stringify(entry())));
		expect(isIncompatibleRegistryEntry(legacy)).toBe(false);
		if (!isIncompatibleRegistryEntry(legacy)) {
			expect(legacy.budgetTimeout).toBeUndefined();
			expect(legacy.budgetIdleTimeout).toBeUndefined();
		}
	});
});
