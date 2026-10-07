// TeamService — session-scoped team lifecycle (ADR 0007 §2, roadmap T2).
//
// App-layer orchestration over an injected TeamStore port; the fs-backed
// store lives in pi/teams-host.ts. The roster is coordination metadata, not a
// receipt: a corrupt roster warns and re-creates (mailboxes/boards/history on
// disk are untouched), unlike registry rows which are never rewritten.

import { deriveTeamId, type TeamRoster, upsertMember } from "../domain/team.js";

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
			members: [],
		};
		this.persist();
		return this.roster;
	}

	/**
	 * Record one admitted assignment (a run spawned under a teammate name).
	 * Teammates persist across assignments until the session ends, so a
	 * settled name gains a new run instead of a new member.
	 */
	recordAssignment(assignment: { name: string; type: string; runId: string }): void {
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
