import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentLaunchInput } from "../../extension-src/pi-teams/domain/backend.js";
import {
	ProcessLaunchCleanupPendingError,
	type ProcessLauncher,
} from "../../extension-src/pi-teams/domain/process-launcher.js";
import { ChildRpcClient } from "../../extension-src/pi-teams/pi/child-rpc-client.js";
import { ProcessAgentExecutionBackend } from "../../extension-src/pi-teams/pi/process-backend.js";
import { createProcessLaunchers } from "../../extension-src/pi-teams/pi/process-launchers.js";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([false, true])(
	"retains an authenticated recovery receipt when startup fails and allocated child cleanup is unverified (launcher rejected: %s)",
	async (launcherRejected) => {
		const cwd = mkdtempSync(join(tmpdir(), "launch-ownership-"));
		roots.push(cwd);
		const launcher: ProcessLauncher = {
			kind: "headless",
			available: async () => true,
			launch: async (spec) => {
				const handle = { kind: "headless" as const, childId: spec.childId, pid: 12345, identity: { start: "owned" } };
				if (launcherRejected)
					throw new ProcessLaunchCleanupPendingError("launcher cleanup unverified", undefined, handle);
				return handle;
			},
			alive: async () => undefined,
			terminate: vi.fn(async () => {
				throw new Error("exit cannot be verified");
			}),
			cleanupExited: vi.fn(async () => false),
		};
		const backend = new ProcessAgentExecutionBackend({ launchers: [launcher], connectTimeoutMs: 10 });
		vi.spyOn(backend, "prepareModel").mockResolvedValue({ model: "fake/model" });
		const input: AgentLaunchInput = {
			runId: "uncertain-launch",
			type: "general-purpose",
			description: "test",
			prompt: "work",
			systemPrompt: "",
			promptMode: "text",
			cwd,
			configCwd: cwd,
			background: true,
		};
		const failure = (await backend.launch(input).catch((error: unknown) => error)) as Error & {
			handle: { kind: "process"; handle: string };
		};
		expect(failure).toBeInstanceOf(Error);
		expect(launcher.terminate).toHaveBeenCalledTimes(launcherRejected ? 0 : 1);
		expect(failure.handle).toEqual({ kind: "process", handle: input.runId });
		const receipt = backend.serializeHandle(failure.handle);
		expect(receipt).toMatchObject({ launcher: { pid: 12345, identity: { start: "owned" } } });
		if (receipt?.kind !== "process") throw new Error("missing process receipt");
		const bootstrap = JSON.parse(readFileSync(join(receipt.runDir, "bootstrap.json"), "utf8"));
		expect(receipt).toMatchObject({
			childId: bootstrap.childId,
			token: bootstrap.token,
			socketPath: bootstrap.socketPath,
		});
		await expect(backend.disposePersisted(receipt)).resolves.toBe(false);
		const recovered = new ProcessAgentExecutionBackend({ launchers: [launcher], connectTimeoutMs: 10 });
		await expect(recovered.disposePersisted({ ...receipt, token: "foreign" })).resolves.toBe(false);
		await expect(recovered.disposePersisted(receipt)).resolves.toBe(false);
		launcher.cleanupExited = async () => true;
		await expect(recovered.disposePersisted(receipt)).resolves.toBe(true);
		await expect(backend.dispose(failure.handle)).resolves.toBeUndefined();
		expect(backend.serializeHandle(failure.handle)).toBeUndefined();
	},
);

it.each([false, true])(
	"preserves the Windows launcher's allocated PID and available identity when internal cleanup fails (probe failed: %s)",
	async (probeFailed) => {
		const cwd = mkdtempSync(join(tmpdir(), "launcher-receipt-"));
		roots.push(cwd);
		const pid = 1900000003;
		const taskkill = vi.fn(async () => {
			throw new Error("taskkill refused");
		});
		const launcher = createProcessLaunchers({
			platform: "win32",
			runner: {
				async run(command) {
					if (command === "taskkill") return taskkill();
					if (probeFailed) throw new Error("identity probe unavailable");
					return {
						stdout: JSON.stringify({ ProcessId: pid, CreationDate: "allocated-time", CommandLine: "foreign" }),
						stderr: "",
					};
				},
			},
			spawnProcess: (() => {
				const child = Object.assign(new EventEmitter(), { pid, unref() {} }) as unknown as ChildProcess;
				queueMicrotask(() => child.emit("spawn"));
				return child;
			}) as typeof spawn,
		}).find((candidate) => candidate.kind === "headless");
		if (!launcher) throw new Error("missing launcher");
		const failure = await launcher
			.launch({
				childId: "allocated",
				runDir: cwd,
				cwd,
				env: {},
				interactiveArgv: [],
				headlessCommand: "node",
				headlessArgv: [],
			})
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ProcessLaunchCleanupPendingError);
		if (!(failure instanceof ProcessLaunchCleanupPendingError) || !failure.handle)
			throw new Error("missing launcher receipt");
		expect(failure.handle).toMatchObject({
			kind: "headless",
			childId: "allocated",
			pid,
			identity: { ownerToken: expect.any(String) },
		});
		expect(failure.handle.identity?.creationDate).toBe(probeFailed ? undefined : "allocated-time");
		// Incomplete probe identity permits exit proof only, never permission to signal.
		await expect(launcher.cleanupExited(failure.handle)).resolves.toBe(true);
		expect(taskkill).toHaveBeenCalledOnce();
	},
);

it.each([false, true])(
	"fences a pending viewer receipt from attachment (native run registered: %s)",
	async (registered) => {
		const cwd = mkdtempSync(join(tmpdir(), "viewer-launch-ownership-"));
		roots.push(cwd);
		let childId = "";
		let cleanupAllowed = false;
		const native: ProcessLauncher = {
			kind: "headless",
			available: async () => true,
			async launch(spec) {
				childId = spec.childId;
				return { kind: "headless", childId, pid: 12345 };
			},
			alive: async () => true,
			cleanupExited: async () => false,
			async terminate() {
				if (!cleanupAllowed) throw new Error("native exit unverified");
			},
		};
		const attach = vi.fn(async () => {});
		const viewer: ProcessLauncher = {
			kind: "tmux",
			attach,
			available: async () => true,
			async launch(spec) {
				const handle = { kind: "tmux" as const, childId: spec.childId, paneId: "%7" };
				if (registered) return handle;
				throw new ProcessLaunchCleanupPendingError("viewer exit unverified", undefined, handle);
			},
			alive: async () => true,
			cleanupExited: async () => false,
			async terminate() {
				if (!cleanupAllowed) throw new Error("viewer exit unverified");
			},
		};
		vi.spyOn(ChildRpcClient.prototype, "connect").mockImplementation(async () => ({
			childId,
			pid: 12345,
			execution: "running",
			transcript: { items: [], cursor: 0 },
			seq: 0,
		}));
		if (registered)
			vi.spyOn(ChildRpcClient.prototype, "prompt").mockRejectedValue(new Error("post-allocation prompt failed"));
		const backend = new ProcessAgentExecutionBackend({ launchers: [viewer, native], launcherHint: "tmux" });
		vi.spyOn(backend, "prepareModel").mockResolvedValue({ model: "fake/model" });
		const failure = await backend
			.launch({
				runId: "viewer-failure",
				type: "general-purpose",
				description: "test",
				prompt: "work",
				systemPrompt: "",
				promptMode: "text",
				cwd,
				configCwd: cwd,
				background: true,
			})
			.catch((error: unknown) => error);
		if (!(failure instanceof Error) || !("handle" in failure)) throw new Error("missing failed-launch owner");
		const handle = failure.handle as { kind: "process"; handle: string };
		expect(backend.serializeHandle(handle)).toMatchObject({
			childId,
			launcher: { kind: "headless", childId, pid: 12345 },
			viewer: { kind: "tmux", childId: `${childId}-viewer`, paneId: "%7" },
		});
		await expect(backend.attach(handle)).resolves.toBe(false);
		expect(attach).not.toHaveBeenCalled();
		cleanupAllowed = true;
		await expect(backend.dispose(handle)).resolves.toBeUndefined();
	},
);
