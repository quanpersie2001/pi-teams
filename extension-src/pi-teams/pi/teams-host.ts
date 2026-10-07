// fs-backed team directory + roster store (ARCH-005: concrete host adapter).
//
// Team artifacts live under `.pi/teams/t/<team-id>/` with owner-only
// permissions, matching other team artifacts. Roster writes are atomic
// (temp + rename) and never rewrite corrupt data as empty — an unreadable
// roster surfaces as undefined so the service can warn and re-create.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TeamStore } from "../app/team-service.js";
import { deriveTeamId, type TeamRoster } from "../domain/team.js";
import { teamsArtifactDir } from "./registry-host.js";

export function teamDirFor(cwd: string, sessionId: string): string {
	return join(teamsArtifactDir(cwd), "t", deriveTeamId(sessionId));
}

function isTeamRoster(value: unknown): value is TeamRoster {
	if (typeof value !== "object" || value === null) return false;
	const roster = value as Record<string, unknown>;
	return (
		roster.version === 1 &&
		typeof roster.teamId === "string" &&
		typeof roster.sessionId === "string" &&
		typeof roster.createdAt === "number" &&
		Array.isArray(roster.members)
	);
}

/** Build the fs-backed roster store for one session's team directory. */
export function createPiTeamStore(cwd: string, sessionId: string): TeamStore {
	const teamDir = teamDirFor(cwd, sessionId);
	const configPath = join(teamDir, "config.json");
	return {
		teamDir,
		readRoster(): TeamRoster | undefined {
			if (!existsSync(configPath)) return undefined;
			try {
				const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
				return isTeamRoster(parsed) ? parsed : undefined;
			} catch {
				return undefined;
			}
		},
		writeRoster(roster: TeamRoster): void {
			mkdirSync(teamDir, { recursive: true, mode: 0o700 });
			const tempPath = `${configPath}.tmp`;
			writeFileSync(tempPath, JSON.stringify(roster, undefined, "\t"), { mode: 0o600 });
			renameSync(tempPath, configPath);
		},
	};
}
