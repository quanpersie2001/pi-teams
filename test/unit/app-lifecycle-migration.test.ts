import { describe, expect, it } from "vitest";
import { createPiSubagentsApp } from "../../extension-src/pi-teams/app/index.js";
import type { PersistedRegistryEntry, SubagentRunStore } from "../../extension-src/pi-teams/app/run-registry.js";
import type { TeamStore } from "../../extension-src/pi-teams/app/team-service.js";
import type { AgentExecutionBackend } from "../../extension-src/pi-teams/domain/backend.js";
import { DEFAULT_SUBAGENTS_SETTINGS } from "../../extension-src/pi-teams/domain/config.js";

const sessionId = "startup-legacy-session";

function makeStartup(
	registryRows: PersistedRegistryEntry[],
	disposePersisted = false,
	options: {
		rememberAgents?: boolean;
		failFenceWrite?: boolean;
		legacyRetired?: boolean;
		initialRoster?: unknown;
		beforeModel?: () => Promise<void>;
		beforeDispose?: () => Promise<boolean>;
	} = {},
) {
	let roster: unknown = JSON.parse(
		JSON.stringify(
			options.initialRoster ?? {
				version: 1,
				teamId: sessionId,
				sessionId,
				createdAt: 1,
				teamKey: "test-key",
				members: [
					{
						name: "worker",
						type: "general-purpose",
						membershipId: "legacy-M1",
						lifecycle: options.legacyRetired === false ? "released" : "retired",
					},
				],
			},
		),
	);
	let registryJson = JSON.stringify(registryRows);
	let historyJson = "[]";
	const runStore: SubagentRunStore = {
		readRegistry: () => JSON.parse(registryJson) as PersistedRegistryEntry[],
		writeRegistry: (next) => {
			registryJson = JSON.stringify(next);
		},
		readHistory: () => JSON.parse(historyJson) as ReturnType<SubagentRunStore["readHistory"]>,
		recordCompleted: (entry) => {
			historyJson = JSON.stringify([...JSON.parse(historyJson), entry]);
		},
	};
	let rosterWrites = 0;
	const teamStore: TeamStore = {
		teamDir: "/tmp/startup-legacy-team",
		readRoster: () => roster as ReturnType<TeamStore["readRoster"]>,
		writeRoster: (next) => {
			rosterWrites++;
			if (options.failFenceWrite && rosterWrites > 1) throw new Error("injected fence persistence failure");
			roster = JSON.parse(JSON.stringify(next));
		},
	};
	const backend = {
		kind: "process" as const,
		available: async () => true,
		prepareModel: async () => {
			await options.beforeModel?.();
			return { model: "test/model" };
		},
		launch: async () => {
			throw new Error("unexpected launch");
		},
		status: async () => ({ state: "completed" as const }),
		steer: async () => false,
		stop: async () => true,
		resume: async () => {
			throw new Error("unexpected resume");
		},
		readTranscript: async () => ({ items: [] }),
		subscribe: () => () => {},
		dispose: async () => {},
		detach: () => {},
		disposePersisted: async () => (options.beforeDispose ? options.beforeDispose() : disposePersisted),
	} as unknown as AgentExecutionBackend;
	const app = createPiSubagentsApp({
		sources: [],
		loader: async () => [],
		settings: {
			...DEFAULT_SUBAGENTS_SETTINGS,
			...(options.rememberAgents === undefined ? {} : { rememberAgents: options.rememberAgents }),
		},
		backends: [backend],
		cwd: "/tmp/project",
		configCwd: "/tmp/project",
		getSessionId: () => sessionId,
		runStore,
		createTeamStore: () => teamStore,
	});
	return { app, getRegistry: () => JSON.parse(registryJson) as PersistedRegistryEntry[], getRoster: () => roster };
}

function ownedReceipt(overrides: Record<string, unknown> = {}): PersistedRegistryEntry {
	return {
		id: "legacy-run",
		type: "general-purpose",
		description: "legacy owned child",
		teammateName: "worker",
		membershipId: "legacy-M1",
		status: "completed",
		backend: "process",
		handle: {
			kind: "process",
			childId: "child-legacy",
			socketPath: "/tmp/child.sock",
			token: "token",
			runDir: "/tmp/child-run",
			launcher: { kind: "headless", childId: "child-legacy", pid: 4321, identity: { ownerToken: "owner" } },
		},
		cwd: "/tmp/project",
		configCwd: "/tmp/project",
		owner: { kind: "conversation", sessionId },
		delivery: "conversation",
		startedAt: 1,
		sessionFile: "/tmp/legacy-session.jsonl",
		...overrides,
	} as PersistedRegistryEntry;
}

async function expectStartupFence(app: ReturnType<typeof makeStartup>["app"]) {
	await app.sessionStart();
	expect(app.teams?.current?.members).toMatchObject([
		{
			name: "worker",
			membershipId: "legacy-M1",
			lifecycle: "released",
			availability: "unavailable",
			recoveryFence: "legacy-retired-unverified",
		},
	]);
	await expect(app.manager.releaseTeammate("worker")).rejects.toThrow(/recovery fence/);
	await expect(
		app.manager.spawn({ type: "general-purpose", name: "worker", context: "fresh", prompt: "must remain blocked" }),
	).rejects.toThrow(/unresolved cleanup ownership/);
	await expect(app.manager.shutdownTeammate("worker")).rejects.toThrow();
	await expect(
		app.manager.spawn({ type: "general-purpose", name: "worker", context: "fresh", prompt: "must remain blocked" }),
	).rejects.toThrow(/shutting down/);
	expect(app.teams?.current?.members).toMatchObject([
		{ name: "worker", membershipId: "legacy-M1", recoveryFence: "legacy-retired-unverified" },
	]);
	await app.manager.dispose();
}

describe("startup legacy lifecycle recovery", () => {
	it("keeps a failed-disposal legacy receipt fenced through migration, release, shutdown, and alias reuse", async () => {
		const { app, getRegistry } = makeStartup([ownedReceipt()]);
		await app.sessionStart();
		expect(getRegistry()).toMatchObject([
			{ id: "legacy-run", membershipId: "legacy-M1", recoveryError: expect.any(String) },
		]);
		await expect(app.manager.resume("legacy-run", "resume fenced identity")).rejects.toThrow(
			/fenced teammate membership/,
		);
		await expect(app.manager.releaseTeammate("worker")).rejects.toThrow(/recovery fence/);
		await expect(
			app.manager.spawn({
				type: "general-purpose",
				name: "worker",
				context: "fresh",
				prompt: "must stay blocked after release",
			}),
		).rejects.toThrow(/unresolved cleanup ownership/);
		await expect(app.manager.shutdownTeammate("worker")).rejects.toThrow(/verify disposal/);
		await expect(
			app.manager.spawn({
				type: "general-purpose",
				name: "worker",
				context: "fresh",
				prompt: "must stay blocked after failed shutdown",
			}),
		).rejects.toThrow(/shutting down/);
		expect(app.teams?.current?.members).toMatchObject([
			{ name: "worker", membershipId: "legacy-M1", recoveryFence: "legacy-retired-unverified" },
		]);
		await app.manager.dispose();
	});

	it("archives a legacy identity only after startup verifies disposal of its correlated receipt", async () => {
		const { app, getRegistry } = makeStartup([ownedReceipt()], true);
		await app.sessionStart();
		expect(app.teams?.current?.members).toEqual([]);
		expect(app.teams?.current?.archivedMembers).toMatchObject([
			{ name: "worker", membershipId: "legacy-M1", lifecycle: "released" },
		]);
		expect(app.teams?.current?.archivedMembers?.[0]).not.toHaveProperty("recoveryFence");
		expect(getRegistry()).toEqual([]);
		await app.manager.dispose();
	});

	it("does not treat one verified receipt as proof when another same-name legacy receipt is uncorrelated", async () => {
		const { app, getRegistry } = makeStartup(
			[ownedReceipt(), ownedReceipt({ id: "legacy-no-id", membershipId: undefined, handle: undefined })],
			true,
		);
		await app.sessionStart();
		expect(app.teams?.current?.members).toMatchObject([
			{ name: "worker", membershipId: "legacy-M1", recoveryFence: "legacy-retired-unverified" },
		]);
		expect(app.teams?.current?.archivedMembers).toBeUndefined();
		expect(getRegistry()).toMatchObject([{ id: "legacy-no-id", recoveryError: expect.any(String) }]);
		await app.manager.dispose();
	});

	it("keeps an exact-ID receipt with a conflicting name unresolved despite another disposed receipt", async () => {
		const { app, getRegistry } = makeStartup(
			[
				ownedReceipt(),
				ownedReceipt({ id: "conflicting-name", teammateName: "not-worker", handle: undefined }),
				ownedReceipt({ id: "missing-name", teammateName: undefined, handle: undefined }),
			],
			true,
		);
		await app.sessionStart();
		expect(app.teams?.current?.members).toMatchObject([
			{ name: "worker", membershipId: "legacy-M1", recoveryFence: "legacy-retired-unverified" },
		]);
		expect(app.teams?.current?.archivedMembers).toBeUndefined();
		expect(getRegistry()).toMatchObject([
			{ id: "conflicting-name", recoveryError: expect.stringContaining("name conflict") },
			{ id: "missing-name", recoveryError: expect.stringContaining("name conflict") },
		]);
		await app.manager.dispose();
	});

	it("invalidates an in-flight model admission when startup cannot persist a required fence", async () => {
		let markModelStarted!: () => void;
		let markDisposeStarted!: () => void;
		let releaseModel!: () => void;
		let releaseDispose!: (result: boolean) => void;
		const modelStarted = new Promise<void>((resolve) => {
			markModelStarted = resolve;
		});
		const disposeStarted = new Promise<void>((resolve) => {
			markDisposeStarted = resolve;
		});
		const modelGate = new Promise<void>((resolve) => {
			releaseModel = resolve;
		});
		const disposeGate = new Promise<boolean>((resolve) => {
			releaseDispose = resolve;
		});
		const { app } = makeStartup([ownedReceipt()], false, {
			legacyRetired: false,
			failFenceWrite: true,
			beforeModel: async () => {
				markModelStarted();
				await modelGate;
			},
			beforeDispose: async () => {
				markDisposeStarted();
				return disposeGate;
			},
		});
		const starting = app.sessionStart();
		await disposeStarted;
		const spawn = app.manager.spawn({
			type: "general-purpose",
			name: "worker",
			context: "fresh",
			prompt: "blocked in flight",
		});
		await modelStarted;
		releaseDispose(false);
		await expect(starting).rejects.toThrow(/Could not persist cleanup fence/);
		releaseModel();
		await expect(spawn).rejects.toThrow(/Agent admission is blocked|session changed during admission/);
		expect(app.manager.list()).toEqual([]);
		await app.manager.dispose();
	});

	it("blocks admissions when startup cannot persist a required receipt fence", async () => {
		const { app } = makeStartup([ownedReceipt({ handle: undefined })], false, {
			legacyRetired: false,
			failFenceWrite: true,
		});
		await expect(app.sessionStart()).rejects.toThrow(/Could not persist cleanup fence/);
		await expect(
			app.manager.spawn({ type: "general-purpose", name: "worker", context: "fresh", prompt: "must not admit" }),
		).rejects.toThrow(/Agent admission is blocked/);
		await app.manager.dispose();
	});

	it("persists verified cleanup proof for rememberAgents=false across restart and manager registry sync", async () => {
		const first = makeStartup([ownedReceipt()], true, { rememberAgents: false, legacyRetired: false });
		await first.app.sessionStart();
		expect(first.getRegistry()).toMatchObject([
			{
				id: "legacy-run",
				cleanupProof: {
					kind: "verified-process-disposal",
					runId: "legacy-run",
					membershipId: "legacy-M1",
					verifiedAt: expect.any(Number),
				},
			},
		]);
		expect(first.getRegistry()[0]).not.toHaveProperty("handle");
		await first.app.manager.dispose(); // syncRegistry must preserve the proof-bearing history row.

		const second = makeStartup(first.getRegistry(), true, {
			rememberAgents: false,
			legacyRetired: false,
			initialRoster: first.getRoster(),
		});
		await second.app.sessionStart();
		expect(second.app.teams?.current?.members).toMatchObject([{ name: "worker", lifecycle: "released" }]);
		expect(second.app.teams?.current?.members[0]).not.toHaveProperty("recoveryFence");
		await expect(second.app.manager.shutdownTeammate("worker")).resolves.toBe(true);
		expect(second.app.teams?.current?.members).toEqual([]);
		await second.app.manager.dispose();
	});

	it("keeps unresolved handle-less cleanup fenced across a second startup", async () => {
		const first = makeStartup([ownedReceipt({ handle: undefined })]);
		await first.app.sessionStart();
		const persistedRegistry = first.getRegistry();
		const persistedRoster = first.getRoster();
		expect(persistedRegistry).toMatchObject([{ id: "legacy-run", recoveryError: expect.any(String) }]);
		await first.app.manager.dispose();

		const second = makeStartup(persistedRegistry, false, { initialRoster: persistedRoster });
		await expectStartupFence(second.app);
	});

	it("treats an incompatible startup receipt as unresolved ownership, not cleanup proof", async () => {
		await expectStartupFence(makeStartup([{ kind: "incompatible", raw: { version: 999 }, reason: "unsupported" }]).app);
	});
});
