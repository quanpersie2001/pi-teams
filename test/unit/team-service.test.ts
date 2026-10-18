// TeamService roster lifecycle + fs-backed team store (ADR 0007 §2).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TeamRosterReadError, TeamService, type TeamStore } from "../../extension-src/pi-teams/app/team-service.js";
import { teamsArtifactDir } from "../../extension-src/pi-teams/pi/registry-host.js";
import { createPiTeamStore, teamDirFor } from "../../extension-src/pi-teams/pi/teams-host.js";

function memoryStore(): TeamStore & { written: unknown[] } {
	const written: unknown[] = [];
	let current: string | undefined;
	return {
		teamDir: "/tmp/teams/t/sess",
		written,
		readRoster: () => (current === undefined ? undefined : (JSON.parse(current) as unknown)),
		writeRoster: (roster) => {
			current = JSON.stringify(roster);
			written.push(roster);
		},
	};
}

describe("TeamService", () => {
	it("creates the roster once and reuses it across session starts", () => {
		const store = memoryStore();
		const service = new TeamService({ sessionId: "sess-a", store, now: () => 5 });
		const first = service.sessionStart();
		expect(first).toMatchObject({ teamId: "sess-a", sessionId: "sess-a", createdAt: 5, members: [] });
		expect(service.sessionStart()).toBe(first);
		expect(store.written).toHaveLength(1);
	});

	it("does not restore persisted busy or idle members as live teammates", () => {
		const store = memoryStore();
		const original = new TeamService({ sessionId: "sess-a", store });
		original.sessionStart();
		original.recordAssignment({ name: "scout", type: "scout", runId: "run-1" });
		original.setLifecycle("scout", "busy");
		original.recordAssignment({ name: "retired", type: "scout", runId: "run-2" });
		const legacyRoster = original.current;
		if (!legacyRoster) throw new Error("Team roster was not initialized.");
		const legacyStore: TeamStore = {
			teamDir: store.teamDir,
			readRoster: () => ({
				...legacyRoster,
				members: legacyRoster.members.map((member) =>
					member.name === "retired" ? ({ ...member, lifecycle: "retired" } as never) : member,
				),
			}),
			writeRoster: (roster) => {
				store.written.push(roster);
			},
		};
		const migrated = new TeamService({ sessionId: "sess-a", store: legacyStore }).sessionStart();
		expect(migrated.members).toMatchObject([
			{ name: "scout", lifecycle: "released" },
			{
				name: "retired",
				lifecycle: "released",
				availability: "unavailable",
				recoveryFence: "legacy-retired-unverified",
			},
		]);
		expect(migrated.archivedMembers).toBeUndefined();
		expect(JSON.stringify(migrated)).not.toContain('"lifecycle":"retired"');
	});

	it("keeps legacy retired identities fenced when cleanup ownership is unresolved", () => {
		const base = {
			version: 1 as const,
			teamId: "sess-a",
			sessionId: "sess-a",
			createdAt: 1,
			teamKey: "key",
			members: [
				{
					name: "orphan",
					type: "scout",
					membershipId: "legacy-id",
					lifecycle: "retired",
					availability: "unavailable" as const,
				},
			],
		};
		let saved: unknown = base;
		const store: TeamStore = {
			teamDir: "/tmp/legacy",
			readRoster: () => saved as ReturnType<TeamStore["readRoster"]>,
			writeRoster: (next) => {
				saved = next;
			},
		};
		const roster = new TeamService({ sessionId: "sess-a", store }).sessionStart();
		expect(roster.members).toMatchObject([
			{
				name: "orphan",
				membershipId: "legacy-id",
				lifecycle: "released",
				availability: "unavailable",
				recoveryFence: "legacy-retired-unverified",
				recoveryError: expect.any(String),
			},
		]);
		expect(roster.archivedMembers).toBeUndefined();
		expect(new TeamService({ sessionId: "sess-a", store }).sessionStart().members[0]?.membershipId).toBe("legacy-id");
	});

	it("does not archive a retired legacy identity whose resource receipt cannot be correlated", () => {
		let saved: unknown = {
			version: 1,
			teamId: "sess-a",
			sessionId: "sess-a",
			createdAt: 1,
			teamKey: "key",
			members: [{ name: "ambiguous", type: "scout", lifecycle: "retired" }],
		};
		const store: TeamStore = {
			teamDir: "/tmp/legacy",
			readRoster: () => saved as ReturnType<TeamStore["readRoster"]>,
			writeRoster: (next) => {
				saved = next;
			},
		};
		const roster = new TeamService({ sessionId: "sess-a", store }).sessionStart();
		expect(roster.members).toMatchObject([
			{
				name: "ambiguous",
				lifecycle: "released",
				availability: "unavailable",
				recoveryFence: "legacy-retired-unverified",
				recoveryError: expect.any(String),
			},
		]);
		expect(roster.archivedMembers).toBeUndefined();
	});

	it("backfills legacy membership IDs once and preserves them across reload", () => {
		const roster = {
			version: 1,
			teamId: "sess-a",
			sessionId: "sess-a",
			createdAt: 1,
			teamKey: "key",
			members: [{ name: "legacy", type: "scout" }],
		};
		let saved: unknown = roster;
		const store: TeamStore = {
			teamDir: "/tmp/legacy",
			readRoster: () => saved as ReturnType<TeamStore["readRoster"]>,
			writeRoster: (next) => {
				saved = next;
			},
		};
		const first = new TeamService({ sessionId: "sess-a", store }).sessionStart().members[0]?.membershipId;
		const second = new TeamService({ sessionId: "sess-a", store }).sessionStart().members[0]?.membershipId;
		expect(first).toBeTruthy();
		expect(second).toBe(first);
	});

	it("forwards an optional archive reason when discarding pending mailbox entries", async () => {
		const reasons: Array<string | undefined> = [];
		const service = new TeamService({
			sessionId: "sess-a",
			store: memoryStore(),
			discardPending: async (_name, reason) => {
				reasons.push(reason);
			},
		});
		await service.discardPending("scout", "fresh");
		await service.discardPending("scout");
		expect(reasons).toEqual(["fresh", undefined]);
	});

	it("records assignments without duplicating members", () => {
		const store = memoryStore();
		const service = new TeamService({ sessionId: "sess-a", store, now: () => 5 });
		service.sessionStart();
		service.recordAssignment({ name: "scout", type: "scout", runId: "run-1" });
		service.recordAssignment({ name: "scout", type: "scout", runId: "run-2" });
		service.recordAssignment({ name: "dev", type: "general-purpose", runId: "run-3" });
		service.setAvailability("scout", "unavailable", "child disconnected");
		service.setLifecycle("scout", "released");
		expect(service.current?.members).toMatchObject([
			{
				name: "scout",
				lastRunId: "run-2",
				lifecycle: "released",
				availability: "unavailable",
				recoveryError: "child disconnected",
			},
			{ name: "dev", lastRunId: "run-3" },
		]);
	});

	it("ignores assignments before a session started and survives write failures", () => {
		const store = memoryStore();
		const warnings: string[] = [];
		const service = new TeamService({
			sessionId: "sess-a",
			store,
			now: () => 5,
			warn: (message) => warnings.push(message),
		});
		service.recordAssignment({ name: "scout", type: "scout", runId: "run-0" });
		expect(service.current).toBeUndefined();
		service.sessionStart();
		const original = store.writeRoster;
		store.writeRoster = () => {
			throw new Error("disk full");
		};
		service.recordAssignment({ name: "scout", type: "scout", runId: "run-1" });
		store.writeRoster = original;
		expect(warnings.join("\n")).toMatch(/disk full/);
		expect(service.current?.members).toMatchObject([{ name: "scout", lastRunId: "run-1" }]);
	});
});

describe("createPiTeamStore", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("persists the roster atomically under the team directory", () => {
		tempDir = mkdtempSync(join(tmpdir(), "teams-store-"));
		mkdirSync(join(tempDir, ".pi"), { recursive: true });
		const store = createPiTeamStore(tempDir, "sess-x");
		expect(store.teamDir).toBe(join(teamsArtifactDir(tempDir), "t", "sess-x"));

		store.writeRoster({
			version: 1,
			teamId: "sess-x",
			sessionId: "sess-x",
			createdAt: 1,
			teamKey: "key1",
			members: [],
		});
		const configPath = join(store.teamDir, "config.json");
		expect(statSync(configPath).mode & 0o777 & 0o700).toBe(0o600 & 0o700);
		expect(statSync(store.teamDir).mode & 0o777).toBe(0o700);
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({ teamId: "sess-x", members: [] });

		const read = store.readRoster();
		expect(read).toMatchObject({ teamId: "sess-x", sessionId: "sess-x" });
	});

	it("distinguishes a missing roster from corrupt and unsupported files without overwriting either", () => {
		tempDir = mkdtempSync(join(tmpdir(), "teams-store-"));
		const store = createPiTeamStore(tempDir, "sess-y");
		expect(store.readRoster()).toBeUndefined();
		expect(teamDirFor(tempDir, "sess-y")).toBe(join(teamsArtifactDir(tempDir), "t", "sess-y"));
		mkdirSync(store.teamDir, { recursive: true });
		const configPath = join(store.teamDir, "config.json");
		for (const [contents, kind] of [
			["{broken", "malformed"],
			[JSON.stringify({ version: 2, members: [] }), "unsupported-version"],
		] as const) {
			writeFileSync(configPath, contents);
			const before = readFileSync(configPath, "utf8");
			const service = new TeamService({ sessionId: "sess-y", store });
			expect(() => service.sessionStart()).toThrow(TeamRosterReadError);
			expect(() => service.sessionStart()).toThrow(expect.objectContaining({ kind }));
			expect(readFileSync(configPath, "utf8")).toBe(before);
		}
	});

	it("fails closed instead of replacing a valid roster for a different session", () => {
		let writes = 0;
		const service = new TeamService({
			sessionId: "sess-b",
			store: {
				teamDir: "/tmp/mismatched-roster",
				readRoster: () => ({
					version: 1,
					teamId: "sess-a",
					sessionId: "sess-a",
					createdAt: 1,
					teamKey: "key",
					members: [],
				}),
				writeRoster: () => {
					writes += 1;
				},
			},
		});
		expect(() => service.sessionStart()).toThrow(/does not match session/);
		expect(writes).toBe(0);
	});
});
