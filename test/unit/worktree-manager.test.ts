// AgentManager × WorktreeService integration with a deterministic process
// backend fake and Git runner — no child model calls or real Git operations.
//
// Covers opt-in worktree creation, preservation across terminal outcomes,
// commit/branch metadata, and shared-workspace-by-default behavior.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../../extension-src/pi-teams/app/agent-manager.js";
import { AgentRegistry } from "../../extension-src/pi-teams/app/agent-registry.js";
import { WorktreeService } from "../../extension-src/pi-teams/app/worktree-service.js";
import { type SubagentsSettings, sanitizeSettings } from "../../extension-src/pi-teams/domain/config.js";
import type { AgentLifecycleEvent } from "../../extension-src/pi-teams/domain/integration-protocol.js";
import { FakeBackend } from "../helpers/fake-backend.js";
import { BASE_SHA, FakeGit } from "../helpers/fake-git.js";

const tempRoots: string[] = [];
afterEach(async () => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) await rm(root, { recursive: true, force: true });
	}
});

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let turn = 0; turn < 128 && !predicate(); turn += 1) await Promise.resolve();
	if (!predicate()) throw new Error("condition was not reached");
}

/** A worktree-isolation-pinned specialist definition. */
const WORKTREE_AGENT = {
	sourcePath: "/agents/wt.md",
	frontmatter: { name: "worktree-specialist", isolation: "worktree" },
	body: "Do isolated work.",
	filenameStem: "wt",
};

interface Fixture {
	manager: AgentManager;
	backend: FakeBackend;
	git: FakeGit;
	worktree: WorktreeService;
	events: AgentLifecycleEvent[];
	repo: string;
	tmpRoot: string;
	nextId: () => string;
}

async function makeFixture(settingsOverrides: Partial<SubagentsSettings> = {}): Promise<Fixture> {
	const repo = await mkdtemp(join(tmpdir(), "teams-mgr-"));
	tempRoots.push(repo);
	const tmpRoot = await mkdtemp(join(tmpdir(), "teams-wt-"));
	tempRoots.push(tmpRoot);

	const backend = new FakeBackend();
	const git = new FakeGit(repo);
	const registry = new AgentRegistry({
		sources: [],
		loader: async () => [WORKTREE_AGENT],
		settings: sanitizeSettings({ backgroundByDefault: true, ...settingsOverrides }),
	});
	await registry.load();
	const worktree = new WorktreeService({
		runGit: git.run,
		tmpRoot,
		settings: sanitizeSettings(settingsOverrides),
		uniqueSuffix: () => "abc12345",
	});
	let next = 0;
	const manager = new AgentManager({
		registry,
		settings: sanitizeSettings({ backgroundByDefault: true, ...settingsOverrides }),
		backends: [backend],
		cwd: repo,
		configCwd: repo,
		worktreeService: worktree,
		idFactory: () => {
			next += 1;
			return `run-${next}`;
		},
	});
	const events: AgentLifecycleEvent[] = [];
	manager.subscribe((event) => events.push(event));
	return { manager, backend, git, worktree, events, repo, tmpRoot, nextId: () => `run-${next + 1}` };
}

const wtType = (): { type: "worktree-specialist" } => ({ type: "worktree-specialist" });

describe("worktree isolation through the manager", () => {
	it("cuts an opted-in worktree before launch and retains its checkout after settlement", async () => {
		const fixture = await makeFixture({ worktreeIsolation: true });
		const record = await fixture.manager.spawn({ ...wtType(), prompt: "go", run_in_background: true });

		await waitFor(() => fixture.backend.launches.length > 0);
		const launch = fixture.backend.launches[0];
		const worktreePath = launch?.cwd ?? "";
		expect(worktreePath).toMatch(new RegExp(`pi-teams-${record.id}-abc12345$`));
		expect(launch?.isolation).toBe("worktree");
		expect(launch?.configCwd).toBe(fixture.repo);
		expect(fixture.manager.get(record.id)?.worktree?.path).toBe(worktreePath);
		expect(fixture.git.calls.some((call) => call.args.join(" ").startsWith("worktree add --detach"))).toBe(true);

		fixture.git.setDirty(worktreePath, true);
		fixture.backend.complete(record.id, "result");
		await fixture.manager.whenSettled(record.id);

		const settled = fixture.manager.get(record.id);
		expect(settled?.status).toBe("completed");
		expect(settled?.worktree?.path).toBe(worktreePath);
		expect(settled?.worktreeResult).toMatchObject({
			hasChanges: true,
			branch: `agent/${record.id}-${BASE_SHA.slice(0, 8)}`,
			path: worktreePath,
		});
		expect(fixture.git.worktreePaths).toContain(worktreePath);
		expect(fixture.git.branches.has(settled?.worktreeResult?.branch ?? "")).toBe(true);
		expect(fixture.git.calls.some((call) => call.args[0] === "commit")).toBe(true);
	});

	it("retains opted-in checkout and uncommitted changes after a stopped run", async () => {
		const fixture = await makeFixture({ worktreeIsolation: true });
		const record = await fixture.manager.spawn({ ...wtType(), prompt: "go", run_in_background: true });
		await waitFor(() => fixture.backend.launches.length > 0);
		const worktreePath = fixture.backend.launches[0]?.cwd ?? "";
		fixture.git.setDirty(worktreePath, true);

		expect(await fixture.manager.stop(record.id)).toBe(true);
		fixture.backend.settleStopped(record.id);
		await fixture.manager.whenSettled(record.id);

		const settled = fixture.manager.get(record.id);
		expect(settled?.status).toBe("stopped");
		expect(settled?.worktree?.path).toBe(worktreePath);
		expect(settled?.worktreeResult?.hasChanges).toBe(true);
		expect(fixture.git.worktreePaths).toContain(worktreePath);
		expect(fixture.git.branches.has(settled?.worktreeResult?.branch ?? "")).toBe(true);
	});

	it("retains changed checkouts and preserves them on failure settlement", async () => {
		const fixture = await makeFixture({ worktreeIsolation: true });
		const record = await fixture.manager.spawn({ ...wtType(), prompt: "go", run_in_background: true });
		await waitFor(() => fixture.backend.launches.length > 0);
		const worktreePath = fixture.backend.launches[0]?.cwd ?? "";
		fixture.git.setDirty(worktreePath, true);

		fixture.backend.fail(record.id, "child failed");
		await fixture.manager.whenSettled(record.id);
		const settled = fixture.manager.get(record.id);
		expect(settled?.status).toBe("error");
		expect(settled?.worktreeResult?.hasChanges).toBe(true);
		expect(fixture.git.worktreePaths).toContain(worktreePath);
		expect(fixture.git.branches.has(settled?.worktreeResult?.branch ?? "")).toBe(true);
	});

	it("automatically closes the child while retaining its worktree for review", async () => {
		const fixture = await makeFixture({ worktreeIsolation: true });
		const record = await fixture.manager.spawn({ ...wtType(), prompt: "go", run_in_background: true });
		await waitFor(() => fixture.backend.launches.length > 0);
		const worktreePath = fixture.backend.launches[0]?.cwd ?? "";
		fixture.git.setDirty(worktreePath, true);
		fixture.backend.complete(record.id, "result");
		await fixture.manager.whenSettled(record.id);

		expect(fixture.backend.disposedHandles).toHaveLength(1);
		expect(fixture.manager.get(record.id)?.handle).toBeUndefined();
		expect(fixture.manager.get(record.id)?.worktree?.path).toBe(worktreePath);
		expect(fixture.git.worktreePaths).toContain(worktreePath);
	});

	it("removes only an explicitly released clean checkout and retains result history", async () => {
		const fixture = await makeFixture({ worktreeIsolation: true });
		const record = await fixture.manager.spawn({ ...wtType(), prompt: "go", run_in_background: true });
		await waitFor(() => fixture.backend.launches.length > 0);
		const worktreePath = fixture.backend.launches[0]?.cwd ?? "";
		fixture.backend.complete(record.id, "result");
		await fixture.manager.whenSettled(record.id);

		expect(await fixture.manager.release(record.id, { cleanupWorktree: true })).toBe(true);
		expect(fixture.git.worktreePaths).not.toContain(worktreePath);
		expect(fixture.manager.get(record.id)?.worktree).toBeUndefined();
		expect(fixture.manager.get(record.id)?.worktreeReleased).toBe(true);
		expect(fixture.manager.get(record.id)?.worktreeResult).toMatchObject({ hasChanges: false, path: worktreePath });
	});

	it("removes an explicitly released preserved checkout while retaining its branch and result", async () => {
		const fixture = await makeFixture({ worktreeIsolation: true });
		const record = await fixture.manager.spawn({ ...wtType(), prompt: "go", run_in_background: true });
		await waitFor(() => fixture.backend.launches.length > 0);
		const worktreePath = fixture.backend.launches[0]?.cwd ?? "";
		fixture.git.setDirty(worktreePath, true);
		fixture.backend.complete(record.id, "result");
		await fixture.manager.whenSettled(record.id);
		const branch = fixture.manager.get(record.id)?.worktreeResult?.branch;

		expect(await fixture.manager.release(record.id, { cleanupWorktree: true })).toBe(true);
		expect(fixture.git.worktreePaths).not.toContain(worktreePath);
		expect(fixture.git.branches.has(branch ?? "")).toBe(true);
		expect(fixture.manager.get(record.id)?.worktree).toBeUndefined();
		expect(fixture.manager.get(record.id)?.worktreeReleased).toBe(true);
		expect(fixture.manager.get(record.id)?.worktreeResult).toMatchObject({
			hasChanges: true,
			path: worktreePath,
			branch,
		});
	});

	it("defaults to shared workspace and creates no worktree", async () => {
		const fixture = await makeFixture({ worktreeIsolation: false });
		await fixture.manager.spawn({ ...wtType(), prompt: "go", run_in_background: true });
		await waitFor(() => fixture.backend.launches.length > 0);

		const launch = fixture.backend.launches[0];
		expect(launch?.isolation).toBe("off");
		expect(launch?.cwd).toBe(fixture.repo);
		expect(fixture.git.calls.some((call) => call.args.join(" ").startsWith("worktree add"))).toBe(false);
		expect(fixture.git.worktreePaths).toHaveLength(0);
	});
});
