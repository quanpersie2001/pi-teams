import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SerializableBackendHandle } from "../../extension-src/pi-teams/app/run-registry.js";
import type { ChildState } from "../../extension-src/pi-teams/domain/child-protocol.js";
import {
	type LauncherCommandRunner,
	ProcessLaunchCleanupPendingError,
	type ProcessLauncher,
} from "../../extension-src/pi-teams/domain/process-launcher.js";
import { ChildRpcClient } from "../../extension-src/pi-teams/pi/child-rpc-client.js";
import { ProcessAgentExecutionBackend } from "../../extension-src/pi-teams/pi/process-backend.js";
import { createProcessLaunchers } from "../../extension-src/pi-teams/pi/process-launchers.js";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(["verified", "unverified", "mismatched", "mismatched-path"])(
	"cleans persisted exited endpoints only with owned exit proof: %s",
	async (mode) => {
		const root = mkdtempSync(join(tmpdir(), "runtime-cleanup-"));
		roots.push(root);
		const endpointDir = join(root, "endpoint");
		mkdirSync(endpointDir);
		const socketPath = join(endpointDir, "control.sock");
		const unverifiedDir = join(root, "unverified-endpoint");
		mkdirSync(unverifiedDir);
		writeFileSync(join(unverifiedDir, "artifact"), "not owned by this receipt");
		writeFileSync(join(endpointDir, "artifact"), "owned endpoint artifact");
		writeFileSync(join(root, "bootstrap.json"), JSON.stringify({ childId: "owned", token: "secret", socketPath }));
		const launcher: ProcessLauncher = {
			kind: "headless",
			available: async () => true,
			launch: async () => {
				throw new Error("unused");
			},
			alive: async () => false,
			terminate: async () => {
				throw new Error("must not signal an exited child");
			},
			cleanupExited: async () => mode !== "unverified",
		};
		const backend = new ProcessAgentExecutionBackend({ launchers: [launcher], connectTimeoutMs: 10 });
		const receipt: SerializableBackendHandle = {
			kind: "process",
			childId: "owned",
			token: mode === "mismatched" ? "wrong" : "secret",
			socketPath: mode === "mismatched-path" ? join(unverifiedDir, "control.sock") : socketPath,
			runDir: root,
			launcher: { kind: "headless", childId: "owned", pid: 12345 },
		};
		expect(await backend.disposePersisted(receipt)).toBe(mode === "verified");
		expect(existsSync(endpointDir)).toBe(mode !== "verified" || process.platform === "win32");
		expect(existsSync(join(unverifiedDir, "artifact"))).toBe(true);
	},
);

async function nativeRaceHarness() {
	const cwd = mkdtempSync(join(tmpdir(), "native-loss-race-"));
	roots.push(cwd);
	let state: ChildState;
	let connectionListener: (connected: boolean) => void = () => {};
	const launcher: ProcessLauncher = {
		kind: "headless",
		available: async () => true,
		async launch(spec) {
			state = {
				childId: spec.childId,
				pid: 12345,
				execution: "running",
				currentRunId: "race",
				transcript: { items: [], cursor: 0 },
				seq: 1,
			};
			return { kind: "headless", childId: spec.childId, pid: 12345 };
		},
		alive: async () => true,
		cleanupExited: async () => true,
		terminate: async () => {},
	};
	vi.spyOn(ChildRpcClient.prototype, "connect").mockImplementation(async () => state);
	vi.spyOn(ChildRpcClient.prototype, "state").mockImplementation(async () => state);
	vi.spyOn(ChildRpcClient.prototype, "prompt").mockResolvedValue();
	vi.spyOn(ChildRpcClient.prototype, "subscribeConnection").mockImplementation((listener) => {
		connectionListener = listener;
		return () => {};
	});
	const backend = new ProcessAgentExecutionBackend({ launchers: [launcher] });
	vi.spyOn(backend, "prepareModel").mockResolvedValue({ model: "fake/model" });
	const handle = await backend.launch({
		runId: "race",
		type: "general-purpose",
		description: "test",
		prompt: "work",
		systemPrompt: "",
		promptMode: "text",
		cwd,
		configCwd: cwd,
		background: true,
	});
	return {
		backend,
		launcher,
		handle,
		disconnect: () => connectionListener(false),
		getSnapshot: () => state,
		setSnapshot: (snapshot: ChildState) => {
			state = snapshot;
		},
		complete: async () => {
			state = {
				...state,
				execution: "idle",
				seq: 2,
				lastOutcome: { runId: "race", status: "completed", result: "native won" },
			};
			await backend.status(handle);
		},
	};
}

it.each(["retained idle", "active"])("bounds subscribed focus reads for an unchanged %s child", async (mode) => {
	const { backend, handle, complete, getSnapshot } = await nativeRaceHarness();
	if (mode === "retained idle") await complete();
	const state = vi.spyOn(ChildRpcClient.prototype, "state").mockImplementation(async () => {
		// Fail boundedly on the regression rather than starving the test runner with an endless microtask loop.
		if (state.mock.calls.length > 10) throw new Error("Unbounded focus refresh");
		return structuredClone(getSnapshot());
	});
	state.mockClear();
	const reads: Promise<ChildState | undefined>[] = [];
	const observe = vi.fn(() => {
		reads.push(backend.readFocusState(handle));
	});
	const unsubscribe = backend.subscribeFocus(handle, observe);
	try {
		await Promise.all(reads);
		await backend.readFocusState(handle);
		expect(state).toHaveBeenCalledTimes(2);
		expect(observe).toHaveBeenCalledOnce(); // Initial subscription only; equal fresh RPC objects are not updates.
	} finally {
		unsubscribe();
		backend.detach(handle);
	}
});

it("notifies same-sequence native focus/model/session usage changes but not stale snapshots", async () => {
	const { backend, handle, complete, getSnapshot, setSnapshot } = await nativeRaceHarness();
	await complete();
	const accepted = structuredClone(getSnapshot());
	const observe = vi.fn();
	const unsubscribe = backend.subscribeFocus(handle, observe);
	try {
		const changed: ChildState = {
			...accepted,
			focus: {
				cwd: "/native",
				thinking: "off",
				model: { provider: "native", id: "model", name: "Native model" },
				capabilities: { models: [], thinking: [], commands: [] },
				sessionUsage: {
					scope: "session",
					inputTokens: 10,
					outputTokens: 20,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				},
			},
		};
		setSnapshot(changed);
		await expect(backend.readFocusState(handle)).resolves.toEqual(changed);
		expect(observe).toHaveBeenCalledTimes(2);
		expect(observe).toHaveBeenLastCalledWith(changed);

		setSnapshot({ ...accepted, seq: accepted.seq - 1 });
		await expect(backend.readFocusState(handle)).resolves.toEqual(changed);
		expect(observe).toHaveBeenCalledTimes(2);
	} finally {
		unsubscribe();
		backend.detach(handle);
	}
});

it("preserves native settlement during termination while publishing verified resource loss", async () => {
	const { backend, launcher, handle, complete } = await nativeRaceHarness();
	launcher.terminate = complete;
	expect(await backend.enforceTerminate(handle, 0)).toMatchObject({
		state: "completed",
		result: "native won",
		childExited: true,
	});
	expect(await backend.status(handle)).toMatchObject({ state: "completed", result: "native won", childExited: true });
});

it("publishes verified reconnect loss for an already settled native run", async () => {
	vi.useFakeTimers();
	const { backend, handle, complete, disconnect } = await nativeRaceHarness();
	await complete();
	const observe = vi.fn();
	backend.subscribe(handle, observe);
	vi.spyOn(ChildRpcClient.prototype, "connect").mockRejectedValue(new Error("gone"));
	disconnect();
	await vi.advanceTimersByTimeAsync(500);
	expect(observe).toHaveBeenLastCalledWith(
		expect.objectContaining({ state: "completed", result: "native won", childExited: true }),
	);
});

it.each(["recover", "native-refused", "viewer-refused", "both-exited"])(
	"uses read-only launcher recovery for persisted native/viewer cleanup without signaling incomplete receipts: %s",
	async (mode) => {
		const cwd = mkdtempSync(join(tmpdir(), "persisted-recovery-"));
		roots.push(cwd);
		const endpointDir = join(cwd, "endpoint");
		mkdirSync(endpointDir);
		const socketPath = join(endpointDir, "control.sock");
		writeFileSync(join(cwd, "bootstrap.json"), JSON.stringify({ childId: "owned", token: "secret", socketPath }));
		const nativeHandle = {
			kind: "herdr" as const,
			childId: "owned",
			paneId: "native-pane",
			terminalId: "native-terminal",
		};
		const viewerHandle = { kind: "tmux" as const, childId: "owned-viewer", paneId: "%7" };
		const recoveredNative = { ...nativeHandle, pid: 12345, identity: { startTime: "original" } };
		const recoveredViewer = { ...viewerHandle, pid: 12346, identity: { panePid: "12346", serverPid: "23456" } };
		const native: ProcessLauncher = {
			kind: "herdr",
			available: async () => true,
			launch: async () => nativeHandle,
			alive: async () => undefined,
			recoverForCleanup: vi.fn(async () =>
				mode === "native-refused" || mode === "both-exited" ? undefined : recoveredNative,
			),
			cleanupExited: vi.fn(async () => mode === "both-exited"),
			terminate: vi.fn(async () => {}),
		};
		const viewer: ProcessLauncher = {
			kind: "tmux",
			available: async () => true,
			launch: async () => viewerHandle,
			alive: async () => undefined,
			recoverForCleanup: vi.fn(async () =>
				mode === "viewer-refused" || mode === "both-exited" ? undefined : recoveredViewer,
			),
			cleanupExited: vi.fn(async () => mode === "both-exited"),
			terminate: vi.fn(async () => {}),
		};
		vi.spyOn(ChildRpcClient.prototype, "connect").mockResolvedValue({
			childId: "owned",
			pid: 12345,
			execution: "idle",
			transcript: { items: [], cursor: 0 },
			seq: 1,
		});
		const backend = new ProcessAgentExecutionBackend({ launchers: [native, viewer] });
		const receipt: SerializableBackendHandle = {
			kind: "process",
			childId: "owned",
			token: "secret",
			runDir: cwd,
			socketPath,
			launcher: nativeHandle,
			viewer: viewerHandle,
		};
		await expect(backend.disposePersisted(receipt)).resolves.toBe(mode === "recover" || mode === "both-exited");
		expect(native.recoverForCleanup).toHaveBeenCalledWith(nativeHandle);
		if (mode === "recover") {
			expect(native.terminate).toHaveBeenCalledExactlyOnceWith(recoveredNative);
			expect(viewer.terminate).toHaveBeenCalledExactlyOnceWith(recoveredViewer);
		} else {
			expect(native.terminate).not.toHaveBeenCalled();
			expect(viewer.terminate).not.toHaveBeenCalled();
		}
		expect(receipt.launcher).toEqual(nativeHandle);
		expect(receipt.viewer).toEqual(viewerHandle);
	},
);

it("recovers an actual tmux producer's serialized partial viewer through backend disposal without rebinding a foreign pane", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "real-port-recovery-"));
	roots.push(cwd);
	const socketPath = join(cwd, "endpoint", "control.sock");
	mkdirSync(join(cwd, "endpoint"));
	writeFileSync(join(cwd, "bootstrap.json"), JSON.stringify({ childId: "owned", token: "secret", socketPath }));
	let startCommand = "";
	let probeFailed = true;
	let foreign = false;
	let paneMissing = false;
	const killed: string[] = [];
	const runner: LauncherCommandRunner = {
		async run(command, rawArgs) {
			if (command !== "tmux") throw new Error(`unexpected command ${command}`);
			const args = rawArgs[0] === "-S" ? rawArgs.slice(2) : rawArgs;
			let stdout = "";
			if (args[0] === "split-window") {
				startCommand = args.at(-1) ?? "";
				stdout = "%7\n";
			} else if (args[0] === "list-panes") stdout = args.includes("#{pane_id}") ? "%0\n" : "%0 0 0 120 40\n";
			else if (args.includes("#{pane_id} #{pane_pid} #{pid} #{window_id}")) stdout = "%0 1888888888 1899999999 @0\n";
			else if (args.includes("#{pane_id} #{pane_pid} #{pid}")) {
				if (probeFailed) throw new Error("temporary pane probe failure");
				if (paneMissing) throw new Error("can't find pane: %7");
				stdout = "%7 1900000000 1899999999\n";
			} else if (args.includes("#{pane_start_command}")) stdout = foreign ? "/bin/sh\n" : `${startCommand}\n`;
			else if (args.includes("#{pane_id}")) stdout = "%0\n";
			else if (args.includes("#{pid}")) stdout = "1899999999\n";
			else if (args[0] === "kill-pane") {
				killed.push(args[2] ?? "");
				paneMissing = true;
			} else if (args[0] !== "resize-pane") throw new Error(`unexpected tmux args ${args.join(" ")}`);
			return { stdout, stderr: "" };
		},
	};
	const viewer = createProcessLaunchers({ runner, env: { TMUX: "/tmp/runtime-recovery-tmux.sock,1,0" } }).find(
		(candidate) => candidate.kind === "tmux",
	);
	if (!viewer) throw new Error("missing tmux launcher");
	const failure = await viewer
		.launch({
			childId: "owned-viewer",
			runDir: cwd,
			cwd,
			env: {},
			interactiveArgv: ["node"],
			headlessCommand: "node",
			headlessArgv: [],
		})
		.catch((error: unknown) => error);
	if (!(failure instanceof ProcessLaunchCleanupPendingError) || !failure.handle)
		throw new Error("missing partial viewer receipt");
	const partial = JSON.parse(JSON.stringify(failure.handle));
	expect(partial.pid).toBeUndefined();
	const native: ProcessLauncher = {
		kind: "headless",
		available: async () => true,
		launch: async () => {
			throw new Error("unused");
		},
		alive: async () => true,
		terminate: vi.fn(async () => {}),
		cleanupExited: async () => false,
	};
	vi.spyOn(ChildRpcClient.prototype, "connect").mockResolvedValue({
		childId: "owned",
		pid: 12345,
		execution: "idle",
		transcript: { items: [], cursor: 0 },
		seq: 1,
	});
	const backend = new ProcessAgentExecutionBackend({ launchers: [native, viewer] });
	const receipt: SerializableBackendHandle = {
		kind: "process",
		childId: "owned",
		token: "secret",
		runDir: cwd,
		socketPath,
		launcher: { kind: "headless", childId: "owned", pid: 12345 },
		viewer: partial,
	};
	probeFailed = false;
	foreign = true;
	expect(await backend.disposePersisted(receipt)).toBe(false);
	expect(killed).toEqual([]);
	expect(native.terminate).not.toHaveBeenCalled();
	expect(receipt.viewer?.pid).toBeUndefined();
	foreign = false;
	expect(await backend.disposePersisted(receipt)).toBe(true);
	expect(killed).toEqual(["%7"]);
	expect(native.terminate).toHaveBeenCalledOnce();
	expect(receipt.viewer?.pid).toBeUndefined();
});
