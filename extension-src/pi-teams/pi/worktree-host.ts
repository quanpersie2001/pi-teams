// Concrete Git/filesystem adapter for worktree isolation (ARCHITECTURE.md §15).
//
// app/worktree-service.ts orchestrates worktree lifecycle against an injected
// git runner; this host module provides that runner (execFile on the system
// `git`) and the worktree tmp root under the pi data dir. This is the only
// place worktree git commands are actually executed. The operator can override
// the tmp root via the PI_TEAMS_WORKTREE_TMP env var (test/deterministic
// runs) — an environment override, not a user-facing settings key.

import { execFile } from "node:child_process";
import { join } from "node:path";
import type { GitRunner } from "../app/worktree-service.js";
import { findNearestPiDir } from "./artifacts.js";

/** Env override for a deterministic worktree tmp root (tests/CI). */
export const WORKTREE_TMP_ENV = "PI_TEAMS_WORKTREE_TMP";

/**
 * Deterministic worktree root under the pi data dir:
 * `<piDir>/subagents/worktrees`. Honors PI_TEAMS_WORKTREE_TMP.
 */
export function worktreeTmpRoot(configCwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const override = env[WORKTREE_TMP_ENV];
	if (typeof override === "string" && override.length > 0) return override;
	return join(findNearestPiDir(configCwd), "teams", "worktrees");
}

/** execFile-based `git` runner; rejects with the git exit message on failure. */
export function createGitRunner(exec: typeof execFile = execFile): GitRunner {
	return async (args, opts) => {
		const { stdout } = await runGit(exec, [...args], opts.cwd);
		return { stdout };
	};
}

function runGit(exec: typeof execFile, args: string[], cwd: string): Promise<{ stdout: string }> {
	return new Promise((resolve, reject) => {
		exec("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
			if (error) {
				const detail = String(stderr ?? "").trim() || error.message;
				reject(new Error(`git ${args.join(" ")} failed: ${detail}`));
				return;
			}
			resolve({ stdout });
		});
	});
}
