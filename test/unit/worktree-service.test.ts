// Unit tests for WorktreeService with a FakeGit runner — no real git.
//
// Covers detached worktree creation, opt-in refusal, shared checkout path,
// explicit preservation/release, changed-file commit handling, and orphan
// registration pruning without deleting user data.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type GitRunner,
	WorktreeGitError,
	WorktreeService,
} from "../../extension-src/pi-teams/app/worktree-service.js";
import { sanitizeSettings } from "../../extension-src/pi-teams/domain/config.js";
import { BASE_SHA, COMMITTED_SHA, FakeGit } from "../helpers/fake-git.js";

const tempRoots: string[] = [];
afterEach(async () => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) await rm(root, { recursive: true, force: true });
	}
});

function makeService(
	git: FakeGit,
	opts: { worktreeIsolation?: boolean; now?: () => number } = {},
): {
	service: WorktreeService;
	tmpRoot: string;
} {
	const tmpRoot = join("/tmp", `teams-${git.topLevel.replace(/[^a-z0-9]/gi, "").slice(-8)}`);
	tempRoots.push(tmpRoot);
	const service = new WorktreeService({
		runGit: git.run,
		tmpRoot,
		settings: sanitizeSettings({ worktreeIsolation: opts.worktreeIsolation ?? true }),
		now: opts.now ?? (() => Date.now()),
		uniqueSuffix: () => "abc12345",
	});
	return { service, tmpRoot };
}

async function mkTmpRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "teams-wt-"));
}

async function runGit(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	execFile("git", [...args], { cwd, env, encoding: "utf8" }, (error, stdout, stderr) => {
		if (error) reject(new Error(`git ${args.join(" ")} failed: ${String(stderr)}`));
		else resolve(stdout);
	});
	return promise;
}

async function makeRealGitRepo(): Promise<{ root: string; env: NodeJS.ProcessEnv; run: GitRunner }> {
	const root = await mkTmpRoot();
	const env = {
		...process.env,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(root, "isolated-global-config"),
	};
	await runGit(["init", "--quiet"], root, env);
	await runGit(["config", "user.name", "Pi Teams Test"], root, env);
	await runGit(["config", "user.email", "pi-teams-test@example.invalid"], root, env);
	await runGit(["commit", "--allow-empty", "-m", "base"], root, env);
	const run: GitRunner = async (args, { cwd }) => ({ stdout: await runGit(args, cwd, env) });
	return { root, env, run };
}

describe("createForRun", () => {
	it("validates the repo and base commit, cuts a detached worktree and returns branch metadata", async () => {
		const repo = await mkTmpRoot();
		const git = new FakeGit(repo);
		const { service } = makeService(git);
		const info = await service.createForRun("task-123", repo);

		expect(info.baseRepo).toBe(await realpath(repo));
		expect(info.branch).toBe(`agent/task-123-${BASE_SHA.slice(0, 8)}`);
		expect(info.path).toMatch(/pi-teams-task-123-abc12345$/);
		expect(info.checkoutRoot).toBe(info.path);

		const flat = git.calls.map((call) => call.args.join(" "));
		expect(flat).toContain("rev-parse --show-toplevel");
		expect(flat).toContain("rev-parse HEAD");
		expect(flat.some((command) => command.startsWith("worktree add --detach ") && command.endsWith(BASE_SHA))).toBe(
			true,
		);
		expect(git.worktreePaths).toEqual([info.checkoutRoot]);
	});

	it("preserves a monorepo subdir as the execution cwd inside the copy", async () => {
		const repo = await mkTmpRoot();
		const subdir = join(repo, "packages", "pkg-a");
		await mkdir(subdir, { recursive: true });
		const git = new FakeGit(repo);
		const { service } = makeService(git);
		const info = await service.createForRun("run-1", subdir);
		expect(info.path).toMatch(new RegExp(`pi-teams-run-1-abc12345${"\\/"}packages\\/pkg-a$`));
		expect(info.baseRepo).toBe(await realpath(repo));
		expect(info.checkoutRoot).toBeDefined();
	});

	it("rejects worktree creation for a directory outside Git", async () => {
		const repo = await mkTmpRoot();
		const git = new FakeGit(repo);
		git.failWorkTree = true;
		const { service } = makeService(git);
		await expect(service.createForRun("run-1", repo)).rejects.toThrow(WorktreeGitError);
		expect(git.worktreePaths).toHaveLength(0);
	});

	it("rejects worktree creation when the repository has no HEAD", async () => {
		const repo = await mkTmpRoot();
		const git = new FakeGit(repo);
		git.failHead = true;
		const { service } = makeService(git);
		await expect(service.createForRun("run-1", repo)).rejects.toThrow(WorktreeGitError);
	});

	it("refuses to cut a worktree when the master switch is off and creates nothing", async () => {
		const repo = await mkTmpRoot();
		const git = new FakeGit(repo);
		const { service } = makeService(git, { worktreeIsolation: false });
		await expect(service.createForRun("run-1", repo)).rejects.toThrow(/disabled/);
		expect(git.worktreePaths).toHaveLength(0);
	});
});

describe("preserveForRun and explicit release", () => {
	it("retains a clean checkout until release is explicitly requested", async () => {
		const repo = await mkTmpRoot();
		const git = new FakeGit(repo);
		const { service } = makeService(git);
		const info = await service.createForRun("run-1", repo);

		const result = await service.preserveForRun(info, "explore the repo");
		expect(result).toMatchObject({
			hasChanges: false,
			branch: info.branch,
			baseSha: BASE_SHA,
			commitSha: BASE_SHA,
			commits: [],
			path: info.path,
		});
		expect(git.worktreePaths).toContain(info.checkoutRoot);
		expect(git.branches.size).toBe(0);
		expect(git.calls.some((call) => call.args[0] === "commit")).toBe(false);

		await service.releaseForRun(info);
		expect(git.worktreePaths).toHaveLength(0);
	});

	it("commits dirty changes to a retained branch and exposes ordered cherry-pick metadata", async () => {
		const repo = await mkTmpRoot();
		const git = new FakeGit(repo);
		const { service } = makeService(git);
		const info = await service.createForRun("run-1", repo);
		git.setDirty(info.checkoutRoot ?? info.path, true);

		const result = await service.preserveForRun(info, "x".repeat(300));
		expect(result).toMatchObject({
			hasChanges: true,
			branch: `agent/run-1-${BASE_SHA.slice(0, 8)}`,
			baseSha: BASE_SHA,
			commitSha: COMMITTED_SHA,
			commits: [COMMITTED_SHA],
			cherryPickCommand: `git cherry-pick ${COMMITTED_SHA}`,
			path: info.path,
		});
		expect(git.worktreePaths).toContain(info.checkoutRoot);
		expect(git.branches.has(result.branch)).toBe(true);

		const commit = git.calls.find((call) => call.args[0] === "commit");
		expect(commit?.args).toContain("--no-verify");
		const msgIndex = commit?.args.indexOf("-m") ?? -1;
		const message = commit?.args[msgIndex + 1] ?? "";
		expect(message.startsWith("pi-agent: ")).toBe(true);
		expect(message.length).toBeLessThanOrEqual("pi-agent: ".length + 200);

		await service.releaseForRun(info);
		expect(git.worktreePaths).toHaveLength(0);
		expect(git.branches.has(result.branch)).toBe(true);
	});

	it("adds a collision suffix without discarding the preserved checkout", async () => {
		const repo = await mkTmpRoot();
		const git = new FakeGit(repo);
		const { service } = makeService(git, { now: () => 1_700_000_000_000 });
		const info = await service.createForRun("run-1", repo);
		git.branches.add(info.branch ?? "");
		git.setDirty(info.path, true);

		const result = await service.preserveForRun(info, "dirty");
		expect(result.branch).toBe(`${info.branch}-1700000000000-abc12345`);
		expect(git.worktreePaths).toContain(info.checkoutRoot);
		expect(git.branches.has(result.branch)).toBe(true);
	});

	it("preserves an already-created clean commit on the result branch", async () => {
		const repo = await mkTmpRoot();
		const git = new FakeGit(repo);
		const { service } = makeService(git);
		const info = await service.createForRun("run-1", repo);
		git.setCommitted(info.path, true);

		const result = await service.preserveForRun(info, "clean but moved");
		expect(result.hasChanges).toBe(true);
		expect(result.commitSha).toBe(COMMITTED_SHA);
		expect(result.commits).toEqual([COMMITTED_SHA]);
		expect(git.worktreePaths).toContain(info.checkoutRoot);
	});

	it("refuses to release dirty or unpreserved work and keeps the checkout", async () => {
		const repo = await mkTmpRoot();
		const git = new FakeGit(repo);
		const { service } = makeService(git);
		const info = await service.createForRun("run-1", repo);
		git.setDirty(info.path, true);

		await expect(service.releaseForRun(info)).rejects.toThrow(/dirty worktree/);
		expect(git.worktreePaths).toContain(info.checkoutRoot);
	});
});

describe("orphanPrune", () => {
	it("keeps existing registered checkouts and drops stale managed registrations", async () => {
		const repo = await mkTmpRoot();
		const git = new FakeGit(repo);
		const { service } = makeService(git);

		const live = await service.createForRun("run-1", repo);
		const stale = await service.createForRun("run-2", repo);
		expect(service.orphanPrune()).toBe(0);

		await rm(stale.checkoutRoot ?? stale.path, { recursive: true, force: true });
		expect(service.orphanPrune()).toBe(1);
		expect(git.worktreePaths).toContain(live.checkoutRoot);
		expect(git.calls.some((call) => call.args[0] === "worktree" && call.args[1] === "prune")).toBe(false);
	});

	it("refuses restored registrations outside the managed checkout root", async () => {
		const repo = await mkTmpRoot();
		const git = new FakeGit(repo);
		const { service } = makeService(git);
		const outside = join("/outside", "repos", "other", "checkout");
		expect(() =>
			service.reconnect({
				baseRepo: repo,
				path: outside,
				checkoutRoot: outside,
				baseSha: BASE_SHA,
				branch: `agent/x-${BASE_SHA.slice(0, 8)}`,
			}),
		).toThrow(/outside managed root/);
	});
});

describe("real Git preservation safety", () => {
	it("preserves through canonical /var and /private/var checkout aliases", async () => {
		const { root, run } = await makeRealGitRepo();
		const canonicalRoot = await realpath(root);
		const tmpRoot = join(root, "worktrees");
		await mkdir(tmpRoot, { recursive: true });
		const service = new WorktreeService({
			runGit: run,
			tmpRoot,
			settings: sanitizeSettings({ worktreeIsolation: true }),
			uniqueSuffix: () => "aliascase",
		});
		const info = await service.createForRun("alias-case", root);
		const aliasPath = join(root, "checkout-alias");
		await symlink(info.checkoutRoot ?? info.path, aliasPath, "dir");
		const result = await service.preserveForRun({ ...info, path: aliasPath }, "alias result");

		expect(canonicalRoot).toBe(await realpath(root));
		expect(await realpath(aliasPath)).toBe(info.checkoutRoot);
		expect(result.path).toBe(aliasPath);
		expect(result.hasChanges).toBe(false);
		expect(existsSync(info.checkoutRoot ?? info.path)).toBe(true);
		await service.releaseForRun(info);
		expect(existsSync(info.checkoutRoot ?? info.path)).toBe(false);
	}, 20_000);

	it("keeps the checkout and user data intact when Git cannot commit changes", async () => {
		const { root, run } = await makeRealGitRepo();
		const tmpRoot = join(root, "worktrees");
		await mkdir(tmpRoot, { recursive: true });
		let failCommit = false;
		const failingRun: GitRunner = async (args, options) => {
			if (failCommit && args[0] === "commit") throw new Error("configured commit failure");
			return run(args, options);
		};
		const service = new WorktreeService({
			runGit: failingRun,
			tmpRoot,
			settings: sanitizeSettings({ worktreeIsolation: true }),
			uniqueSuffix: () => "commitfailure",
		});
		const info = await service.createForRun("commit-failure", root);
		const userDataPath = join(info.checkoutRoot ?? info.path, "valuable.txt");
		await writeFile(userDataPath, "keep every byte\n", "utf8");
		failCommit = true;

		await expect(service.preserveForRun(info, "cannot lose this")).rejects.toThrow(/preservation failed/);
		expect(existsSync(info.checkoutRoot ?? info.path)).toBe(true);
		expect(await readFile(userDataPath, "utf8")).toBe("keep every byte\n");
		expect((await run(["status", "--porcelain"], { cwd: info.checkoutRoot ?? info.path })).stdout).toContain(
			"valuable.txt",
		);
		await expect(service.releaseForRun(info)).rejects.toThrow(/dirty worktree/);
		expect(existsSync(info.checkoutRoot ?? info.path)).toBe(true);
	}, 20_000);
});
