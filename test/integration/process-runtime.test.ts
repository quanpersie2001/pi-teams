import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../../extension-src/pi-teams/app/agent-manager.js";
import { AgentRegistry } from "../../extension-src/pi-teams/app/agent-registry.js";
import type { SerializableBackendHandle, SubagentRunStore } from "../../extension-src/pi-teams/app/run-registry.js";
import { TaskBoardService } from "../../extension-src/pi-teams/app/task-board-service.js";
import { TeamService } from "../../extension-src/pi-teams/app/team-service.js";
import { buildAgentListView } from "../../extension-src/pi-teams/app/ui-snapshot.js";
import { type AgentRun, isTerminalStatus } from "../../extension-src/pi-teams/domain/agent-run.js";
import type {
	AgentBackendHandle,
	AgentLaunchInput,
	BackendStatus,
} from "../../extension-src/pi-teams/domain/backend.js";
import { sanitizeSettings } from "../../extension-src/pi-teams/domain/config.js";
import type { LauncherHandle, ProcessLauncher } from "../../extension-src/pi-teams/domain/process-launcher.js";
import { deriveViewerToken } from "../../extension-src/pi-teams/pi/child-rpc-auth.js";
import { ChildRpcClient } from "../../extension-src/pi-teams/pi/child-rpc-client.js";
import { ProcessAgentExecutionBackend } from "../../extension-src/pi-teams/pi/process-backend.js";
import { createProcessLaunchers } from "../../extension-src/pi-teams/pi/process-launchers.js";
import { createSubagentRunStore } from "../../extension-src/pi-teams/pi/registry-host.js";
import { createPiTeamStore } from "../../extension-src/pi-teams/pi/teams-host.js";

const tempRoots: string[] = [];
const servers: Server[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(async () => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	while (servers.length > 0) {
		const server = servers.pop();
		if (server?.listening) {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	}
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) await rm(root, { recursive: true, force: true });
	}
});

interface LocalProvider {
	cwd: string;
	requests: string[];
	firstRequest: Promise<void>;
	releaseFirst(): void;
	releaseRequest(index: number): void;
}

async function localProvider(
	options: { holdFirst?: boolean; holdRequests?: number[]; createTeamTask?: boolean } = {},
): Promise<LocalProvider> {
	const root = await mkdtemp(join(tmpdir(), "teams-process-runtime-"));
	tempRoots.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(agentDir, { recursive: true });
	await mkdir(cwd, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const requests: string[] = [];
	const firstRequest = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const heldRequests = new Map((options.holdRequests ?? []).map((index) => [index, Promise.withResolvers<void>()]));
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", async () => {
			const requestIndex = requests.length;
			requests.push(body);
			if (requests.length === 1) {
				firstRequest.resolve();
				if (options.holdFirst) await released.promise;
			}
			await heldRequests.get(requestIndex)?.promise;
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			const prefix = { id: "chatcmpl-local", object: "chat.completion.chunk", created: 1, model: "local-model" };
			const createTask = options.createTeamTask && JSON.parse(body).messages.at(-1)?.role === "user";
			const delta = createTask
				? {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: `native-task-${requests.length}`,
								type: "function",
								function: { name: "team_task_create", arguments: JSON.stringify({ title: "Cold continuation task" }) },
							},
						],
					}
				: { role: "assistant", content: "process-child-ok" };
			for (const chunk of [
				{
					...prefix,
					choices: [{ index: 0, delta, finish_reason: null }],
				},
				{ ...prefix, choices: [{ index: 0, delta: {}, finish_reason: createTask ? "tool_calls" : "stop" }] },
				{ ...prefix, choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
			])
				response.write(`data: ${JSON.stringify(chunk)}\n\n`);
			response.end("data: [DONE]\n\n");
		});
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("local provider did not bind a TCP port");
	const baseUrl = `http://127.0.0.1:${address.port}/v1`;
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"local-test": {
					baseUrl,
					apiKey: "local-test-key",
					api: "openai-completions",
					models: [
						{
							id: "local-model",
							name: "Local deterministic model",
							reasoning: false,
							input: ["text"],
							contextWindow: 4096,
							maxTokens: 128,
						},
					],
				},
			},
		}),
		"utf8",
	);
	return {
		cwd,
		requests,
		firstRequest: firstRequest.promise,
		releaseFirst: released.resolve,
		releaseRequest: (index) => heldRequests.get(index)?.resolve(),
	};
}

function launchInput(runId: string, cwd: string): AgentLaunchInput {
	return {
		runId,
		type: "runtime-test",
		description: "real process integration",
		prompt: `Return exactly process-child-ok (${runId})`,
		systemPrompt: "",
		promptMode: "append",
		model: "local-test/local-model",
		tools: [],
		maxTurns: 1,
		cwd,
		configCwd: cwd,
		background: true,
	};
}

function terminal(status: BackendStatus): boolean {
	return (
		status.state === "completed" ||
		status.state === "failed" ||
		status.state === "stopped" ||
		status.state === "timeout"
	);
}

async function waitForTerminal(
	backend: ProcessAgentExecutionBackend,
	handle: AgentBackendHandle,
): Promise<BackendStatus> {
	const initial = await backend.status(handle);
	if (terminal(initial)) return initial;
	return new Promise<BackendStatus>((resolve, reject) => {
		let unsubscribe = () => {};
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error("headless child did not settle before the integration timeout"));
		}, 20_000);
		unsubscribe = backend.subscribe(handle, (status) => {
			if (!terminal(status)) return;
			clearTimeout(timer);
			unsubscribe();
			resolve(status);
		});
		void backend.status(handle).then(
			(status) => {
				if (!terminal(status)) return;
				clearTimeout(timer);
				unsubscribe();
				resolve(status);
			},
			(error: unknown) => {
				clearTimeout(timer);
				unsubscribe();
				reject(error);
			},
		);
	});
}
type ProviderBehavior =
	| { kind: "complete"; content: string }
	/** SSE deltas every intervalMs forever; the request stays open until the client aborts. */
	| { kind: "stream"; intervalMs: number; content: string }
	/**
	 * Emit one bash tool_call for `command` (finish_reason tool_calls) and hold
	 * the response open, so the native child executes the tool while the model
	 * request stays unfinished.
	 */
	| { kind: "toolcall"; command: string }
	/** SSE headers only; the child waits on a silent model request. */
	| { kind: "hold" };

interface ScriptedProvider {
	cwd: string;
	/** Raw request bodies in arrival order. */
	requests: string[];
	/** Indices of requests the child aborted before the scripted response finished. */
	aborted: number[];
	firstRequest: Promise<void>;
	requestAt(index: number): Promise<void>;
	release(): void;
}

/**
 * Deterministic local OpenAI-compatible SSE provider. Request N is handled by
 * behaviors[N] (the last behavior repeats), so one provider can script a
 * budget abort followed by a completing resume turn.
 */
async function scriptedProvider(behaviors: readonly ProviderBehavior[]): Promise<ScriptedProvider> {
	const root = await mkdtemp(join(tmpdir(), "teams-budget-runtime-"));
	tempRoots.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(agentDir, { recursive: true });
	await mkdir(cwd, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const requests: string[] = [];
	const aborted: number[] = [];
	const arrivals = behaviors.map(() => Promise.withResolvers<void>());
	const firstRequest = arrivals[0]?.promise ?? Promise.resolve();
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("close", () => {
			if (!response.writableEnded) aborted.push(requests.length - 1);
		});
		request.on("end", () => {
			const index = requests.push(body) - 1;
			arrivals[index]?.resolve();
			const behavior = behaviors[Math.min(index, behaviors.length - 1)];
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			const prefix = { id: "chatcmpl-local", object: "chat.completion.chunk", created: 1, model: "local-model" };
			if (!behavior || behavior.kind === "hold") return;
			if (behavior.kind === "complete") {
				for (const chunk of [
					{
						...prefix,
						choices: [{ index: 0, delta: { role: "assistant", content: behavior.content }, finish_reason: null }],
					},
					{ ...prefix, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
					{ ...prefix, choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
				])
					response.write(`data: ${JSON.stringify(chunk)}\n\n`);
				response.end("data: [DONE]\n\n");
				return;
			}
			if (behavior.kind === "toolcall") {
				const toolCall = (delta: Record<string, unknown>, finish: string | null): string =>
					`data: ${JSON.stringify({
						...prefix,
						choices: [{ index: 0, delta, finish_reason: finish }],
					})}\n\n`;
				response.write(
					toolCall(
						{
							role: "assistant",
							tool_calls: [
								{ index: 0, id: `call_${index}`, type: "function", function: { name: "bash", arguments: "" } },
							],
						},
						null,
					),
				);
				response.write(
					toolCall(
						{ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: behavior.command }) } }] },
						null,
					),
				);
				response.write(toolCall({}, "tool_calls"));
				response.write(
					`data: ${JSON.stringify({ ...prefix, choices: [], usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } })}\n\n`,
				);
				// The model turn is complete ([DONE]); the child now executes the tool
				// while the run keeps going.
				response.end("data: [DONE]\n\n");
				return;
			}
			let tick = 0;
			response.write(
				`data: ${JSON.stringify({
					...prefix,
					choices: [{ index: 0, delta: { role: "assistant", content: `${behavior.content}-0` }, finish_reason: null }],
				})}\n\n`,
			);
			const timer = setInterval(() => {
				tick += 1;
				response.write(
					`data: ${JSON.stringify({
						...prefix,
						choices: [{ index: 0, delta: { content: `${behavior.content}-${tick}` }, finish_reason: null }],
					})}\n\n`,
				);
			}, behavior.intervalMs);
			response.on("close", () => clearInterval(timer));
		});
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("local provider did not bind a TCP port");
	const baseUrl = `http://127.0.0.1:${address.port}/v1`;
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"local-test": {
					baseUrl,
					apiKey: "local-test-key",
					api: "openai-completions",
					models: [
						{
							id: "local-model",
							name: "Local deterministic model",
							reasoning: false,
							input: ["text"],
							contextWindow: 4096,
							maxTokens: 128,
						},
					],
				},
			},
		}),
		"utf8",
	);
	return {
		cwd,
		requests,
		aborted,
		firstRequest,
		requestAt: (index: number) => arrivals[index]?.promise ?? Promise.resolve(),
		release: () => undefined,
	};
}

interface ObservedLaunchers {
	launcher: ProcessLauncher;
	/** One entry per native child this launcher started, with its exit signal. */
	launched: Array<{ handle: LauncherHandle; exited: Promise<void> }>;
	spawned: ChildProcess[];
}

/** Headless launcher that records every native child it spawns plus a verified exit signal per child. */
function observedHeadlessLaunchers(): ObservedLaunchers {
	const spawned: ChildProcess[] = [];
	const exits: Promise<void>[] = [];
	const observedSpawn = ((...args: Parameters<typeof spawn>) => {
		const child = spawn(...args);
		const exited = Promise.withResolvers<void>();
		child.once("exit", () => exited.resolve());
		spawned.push(child);
		exits.push(exited.promise);
		return child;
	}) as typeof spawn;
	const base = createProcessLaunchers({ spawnProcess: observedSpawn }).find(
		(candidate) => candidate.kind === "headless",
	);
	if (!base) throw new Error("headless process launcher is unavailable");
	const launched: Array<{ handle: LauncherHandle; exited: Promise<void> }> = [];
	const launcher: ProcessLauncher = {
		kind: "headless",
		available: () => base.available(),
		async launch(spec) {
			const handle = await base.launch(spec);
			const exited = exits.shift();
			if (!exited) throw new Error("child exit watcher was not registered before launch");
			launched.push({ handle, exited });
			return handle;
		},
		alive: (handle) => base.alive(handle),
		cleanupExited: (handle) => base.cleanupExited(handle),
		terminate: (handle) => base.terminate(handle),
		// Budget enforcement escalates to SIGKILL only through the launcher's own
		// port; expose it exactly when the real headless launcher provides it.
		...(base.forceKill !== undefined
			? {
					forceKill: async (handle: LauncherHandle) => {
						await base.forceKill?.(handle);
					},
				}
			: {}),
	};
	return { launcher, launched, spawned };
}

interface BudgetHarness {
	provider: ScriptedProvider;
	manager: AgentManager;
	store: SubagentRunStore;
	launch: ObservedLaunchers;
	allocatedIds: () => number;
}

/**
 * Manager stack over the real process backend and native headless launcher,
 * with scripted definitions for budget scenarios.
 */
async function budgetHarness(options: {
	behaviors: readonly ProviderBehavior[];
	definitions: ReadonlyArray<{ frontmatter: Record<string, unknown>; body?: string }>;
	settings?: Record<string, unknown>;
}): Promise<BudgetHarness> {
	const provider = await scriptedProvider(options.behaviors);
	const launch = observedHeadlessLaunchers();
	const backend = new ProcessAgentExecutionBackend({ launchers: [launch.launcher], connectTimeoutMs: 15_000 });
	const settings = sanitizeSettings({ backgroundByDefault: true, worktreeIsolation: false, ...options.settings });
	const registry = new AgentRegistry({
		sources: [],
		loader: async () =>
			options.definitions.map((definition) => ({
				sourcePath: join(provider.cwd, `${String(definition.frontmatter.name)}.md`),
				frontmatter: {
					description: "native budget regression agent",
					model: "local-test/local-model",
					tools: "none",
					max_turns: 1,
					...definition.frontmatter,
				},
				body: definition.body ?? "Use the local deterministic provider.",
				filenameStem: String(definition.frontmatter.name),
			})),
		settings,
	});
	await registry.load();
	const store = createSubagentRunStore(provider.cwd);
	let allocated = 0;
	const manager = new AgentManager({
		registry,
		settings,
		backends: [backend],
		cwd: provider.cwd,
		configCwd: provider.cwd,
		registryStore: store,
		idFactory: () => `budget-run-${++allocated}`,
	});
	return {
		provider,
		manager,
		store,
		launch,
		allocatedIds: () => allocated,
	};
}

/**
 * Polls until the native child is admitted and streaming. Wall-clock polling
 * is deliberate: the budget feature under test is defined against the real
 * platform clock, so deterministic timer control cannot express it.
 */
async function waitUntilRunning(manager: AgentManager, runId: string, timeoutMs = 12_000): Promise<AgentRun> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const record = manager.get(runId);
		if (record === undefined) throw new Error(`Unknown run ${runId}`);
		if (record.status === "running") return record;
		if (isTerminalStatus(record.status)) throw new Error(`Run ${runId} settled early as ${record.status}`);
		if (Date.now() > deadline) throw new Error(`Run ${runId} never started streaming within ${timeoutMs}ms`);
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
	}
}

/** Resolves once the run's budget clocks have been live for at least `elapsedMs`. */
async function waitUntilBudgetElapsed(manager: AgentManager, record: AgentRun, elapsedMs: number): Promise<AgentRun> {
	const startedAt = record.budgetStartedAt;
	if (startedAt === undefined) throw new Error(`Run ${record.id} froze no budgetStartedAt`);
	while (Date.now() - startedAt < elapsedMs) {
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
	}
	const latest = manager.get(record.id);
	if (latest === undefined) throw new Error(`Unknown run ${record.id}`);
	if (isTerminalStatus(latest.status)) throw new Error(`Run ${record.id} settled before the steer window`);
	return latest;
}

function observedHeadlessLauncher(): {
	launcher: ProcessLauncher;
	exited: Promise<void>;
	spawned: ReturnType<typeof spawn>[];
} {
	const exited = Promise.withResolvers<void>();
	const spawned: ReturnType<typeof spawn>[] = [];
	const observedSpawn = ((...args: Parameters<typeof spawn>) => {
		const child = spawn(...args);
		spawned.push(child);
		child.once("exit", () => exited.resolve());
		return child;
	}) as typeof spawn;
	const launcher = createProcessLaunchers({ spawnProcess: observedSpawn }).find(
		(candidate) => candidate.kind === "headless",
	);
	if (!launcher) throw new Error("headless launcher is unavailable");
	return { launcher, exited: exited.promise, spawned };
}

describe("real process runtime", () => {
	it("closes idle panes and reopens the same native worker for its next assignment", async () => {
		const provider = await localProvider({ holdRequests: [0, 1, 2] });
		const panes = new Map<string, LauncherHandle>();
		let nextPane = 0;
		let viewerArgv: readonly string[] = [];
		let viewerHostModule: string | undefined;
		const presentation: ProcessLauncher = {
			kind: "tmux",
			available: async () => true,
			launch: async (spec) => {
				viewerArgv = spec.interactiveArgv;
				viewerHostModule = spec.env.PI_TEAMS_HOST_MODULE;
				const handle: LauncherHandle = {
					kind: "tmux",
					childId: spec.childId,
					paneId: `%integration-${nextPane++}`,
				};
				panes.set(handle.paneId ?? "", handle);
				return handle;
			},
			alive: async (handle) => panes.get(handle.paneId ?? "") === handle,
			cleanupExited: async (handle) => !panes.has(handle.paneId ?? ""),
			terminate: async (handle) => {
				panes.delete(handle.paneId ?? "");
			},
		};
		const { launcher } = observedHeadlessLauncher();
		const backend = new ProcessAgentExecutionBackend({
			launcherHint: "tmux",
			launchers: [presentation, launcher],
			connectTimeoutMs: 15_000,
		});
		let worker: AgentBackendHandle | undefined;
		let other: AgentBackendHandle | undefined;
		let unsubscribe = () => {};
		let viewerAvailable = false;
		try {
			worker = await backend.launch(launchInput("idle-pane-first", provider.cwd));
			const firstWorker = worker;
			await provider.firstRequest;
			unsubscribe = backend.subscribePresentation(worker, (available) => {
				viewerAvailable = available;
			});
			await vi.waitFor(() => expect(backend.hasViewer(firstWorker)).toBe(true), { timeout: 10_000 });
			const running = await backend.status(worker);
			const initial = backend.serializeHandle(worker);
			if (!initial?.launcher.pid || !initial.viewer?.paneId || !running.sessionFile)
				throw new Error("Held native worker omitted its execution, viewer, or session identity");
			const pid = initial.launcher.pid;
			const sessionFile = running.sessionFile;
			const firstPaneId = initial.viewer.paneId;
			expect(running.state).toBe("running");
			expect(pid).not.toBe(process.pid);
			expect(viewerAvailable).toBe(true);
			expect(backend.hasViewer(worker)).toBe(true);
			expect(viewerArgv).toEqual([
				process.execPath,
				"--import",
				expect.stringContaining("child-module-loader.js"),
				expect.stringContaining("terminal-client.js"),
			]);
			expect(viewerHostModule).toContain("pi-coding-agent");
			expect(panes.has(initial.viewer.paneId)).toBe(true);

			other = await backend.launch(launchInput("idle-pane-other-active", provider.cwd));
			const otherWorker = other;
			await vi.waitFor(() => expect(provider.requests).toHaveLength(2), { timeout: 10_000 });
			await vi.waitFor(() => expect(backend.hasViewer(otherWorker)).toBe(true), { timeout: 10_000 });
			expect((await backend.status(other)).state).toBe("running");
			const otherIdentity = backend.serializeHandle(other);
			if (!otherIdentity?.viewer?.paneId) throw new Error("Other active worker omitted its viewer");
			expect(panes.size).toBe(2);

			provider.releaseRequest(0);
			const completed = await waitForTerminal(backend, worker);
			expect(completed.state).toBe("completed");
			expect(completed.result).toContain("process-child-ok");
			expect(completed.sessionFile).toBe(sessionFile);
			await vi.waitFor(
				() => {
					expect(backend.serializeHandle(firstWorker)?.viewer).toBeUndefined();
					expect(backend.hasViewer(firstWorker)).toBe(false);
					expect(viewerAvailable).toBe(false);
					expect(panes.has(firstPaneId)).toBe(false);
				},
				{ timeout: 10_000 },
			);
			const idle = backend.serializeHandle(worker);
			expect(idle?.childId).toBe(initial.childId);
			expect(idle?.launcher.pid).toBe(pid);
			process.kill(pid, 0);
			expect((await backend.status(worker)).sessionFile).toBe(sessionFile);
			expect(backend.hasViewer(other)).toBe(true);
			expect(panes.has(otherIdentity.viewer.paneId)).toBe(true);
			expect(panes.size).toBe(1);

			worker = await backend.assign(worker, {
				runId: "idle-pane-second",
				prompt: "Continue the first assignment and return process-child-ok again.",
				maxTurns: 1,
			});
			const secondWorker = worker;
			await vi.waitFor(() => expect(provider.requests).toHaveLength(3), { timeout: 10_000 });
			await vi.waitFor(
				() => {
					expect(backend.hasViewer(secondWorker)).toBe(true);
					expect(viewerAvailable).toBe(true);
					expect(backend.serializeHandle(secondWorker)?.viewer?.paneId).toBeDefined();
				},
				{ timeout: 10_000 },
			);
			const reassigned = backend.serializeHandle(worker);
			if (!reassigned?.viewer?.paneId) throw new Error("Reassigned native worker omitted its viewer");
			const secondPaneId = reassigned.viewer.paneId;
			expect(reassigned.childId).toBe(initial.childId);
			expect(reassigned.launcher.pid).toBe(pid);
			expect(reassigned.viewer.paneId).not.toBe(initial.viewer.paneId);
			expect(panes.has(reassigned.viewer.paneId)).toBe(true);
			expect(panes.has(otherIdentity.viewer.paneId)).toBe(true);
			expect(panes.size).toBe(2);
			const secondRunning = await backend.status(worker);
			expect(secondRunning.state).toBe("running");
			expect(secondRunning.sessionFile).toBe(sessionFile);
			const continuation = JSON.parse(provider.requests[2] ?? "{}") as {
				messages: Array<{ role: string; content: unknown }>;
			};
			expect(
				continuation.messages.some(
					(message) => message.role === "user" && JSON.stringify(message.content).includes("idle-pane-first"),
				),
			).toBe(true);
			expect(
				continuation.messages.some(
					(message) => message.role === "assistant" && JSON.stringify(message.content).includes("process-child-ok"),
				),
			).toBe(true);

			provider.releaseRequest(2);
			const secondCompleted = await waitForTerminal(backend, worker);
			expect(secondCompleted.state).toBe("completed");
			expect(secondCompleted.sessionFile).toBe(sessionFile);
			await vi.waitFor(
				() => {
					expect(backend.serializeHandle(secondWorker)?.viewer).toBeUndefined();
					expect(backend.hasViewer(secondWorker)).toBe(false);
					expect(viewerAvailable).toBe(false);
					expect(panes.has(secondPaneId)).toBe(false);
				},
				{ timeout: 10_000 },
			);
			expect(backend.serializeHandle(worker)?.childId).toBe(initial.childId);
			expect(backend.serializeHandle(worker)?.launcher.pid).toBe(pid);
			process.kill(pid, 0);
			expect(backend.hasViewer(other)).toBe(true);
			expect((await backend.status(other)).state).toBe("running");
			expect(panes.has(otherIdentity.viewer.paneId)).toBe(true);
			expect(panes.size).toBe(1);
		} finally {
			unsubscribe();
			for (const index of [0, 1, 2]) provider.releaseRequest(index);
			const retainedWorkers = [worker, other].filter((handle): handle is AgentBackendHandle => handle !== undefined);
			await Promise.all(
				retainedWorkers.map(async (handle) => {
					await waitForTerminal(backend, handle);
					await backend.dispose(handle);
				}),
			);
		}
	}, 60_000);

	it("reattaches the real native UI at the same size without replacing or replaying active execution", async () => {
		const provider = await localProvider({ holdFirst: true });
		const controlDir = await mkdtemp("/tmp/teams-native-terminal-");
		tempRoots.push(controlDir);
		const sessionDir = join(provider.cwd, "native-sessions");
		await mkdir(sessionDir, { mode: 0o700 });
		const bootstrap = {
			childId: "native-ui-child",
			token: "native-ui-owner-token-with-enough-length",
			socketPath: join(controlDir, "control.sock"),
			terminalSocketPath: join(controlDir, "terminal.sock"),
			sessionDir,
			cwd: provider.cwd,
			configCwd: provider.cwd,
			systemPrompt: "",
			promptMode: "append",
			model: "local-test/local-model",
			tools: [],
		};
		const bootstrapFile = join(controlDir, "bootstrap.json");
		await writeFile(bootstrapFile, JSON.stringify(bootstrap), { mode: 0o600 });
		const child = spawn(process.execPath, [join(process.cwd(), "dist/extensions/headless-child.js")], {
			cwd: provider.cwd,
			env: { ...process.env, PI_TEAMS_CHILD: "1", PI_TEAMS_BOOTSTRAP: bootstrapFile, PI_OFFLINE: "1" },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr?.on("data", (data) => {
			stderr += String(data);
		});
		const owner = new ChildRpcClient({
			socketPath: bootstrap.socketPath,
			childId: bootstrap.childId,
			token: bootstrap.token,
			connectTimeoutMs: 15_000,
		});
		const sockets: Socket[] = [];
		async function attach() {
			const socket = connect(bootstrap.terminalSocketPath);
			sockets.push(socket);
			let output = "";
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", (data: string) => {
				buffer += data;
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const frame = JSON.parse(buffer.slice(0, newline)) as { type: string; data?: string };
					buffer = buffer.slice(newline + 1);
					if (frame.type === "output" && frame.data) output += Buffer.from(frame.data, "base64").toString("utf8");
					newline = buffer.indexOf("\n");
				}
			});
			socket.on("error", () => {});
			await new Promise<void>((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("error", reject);
			});
			socket.write(
				`${JSON.stringify({
					type: "auth",
					childId: bootstrap.childId,
					token: deriveViewerToken(bootstrap.childId, bootstrap.token),
				})}\n`,
			);
			socket.write(`${JSON.stringify({ type: "resize", columns: 120, rows: 40 })}\n`);
			return { socket, output: () => output };
		}
		try {
			const initial = await owner.connect().catch((error: unknown) => {
				throw new Error(`Native child failed: ${stderr}`, { cause: error });
			});
			const first = await attach();
			await owner.prompt("native-ui-run", "NATIVE_ACTIVE_ASSIGNMENT");
			await provider.firstRequest;
			await vi.waitFor(() => expect(first.output()).toContain("NATIVE_ACTIVE_ASSIGNMENT"), { timeout: 10_000 });
			await new Promise<void>((resolve) => {
				first.socket.once("close", resolve);
				first.socket.destroy();
			});
			const disconnected = await owner.state();
			expect(disconnected.execution).toBe("running");
			expect(disconnected.pid).toBe(initial.pid);
			const reopened = await attach();
			await vi.waitFor(() => expect(reopened.output()).toContain("NATIVE_ACTIVE_ASSIGNMENT"), { timeout: 10_000 });
			expect((await owner.state()).sessionFile).toBe(initial.sessionFile);
			expect(provider.requests).toHaveLength(1);
			provider.releaseFirst();
			await vi.waitFor(async () => expect((await owner.state()).lastOutcome?.status).toBe("completed"), {
				timeout: 10_000,
			});
			for (const data of ["/model", "\r"]) {
				reopened.socket.write(
					`${JSON.stringify({
						type: "input",
						data: Buffer.from(data).toString("base64"),
						final: true,
						kittyProtocolActive: false,
					})}\n`,
				);
			}
			await vi.waitFor(() => expect(reopened.output()).toContain("Model Name:"), { timeout: 10_000 });
			expect(provider.requests).toHaveLength(1);
			expect((await owner.state()).pid).toBe(initial.pid);
			await new Promise<void>((resolve) => {
				reopened.socket.once("data", () => resolve());
				reopened.socket.write(
					`${JSON.stringify({
						type: "input",
						data: Buffer.from("\u001b").toString("base64"),
						final: true,
						kittyProtocolActive: false,
					})}\n`,
				);
			});
			for (const data of ["REQUIRES_PARENT_ADMISSION", "\r"]) {
				reopened.socket.write(
					`${JSON.stringify({
						type: "input",
						data: Buffer.from(data).toString("base64"),
						final: true,
						kittyProtocolActive: false,
					})}\n`,
				);
			}
			await vi.waitFor(() => expect(reopened.output()).toContain("no parent-owned mailbox"), { timeout: 10_000 });
			expect((await owner.state()).execution).toBe("idle");
			expect(provider.requests).toHaveLength(1);
			const sessionEntries = (await readFile(initial.sessionFile, "utf8"))
				.trim()
				.split("\n")
				.map((line: string) => JSON.parse(line));
			expect(
				sessionEntries.some(
					(entry) =>
						entry.type === "message" &&
						entry.message?.role === "user" &&
						entry.message.content.some(
							(part: { type: string; text?: string }) =>
								part.type === "text" && part.text?.includes("REQUIRES_PARENT_ADMISSION"),
						),
				),
			).toBe(false);
		} finally {
			provider.releaseFirst();
			for (const socket of sockets) socket.destroy();
			await owner.shutdown().catch(() => {
				child.kill("SIGTERM");
			});
			owner.disconnect();
			if (child.exitCode === null && child.signalCode === null) {
				await new Promise<void>((resolve) => {
					child.once("exit", resolve);
					child.kill("SIGTERM");
				});
			}
		}
	}, 60_000);

	it("rejects missing native auth before allocating a run, process, or artifacts", async () => {
		const provider = await localProvider();
		const previousEnv = process.env;
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
		process.env = { PATH: previousEnv.PATH, HOME: dirname(agentDir), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
		const modelsPath = join(agentDir, "models.json");
		const models = JSON.parse(await readFile(modelsPath, "utf8"));
		delete models.providers["local-test"].apiKey;
		models.providers["local-test"].authHeader = true;
		await writeFile(modelsPath, JSON.stringify(models));
		const { launcher, spawned } = observedHeadlessLauncher();
		const backend = new ProcessAgentExecutionBackend({ launchers: [launcher], agentDir });
		const settings = sanitizeSettings({ backgroundByDefault: true, worktreeIsolation: false });
		const registry = new AgentRegistry({ sources: [], loader: async () => [], settings });
		await registry.load();
		const store = createSubagentRunStore(provider.cwd);
		let allocatedIds = 0;
		const manager = new AgentManager({
			registry,
			settings,
			backends: [backend],
			cwd: provider.cwd,
			configCwd: provider.cwd,
			registryStore: store,
			idFactory: () => `run-${++allocatedIds}`,
		});
		try {
			await expect(
				manager.spawn({
					type: "general-purpose",
					model: "local-test/local-model",
					prompt: "Attempt a native prompt without configured credentials.",
					run_in_background: true,
				}),
			).rejects.toThrow("No authenticated model is available");
			await expect(backend.launch(launchInput(provider.cwd, "direct-missing-auth"))).rejects.toThrow(
				"No authenticated model is available",
			);
			expect(allocatedIds).toBe(0);
			expect(manager.list()).toEqual([]);
			expect(buildAgentListView(manager).rows).toEqual([]);
			expect(store.readHistory()).toEqual([]);
			expect(store.readRegistry()).toEqual([]);
			expect(spawned).toEqual([]);
			expect(provider.requests).toEqual([]);
			await expect(access(join(provider.cwd, ".pi", "teams"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await manager.shutdownSession();
			process.env = previousEnv;
		}
	}, 60_000);

	it("uses the authenticated parent when a configured specialist model has no auth", async () => {
		const provider = await localProvider();
		const previousEnv = process.env;
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
		process.env = { PATH: previousEnv.PATH, HOME: dirname(agentDir), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
		const { launcher, exited, spawned } = observedHeadlessLauncher();
		const backend = new ProcessAgentExecutionBackend({
			launchers: [launcher],
			agentDir,
			getParentModel: () => "local-test/local-model",
			connectTimeoutMs: 15_000,
		});
		const settings = sanitizeSettings({ backgroundByDefault: true, worktreeIsolation: false });
		const registry = new AgentRegistry({
			sources: [],
			loader: async () => [
				{
					sourcePath: "/agents/pinned-specialist.md",
					frontmatter: { name: "pinned-specialist", model: "missing-provider/missing-model" },
					body: "Return the requested response.",
				},
			],
			settings,
		});
		await registry.load();
		const store = createSubagentRunStore(provider.cwd);
		const manager = new AgentManager({
			registry,
			settings,
			backends: [backend],
			cwd: provider.cwd,
			configCwd: provider.cwd,
			registryStore: store,
		});
		try {
			const run = await manager.spawn({
				type: "pinned-specialist",
				prompt: "Return process-child-ok.",
				run_in_background: true,
			});
			await manager.whenSettled(run.id);
			await exited;
			const completed = manager.get(run.id);
			expect(completed?.status).toBe("completed");
			expect(completed?.result).toBe("process-child-ok");
			expect(completed?.model).toBe("local-test/local-model");
			expect(completed?.modelFallback).toContain("missing-provider/missing-model");
			expect(completed?.modelFallback).toContain("local-test/local-model");
			expect(spawned).toHaveLength(1);
			expect(spawned[0]?.exitCode).toBe(0);
			expect(provider.requests).toHaveLength(1);
			expect(store.readRegistry()).toEqual([]);
			expect(store.readHistory()[0]).toMatchObject({
				model: "local-test/local-model",
				modelFallback: completed?.modelFallback,
				status: "completed",
			});
		} finally {
			await manager.shutdownSession();
			process.env = previousEnv;
		}
	}, 60_000);

	it("refuses stale disposal when the authenticated child PID disagrees with the launcher identity", async () => {
		const provider = await localProvider({ holdFirst: true });
		const original = new ProcessAgentExecutionBackend({ launcherHint: "headless", connectTimeoutMs: 15_000 });
		const disposer = new ProcessAgentExecutionBackend({ launcherHint: "headless", connectTimeoutMs: 2_000 });
		let originalHandle: AgentBackendHandle | undefined;
		try {
			originalHandle = await original.launch(launchInput("identity-mismatch", provider.cwd));
			await provider.firstRequest;
			const serialized = original.serializeHandle(originalHandle);
			if (!serialized?.launcher.pid) throw new Error("Fixture launcher identity was not serializable");
			original.detach(originalHandle);
			const mismatched = { ...serialized, launcher: { ...serialized.launcher, pid: serialized.launcher.pid + 1 } };
			await expect(disposer.disposePersisted(mismatched)).rejects.toThrow(/PID/);
		} finally {
			provider.releaseFirst();
			if (originalHandle) {
				// Releasing the provider is not the SDK's idle boundary.
				const handle = originalHandle;
				await vi.waitFor(() => original.dispose(handle), { timeout: 10_000 });
			}
		}
	}, 60_000);
	it("self-terminates a detached child through control-socket loss (ADR 0007)", async () => {
		const provider = await localProvider({ holdFirst: true });
		const { launcher, exited } = observedHeadlessLauncher();
		const backend = new ProcessAgentExecutionBackend({ launchers: [launcher], connectTimeoutMs: 15_000 });
		let handle: AgentBackendHandle | undefined;
		let serialized: SerializableBackendHandle | undefined;
		try {
			handle = await backend.launch(launchInput("control-loss-selfstop", provider.cwd));
			await provider.firstRequest;
			serialized = backend.serializeHandle(handle);
			if (!serialized?.launcher.pid) throw new Error("Fixture launcher identity was not serializable");
			backend.detach(handle);
			// Detaching drops the control connection: the child must abort its
			// held run, persist the annotated partial artifact and exit itself.
			await exited;
			const artifact = readFileSync(join(serialized.runDir, "result.md"), "utf8");
			expect(artifact.startsWith("stopped: parent control lost")).toBe(true);
			await backend.dispose(handle);
			expect(backend.serializeHandle(handle)).toBeUndefined();
		} finally {
			provider.releaseFirst();
			if (serialized) {
				await launcher.terminate(serialized.launcher).catch(() => undefined);
				await exited;
			}
			if (handle) await backend.dispose(handle);
		}
	}, 60_000);
	it("disposes a disconnected handle after its verified child process group exits", async () => {
		const provider = await localProvider({ holdFirst: true });
		const { launcher, exited } = observedHeadlessLauncher();
		const backend = new ProcessAgentExecutionBackend({ launchers: [launcher], connectTimeoutMs: 15_000 });
		let handle: AgentBackendHandle | undefined;
		let serialized: SerializableBackendHandle | undefined;
		let disposed = false;
		try {
			handle = await backend.launch(launchInput("dead-disconnected", provider.cwd));
			await provider.firstRequest;
			serialized = backend.serializeHandle(handle);
			if (!serialized?.launcher.pid) throw new Error("Fixture launcher identity was not serializable");
			backend.detach(handle);
			process.kill(serialized.launcher.pid, "SIGKILL");
			await exited;
			await backend.dispose(handle);
			disposed = true;
			expect(backend.serializeHandle(handle)).toBeUndefined();
		} finally {
			provider.releaseFirst();
			if (serialized && !disposed) {
				await launcher.terminate(serialized.launcher).catch(() => undefined);
				await exited;
			}
			if (handle && !disposed) await backend.dispose(handle);
		}
	}, 60_000);
	it("runs a real headless child from an isolated package without installed host peers", async () => {
		const provider = await localProvider();
		const packageRoot = await mkdtemp(join(tmpdir(), "teams-isolated-package-"));
		tempRoots.push(packageRoot);
		const dist = join(packageRoot, "dist/extensions");
		await cp(join(process.cwd(), "dist/extensions"), dist, { recursive: true });
		const backend = new ProcessAgentExecutionBackend({
			launcherHint: "headless",
			connectTimeoutMs: 15_000,
			entryPaths: {
				headless: join(dist, "headless-child.js"),
				terminalClient: join(dist, "terminal-client.js"),
				moduleLoader: join(dist, "child-module-loader.js"),
			},
		});
		let handle: AgentBackendHandle | undefined;
		try {
			handle = await backend.launch(launchInput("isolated-package-run", provider.cwd));
			const status = await waitForTerminal(backend, handle);
			expect(status.state).toBe("completed");
			expect(status.result).toContain("process-child-ok");
		} finally {
			if (handle) await backend.dispose(handle);
		}
	}, 60_000);

	it("cold-resumes a native Pi child from the original persisted session", async () => {
		const provider = await localProvider();
		const cwd = provider.cwd;
		const backend = new ProcessAgentExecutionBackend({ launcherHint: "headless", connectTimeoutMs: 15_000 });
		let activeHandle: AgentBackendHandle | undefined;
		try {
			expect(await backend.available()).toBe(true);
			const first = await backend.launch(launchInput("process-run-1", cwd));
			activeHandle = first;
			const firstSerialized = backend.serializeHandle(first);
			if (!firstSerialized?.launcher.pid) throw new Error("First native child identity was not serializable");
			expect(firstSerialized.launcher.pid).not.toBe(process.pid);
			const firstStatus = await waitForTerminal(backend, first);
			expect(firstStatus.state).toBe("completed");
			expect(firstStatus.result).toContain("process-child-ok");
			const firstTranscript = await backend.readTranscript(first);
			expect(
				firstTranscript.items.some((item) => item.kind === "assistant" && item.text?.includes("process-child-ok")),
			).toBe(true);
			if (!firstStatus.sessionFile) throw new Error("Native completion omitted its session JSONL path");

			await backend.dispose(first);
			activeHandle = undefined;
			expect(backend.serializeHandle(first)).toBeUndefined();
			expect(await backend.readTranscript(first)).toEqual(firstTranscript);

			const resumed = await backend.resume({
				runId: "process-run-2",
				prompt: "Continue and return the same deterministic answer.",
				cwd,
				background: true,
				sessionFile: firstStatus.sessionFile,
			});
			activeHandle = resumed;
			const resumedSerialized = backend.serializeHandle(resumed);
			if (!resumedSerialized) throw new Error("Cold-resumed child identity was not serializable");
			expect(resumedSerialized.childId).not.toBe(firstSerialized.childId);
			const resumedStatus = await waitForTerminal(backend, resumed);
			expect(resumedStatus.state).toBe("completed");
			const continuation = JSON.parse(provider.requests[1] ?? "{}");
			expect(
				continuation.messages.some(
					(message: { role: string; content: unknown }) =>
						message.role === "user" && JSON.stringify(message.content).includes("process-run-1"),
				),
			).toBe(true);
			expect(
				continuation.messages.some(
					(message: { role: string; content: unknown }) =>
						message.role === "assistant" && JSON.stringify(message.content).includes("process-child-ok"),
				),
			).toBe(true);

			await backend.dispose(resumed);
			activeHandle = undefined;
		} finally {
			if (activeHandle) await backend.dispose(activeHandle);
		}
	}, 60_000);
	it("cold-resumes a named child against its current team's board without mutating the previous team", async () => {
		const provider = await localProvider({ createTeamTask: true });
		const backend = new ProcessAgentExecutionBackend({ launcherHint: "headless", connectTimeoutMs: 15_000 });
		const previousDir = join(provider.cwd, ".pi", "teams", "t", "previous");
		const currentDir = join(provider.cwd, ".pi", "teams", "t", "current");
		const previous = new TaskBoardService({ teamDir: previousDir, self: "lead" });
		const current = new TaskBoardService({ teamDir: currentDir, self: "lead" });
		let handle: AgentBackendHandle | undefined;
		try {
			handle = await backend.launch({
				...launchInput("named-before-cold", provider.cwd),
				maxTurns: 2,
				team: { teamDir: previousDir, teamKey: "a".repeat(64), teammateName: "worker" },
			});
			const source = await waitForTerminal(backend, handle);
			if (!source.sessionFile || source.state !== "completed")
				throw new Error("Named source did not preserve a completed native session");
			const previousTasks = previous.list();
			await backend.dispose(handle);
			handle = undefined;
			handle = await backend.resume({
				runId: "named-after-cold",
				sessionFile: source.sessionFile,
				prompt: "Continue the saved conversation in the current team.",
				cwd: provider.cwd,
				background: true,
				team: { teamDir: currentDir, teamKey: "b".repeat(64), teammateName: "worker" },
			});
			expect((await waitForTerminal(backend, handle)).state).toBe("completed");
			expect(previous.list()).toEqual(previousTasks);
			expect(current.list()).toMatchObject([{ title: "Cold continuation task", status: "pending" }]);
		} finally {
			if (handle) await backend.dispose(handle);
		}
	}, 60_000);

	it("releases execution capacity when a retained native teammate refuses a new assignment", async () => {
		const provider = await localProvider();
		const backend = new ProcessAgentExecutionBackend({ launcherHint: "headless", connectTimeoutMs: 15_000 });
		const settings = sanitizeSettings({ maxConcurrent: 1, backgroundByDefault: true, worktreeIsolation: false });
		const registry = new AgentRegistry({
			sources: [],
			loader: async () => [
				{
					sourcePath: join(provider.cwd, "worker.md"),
					filenameStem: "worker",
					frontmatter: { name: "worker", model: "local-test/local-model", tools: "none", max_turns: 1 },
					body: "Use the local deterministic provider.",
				},
			],
			settings,
		});
		await registry.load();
		const team = new TeamService({
			sessionId: "refused-native-assignment",
			store: createPiTeamStore(provider.cwd, "refused-native-assignment"),
		});
		team.sessionStart();
		const manager = new AgentManager({
			registry,
			settings,
			backends: [backend],
			cwd: provider.cwd,
			configCwd: provider.cwd,
		});
		manager.setTeamService(team);
		try {
			const original = await manager.spawn({ type: "worker", name: "a", prompt: "Initial assignment." });
			expect((await manager.whenSettled(original.id))?.status).toBe("completed");
			const continuation = await manager.spawn({
				type: "worker",
				name: "a",
				prompt: "Next assignment in the same native child.",
			});
			expect((await manager.whenSettled(continuation.id))?.status).toBe("completed");
			await expect(manager.resume(original.id, "Do not duplicate the retained teammate.")).rejects.toThrow();
			const oversized = await manager.spawn({ type: "worker", name: "a", prompt: "x".repeat(262_145) });
			const rejected = await manager.whenSettled(oversized.id);
			expect(rejected).toMatchObject({ status: "error", turns: 0, toolUses: 0 });
			expect(rejected?.result).toBeUndefined();
			expect(rejected?.resultFile).toBeUndefined();
			const handle = manager.get(oversized.id)?.handle;
			if (!handle) throw new Error("Named native child was not retained");
			backend.detach(handle);
			const refused = await manager.spawn({
				type: "worker",
				name: "a",
				prompt: "Cannot admit through released control.",
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(manager.get(refused.id)?.status).toBe("error");
			expect(manager.hasRunning()).toBe(false);
			await manager.release(oversized.id);
			const next = await manager.spawn({ type: "worker", name: "a", prompt: "Execution capacity remains available." });
			expect((await manager.whenSettled(next.id))?.status).toBe("completed");
		} finally {
			await manager.shutdownSession();
		}
	}, 60_000);
	it("manager closes native children and cold-resumes with saved conversation context", async () => {
		const provider = await localProvider();
		const spawnedExits: Promise<void>[] = [];
		const launchedChildren: Array<{ handle: LauncherHandle; exited: Promise<void> }> = [];
		const observedSpawn = ((...args: Parameters<typeof spawn>) => {
			const child = spawn(...args);
			const exited = Promise.withResolvers<void>();
			child.once("exit", () => exited.resolve());
			spawnedExits.push(exited.promise);
			return child;
		}) as typeof spawn;
		const baseLauncher = createProcessLaunchers({ spawnProcess: observedSpawn }).find(
			(candidate) => candidate.kind === "headless",
		);
		if (!baseLauncher) throw new Error("headless process launcher is unavailable");
		const launcher: ProcessLauncher = {
			kind: "headless",
			available: () => baseLauncher.available(),
			async launch(spec) {
				const handle = await baseLauncher.launch(spec);
				const exited = spawnedExits.shift();
				if (!exited) throw new Error("launched child exit event was not registered");
				launchedChildren.push({ handle, exited });
				return handle;
			},
			alive: (handle) => baseLauncher.alive(handle),
			cleanupExited: (handle) => baseLauncher.cleanupExited(handle),
			terminate: (handle) => baseLauncher.terminate(handle),
		};
		const backend = new ProcessAgentExecutionBackend({
			launchers: [launcher],
			connectTimeoutMs: 15_000,
		});
		const settings = sanitizeSettings({ backgroundByDefault: true, worktreeIsolation: false });
		const registry = new AgentRegistry({
			sources: [],
			loader: async () => [
				{
					sourcePath: join(provider.cwd, "runtime-agent.md"),
					frontmatter: {
						name: "runtime-agent",
						description: "real manager lifecycle regression",
						model: "local-test/local-model",
						tools: "none",
						max_turns: 1,
					},
					body: "Use the local deterministic provider.",
					filenameStem: "runtime-agent",
				},
			],
			settings,
		});
		await registry.load();
		const store = createSubagentRunStore(provider.cwd);
		const manager = new AgentManager({
			registry,
			settings,
			backends: [backend],
			cwd: provider.cwd,
			configCwd: provider.cwd,
			registryStore: store,
		});
		const originalPrompt = "Keep this context for the follow-up: ORCHID-57.";
		try {
			const original = await manager.spawn({
				type: "runtime-agent",
				prompt: originalPrompt,
				run_in_background: true,
			});
			await manager.whenSettled(original.id);

			const completed = manager.get(original.id);
			const sessionFile = completed?.sessionFile;
			expect(completed?.status).toBe("completed");
			expect(completed?.handle).toBeUndefined();
			expect(sessionFile).toBeTruthy();
			if (!sessionFile) throw new Error("native completion omitted its session JSONL path");
			expect(store.readRegistry()).toEqual([]);
			expect(store.readHistory()).toMatchObject([{ id: original.id, status: "completed", sessionFile }]);
			expect(store.readHistory()[0]).not.toHaveProperty("handle");
			const originalChild = launchedChildren[0];
			if (!originalChild) throw new Error("manager did not launch the original native child");
			expect(originalChild.handle.pid).not.toBe(process.pid);
			await originalChild.exited;
			expect(await launcher.alive(originalChild.handle)).toBe(false);

			const originalJsonl = await readFile(sessionFile, "utf8");
			const bootstrapPath = join(dirname(sessionFile), "bootstrap.json");
			const originalBootstrap = await readFile(bootstrapPath, "utf8");
			expect(originalJsonl).toContain("process-child-ok");
			expect(originalBootstrap).toContain("local-test/local-model");

			const resumed = await manager.resume(original.id, "Continue using the saved context.");
			await manager.whenSettled(resumed.id);
			expect(manager.get(resumed.id)?.status).toBe("completed");
			expect(manager.get(resumed.id)?.handle).toBeUndefined();
			const resumedChild = launchedChildren[1];
			if (!resumedChild) throw new Error("cold resume did not launch a new native child");
			expect(resumedChild.handle.childId).not.toBe(originalChild.handle.childId);
			await resumedChild.exited;
			expect(await launcher.alive(resumedChild.handle)).toBe(false);

			const continuation = JSON.parse(provider.requests[1] ?? "{}") as {
				messages?: Array<{ role: string; content: unknown }>;
			};
			expect(
				continuation.messages?.some(
					(message) => message.role === "user" && JSON.stringify(message.content).includes(originalPrompt),
				),
			).toBe(true);
			expect(
				continuation.messages?.some(
					(message) => message.role === "assistant" && JSON.stringify(message.content).includes("process-child-ok"),
				),
			).toBe(true);
			expect(store.readRegistry()).toEqual([]);
			expect(store.readHistory().map((entry) => entry.id)).toEqual([original.id, resumed.id]);
			expect(store.readHistory().every((entry) => !("handle" in entry))).toBe(true);
		} finally {
			await manager.dispose();
		}
	}, 60_000);
});

/**
 * Polls a condition against the real event loop. Budget enforcement and abort
 * propagation are wall-clock phenomena against live child processes, so
 * deterministic timer control cannot express them; every wait here targets an
 * observed condition, never a guessed duration.
 */
async function eventually(description: string, timeoutMs: number, check: () => boolean): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`did not observe ${description} within ${timeoutMs}ms`);
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
	}
}

describe("native time budgets", () => {
	it("hard-stops a streaming run at the wall budget, marks the partial work, disposes the child, and cold-resumes under the same frozen budgets", async () => {
		const harness = await budgetHarness({
			behaviors: [
				{ kind: "stream", intervalMs: 600, content: "budget-partial" },
				{ kind: "complete", content: "process-child-ok" },
			],
			definitions: [{ frontmatter: { name: "budgeted-wall", timeout: 6 } }],
		});
		const { manager, provider, store, launch } = harness;
		try {
			const originalPrompt = "Stream for a long time; the wall budget must stop you.";
			const run = await manager.spawn({ type: "budgeted-wall", prompt: originalPrompt, run_in_background: true });
			const settled = await manager.whenSettled(run.id);
			const elapsed = (settled.completedAt ?? Date.now()) - (settled.budgetStartedAt ?? settled.startedAt);

			expect(settled.status).toBe("stopped");
			expect(settled.budgetExhausted).toBe("timeout");
			expect(settled.budgetSeconds).toBe(6);
			expect(settled.budgetTimeout).toBe(6);
			expect(settled.budgetIdleTimeout).toBe(0);
			expect(elapsed).toBeGreaterThanOrEqual(5_400);
			expect(elapsed).toBeLessThan(15_000);

			// Ongoing child output did not matter: the wall budget fired anyway and
			// the stop reached the child's in-flight model request.
			await provider.firstRequest;
			await eventually("the child aborting its in-flight model request", 5_000, () => provider.aborted.includes(0));

			// The parent-facing result names the exhausted budget and the partial work.
			const reported = await manager.getResult(run.id);
			expect(reported).toMatch(/Stopped by timeout budget after 6s/);
			expect(reported).toMatch(/partial work may be incomplete/);

			// Verified disposal: the native child is gone, not merely detached.
			const child = launch.launched[0];
			if (!child) throw new Error("budget run did not launch a native child");
			expect(child.handle.pid).not.toBe(process.pid);
			await child.exited;
			expect(await launch.launcher.alive(child.handle)).toBe(false);
			if (child.handle.pid) expect(() => process.kill(child.handle.pid, 0)).toThrow(/ESRCH/);
			expect(store.readRegistry()).toEqual([]);

			const history = store.readHistory();
			expect(history).toHaveLength(1);
			expect(history[0]).toMatchObject({
				id: run.id,
				status: "stopped",
				budgetExhausted: "timeout",
				budgetSeconds: 6,
				budgetTimeout: 6,
				budgetIdleTimeout: 0,
			});
			expect(history[0]?.sessionFile).toBeTruthy();

			// Resume reuses the frozen budgets even when the settings tier changes,
			// with fresh clocks: it completes instead of instantly re-aborting.
			manager.updateSettings(
				sanitizeSettings({ backgroundByDefault: true, worktreeIsolation: false, defaultTimeout: 999 }),
			);
			const resumed = await manager.resume(run.id, "Finish the task now.");
			expect(resumed.budgetTimeout).toBe(6);
			expect(resumed.budgetIdleTimeout).toBe(0);
			const resumedSettled = await manager.whenSettled(resumed.id);
			// Fresh clocks: the resumed run started its budget countdown after the
			// original run settled, and it completed instead of instantly re-aborting.
			expect(resumedSettled?.budgetStartedAt ?? 0).toBeGreaterThanOrEqual(settled.completedAt ?? 0);
			expect(resumedSettled?.status).toBe("completed");
			expect(resumedSettled?.budgetExhausted).toBeUndefined();
			expect(resumedSettled?.result).toContain("process-child-ok");
			const continuation = JSON.parse(provider.requests[1] ?? "{}") as {
				messages?: Array<{ role: string; content: unknown }>;
			};
			expect(
				continuation.messages?.some(
					(message) => message.role === "user" && JSON.stringify(message.content).includes(originalPrompt),
				),
			).toBe(true);
			const resumedChild = launch.launched[1];
			if (!resumedChild) throw new Error("cold resume under frozen budgets did not launch a new native child");
			expect(resumedChild.handle.childId).not.toBe(child.handle.childId);
			await resumedChild.exited;
			if (resumedChild.handle.pid) expect(() => process.kill(resumedChild.handle.pid, 0)).toThrow(/ESRCH/);
			expect(store.readRegistry()).toEqual([]);
			expect(store.readHistory().map((entry) => entry.status)).toEqual(["stopped", "completed"]);
		} finally {
			await manager.dispose();
		}
	}, 45_000);

	it("hard-stops a silent run at the idle budget from settings and steers do not buy time", async () => {
		const harness = await budgetHarness({
			behaviors: [{ kind: "hold" }],
			definitions: [{ frontmatter: { name: "budgeted-idle" } }],
			settings: { defaultIdleTimeout: 8 },
		});
		const { manager, provider, store, launch } = harness;
		try {
			const run = await manager.spawn({
				type: "budgeted-idle",
				prompt: "Hang without producing output.",
				run_in_background: true,
			});
			await provider.firstRequest;
			const running = await waitUntilRunning(manager, run.id);
			// Steer once the idle clock has been live for 4s. The idle budget is
			// anchored to budgetStartedAt because the child never produces output,
			// so a correct watchdog aborts near 8s while a watchdog that lets the
			// steer restart the window cannot abort before ~12s.
			const steerable = await waitUntilBudgetElapsed(manager, running, 4_000);
			const steerAt = Date.now() - (steerable.budgetStartedAt ?? steerable.startedAt);
			if (steerAt > 6_500) throw new Error(`native child connected too slowly for the steer window (${steerAt}ms)`);
			await expect(manager.steer(run.id, "ignored steer while the model request is silent")).resolves.toBe(true);

			const settled = await manager.whenSettled(run.id);
			const elapsed = (settled.completedAt ?? Date.now()) - (settled.budgetStartedAt ?? settled.startedAt);

			expect(settled.status).toBe("stopped");
			expect(settled.budgetExhausted).toBe("idle_timeout");
			expect(settled.budgetSeconds).toBe(8);
			expect(settled.budgetIdleTimeout).toBe(8);
			expect(settled.budgetTimeout).toBe(0);
			expect(elapsed).toBeGreaterThanOrEqual(7_400);
			// A steer-restarted window cannot land before ~12s (steer at >=4s plus a
			// fresh 8s), so this upper bound tolerates slow-CI timer delay while
			// still catching that regression.
			expect(elapsed).toBeLessThan(11_500);

			const reported = await manager.getResult(run.id);
			expect(reported).toMatch(/Stopped by idle_timeout budget after 8s/);
			expect(reported).toMatch(/partial work may be incomplete/);

			const child = launch.launched[0];
			if (!child) throw new Error("idle-budget run did not launch a native child");
			await child.exited;
			expect(await launch.launcher.alive(child.handle)).toBe(false);
			if (child.handle.pid) expect(() => process.kill(child.handle.pid, 0)).toThrow(/ESRCH/);
			expect(store.readRegistry()).toEqual([]);
			expect(store.readHistory()).toHaveLength(1);
			expect(store.readHistory()[0]).toMatchObject({
				id: run.id,
				status: "stopped",
				budgetExhausted: "idle_timeout",
				budgetSeconds: 8,
				budgetTimeout: 0,
				budgetIdleTimeout: 8,
			});
		} finally {
			await manager.dispose();
		}
	}, 45_000);

	it("rejects malformed budget overrides before allocation and applies the invocation budget over the definition budget", async () => {
		const harness = await budgetHarness({
			behaviors: [{ kind: "hold" }],
			definitions: [{ frontmatter: { name: "budgeted-pinned", timeout: 90 } }],
		});
		const { manager, provider, store, launch, allocatedIds } = harness;
		try {
			await expect(
				manager.spawn({ type: "budgeted-pinned", prompt: "zero budget", run_in_background: true, timeout: 0 }),
			).rejects.toThrow(/invalid timeout/);
			await expect(
				manager.spawn({
					type: "budgeted-pinned",
					prompt: "fractional budget",
					run_in_background: true,
					idle_timeout: 2.5,
				}),
			).rejects.toThrow(/invalid idleTimeout/);
			// Rejected budgets never allocate a run id, child process, or artifact.
			expect(allocatedIds()).toBe(0);
			expect(launch.spawned).toHaveLength(0);
			expect(provider.requests).toHaveLength(0);
			expect(store.readRegistry()).toEqual([]);
			expect(store.readHistory()).toEqual([]);

			// The 90s definition budget loses to the 4s invocation override: a
			// definition-wins regression would hang past this test's timeout.
			const run = await manager.spawn({
				type: "budgeted-pinned",
				prompt: "Pinned run tightened by the caller.",
				run_in_background: true,
				timeout: 4,
			});
			const settled = await manager.whenSettled(run.id);
			const elapsed = (settled.completedAt ?? Date.now()) - (settled.budgetStartedAt ?? settled.startedAt);

			expect(settled.status).toBe("stopped");
			expect(settled.budgetExhausted).toBe("timeout");
			expect(settled.budgetSeconds).toBe(4);
			expect(settled.budgetTimeout).toBe(4);
			expect(settled.budgetIdleTimeout).toBe(0);
			expect(elapsed).toBeGreaterThanOrEqual(3_400);
			expect(elapsed).toBeLessThan(12_000);

			const child = launch.launched[0];
			if (!child) throw new Error("override-budget run did not launch a native child");
			await child.exited;
			expect(await launch.launcher.alive(child.handle)).toBe(false);
			if (child.handle.pid) expect(() => process.kill(child.handle.pid, 0)).toThrow(/ESRCH/);
			expect(store.readRegistry()).toEqual([]);
			expect(store.readHistory()[0]).toMatchObject({
				id: run.id,
				status: "stopped",
				budgetExhausted: "timeout",
				budgetSeconds: 4,
			});

			// Resume re-enforces the ORIGINAL frozen 4s limit even though the
			// definition still pins 90s and the settings tier now says 999s: the
			// resumed run aborts again near 4s on fresh clocks (a stale clock would
			// abort instantly; re-resolved tiers would let it run 90s/999s).
			manager.updateSettings(
				sanitizeSettings({
					backgroundByDefault: true,
					worktreeIsolation: false,
					defaultTimeout: 999,
					defaultIdleTimeout: 999,
				}),
			);
			const resumed = await manager.resume(run.id, "Continue after the tightened run.");
			expect(resumed.budgetTimeout).toBe(4);
			expect(resumed.budgetIdleTimeout).toBe(0);
			const resumedSettled = await manager.whenSettled(resumed.id);
			expect(resumedSettled?.budgetStartedAt ?? 0).toBeGreaterThanOrEqual(settled.completedAt ?? 0);
			const resumedElapsed = (resumedSettled?.completedAt ?? Date.now()) - (resumedSettled?.budgetStartedAt ?? 0);
			expect(resumedSettled?.status).toBe("stopped");
			expect(resumedSettled?.budgetExhausted).toBe("timeout");
			expect(resumedSettled?.budgetSeconds).toBe(4);
			expect(resumedElapsed).toBeGreaterThanOrEqual(3_400);
			expect(resumedElapsed).toBeLessThan(12_000);
			const resumedChild = launch.launched[1];
			if (!resumedChild) throw new Error("frozen-budget resume did not launch a new native child");
			await resumedChild.exited;
			if (resumedChild.handle.pid) expect(() => process.kill(resumedChild.handle.pid, 0)).toThrow(/ESRCH/);
			expect(store.readRegistry()).toEqual([]);
			expect(store.readHistory().map((entry) => entry.status)).toEqual(["stopped", "stopped"]);
			expect(store.readHistory()[1]).toMatchObject({ budgetExhausted: "timeout", budgetSeconds: 4 });
		} finally {
			await manager.dispose();
		}
	}, 45_000);

	it("stops a run at the idle deadline despite a hung tool subprocess and leaves no survivors", async () => {
		const harness = await budgetHarness({
			behaviors: [
				{
					kind: "toolcall",
					// The tool traps TERM/INT and sleeps: pi's own abort handling must
					// still end it, and the budget deadline must not be extended by it.
					command: `sh -c 'trap "" TERM INT; echo $$ > hung.pid; sleep 60'`,
				},
			],
			definitions: [{ frontmatter: { name: "budgeted-tool", tools: "bash" } }],
			settings: { defaultIdleTimeout: 8 },
		});
		const { manager, provider, store, launch } = harness;
		try {
			const run = await manager.spawn({ type: "budgeted-tool", prompt: "Run the hung tool.", run_in_background: true });
			await provider.firstRequest;
			let hungPid: number | undefined;
			await eventually("the hung tool subprocess recording its pid", 15_000, () => {
				try {
					hungPid = Number.parseInt(readFileSync(join(provider.cwd, "hung.pid"), "utf8").trim(), 10);
				} catch {
					return false;
				}
				return hungPid !== undefined && hungPid > 1;
			});

			const settled = await manager.whenSettled(run.id);
			const elapsed = (settled.completedAt ?? Date.now()) - (settled.budgetStartedAt ?? settled.startedAt);

			expect(settled.status).toBe("stopped");
			expect(settled.budgetExhausted).toBe("idle_timeout");
			expect(settled.budgetSeconds).toBe(8);
			expect(settled.budgetIdleTimeout).toBe(8);
			expect(settled.budgetTimeout).toBe(0);
			expect(elapsed).toBeGreaterThanOrEqual(7_400);
			expect(elapsed).toBeLessThan(11_500);
			expect(settled.recoveryError).toBeUndefined();
			expect(settled.handle).toBeUndefined();

			const child = launch.launched[0];
			if (!child) throw new Error("hung-tool run did not launch a native child");
			await child.exited;
			expect(await launch.launcher.alive(child.handle)).toBe(false);
			if (child.handle.pid) expect(() => process.kill(child.handle.pid, 0)).toThrow(/ESRCH/);
			// Group-exit verification beyond the Pi PID: the tool subprocess died too.
			if (hungPid !== undefined) expect(() => process.kill(hungPid, 0)).toThrow(/ESRCH/);
			expect(store.readRegistry()).toEqual([]);
			expect(store.readHistory()[0]).toMatchObject({
				id: run.id,
				status: "stopped",
				budgetExhausted: "idle_timeout",
				budgetSeconds: 8,
			});
		} finally {
			await manager.dispose();
		}
	}, 45_000);

	it("hard-kills a SIGSTOP-frozen child at the idle deadline and settles with the budget outcome", async () => {
		const harness = await budgetHarness({
			behaviors: [{ kind: "hold" }],
			definitions: [{ frontmatter: { name: "budgeted-frozen" } }],
			settings: { defaultIdleTimeout: 8 },
		});
		const { manager, provider, store, launch } = harness;
		let frozenPid: number | undefined;
		try {
			const run = await manager.spawn({
				type: "budgeted-frozen",
				prompt: "Get frozen mid-run.",
				run_in_background: true,
			});
			await provider.firstRequest;
			await waitUntilRunning(manager, run.id);
			frozenPid = launch.launched[0]?.handle.pid;
			if (frozenPid === undefined) throw new Error("frozen-child run did not launch a native child");
			// A stopped process group cannot process the abort RPC and cannot die by
			// SIGTERM: enforcement must escalate (TERM, then SIGKILL) against the
			// verified owned group so the deadline ACTUALLY stops the run.
			process.kill(frozenPid, "SIGSTOP");

			const settled = await manager.whenSettled(run.id);
			const elapsed = (settled.completedAt ?? Date.now()) - (settled.budgetStartedAt ?? settled.startedAt);

			expect(settled.status).toBe("stopped");
			expect(settled.budgetExhausted).toBe("idle_timeout");
			expect(settled.budgetSeconds).toBe(8);
			expect(settled.budgetIdleTimeout).toBe(8);
			expect(settled.budgetTimeout).toBe(0);
			// idle 8s + cooperative grace 2s + TERM window + SIGKILL escalation.
			expect(elapsed).toBeGreaterThanOrEqual(9_900);
			expect(elapsed).toBeLessThan(30_000);
			expect(settled.recoveryError).toBeUndefined();
			expect(settled.handle).toBeUndefined();
			// The partial session survives the enforced kill: the run stays
			// resumable from its persisted JSONL.
			expect(settled.sessionFile).toBeTruthy();

			const child = launch.launched[0];
			if (!child) throw new Error("frozen-child run did not launch a native child");
			await child.exited;
			expect(await launch.launcher.alive(child.handle)).toBe(false);
			expect(() => process.kill(frozenPid, 0)).toThrow(/ESRCH/);
			expect(store.readRegistry()).toEqual([]);
			expect(store.readHistory()[0]).toMatchObject({
				id: run.id,
				status: "stopped",
				budgetExhausted: "idle_timeout",
				budgetSeconds: 8,
			});
			expect(store.readHistory()[0]?.sessionFile).toBeTruthy();
		} finally {
			// Safety net only: on success enforcement already killed the group.
			if (frozenPid !== undefined) {
				try {
					process.kill(-frozenPid, "SIGKILL");
				} catch {}
				try {
					process.kill(frozenPid, "SIGKILL");
				} catch {}
			}
			await harness.manager.dispose().catch(() => undefined);
		}
	}, 45_000);
});
