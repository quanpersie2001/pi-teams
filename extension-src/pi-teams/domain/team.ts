// Team identity and roster contracts (ADR 0007 §2).
//
// One team per session; the session is the fixed lead. Teammates are named at
// spawn and persist across assignments until the session ends — a settled
// teammate may receive a new assignment under the same name; an active one may
// not. Pure module: no Pi, fs or process imports.

export interface TeamMember {
	/** Team-unique teammate address: mailbox path segment, send_message target, @mention. */
	name: string;
	/** Specialist type (agent definition) the teammate was spawned as. */
	type: string;
	/** Latest admitted run carrying this teammate name. */
	lastRunId: string;
	firstAssignedAt: number;
	lastAssignedAt: number;
}

/** Roster at `.pi/teams/t/<team-id>/config.json`; how participants discover peers. */
export interface TeamRoster {
	version: 1;
	teamId: string;
	sessionId: string;
	createdAt: number;
	members: TeamMember[];
}

/** Mailbox/board address of the session acting as the fixed lead. */
export const LEAD_ADDRESS = "lead";

const TEAMMATE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * Why a proposed teammate name is unusable, or undefined when valid:
 *   - `lead` is reserved for the session lead;
 *   - otherwise 1–64 chars of letters/digits/`.`/`_`/`-`, starting alphanumeric.
 */
export function teammateNameProblem(name: string): string | undefined {
	if (name === LEAD_ADDRESS) return `"${LEAD_ADDRESS}" is reserved for the session lead`;
	if (!TEAMMATE_NAME_PATTERN.test(name))
		return "teammate names are 1–64 characters of letters, digits, '.', '_' or '-' and start with a letter or digit";
	return undefined;
}

/**
 * Team id derived from the owning session id (one team per session): unsafe
 * path characters collapse to '-', capped at 64 characters. Team directories
 * live under `t/`, so generated ids can never collide with `sessions/`.
 */
export function deriveTeamId(sessionId: string): string {
	const cleaned = sessionId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
	return cleaned.length > 0 ? cleaned : "session";
}

/**
 * Record one assignment on the roster (pure): a new member is appended; an
 * existing member keeps its identity and gains the new run/timestamp. The
 * input roster is never mutated.
 */
export function upsertMember(
	roster: TeamRoster,
	assignment: { name: string; type: string; runId: string; at: number },
): TeamRoster {
	const existing = roster.members.find((member) => member.name === assignment.name);
	const members = existing
		? roster.members.map((member) =>
				member === existing
					? { ...member, type: assignment.type, lastRunId: assignment.runId, lastAssignedAt: assignment.at }
					: member,
			)
		: [
				...roster.members,
				{
					name: assignment.name,
					type: assignment.type,
					lastRunId: assignment.runId,
					firstAssignedAt: assignment.at,
					lastAssignedAt: assignment.at,
				},
			];
	return { ...roster, members };
}
