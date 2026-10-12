import { describe, expect, it, vi } from "vitest";
import { AgentManager } from "../../extension-src/pi-teams/app/agent-manager.js";
import { AgentRegistry } from "../../extension-src/pi-teams/app/agent-registry.js";
import type {
	CompletedRunHistoryEntry,
	PersistedRegistryEntry,
	SubagentRunStore,
} from "../../extension-src/pi-teams/app/run-registry.js";
import { TeamService } from "../../extension-src/pi-teams/app/team-service.js";
import { sanitizeSettings } from "../../extension-src/pi-teams/domain/config.js";
import { FakeBackend } from "../helpers/fake-backend.js";

async function fixture() {
	const settings = sanitizeSettings({ worktreeIsolation: false });
	const backend = new FakeBackend();
	const registry = new AgentRegistry({ sources: [], loader: async () => [], settings });
	await registry.load();
	let entries: PersistedRegistryEntry[] = [];
	const history: CompletedRunHistoryEntry[] = [];
	const store: SubagentRunStore = {
		readRegistry: () => entries,
		writeRegistry: (rows) => {
			entries = [...rows];
		},
		readHistory: () => history,
		recordCompleted: (row) => {
			history.push(row);
		},
	};
	const manager = new AgentManager({
		registry,
		settings,
		backends: [backend],
		cwd: "/tmp/project",
		configCwd: "/tmp/project",
		registryStore: store,
		teardownGraceMs: 0,
	});
	return { manager, backend, history, store };
}

describe("teammate recovery boundaries", () => {
	it("fails shutdown and blocks session replacement until child termination is verified", async () => {
		const { manager, backend } = await fixture();
		const run = await manager.spawn({ type: "general-purpose", prompt: "work" });
		await vi.waitFor(() => expect(manager.get(run.id)?.status).toBe("running"));
		backend.enforceTerminateError = new Error("ownership uncertain");
		await expect(manager.shutdownSession()).rejects.toThrow(/shutdown incomplete/);
		expect(manager.get(run.id)?.status).toBe("running");
		expect(() => manager.beginSession()).toThrow(/cleanup is unconfirmed/);
		expect(backend.detachedHandles).toEqual([]);
		backend.enforceTerminateError = undefined;
		await manager.shutdownSession();
		manager.beginSession();
		await manager.dispose();
	});

	it("blocks cold resume of history with unverified stale child cleanup", async () => {
		const { manager, backend, history } = await fixture();
		const run = await manager.spawn({ type: "general-purpose", prompt: "work" });
		await vi.waitFor(() => expect(manager.get(run.id)?.status).toBe("running"));
		backend.complete(run.id, "done");
		await manager.whenSettled(run.id);
		const saved = history[0];
		if (!saved) throw new Error("missing history");
		history.push({ ...saved, id: "historical-uncertain", recoveryError: "verified disposal could not be confirmed" });
		await expect(manager.resume("historical-uncertain", "continue")).rejects.toThrow(/cleanup is unconfirmed/);
		expect(backend.resumes).toEqual([]);
		await manager.dispose();
	});

	it("archives pending messages before named cold resume", async () => {
		const { manager, backend } = await fixture();
		const discard = vi.fn();
		const team = new TeamService({
			sessionId: "recovery",
			store: { teamDir: "/tmp/team", readRoster: () => undefined, writeRoster: () => {} },
			discardPending: discard,
		});
		team.sessionStart();
		manager.setTeamService(team);
		const run = await manager.spawn({ type: "general-purpose", name: "worker", prompt: "work" });
		await vi.waitFor(() => expect(manager.get(run.id)?.status).toBe("running"));
		backend.complete(run.id, "done", "/tmp/worker-session.jsonl");
		await manager.whenSettled(run.id);
		await manager.releaseTeammate("worker");
		discard.mockClear();
		const resumed = await manager.resume(run.id, "continue saved history");
		expect(discard).toHaveBeenCalledWith("worker", "context-reset");
		await vi.waitFor(() => expect(manager.get(resumed.id)?.status).toBe("running"));
		backend.complete(resumed.id, "done");
		await manager.whenSettled(resumed.id);
		await manager.dispose();
	});
});
