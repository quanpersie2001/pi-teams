import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../../extension-src/pi-teams/app/agent-manager.js";
import { AgentRegistry } from "../../extension-src/pi-teams/app/agent-registry.js";
import { TeamService } from "../../extension-src/pi-teams/app/team-service.js";
import { sanitizeSettings } from "../../extension-src/pi-teams/domain/config.js";
import type { LauncherHandle, ProcessLauncher } from "../../extension-src/pi-teams/domain/process-launcher.js";
import { ProcessAgentExecutionBackend } from "../../extension-src/pi-teams/pi/process-backend.js";
import { createProcessLaunchers } from "../../extension-src/pi-teams/pi/process-launchers.js";
import { createPiTeamStore } from "../../extension-src/pi-teams/pi/teams-host.js";

let root: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
afterEach(async () => {
	if (server?.listening) await new Promise<void>((resolve) => server?.close(() => resolve()));
	server = undefined;
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

describe("native manager shutdown smoke", () => {
	it("shuts down a busy named Pi child, removes membership, and permits fresh same-name identity", async () => {
		root = await mkdtemp(join(tmpdir(), "pi-teams-shutdown-manager-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		await mkdir(agentDir, { recursive: true });
		await mkdir(cwd, { recursive: true });
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		let receivedResolve!: () => void;
		const received = new Promise<void>((resolve) => {
			receivedResolve = resolve;
		});
		let releaseResolve!: () => void;
		const release = new Promise<void>((resolve) => {
			releaseResolve = resolve;
		});
		server = createServer((request, response) => {
			request.resume();
			request.on("end", async () => {
				receivedResolve();
				await release;
				response.writeHead(200, { "content-type": "text/event-stream" });
				for (const chunk of [
					{ choices: [{ index: 0, delta: { role: "assistant", content: "local-ok" }, finish_reason: null }] },
					{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
					{ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
				])
					response.write(
						`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "local", ...chunk })}\n\n`,
					);
				response.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("local provider failed to bind");
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"local-test": {
						baseUrl: `http://127.0.0.1:${address.port}/v1`,
						apiKey: "offline",
						api: "openai-completions",
						models: [
							{
								id: "local-model",
								name: "local",
								reasoning: false,
								input: ["text"],
								contextWindow: 4096,
								maxTokens: 128,
							},
						],
					},
				},
			}),
		);

		const children: Array<{ handle: LauncherHandle; exited: Promise<void> }> = [];
		const exits: Promise<void>[] = [];
		const observedSpawn = ((...args: Parameters<typeof spawn>) => {
			const child = spawn(...args);
			const done = Promise.withResolvers<void>();
			child.once("exit", () => done.resolve());
			exits.push(done.promise);
			return child;
		}) as typeof spawn;
		const base = createProcessLaunchers({ spawnProcess: observedSpawn }).find((item) => item.kind === "headless");
		if (!base) throw new Error("headless launcher unavailable");
		const launcher: ProcessLauncher = {
			kind: "headless",
			available: () => base.available(),
			async launch(spec) {
				const handle = await base.launch(spec);
				const exited = exits.shift();
				if (!exited) throw new Error("missing child exit watcher");
				children.push({ handle, exited });
				return handle;
			},
			alive: (handle) => base.alive(handle),
			cleanupExited: (handle) => base.cleanupExited(handle),
			terminate: (handle) => base.terminate(handle),
			...(base.forceKill ? { forceKill: (handle: LauncherHandle) => base.forceKill?.(handle) } : {}),
		};
		const backend = new ProcessAgentExecutionBackend({ launchers: [launcher], connectTimeoutMs: 15_000 });
		const settings = sanitizeSettings({ maxConcurrent: 1, backgroundByDefault: true, worktreeIsolation: false });
		const registry = new AgentRegistry({
			sources: [],
			loader: async () => [
				{
					sourcePath: join(cwd, "worker.md"),
					filenameStem: "worker",
					frontmatter: { name: "worker", model: "local-test/local-model", tools: "none", max_turns: 1 },
					body: "local fixture",
				},
			],
			settings,
		});
		await registry.load();
		const team = new TeamService({
			sessionId: "native-shutdown-smoke",
			store: createPiTeamStore(cwd, "native-shutdown-smoke"),
		});
		team.sessionStart();
		const manager = new AgentManager({ registry, settings, backends: [backend], cwd, configCwd: cwd });
		manager.setTeamService(team);
		try {
			const run = await manager.spawn({ type: "worker", name: "reusable", prompt: "wait for shutdown" });
			await received;
			const firstPid = children[0]?.handle.pid;
			expect(firstPid).toBeDefined();
			expect(firstPid).not.toBe(process.pid);

			// Occupied concurrency slot: this named assignment is genuinely queued and
			// must be canceled without starting a second native process.
			const queued = await manager.spawn({ type: "worker", name: "queued-name", prompt: "must never launch" });
			expect(manager.get(queued.id)?.status).toBe("queued");
			await expect(manager.shutdownTeammate("queued-name")).resolves.toBe(true);
			expect((await manager.whenSettled(queued.id))?.status).toBe("stopped");
			expect(children).toHaveLength(1);
			expect(team.current?.members.some((member) => member.name === "queued-name")).toBe(false);
			expect(manager.get(run.id)?.status).toBe("running");

			const closing = manager.shutdownTeammate("reusable");
			// The real local provider remains held while shutdown must abort and verify its child.
			await expect(closing).resolves.toBe(true);
			const settled = await manager.whenSettled(run.id);
			expect(settled?.status).toBe("stopped");
			await children[0]?.exited;
			if (firstPid) expect(() => process.kill(firstPid, 0)).toThrow(/ESRCH/);
			expect(team.current?.members.some((member) => member.name === "reusable")).toBe(false);
			releaseResolve();
			const next = await manager.spawn({ type: "worker", name: "reusable", prompt: "new membership" });
			releaseResolve();
			expect((await manager.whenSettled(next.id))?.status).toBe("completed");
			expect(children[1]?.handle.pid).not.toBe(firstPid);
		} finally {
			releaseResolve();
			await manager.dispose();
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		}
	}, 60_000);
});
