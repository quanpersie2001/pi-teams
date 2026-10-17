import type { AgentBackendHandle, AgentExecutionBackend } from "../domain/backend.js";
import type { WorktreeInfo } from "../domain/worktree.js";

export type TeammateLifecycle = "idle" | "busy" | "released" | "retired";

/** Session-owned teammate identity and child context. Runs contain outcomes; this owns live child resources. */
export interface TeammateRuntimeEntry {
	readonly name: string;
	readonly membershipId?: string;
	readonly type: string;
	readonly color?: string;
	state: TeammateLifecycle;
	operation?: "shutting_down";
	contextGeneration: number;
	currentRunId?: string;
	backend?: AgentExecutionBackend;
	handle?: AgentBackendHandle;
	cwd?: string;
	worktreeInfo?: WorktreeInfo;
	sessionFile?: string;
	recoveryError?: string;
}

export class TeammateRuntime {
	private readonly entries = new Map<string, TeammateRuntimeEntry>();

	ensure(identity: { name: string; membershipId?: string; type: string; color?: string }): TeammateRuntimeEntry {
		const entry = this.entries.get(identity.name);
		if (entry) {
			if (identity.membershipId !== undefined && entry.membershipId !== identity.membershipId)
				throw new Error(
					`Teammate "@${identity.name}" runtime belongs to a different membership incarnation; recover it before reuse.`,
				);
			if (entry.type !== identity.type)
				throw new Error(`Teammate "@${identity.name}" keeps its specialist role; use a new name for a different role.`);
			if (identity.color !== undefined && entry.color !== identity.color)
				throw new Error(
					`Teammate "@${identity.name}" already has color ${entry.color ?? "the default"}; its identity color cannot change.`,
				);
			if (entry.state === "retired")
				throw new Error(`Teammate "@${identity.name}" is retired and cannot be reassigned.`);
			return entry;
		}
		const created: TeammateRuntimeEntry = {
			name: identity.name,
			...(identity.membershipId !== undefined ? { membershipId: identity.membershipId } : {}),
			type: identity.type,
			...(identity.color !== undefined ? { color: identity.color } : {}),
			state: "released",
			contextGeneration: 0,
		};
		this.entries.set(identity.name, created);
		return created;
	}

	remove(name: string, expected?: TeammateRuntimeEntry): boolean {
		const current = this.entries.get(name);
		if (!current || (expected !== undefined && current !== expected)) return false;
		this.entries.delete(name);
		return true;
	}

	get(name: string): TeammateRuntimeEntry | undefined {
		return this.entries.get(name);
	}

	setChild(
		name: string,
		resource: {
			currentRunId: string;
			backend: AgentExecutionBackend;
			preserveContext?: boolean;
			handle: AgentBackendHandle;
			cwd: string;
			worktreeInfo?: WorktreeInfo;
			sessionFile?: string;
		},
	): void {
		const entry = this.entries.get(name);
		if (!entry) throw new Error(`Unknown teammate runtime: "${name}".`);
		entry.currentRunId = resource.currentRunId;
		if (!resource.preserveContext) entry.contextGeneration++;
		entry.backend = resource.backend;
		entry.handle = resource.handle;
		entry.cwd = resource.cwd;
		if (resource.worktreeInfo !== undefined) entry.worktreeInfo = resource.worktreeInfo;
		if (resource.sessionFile !== undefined) entry.sessionFile = resource.sessionFile;
		delete entry.recoveryError;
		entry.state = "busy";
	}

	reserve(name: string, runId: string): void {
		const entry = this.entries.get(name);
		if (!entry) throw new Error(`Unknown teammate runtime: "${name}".`);
		if (entry.state === "retired") throw new Error(`Teammate "@${name}" is retired and cannot be reassigned.`);
		if (entry.state === "busy") throw new Error(`Teammate "@${name}" is already busy.`);
		entry.state = "busy";
		if (entry.handle === undefined) entry.currentRunId = runId;
	}

	setState(name: string, state: TeammateLifecycle, recoveryError?: string): void {
		const entry = this.entries.get(name);
		if (!entry) return;
		entry.state = state;
		if (recoveryError !== undefined) entry.recoveryError = recoveryError;
		else if (state === "released" || state === "idle") delete entry.recoveryError;
	}

	clearChild(name: string, state: "released" | "retired" = "released"): void {
		const entry = this.entries.get(name);
		if (!entry) return;
		delete entry.backend;
		delete entry.handle;
		delete entry.currentRunId;
		delete entry.sessionFile;
		entry.state = state;
		delete entry.recoveryError;
	}

	clearWorktree(name: string): void {
		const entry = this.entries.get(name);
		if (!entry) return;
		delete entry.worktreeInfo;
		delete entry.cwd;
	}

	updateSessionFile(name: string, runId: string, sessionFile: string): void {
		const entry = this.entries.get(name);
		if (entry?.currentRunId === runId) entry.sessionFile = sessionFile;
	}

	setRecoveryError(name: string, error: string): void {
		const entry = this.entries.get(name);
		if (!entry) return;
		entry.recoveryError = error;
	}

	clearRecoveryError(name: string): void {
		const entry = this.entries.get(name);
		if (entry) delete entry.recoveryError;
	}

	clearSettled(): void {
		for (const [name, entry] of this.entries) {
			if (!entry.backend && !entry.handle && entry.recoveryError === undefined) this.entries.delete(name);
		}
	}

	values(): IterableIterator<TeammateRuntimeEntry> {
		return this.entries.values();
	}
}
