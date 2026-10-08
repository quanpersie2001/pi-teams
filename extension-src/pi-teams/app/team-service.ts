// TeamService — session-scoped team lifecycle (ADR 0007 §2, roadmap T2).
//
// App-layer orchestration over an injected TeamStore port; the fs-backed
// store lives in pi/teams-host.ts. The roster is coordination metadata, not a
// receipt: a corrupt roster warns and re-creates (mailboxes/boards/history on
// disk are untouched), unlike registry rows which are never rewritten.

import { randomBytes } from "node:crypto";
import { deriveTeamId, ensureMemberIdentity, type TeamRoster, upsertMember } from "../domain/team.js";

/** Durable roster adapter; implementations write atomically with owner-only permissions. */
export interface TeamStore {
	/** Team directory (`.pi/teams/t/<team-id>/`); needed by later mailbox/board wiring. */
	readonly teamDir: string;
	readRoster(): TeamRoster | undefined;
	writeRoster(roster: TeamRoster): void;
}

export interface TeamServiceOptions {
	sessionId: string;
	store: TeamStore;
	now?: () => number;
	warn?: (message: string) => void;
}

export class TeamService {
	private roster: TeamRoster | undefined;
	private readonly sessionId: string;
	private readonly store: TeamStore;
	private readonly now: () => number;
	private readonly warn: (message: string) => void;

	constructor(options: TeamServiceOptions) {
		this.sessionId = options.sessionId;
		this.store = options.store;
		this.now = options.now ?? (() => Date.now());
		this.warn = options.warn ?? ((message) => console.warn(`[pi-teams] ${message}`));
	}

	get teamDir(): string {
		return this.store.teamDir;
	}

	/** Current roster; undefined until sessionStart ran. */
	get current(): TeamRoster | undefined {
		return this.roster;
	}

	/**
	 * Load the team for this session, creating `t/<team-id>/config.json` on
	 * first sight. The same session resumed reuses its roster; a new session
	 * never touches another team's directory.
	 */
	sessionStart(): TeamRoster {
		if (this.roster) return this.roster;
		const teamId = deriveTeamId(this.sessionId);
		const existing = this.store.readRoster();
		if (existing && existing.teamId === teamId && existing.sessionId === this.sessionId) {
			this.roster = existing;
			return existing;
		}
		this.roster = {
			version: 1,
			teamId,
			sessionId: this.sessionId,
			createdAt: this.now(),
			teamKey: randomBytes(32).toString("hex"),
			members: [],
		};
		this.persist();
		return this.roster;
	}

	/** Rejects a changed color before admission without changing the roster. */
	assertIdentityColor(name: string, color: string | undefined): void {
		const member = this.roster?.members.find((candidate) => candidate.name === name);
		if (member && color !== undefined && member.color !== color)
			throw new Error(
				`Teammate "@${name}" already has color ${member.color ?? "the default"}; its identity color cannot change.`,
			);
	}

	/** Freeze a new identity before allocating a run or child resource. */
	ensureIdentity(identity: { name: string; type: string; color?: string }): string | undefined {
		if (!this.roster) return identity.color;
		const ensured = ensureMemberIdentity(this.roster, identity, this.now());
		if (ensured.roster !== this.roster) {
			this.roster = ensured.roster;
			this.persist();
		}
		return ensured.color;
	}

	/**
	 * Record an admitted assignment against its already-frozen member identity.
	 * Teammates persist across assignments until the session ends.
	 */
	recordAssignment(assignment: { name: string; type: string; runId: string; color?: string }): void {
		if (!this.roster) return;
		this.roster = upsertMember(this.roster, { ...assignment, at: this.now() });
		this.persist();
	}

	private persist(): void {
		if (!this.roster) return;
		try {
			this.store.writeRoster(this.roster);
		} catch (error) {
			this.warn(
				`team roster write failed in ${this.store.teamDir}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
