// Deterministic FakeGit runner for worktree tests — no real git required.
// Tracks checkout dirt/HEAD plus branches and ordered commit ranges.

import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GitRunner } from "../../extension-src/pi-subagents/app/worktree-service.js";

export const BASE_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f900aabbccdd";
export const COMMITTED_SHA = "9988776655443322110099887766554433221100";

export interface FakeWorktree {
	path: string;
	dirty: boolean;
	committed: boolean;
}

export class FakeGit {
	topLevel: string;
	readonly branches = new Set<string>();
	readonly branchHeads = new Map<string, string>();
	readonly calls: Array<{ args: readonly string[]; cwd: string }> = [];
	failWorkTree = false;
	failHead = false;

	private readonly worktrees = new Map<string, FakeWorktree>();

	constructor(topLevel: string) {
		this.topLevel = topLevel;
	}

	readonly run: GitRunner = async (args, { cwd }) => {
		this.calls.push({ args: [...args], cwd });
		const [cmd, ...rest] = args;
		switch (cmd) {
			case "rev-parse": {
				if (rest[0] === "--show-toplevel") {
					if (this.failWorkTree) throw new Error("fatal: not a git repository");
					return { stdout: `${this.topLevel}\n` };
				}
				if (rest[0] === "HEAD") {
					if (this.failHead) throw new Error("fatal: your current branch does not have any commits yet");
					const wt = this.worktreeAt(cwd);
					return { stdout: `${wt?.committed ? COMMITTED_SHA : BASE_SHA}\n` };
				}
				if (rest[0] === "--verify") {
					const branch = rest[1]?.replace(/^refs\/heads\//, "");
					if (!branch || !this.branches.has(branch)) throw new Error("fatal: reference is not a valid branch");
					return { stdout: `${this.branchHeads.get(branch) ?? BASE_SHA}\n` };
				}
				throw new Error(`FakeGit: unexpected rev-parse ${rest.join(" ")}`);
			}
			case "rev-list":
				return { stdout: `${COMMITTED_SHA}\n` };
			case "worktree": {
				if (rest[0] === "add") {
					const requestedPath = resolve(rest[2] ?? "");
					mkdirSync(requestedPath, { recursive: true });
					mkdirSync(join(requestedPath, "packages", "pkg-a"), { recursive: true });
					const path = realpathSync(requestedPath);
					this.worktrees.set(path, { path, dirty: false, committed: false });
					return { stdout: "" };
				}
				if (rest[0] === "remove") {
					const path = canonicalPath(resolve(rest.at(-1) ?? ""));
					this.worktrees.delete(path);
					rmSync(path, { recursive: true, force: false });
					return { stdout: "" };
				}
				if (rest[0] === "prune") return { stdout: "" };
				throw new Error(`FakeGit: unexpected worktree ${rest.join(" ")}`);
			}
			case "status": {
				const wt = this.worktreeAt(cwd);
				return { stdout: wt?.dirty ? " M file.txt\n" : "" };
			}
			case "add":
				return { stdout: "" };
			case "commit": {
				const wt = this.worktreeAt(cwd);
				if (wt) {
					wt.committed = true;
					wt.dirty = false;
				}
				return { stdout: `[detached HEAD ${COMMITTED_SHA.slice(0, 7)}] pi-agent: run\n` };
			}
			case "branch": {
				const name = rest[0];
				if (!name) throw new Error("FakeGit: branch name missing");
				if (this.branches.has(name)) throw new Error(`fatal: a branch named '${name}' already exists`);
				this.branches.add(name);
				this.branchHeads.set(name, rest[1] ?? BASE_SHA);
				return { stdout: "" };
			}
			default:
				throw new Error(`FakeGit: unexpected command ${cmd}`);
		}
	};

	setDirty(checkoutRoot: string, dirty: boolean): void {
		const path = canonicalPath(checkoutRoot);
		const wt = this.worktrees.get(path);
		if (wt) wt.dirty = dirty;
	}
	setCommitted(checkoutRoot: string, committed: boolean): void {
		const path = canonicalPath(checkoutRoot);
		const wt = this.worktrees.get(path);
		if (wt) wt.committed = committed;
	}

	get worktreePaths(): string[] {
		return [...this.worktrees.keys()];
	}

	private worktreeAt(cwd: string): FakeWorktree | undefined {
		const path = canonicalPath(cwd);
		for (const [worktreePath, worktree] of this.worktrees) {
			if (path === worktreePath || path.startsWith(`${worktreePath}/`)) return worktree;
		}
		return undefined;
	}
}

function canonicalPath(path: string): string {
	return existsSync(path) ? realpathSync(path) : resolve(path);
}
