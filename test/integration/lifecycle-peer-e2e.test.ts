import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../../extension-src/pi-teams/app/agent-manager.js";
import { AgentRegistry } from "../../extension-src/pi-teams/app/agent-registry.js";
import { TeamService } from "../../extension-src/pi-teams/app/team-service.js";
import { sanitizeSettings } from "../../extension-src/pi-teams/domain/config.js";
import type { LauncherHandle, ProcessLauncher } from "../../extension-src/pi-teams/domain/process-launcher.js";
import { startPeerRuntime } from "../../extension-src/pi-teams/pi/peer-runtime.js";
import { ProcessAgentExecutionBackend } from "../../extension-src/pi-teams/pi/process-backend.js";
import { createProcessLaunchers } from "../../extension-src/pi-teams/pi/process-launchers.js";
import { createPiTeamStore } from "../../extension-src/pi-teams/pi/teams-host.js";

let root: string | undefined;
let peerRoot: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let priorChildEnv: string | undefined;
const peerRuntimes: Array<Awaited<ReturnType<typeof startPeerRuntime>>> = [];
const peerSessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
afterEach(async () => {
	for (const runtime of peerRuntimes.splice(0)) await runtime?.dispose();
	for (const session of peerSessions.splice(0)) await session.abort();
	if (server?.listening) await new Promise<void>((resolve) => server?.close(() => resolve()));
	server = undefined;
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
	if (peerRoot) await rm(peerRoot, { recursive: true, force: true });
	peerRoot = undefined;
	if (priorChildEnv === undefined) delete process.env.PI_TEAMS_CHILD;
	else process.env.PI_TEAMS_CHILD = priorChildEnv;
	priorChildEnv = undefined;
});

function sdkAdapter(
	session: Awaited<ReturnType<typeof createAgentSession>>["session"],
	accepted: string[],
): ExtensionAPI {
	const handlers = new Map<string, Set<(event: never) => void>>();
	session.subscribe((event) => {
		if (event.type === "message_start" && "message" in event && event.message.role === "user") {
			const content = event.message.content;
			const text =
				typeof content === "string"
					? content
					: content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("");
			if (text.includes("[peer-delivery:")) accepted.push(text);
		}
		for (const handler of handlers.get(event.type) ?? []) handler(event as never);
	});
	return {
		on(event, handler) {
			const set = handlers.get(event) ?? new Set();
			set.add(handler as (event: never) => void);
			handlers.set(event, set);
			return () => set.delete(handler as (event: never) => void);
		},
		sendUserMessage(content, options) {
			void session
				.prompt(typeof content === "string" ? content : content.map((part) => part.text ?? "").join(""), {
					...options,
					streamingBehavior: options?.deliverAs === "steer" ? "steer" : "followUp",
					expandPromptTemplates: false,
				})
				.catch(() => undefined);
		},
	} as ExtensionAPI;
}
async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("timed out waiting for native peer state");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("native teammate lifecycle and independent peer sessions", () => {
	it("removes and reuses a native teammate name without disturbing independent SDK peer sessions", async () => {
		priorChildEnv = process.env.PI_TEAMS_CHILD;
		delete process.env.PI_TEAMS_CHILD;
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

			const oldMembership = team.current?.members.find((member) => member.name === "reusable")?.membershipId;
			expect(oldMembership).toBeDefined();
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
			const newMember = team.current?.members.find((member) => member.name === "reusable");
			expect(newMember?.membershipId).toBeDefined();
			expect(newMember?.membershipId).not.toBe(oldMembership);
			expect(team.removeMember("reusable", oldMembership)).toBe(false);

			// Peer identity is session/runtime-scoped and independent of teammate membership.
			const makeSdkSession = async (id: string) => {
				const { session } = await createAgentSession({
					cwd,
					agentDir,
					noTools: "all",
					sessionManager: SessionManager.inMemory(cwd, { id }),
				});
				peerSessions.push(session);
				return session;
			};
			peerRoot = await mkdtemp(join("/tmp", "pe-"));
			const peerA = await makeSdkSession("independent-peer-a");
			const peerB = await makeSdkSession("independent-peer-b");
			const accepted: string[] = [];
			for (const [session, id] of [
				[peerA, "independent-peer-a"],
				[peerB, "independent-peer-b"],
			] as const) {
				let peerStartupError: unknown;
				const runtime = await startPeerRuntime({
					pi: sdkAdapter(session, id === "independent-peer-b" ? accepted : []),
					ctx: { sessionManager: session.sessionManager, ui: { notify() {} } } as unknown as ExtensionContext,
					root: peerRoot,
					enabled: true,
					policy: "accept",
					onError(error) {
						peerStartupError = error;
					},
				});
				if (!runtime) throw new Error(`peer runtime ${id} did not start: ${String(peerStartupError)}`);
				peerRuntimes.push(runtime);
			}
			const [runtimeA, runtimeB] = peerRuntimes;
			if (!runtimeA || !runtimeB) throw new Error("independent peer runtimes missing");
			const peerAd = (await runtimeA.discovery.discover(runtimeA.projectId)).find(
				(peer) => peer.peerSessionId === "independent-peer-b",
			);
			if (!peerAd) throw new Error("counterpart peer advertisement missing");
			const peerSent = await runtimeA.messaging.send(peerAd, "after member shutdown");
			await waitFor(() => accepted.some((message) => message.includes("after member shutdown")));
			await waitFor(async () => (await runtimeB.messaging.receipt(peerSent.messageId)).receipt === "delivered");
			expect(accepted).toHaveLength(1);
			expect(peerA.isIdle).toBe(true);
			expect(peerB.isIdle).toBe(true);
		} finally {
			releaseResolve();
			await manager.dispose();
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		}
	}, 60_000);
});
