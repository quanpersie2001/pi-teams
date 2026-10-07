import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SubagentsSettings } from "../domain/config.js";
import type { WorktreeInfo, WorktreeResult } from "../domain/worktree.js";

export interface GitCommandResult {
	stdout: string;
}
export type GitRunner = (args: readonly string[], opts: { cwd: string }) => Promise<GitCommandResult>;
export class WorktreeGitError extends Error {
	constructor(
		message: string,
		readonly args: readonly string[],
		readonly cause: unknown,
	) {
		super(message);
		this.name = "WorktreeGitError";
	}
}
interface WorktreeRegistration {
	baseRepo: string;
	checkoutRoot: string;
	workPath: string;
	branch: string;
	baseSha: string;
}
export interface WorktreeServiceOptions {
	runGit: GitRunner;
	tmpRoot: string;
	settings: SubagentsSettings;
	now?: () => number;
	uniqueSuffix?: () => string;
}

/** Retains isolated results for review/cherry-pick; release is a separate explicit operation. */
export class WorktreeService {
	private readonly runGit: GitRunner;
	private readonly tmpRoot: string;
	private settings: SubagentsSettings;
	private readonly now: () => number;
	private readonly uniqueSuffix: () => string;
	private readonly registrations = new Map<string, WorktreeRegistration>();
	constructor(options: WorktreeServiceOptions) {
		this.runGit = options.runGit;
		this.tmpRoot = resolve(options.tmpRoot);
		this.settings = options.settings;
		this.now = options.now ?? (() => Date.now());
		this.uniqueSuffix = options.uniqueSuffix ?? (() => randomUUID().slice(0, 8));
	}
	updateSettings(settings: SubagentsSettings): void {
		this.settings = settings;
	}
	get tmpRootPath(): string {
		return this.tmpRoot;
	}

	async createForRun(runId: string, cwd: string, subdir?: string): Promise<WorktreeInfo> {
		if (!this.settings.worktreeIsolation) throw new Error("Worktree isolation is disabled.");
		if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid worktree run identity.");
		const original = resolve(cwd);
		let baseRepo: string;
		let baseSha: string;
		try {
			const top = (await this.runGit(["rev-parse", "--show-toplevel"], { cwd: original })).stdout.trim();
			baseRepo = realpathSync(top);
			baseSha = (await this.runGit(["rev-parse", "HEAD"], { cwd: baseRepo })).stdout.trim();
		} catch (error) {
			throw new WorktreeGitError(
				`Cannot create worktree: ${original} has no accessible Git HEAD.`,
				["rev-parse", "HEAD"],
				error,
			);
		}
		const packagePath = subdir ?? relative(baseRepo, realpathSync(original));
		if (isAbsolute(packagePath) || packagePath === ".." || packagePath.startsWith(`..${sep}`))
			throw new Error("Execution cwd must stay within the repository checkout.");
		const checkoutRoot = join(this.tmpRoot, `pi-teams-${runId}-${this.uniqueSuffix()}`);
		await this.runGit(["worktree", "add", "--detach", checkoutRoot, baseSha], { cwd: baseRepo });
		const canonicalCheckout = realpathSync(checkoutRoot);
		let workPath: string;
		try {
			workPath = realpathSync(resolve(canonicalCheckout, packagePath));
			if (workPath !== canonicalCheckout && !workPath.startsWith(canonicalCheckout + sep))
				throw new Error("Worktree execution path escaped the checkout.");
		} catch (error) {
			// No child has started in this checkout; remove only this new worktree.
			try {
				await this.runGit(["worktree", "remove", canonicalCheckout], { cwd: baseRepo });
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					`Cannot resolve worktree execution cwd; checkout retained at ${canonicalCheckout}.`,
				);
			}
			throw error;
		}
		const branch = `agent/${runId}-${baseSha.slice(0, 8)}`;
		this.registrations.set(workPath, { baseRepo, checkoutRoot: canonicalCheckout, workPath, branch, baseSha });
		return { baseRepo, path: workPath, checkoutRoot: canonicalCheckout, baseSha, branch };
	}

	async preserveForRun(info: WorktreeInfo, description?: string): Promise<WorktreeResult> {
		const reg = this.registration(info);
		if (!existsSync(reg.checkoutRoot)) throw new Error(`Worktree is missing: ${reg.checkoutRoot}`);
		try {
			const status = (await this.runGit(["status", "--porcelain"], { cwd: reg.checkoutRoot })).stdout.trim();
			if (status) {
				await this.runGit(["add", "-A"], { cwd: reg.checkoutRoot });
				await this.runGit(["commit", "--no-verify", "-m", `pi-agent: ${(description ?? reg.branch).slice(0, 200)}`], {
					cwd: reg.checkoutRoot,
				});
			}
			const commitSha = (await this.runGit(["rev-parse", "HEAD"], { cwd: reg.checkoutRoot })).stdout.trim();
			const hasChanges = commitSha !== reg.baseSha;
			let branch = reg.branch;
			if (hasChanges) {
				let existingSha: string | undefined;
				try {
					existingSha = (
						await this.runGit(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: reg.baseRepo })
					).stdout.trim();
				} catch {
					/* A new result branch is normal. */
				}
				if (existingSha !== commitSha) {
					if (existingSha) branch = `${branch}-${this.now()}-${this.uniqueSuffix()}`;
					await this.runGit(["branch", branch, commitSha], { cwd: reg.baseRepo });
				}
			}
			reg.branch = branch;
			this.registrations.set(info.path, reg);
			const commits = hasChanges
				? (
						await this.runGit(["rev-list", "--reverse", `${reg.baseSha}..${commitSha}`], { cwd: reg.checkoutRoot })
					).stdout
						.trim()
						.split(/\s+/)
						.filter(Boolean)
				: [];
			return {
				branch,
				hasChanges,
				baseSha: reg.baseSha,
				commitSha,
				commits,
				path: reg.workPath,
				...(commits.length ? { cherryPickCommand: `git cherry-pick ${commits.join(" ")}` } : {}),
			};
		} catch (error) {
			// Never remove a checkout when commit/branch preservation failed.
			throw new WorktreeGitError(
				`Worktree preservation failed; recover changes at ${reg.checkoutRoot}: ${error instanceof Error ? error.message : String(error)}`,
				["commit"],
				error,
			);
		}
	}

	async releaseForRun(info: WorktreeInfo): Promise<void> {
		const reg = this.registration(info);
		if (!existsSync(reg.checkoutRoot)) {
			this.registrations.delete(info.path);
			return;
		}
		const status = (await this.runGit(["status", "--porcelain"], { cwd: reg.checkoutRoot })).stdout.trim();
		if (status) throw new Error(`Refusing to release dirty worktree; preserve changes first: ${reg.checkoutRoot}`);
		const head = (await this.runGit(["rev-parse", "HEAD"], { cwd: reg.checkoutRoot })).stdout.trim();
		if (head !== reg.baseSha) {
			const preserved = (
				await this.runGit(["rev-parse", "--verify", `refs/heads/${reg.branch}`], { cwd: reg.baseRepo })
			).stdout.trim();
			if (preserved !== head) throw new Error(`Refusing to release an unpreserved worktree HEAD: ${reg.checkoutRoot}`);
		}
		await this.runGit(["worktree", "remove", reg.checkoutRoot], { cwd: reg.baseRepo });
		this.registrations.delete(info.path);
	}

	reconnect(info: WorktreeInfo): void {
		this.registrations.set(info.path, this.registration(info));
	}
	orphanPrune(): number {
		let count = 0;
		for (const [path, reg] of this.registrations) {
			if (!existsSync(reg.checkoutRoot)) {
				this.registrations.delete(path);
				count += 1;
			}
		}
		return count;
	}
	private registration(info: WorktreeInfo): WorktreeRegistration {
		const known = this.registrations.get(info.path);
		if (known) return known;
		const checkoutRoot = resolve(info.checkoutRoot ?? info.path);
		const root = existsSync(this.tmpRoot) ? realpathSync(this.tmpRoot) : this.tmpRoot;
		const canonical = existsSync(checkoutRoot) ? realpathSync(checkoutRoot) : checkoutRoot;
		if (!canonical.startsWith(root + sep)) throw new Error(`Worktree is outside managed root: ${checkoutRoot}`);
		if (!info.baseSha) throw new Error("Restored worktree is missing its immutable baseline.");
		return {
			baseRepo: info.baseRepo,
			checkoutRoot: canonical,
			workPath: info.path,
			branch: info.branch ?? "agent/unknown",
			baseSha: info.baseSha,
		};
	}
}
