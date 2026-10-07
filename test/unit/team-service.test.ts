// TeamService roster lifecycle + fs-backed team store (ADR 0007 §2).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TeamService, type TeamStore } from "../../extension-src/pi-teams/app/team-service.js";
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

	it("records assignments without duplicating members", () => {
		const store = memoryStore();
		const service = new TeamService({ sessionId: "sess-a", store, now: () => 5 });
		service.sessionStart();
		service.recordAssignment({ name: "scout", type: "scout", runId: "run-1" });
		service.recordAssignment({ name: "scout", type: "scout", runId: "run-2" });
		service.recordAssignment({ name: "dev", type: "general-purpose", runId: "run-3" });
		expect(service.current?.members).toMatchObject([
			{ name: "scout", lastRunId: "run-2" },
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

		store.writeRoster({ version: 1, teamId: "sess-x", sessionId: "sess-x", createdAt: 1, members: [] });
		const configPath = join(store.teamDir, "config.json");
		expect(statSync(configPath).mode & 0o777 & 0o700).toBe(0o600 & 0o700);
		expect(statSync(store.teamDir).mode & 0o777).toBe(0o700);
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({ teamId: "sess-x", members: [] });

		const read = store.readRoster();
		expect(read).toMatchObject({ teamId: "sess-x", sessionId: "sess-x" });
	});

	it("returns undefined for absent or corrupt rosters", () => {
		tempDir = mkdtempSync(join(tmpdir(), "teams-store-"));
		const store = createPiTeamStore(tempDir, "sess-y");
		expect(store.readRoster()).toBeUndefined();
		expect(teamDirFor(tempDir, "sess-y")).toBe(join(teamsArtifactDir(tempDir), "t", "sess-y"));
	});
});
