// fs-backed team directory + roster store (ARCH-005: concrete host adapter).
//
// Team artifacts live under `.pi/teams/t/<team-id>/` with owner-only
// permissions, matching other team artifacts. Roster writes are atomic
// (temp + rename) and never rewrite corrupt or newer-version data.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TeamRosterReadError, type TeamStore } from "../app/team-service.js";
import type { TeamMember, TeamRoster } from "../domain/team.js";
import { deriveTeamId } from "../domain/team.js";
import { teamsArtifactDir } from "./registry-host.js";

export function teamDirFor(cwd: string, sessionId: string): string {
	return join(teamsArtifactDir(cwd), "t", deriveTeamId(sessionId));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(record: Record<string, unknown>, key: string): boolean {
	return record[key] === undefined || typeof record[key] === "string";
}

function isOptionalFiniteNumber(record: Record<string, unknown>, key: string): boolean {
	return record[key] === undefined || (typeof record[key] === "number" && Number.isFinite(record[key]));
}

function isTeamMember(value: unknown): value is TeamMember {
	if (!isRecord(value)) return false;
	if (typeof value.name !== "string" || typeof value.type !== "string") return false;
	if (
		!isOptionalString(value, "membershipId") ||
		!isOptionalString(value, "color") ||
		!isOptionalString(value, "lastRunId")
	)
		return false;
	if (!isOptionalString(value, "recoveryError")) return false;
	if (
		value.recoveryFence !== undefined &&
		value.recoveryFence !== "legacy-retired-unverified" &&
		value.recoveryFence !== "registry-receipt-unresolved"
	)
		return false;
	if (!isOptionalFiniteNumber(value, "firstAssignedAt") || !isOptionalFiniteNumber(value, "lastAssignedAt"))
		return false;
	if (value.lifecycle !== undefined && !["idle", "busy", "released", "retired"].includes(String(value.lifecycle)))
		return false;
	if (value.availability !== undefined && value.availability !== "available" && value.availability !== "unavailable")
		return false;
	if (value.operation !== undefined) {
		if (
			!isRecord(value.operation) ||
			value.operation.kind !== "shutdown" ||
			typeof value.operation.operationId !== "string" ||
			!["requested", "settled", "tasks_reconciled", "resources_disposed"].includes(String(value.operation.phase))
		)
			return false;
	}
	return true;
}

function isTeamRoster(value: unknown): value is TeamRoster {
	if (!isRecord(value)) return false;
	return (
		value.version === 1 &&
		typeof value.teamId === "string" &&
		typeof value.sessionId === "string" &&
		typeof value.createdAt === "number" &&
		Number.isFinite(value.createdAt) &&
		typeof value.teamKey === "string" &&
		value.teamKey.length > 0 &&
		Array.isArray(value.members) &&
		value.members.every(isTeamMember) &&
		(value.archivedMembers === undefined ||
			(Array.isArray(value.archivedMembers) && value.archivedMembers.every(isTeamMember)))
	);
}

/** Build the fs-backed roster store for one session's team directory. */
export function createPiTeamStore(cwd: string, sessionId: string): TeamStore {
	const teamDir = teamDirFor(cwd, sessionId);
	const configPath = join(teamDir, "config.json");
	return {
		teamDir,
		readRoster(): TeamRoster | undefined {
			let serialized: string;
			try {
				serialized = readFileSync(configPath, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(serialized);
			} catch (error) {
				throw new TeamRosterReadError(
					"malformed",
					`Malformed team roster at ${configPath}; preserving it for recovery.`,
					{
						cause: error,
					},
				);
			}
			if (isRecord(parsed) && typeof parsed.version === "number" && parsed.version !== 1)
				throw new TeamRosterReadError(
					"unsupported-version",
					`Unsupported team roster version at ${configPath}; preserving it for recovery.`,
				);
			if (!isTeamRoster(parsed))
				throw new TeamRosterReadError("malformed", `Invalid team roster at ${configPath}; preserving it for recovery.`);
			return parsed;
		},
		writeRoster(roster: TeamRoster): void {
			mkdirSync(teamDir, { recursive: true, mode: 0o700 });
			const tempPath = `${configPath}.tmp`;
			writeFileSync(tempPath, JSON.stringify(roster, undefined, "\t"), { mode: 0o600 });
			renameSync(tempPath, configPath);
		},
	};
}
