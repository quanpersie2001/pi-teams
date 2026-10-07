import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../../extension-src/pi-subagents/app/agent-manager.js";
import { AgentRegistry } from "../../extension-src/pi-subagents/app/agent-registry.js";
import { createPiSubagentsApp } from "../../extension-src/pi-subagents/app/index.js";
import type { SerializableBackendHandle, SubagentRunStore } from "../../extension-src/pi-subagents/app/run-registry.js";
import { buildAgentListView } from "../../extension-src/pi-subagents/app/ui-snapshot.js";
import { type AgentRun, isTerminalStatus } from "../../extension-src/pi-subagents/domain/agent-run.js";
import type {
	AgentBackendHandle,
	AgentLaunchInput,
	BackendStatus,
} from "../../extension-src/pi-subagents/domain/backend.js";
import { sanitizeSettings } from "../../extension-src/pi-subagents/domain/config.js";
import type { LauncherHandle, ProcessLauncher } from "../../extension-src/pi-subagents/domain/process-launcher.js";
import { ProcessAgentExecutionBackend } from "../../extension-src/pi-subagents/pi/process-backend.js";
import { createProcessLaunchers } from "../../extension-src/pi-subagents/pi/process-launchers.js";
import { createSubagentRunStore } from "../../extension-src/pi-subagents/pi/registry-host.js";

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
}

async function localProvider(options: { holdFirst?: boolean } = {}): Promise<LocalProvider> {
	const root = await mkdtemp(join(tmpdir(), "subagents-process-runtime-"));
	tempRoots.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(agentDir, { recursive: true });
	await mkdir(cwd, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const requests: string[] = [];
	const firstRequest = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", async () => {
			requests.push(body);
			if (requests.length === 1) {
				firstRequest.resolve();
				if (options.holdFirst) await released.promise;
			}
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			const prefix = { id: "chatcmpl-local", object: "chat.completion.chunk", created: 1, model: "local-model" };
			for (const chunk of [
				{
					...prefix,
					choices: [{ index: 0, delta: { role: "assistant", content: "process-child-ok" }, finish_reason: null }],
				},
				{ ...prefix, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
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
	return { cwd, requests, firstRequest: firstRequest.promise, releaseFirst: released.resolve };
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
	const root = await mkdtemp(join(tmpdir(), "subagents-budget-runtime-"));
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
	for (const live of [false, true]) {
		it(`restores a settled unavailable-RPC receipt without ${live ? "killing a live child" : "retaining a verified dead child"}`, async () => {
			const provider = await localProvider({ holdFirst: true });
			const { launcher, exited } = observedHeadlessLauncher();
			const original = new ProcessAgentExecutionBackend({ launchers: [launcher], connectTimeoutMs: 15_000 });
			const restored = new ProcessAgentExecutionBackend({ launchers: [launcher] });
			const id = `settled-disconnected-${live ? "live" : "dead"}`;
			const handle = await original.launch(launchInput(id, provider.cwd));
			await provider.firstRequest;
			const serialized = original.serializeHandle(handle);
			if (!serialized?.launcher.pid) throw new Error("Native child identity is unavailable");
			original.detach(handle);
			await rm(serialized.socketPath, { force: true });
			if (!live) {
				process.kill(serialized.launcher.pid, "SIGKILL");
				await exited;
			}
			const store = createSubagentRunStore(provider.cwd);
			store.writeRegistry([
				{
					id,
					type: "general-purpose",
					description: "Interrupted failed-child cleanup",
					status: "error",
					backend: "process",
					handle: serialized,
					error: "Preserved provider failure",
					startedAt: 1,
					completedAt: 2,
					cwd: provider.cwd,
					configCwd: provider.cwd,
					owner: { kind: "conversation", sessionId: "restore-smoke" },
					delivery: "conversation",
				},
			]);
			const observed = await restored.probeSerialized(serialized, id);
			expect(observed.state).toBe("disconnected");
			const app = createPiSubagentsApp({
				sources: [],
				loader: async () => [],
				settings: sanitizeSettings({ rememberAgents: true, worktreeIsolation: false }),
				backends: [restored],
				cwd: provider.cwd,
				configCwd: provider.cwd,
				getSessionId: () => "restore-smoke",
				runStore: store,
				restoreObservers: {
					sessionPresent: () => true,
					detectCompletion: () => ({ finished: false }),
					resourceAlive: () => undefined,
				},
			});
			try {
				await app.sessionStart();
				expect(app.manager.get(id)?.status).toBe("error");
				expect(app.manager.get(id)?.error).toBe("Preserved provider failure");
				if (live) {
					expect(app.manager.get(id)?.handle).toBeDefined();
					expect(app.manager.get(id)?.recoveryError).toBeDefined();
					expect(store.readRegistry()).toMatchObject([{ id, handle: serialized }]);
					expect(process.kill(serialized.launcher.pid ?? 0, 0)).toBe(true);
				} else {
					expect(app.manager.get(id)?.handle).toBeUndefined();
					expect(store.readRegistry()).toEqual([]);
					expect(() => process.kill(serialized.launcher.pid ?? 0, 0)).toThrow(/ESRCH/);
				}
				expect(store.readHistory()).toMatchObject([{ id, status: "error", error: "Preserved provider failure" }]);
			} finally {
				await app.sessionShutdown();
				provider.releaseFirst();
				if (live) {
					await launcher.terminate(serialized.launcher);
					await exited;
				}
			}
		}, 60_000);
	}
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
			await expect(access(join(provider.cwd, ".pi", "subagents"))).rejects.toMatchObject({ code: "ENOENT" });
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

	it("rejects controls when authenticated native PID disagrees with a persisted launcher identity", async () => {
		const provider = await localProvider({ holdFirst: true });
		const original = new ProcessAgentExecutionBackend({ launcherHint: "headless", connectTimeoutMs: 15_000 });
		const restored = new ProcessAgentExecutionBackend({ launcherHint: "headless", connectTimeoutMs: 2_000 });
		let originalHandle: AgentBackendHandle | undefined;
		let restoredHandle: AgentBackendHandle | undefined;
		try {
			originalHandle = await original.launch(launchInput("identity-mismatch", provider.cwd));
			await provider.firstRequest;
			const serialized = original.serializeHandle(originalHandle);
			if (!serialized?.launcher.pid) throw new Error("Fixture launcher identity was not serializable");
			original.detach(originalHandle);
			const mismatched = { ...serialized, launcher: { ...serialized.launcher, pid: serialized.launcher.pid + 1 } };
			restoredHandle = restored.restoreHandle("identity-mismatch", mismatched) ?? undefined;
			if (!restoredHandle) throw new Error("Fixture bootstrap was not restorable");
			expect(await restored.status(restoredHandle)).toMatchObject({
				state: "disconnected",
				detail: expect.stringMatching(/PID/),
			});
			await expect(restored.steer(restoredHandle, "Do not admit this steer")).rejects.toThrow(/PID/);
			await expect(restored.stop(restoredHandle)).rejects.toThrow(/PID/);
		} finally {
			provider.releaseFirst();
			if (restoredHandle) restored.detach(restoredHandle);
			if (originalHandle) await original.dispose(originalHandle);
		}
	}, 60_000);
	it("retains a live disconnected child handle when its socket is unavailable", async () => {
		const provider = await localProvider({ holdFirst: true });
		const { launcher, exited } = observedHeadlessLauncher();
		const backend = new ProcessAgentExecutionBackend({ launchers: [launcher], connectTimeoutMs: 15_000 });
		let handle: AgentBackendHandle | undefined;
		let serialized: SerializableBackendHandle | undefined;
		try {
			handle = await backend.launch(launchInput("live-disconnected", provider.cwd));
			await provider.firstRequest;
			serialized = backend.serializeHandle(handle);
			if (!serialized?.launcher.pid) throw new Error("Fixture launcher identity was not serializable");
			backend.detach(handle);
			await rm(serialized.socketPath, { force: true });
			await expect(backend.dispose(handle)).rejects.toThrow();
			expect(backend.serializeHandle(handle)).toBeDefined();
			expect(await launcher.cleanupExited(serialized.launcher)).toBe(false);
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
	it("reauthenticates a detached live child in the same backend before accepting control", async () => {
		const provider = await localProvider({ holdFirst: true });
		const backend = new ProcessAgentExecutionBackend({ launcherHint: "headless", connectTimeoutMs: 15_000 });
		let handle: AgentBackendHandle | undefined;
		try {
			handle = await backend.launch(launchInput("detached-active", provider.cwd));
			await provider.firstRequest;
			backend.detach(handle);
			expect((await backend.status(handle)).state).toBe("running");
			expect(await backend.stop(handle)).toBe(true);
			expect((await waitForTerminal(backend, handle)).state).toBe("stopped");
		} finally {
			provider.releaseFirst();
			if (handle) await backend.dispose(handle);
		}
	}, 60_000);
	it("cold-resumes a native Pi child from the original persisted session", async () => {
		const provider = await localProvider();
		const cwd = provider.cwd;
		let backend = new ProcessAgentExecutionBackend({ launcherHint: "headless", connectTimeoutMs: 15_000 });
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

			const serialized = backend.serializeHandle(resumed, resumedStatus.sessionFile);
			if (!serialized) throw new Error("Completed child identity was not serializable");
			const detachedBackend = backend;
			detachedBackend.detach(resumed);
			activeHandle = undefined;
			backend = new ProcessAgentExecutionBackend({ launcherHint: "headless", connectTimeoutMs: 15_000 });
			const restored = backend.restoreHandle("process-run-2", serialized);
			if (!restored) {
				await detachedBackend.dispose(resumed);
				throw new Error("Persisted child identity was not restorable");
			}
			activeHandle = restored;
			expect(await backend.status(restored)).toMatchObject({ state: "completed", result: "process-child-ok" });
			const transcriptBeforeClose = await backend.readTranscript(restored);
			await backend.dispose(restored);
			activeHandle = undefined;
			expect(backend.serializeHandle(restored)).toBeUndefined();
			expect(await backend.readTranscript(restored)).toEqual(transcriptBeforeClose);
			expect(await backend.status(restored)).toMatchObject({
				state: "completed",
				sessionFile: resumedStatus.sessionFile,
			});
		} finally {
			if (activeHandle) await backend.dispose(activeHandle);
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

	it("anchors budget enforcement to the authenticated bootstrap identity, not a tampered registry PID", async () => {
		const provider = await scriptedProvider([{ kind: "hold" }]);
		const { launcher } = observedHeadlessLaunchers();
		const backend = new ProcessAgentExecutionBackend({ launchers: [launcher], connectTimeoutMs: 15_000 });
		const settings = sanitizeSettings({ backgroundByDefault: true, worktreeIsolation: false });
		const registry = new AgentRegistry({ sources: [], loader: async () => [], settings });
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
		let handle: AgentBackendHandle | undefined;
		let serialized: SerializableBackendHandle | undefined;
		try {
			handle = await backend.launch(launchInput("tampered-budget-run", provider.cwd));
			await provider.firstRequest;
			serialized = backend.serializeHandle(handle);
			if (!serialized?.launcher.pid) throw new Error("native child identity was not serializable");
			const realPid = serialized.launcher.pid;

			// A stale/tampered launcher PID in a restored receipt must neither
			// shield the owned child from its deadline nor redirect the kill at an
			// unrelated process: ownership follows the authenticated bootstrap, the
			// owned group is terminated, and the run settles with the budget outcome.
			const staleClocks = Date.now() - 9_000;
			const receipt = {
				id: "tampered-budget-run",
				type: "general-purpose",
				description: "tampered receipt budget enforcement",
				status: "running",
				backend: "process",
				handle: { ...serialized, launcher: { ...serialized.launcher, pid: realPid + 1 } },
				model: "local-test/local-model",
				startedAt: staleClocks,
				cwd: provider.cwd,
				configCwd: provider.cwd,
				owner: { kind: "conversation", sessionId: "tampered-budget" },
				delivery: "conversation",
				budgetTimeout: 0,
				budgetIdleTimeout: 8,
				budgetStartedAt: staleClocks,
				budgetLastOutputAt: staleClocks,
			} as const;
			store.writeRegistry([receipt]);
			const restored = await manager.restoreReconnectedRun(receipt);
			expect(restored.state).toBe("retained");

			const settled = await manager.whenSettled("tampered-budget-run");
			expect(settled?.status).toBe("stopped");
			expect(settled?.budgetExhausted).toBe("idle_timeout");
			expect(settled?.budgetSeconds).toBe(8);
			expect(settled?.recoveryError).toBeUndefined();
			// The owned child group is gone.
			expect(() => process.kill(realPid, 0)).toThrow(/ESRCH/);
			expect(store.readRegistry()).toEqual([]);
			expect(store.readHistory()[0]).toMatchObject({
				id: "tampered-budget-run",
				status: "stopped",
				budgetExhausted: "idle_timeout",
				budgetSeconds: 8,
			});
		} finally {
			await manager.shutdownSession();
			if (serialized) await launcher.terminate(serialized.launcher).catch(() => undefined);
			if (handle) await backend.dispose(handle).catch(() => undefined);
		}
	}, 45_000);
});
