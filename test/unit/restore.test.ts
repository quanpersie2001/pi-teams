// Process restore decision table and reconciliation; no launcher liveness or JSONL text is execution authority.

import { describe, expect, it } from "vitest";
import {
	decideRestore,
	partitionOwnedEntries,
	type RestoreDeps,
	type RestoreObservation,
	restoreRegisteredRuns,
} from "../../extension-src/pi-teams/app/restore.js";
import type {
	AgentRegistryEntry,
	PersistedRegistryEntry,
	RestoreCompletionObservation,
} from "../../extension-src/pi-teams/app/run-registry.js";

function entry(overrides: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
	return {
		id: "run-1",
		type: "explore",
		description: "explore the codebase",
		status: "running",
		backend: "process",
		handle: {
			kind: "process",
			childId: "child-1",
			socketPath: "/tmp/pi-teams/child-1.sock",
			token: "opaque-test-token",
			runDir: "/proj/.pi/teams/sessions/child-1",
			launcher: { kind: "headless", childId: "child-1", pid: 4312, identity: { ownerToken: "owner-1" } },
		},
		cwd: "/proj/work",
		configCwd: "/proj",
		owner: { kind: "conversation", sessionId: "sess-1" },
		delivery: "conversation",
		startedAt: 1000,
		...overrides,
	};
}

function observation(overrides: Partial<RestoreObservation> = {}): RestoreObservation {
	return {
		completion: { finished: false },
		...overrides,
	};
}

interface DepsHarness {
	deps: RestoreDeps;
	warnings: string[];
	history: AgentRegistryEntry[];
	persists: PersistedRegistryEntry[][];
	reconnects: string[];
	disposals: string[];
	resourceAlive: boolean | undefined;
	completion: RestoreCompletionObservation;
	reconnectResult: "retained" | "closed" | "deferred";
	disposalResult: boolean | Error;
}

function makeDeps(overrides: Partial<DepsHarness> = {}): DepsHarness {
	const harness: DepsHarness = {
		warnings: [],
		history: [],
		persists: [],
		reconnects: [],
		disposals: [],
		resourceAlive: "resourceAlive" in overrides ? overrides.resourceAlive : true,
		completion: overrides.completion ?? { finished: false },
		reconnectResult: overrides.reconnectResult ?? "retained",
		disposalResult: overrides.disposalResult ?? true,
		deps: undefined as unknown as RestoreDeps,
	};
	harness.deps = {
		sessionPresent: () => true,
		detectCompletion: () => harness.completion,
		resourceAlive: () => harness.resourceAlive,
		reconnect: (row) => {
			harness.reconnects.push(row.id);
			const state = harness.reconnectResult;
			return state === "retained" ? { state, entry: row } : { state };
		},
		disposeOrphan: (row) => {
			harness.disposals.push(row.id);
			if (harness.disposalResult instanceof Error) throw harness.disposalResult;
			return harness.disposalResult;
		},
		recordCompleted: (row) => harness.history.push(row),
		persist: (rows) => harness.persists.push([...rows]),
		rememberAgents: true,
		warn: (message) => harness.warnings.push(message),
		now: () => 5000,
	};
	return harness;
}

describe("decideRestore for process children", () => {
	it("archives leftover active rows as orphan-stopped — never re-adopts (ADR 0007)", () => {
		expect(decideRestore(entry(), observation())).toEqual({ action: "orphan-stopped" });
	});

	it("uses a settled child RPC outcome before launcher liveness", () => {
		expect(
			decideRestore(entry(), observation({ completion: { finished: true, outcome: "completed", result: "done" } })),
		).toEqual({ action: "completed", outcome: "completed" });
	});

	it("preserves the child-reported failed and stopped outcomes", () => {
		expect(decideRestore(entry(), observation({ completion: { finished: true, outcome: "failed" } }))).toEqual({
			action: "completed",
			outcome: "failed",
		});
		expect(decideRestore(entry(), observation({ completion: { finished: true, outcome: "stopped" } }))).toEqual({
			action: "completed",
			outcome: "stopped",
		});
	});

	it("defers rows without a process control identity", () => {
		expect(decideRestore(entry({ handle: undefined }), observation())).toEqual({
			action: "defer",
			reason: "process control identity is unavailable",
		});
	});

	it("recovers persisted terminal rows after an interrupted history write", () => {
		expect(decideRestore(entry({ status: "completed" }), observation())).toEqual({
			action: "recover-terminal",
		});
	});
});

describe("restoreRegisteredRuns process reconciliation", () => {
	it("records native completion and removes the registry row after manager confirms child closure", async () => {
		const row = entry();
		const harness = makeDeps({
			completion: { finished: true, outcome: "completed", result: "done text" },
			reconnectResult: "closed",
		});

		const summary = await restoreRegisteredRuns([row], harness.deps);

		expect(summary.completed).toEqual(["run-1"]);
		expect(harness.history).toMatchObject([{ id: "run-1", status: "completed", result: "done text" }]);
		expect(harness.history[0]).not.toHaveProperty("handle");
		expect(harness.reconnects).toEqual(["run-1"]);
		expect(harness.persists.at(-1)).toEqual([]);
	});

	it("retains the process receipt when manager cleanup fails after native completion", async () => {
		const row = entry();
		const harness = makeDeps({ completion: { finished: true, outcome: "completed", result: "done text" } });

		const summary = await restoreRegisteredRuns([row], harness.deps);

		expect(summary.completed).toEqual(["run-1"]);
		expect(harness.persists.at(-1)).toEqual([row]);
	});

	it("archives leftover active rows stopped with verified disposal, without re-adopting", async () => {
		const row = entry();
		const harness = makeDeps({ resourceAlive: undefined });

		const summary = await restoreRegisteredRuns([row], harness.deps);

		expect(summary.orphaned).toEqual(["run-1"]);
		expect(harness.disposals).toEqual(["run-1"]);
		expect(harness.reconnects).toEqual([]);
		expect(harness.history).toMatchObject([{ id: "run-1", status: "stopped", completedAt: 5000 }]);
		expect(harness.history[0]?.recoveryError).toMatch(/never re-adopted/);
		expect(harness.history[0]).not.toHaveProperty("handle");
		expect(harness.persists.at(-1)).toEqual([]);
	});

	it("archives a dead leftover process stopped instead of inventing an error outcome", async () => {
		const row = entry();
		const harness = makeDeps({ resourceAlive: false });

		const summary = await restoreRegisteredRuns([row], harness.deps);

		expect(summary.orphaned).toEqual(["run-1"]);
		expect(harness.history).toMatchObject([{ id: "run-1", status: "stopped" }]);
		expect(harness.persists.at(-1)).toEqual([]);
	});

	it("retains the resource receipt when verified disposal fails", async () => {
		const row = entry();
		const harness = makeDeps({ disposalResult: new Error("identity mismatch") });

		const summary = await restoreRegisteredRuns([row], harness.deps);

		expect(summary.orphaned).toEqual(["run-1"]);
		expect(summary.deferred).toEqual(["run-1"]);
		expect(harness.history[0]?.recoveryError).toMatch(/verified disposal failed: identity mismatch/);
		expect(harness.persists.at(-1)).toEqual([row]);
	});

	it("keeps settled process rows when rememberAgents is disabled; active rows still archive stopped", async () => {
		const completedRow = entry({ id: "done-row", status: "completed" });
		const activeRow = entry({ id: "live-row" });
		const harness = makeDeps();
		harness.deps.rememberAgents = false;

		const summary = await restoreRegisteredRuns([completedRow, activeRow], harness.deps);

		expect(summary.skippedByRememberAgents).toEqual(["done-row"]);
		expect(summary.orphaned).toEqual(["live-row"]);
		expect(harness.persists.at(-1)).toEqual([completedRow]);
	});
});

describe("partitionOwnedEntries", () => {
	const ownRow = entry({ id: "own", owner: { kind: "conversation", sessionId: "sess-a" } });
	const otherConversation = entry({
		id: "other",
		owner: { kind: "conversation", sessionId: "sess-b" },
	});
	const extensionRow = entry({ id: "ext", owner: { kind: "extension", id: "pi-tasks" }, delivery: "event" });
	const incompatible: PersistedRegistryEntry = { kind: "incompatible", raw: { junk: true }, reason: "legacy" };
	const isOwnSessionA = (candidate: AgentRegistryEntry) =>
		candidate.owner.kind === "conversation" && candidate.owner.sessionId === "sess-a";

	it("splits rows into owned, incompatible and foreign by conversation owner", () => {
		const partitioned = partitionOwnedEntries([ownRow, otherConversation, extensionRow, incompatible], isOwnSessionA);

		expect(partitioned.owned).toEqual([ownRow]);
		expect(partitioned.foreign.map((candidate) => candidate.id)).toEqual(["other", "ext"]);
		expect(partitioned.incompatible).toEqual([incompatible]);
	});

	it("returns every row as foreign when no owner matches", () => {
		const partitioned = partitionOwnedEntries([ownRow, otherConversation], () => false);

		expect(partitioned.owned).toEqual([]);
		expect(partitioned.foreign).toEqual([ownRow, otherConversation]);
	});
});
