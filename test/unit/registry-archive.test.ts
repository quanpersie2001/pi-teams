import { describe, expect, it } from "vitest";
import { archiveRegistryRuns, partitionOwnedEntries } from "../../extension-src/pi-teams/app/registry-archive.js";
import type { AgentRegistryEntry, PersistedRegistryEntry } from "../../extension-src/pi-teams/app/run-registry.js";

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

describe("archiveRegistryRuns", () => {
	it("archives stale active receipts as stopped and attempts disposal without retaining live rows", async () => {
		const row = entry();
		const history: AgentRegistryEntry[] = [];
		const persisted: PersistedRegistryEntry[][] = [];
		const disposed: AgentRegistryEntry[] = [];
		await archiveRegistryRuns([row], {
			dispose: (candidate) => {
				disposed.push(candidate);
				return false;
			},
			recordCompleted: (candidate) => history.push(candidate),
			persist: (rows) => persisted.push([...rows]),
			rememberAgents: true,
			warn: () => {},
			now: () => 5000,
		});
		expect(disposed).toEqual([row]);
		expect(history).toMatchObject([
			{
				id: "run-1",
				status: "stopped",
				completedAt: 5000,
				recoveryError: expect.stringContaining("could not be confirmed"),
			},
		]);
		expect(history[0]).not.toHaveProperty("handle");
		expect(persisted).toEqual([[]]);
	});

	it("keeps terminal history and preserves incompatible rows byte-for-value", async () => {
		const terminal = entry({ status: "completed", completedAt: 4000, result: "finished" });
		const incompatible: PersistedRegistryEntry = {
			kind: "incompatible",
			raw: { id: "legacy", junk: true },
			reason: "legacy",
		};
		const history: AgentRegistryEntry[] = [];
		const persisted: PersistedRegistryEntry[][] = [];
		await archiveRegistryRuns([terminal, incompatible], {
			dispose: () => false,
			recordCompleted: (candidate) => history.push(candidate),
			persist: (rows) => persisted.push([...rows]),
			rememberAgents: true,
			warn: () => {},
			now: () => 5000,
		});
		expect(history).toMatchObject([
			{ id: "run-1", status: "completed", result: "finished", recoveryError: expect.any(String) },
		]);
		expect(history[0]).not.toHaveProperty("handle");
		expect(persisted).toEqual([[incompatible]]);
	});
});

describe("partitionOwnedEntries", () => {
	it("splits by conversation owner and retains incompatible rows", () => {
		const own = entry({ id: "own", owner: { kind: "conversation", sessionId: "sess-a" } });
		const foreign = entry({ id: "foreign", owner: { kind: "conversation", sessionId: "sess-b" } });
		const incompatible: PersistedRegistryEntry = { kind: "incompatible", raw: { junk: true }, reason: "legacy" };
		const partitioned = partitionOwnedEntries(
			[own, foreign, incompatible],
			(candidate) => candidate.owner.kind === "conversation" && candidate.owner.sessionId === "sess-a",
		);
		expect(partitioned.owned).toEqual([own]);
		expect(partitioned.foreign).toEqual([foreign]);
		expect(partitioned.incompatible).toEqual([incompatible]);
	});
});
