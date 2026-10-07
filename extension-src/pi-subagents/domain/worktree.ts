/** Optional per-run checkout; shared workspace is the default. */
export interface WorktreeInfo {
	baseRepo: string;
	/** Execution cwd, potentially a package subdirectory within checkoutRoot. */
	path: string;
	checkoutRoot?: string;
	baseSha?: string;
	branch?: string;
}

/** Preserved result. The checkout remains available until explicit release. */
export interface WorktreeResult {
	branch: string;
	hasChanges: boolean;
	baseSha: string;
	commitSha: string;
	/** Commits after the baseline in integration order, including agent-created commits. */
	commits: readonly string[];
	cherryPickCommand?: string;
	path: string;
}

export function supportsChangedFiles(worktree: Pick<WorktreeInfo, "branch">): boolean {
	return typeof worktree.branch === "string" && worktree.branch.length > 0;
}
