import type { ChildProcess, SpawnOptions } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LauncherCommandRunner } from "../../extension-src/pi-teams/domain/process-launcher.js";
import {
	ProcessLaunchCleanupPendingError,
	type ProcessLauncher,
} from "../../extension-src/pi-teams/domain/process-launcher.js";
import { createProcessLaunchers } from "../../extension-src/pi-teams/pi/process-launchers.js";

interface Harness {
	launcher: ProcessLauncher;
	reusePane(command?: string): void;
	failSplit(): void;
	failPaneQuery(): void;
	removePane(blankReply?: boolean): void;
	command(): string;
	killed: string[];
}

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const directory = tempDirs.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

function tmuxHarness(): Harness {
	const panePid = "1900000000";
	const serverPid = "1899999999";
	let startCommand = "";
	let splitFails = false;
	let paneQueryFails = false;
	let paneMissing = false;
	let blankMissingReply = false;
	let splitCreated = false;
	const killed: string[] = [];
	const runner: LauncherCommandRunner = {
		async run(command, args) {
			if (command !== "tmux") throw new Error(`unexpected command ${command}`);
			const socketPath = args[0] === "-S" ? args[1] : undefined;
			if (socketPath === "/tmp/missing-tmux.sock") throw new Error("no server running");
			const commandArgs = args[0] === "-S" ? args.slice(2) : args;
			if (socketPath === "/tmp/foreign-tmux.sock") {
				if (commandArgs.includes("#{pane_id} #{pane_pid} #{pid}"))
					return { stdout: `%7 ${panePid} 1899999998\n`, stderr: "" };
				if (commandArgs.includes("#{pane_start_command}")) return { stdout: "/bin/sh\n", stderr: "" };
			}
			if (commandArgs[0] === "-V") return { stdout: "tmux 3.5", stderr: "" };
			if (commandArgs[0] === "display-message" && commandArgs[2] === "#{pane_id}")
				return { stdout: "%0\n", stderr: "" };
			if (commandArgs[0] === "display-message" && commandArgs[2] === "#{pid}")
				return { stdout: `${serverPid}\n`, stderr: "" };
			if (commandArgs[0] === "display-message" && commandArgs.includes("#{pane_id} #{pane_pid} #{pid} #{window_id}"))
				return { stdout: `%0 1888888888 ${serverPid} @0\n`, stderr: "" };
			if (commandArgs[0] === "list-panes") {
				if (commandArgs.includes("#{pane_id}"))
					return { stdout: splitCreated && !paneMissing ? "%0\n%7\n" : "%0\n", stderr: "" };
				const stdout = splitCreated && !paneMissing ? "%0 0 0 60 40\n%7 61 0 59 40\n" : "%0 0 0 120 40\n";
				return { stdout, stderr: "" };
			}
			if (commandArgs[0] === "split-window") {
				if (splitFails) throw new Error("split failed");
				splitCreated = true;
				startCommand = commandArgs.at(-1) ?? "";
				return { stdout: "%7\n", stderr: "" };
			}
			if (commandArgs[0] === "display-message" && commandArgs.includes("#{pane_start_command}"))
				return { stdout: paneMissing && blankMissingReply ? "\n" : `${startCommand}\n`, stderr: "" };
			if (commandArgs[0] === "display-message" && commandArgs.includes("#{pane_id} #{pane_pid} #{pid}")) {
				if (paneMissing && blankMissingReply) return { stdout: `  ${serverPid}\n`, stderr: "" };
				if (paneMissing) throw new Error("can't find pane: %7");
				if (paneQueryFails) throw new Error("tmux socket unavailable");
				return { stdout: `%7 ${panePid} ${serverPid}\n`, stderr: "" };
			}
			if (commandArgs[0] === "kill-pane") {
				const pane = commandArgs[2];
				if (!pane) throw new Error("kill-pane requires a target");
				killed.push(pane);
				paneMissing = true;
				return { stdout: "", stderr: "" };
			}
			throw new Error(`unexpected tmux args ${commandArgs.join(" ")}`);
		},
	};
	const launcher = createProcessLaunchers({ runner, env: { TMUX: "/tmp/tmux-1000/default,1,0" } }).find(
		(candidate) => candidate.kind === "tmux",
	);
	if (!launcher) throw new Error("tmux launcher is missing");
	return {
		launcher,
		reusePane(command = "/bin/sh") {
			startCommand = command;
		},
		failSplit() {
			splitFails = true;
		},
		failPaneQuery() {
			paneQueryFails = true;
		},
		removePane(blankReply = false) {
			paneMissing = true;
			blankMissingReply = blankReply;
		},
		command() {
			return startCommand;
		},
		killed,
	};
}

const spec = {
	childId: "child-a",
	runDir: "/tmp/child-a",
	cwd: "/tmp",
	env: { PI_TEAMS_BOOTSTRAP: "/tmp/config.json", MESSAGE: "'quoted value'" },
	interactiveArgv: ["pi", "--extension", "/tmp/bridge with spaces.js"],
	headlessCommand: "node",
	headlessArgv: ["/tmp/child.js"],
};

// A PID beyond the kernel's allocation range never exists, so processExists()
// stays deterministically false on the CI hosts running this suite.
const windowsDeadPid = 1900000003;
const windowsCreationDate = "/Date(1760000000000)/";
const reusedWindowsCreationDate = "/Date(1760000099999)/";

interface WindowsHeadlessHarness {
	launcher: ProcessLauncher;
	taskkill: string[];
	spawnedArgv(): readonly string[];
	spawnedOwnerEnv(): string | undefined;
	useLivePid(): ChildProcess;
	dropOwnerToken(): void;
	reusePid(): void;
	failProbe(): void;
	failNextTaskkill(code: number, stderr: string): void;
}

function windowsHeadlessHarness(): WindowsHeadlessHarness {
	let pid = windowsDeadPid;
	let creationDate = windowsCreationDate;
	let ownerless = false;
	let probeFails = false;
	let spawnedArgv: readonly string[] = [];
	let spawnedOwnerEnv: string | undefined;
	const taskkill: string[] = [];
	const taskkillFailures: Array<{ code: number; stderr: string }> = [];
	const runner: LauncherCommandRunner = {
		async run(command, args) {
			if (command === "powershell.exe") {
				if (probeFails) throw Object.assign(new Error("powershell.exe exited unsuccessfully"), { code: 1, stderr: "" });
				const probed = /ProcessId=(\d+)/.exec(args.join(" "))?.[1];
				if (probed !== String(pid)) return { stdout: "", stderr: "" };
				const commandLine = ownerless ? "C:\\Windows\\System32\\unrelated.exe --foreign" : spawnedArgv.join(" ");
				return {
					stdout: JSON.stringify({ ProcessId: pid, CreationDate: creationDate, CommandLine: commandLine }),
					stderr: "",
				};
			}
			if (command === "taskkill") {
				taskkill.push(args.join(" "));
				const failure = taskkillFailures.shift();
				if (failure)
					throw Object.assign(new Error("taskkill exited unsuccessfully"), {
						code: failure.code,
						stderr: failure.stderr,
						stdout: "",
					});
				return { stdout: "", stderr: "" };
			}
			throw new Error(`unexpected command ${command}`);
		},
	};
	const spawnProcess = ((command: string, args: readonly string[], options: SpawnOptions) => {
		spawnedArgv = [command, ...args];
		spawnedOwnerEnv = options.env?.PI_TEAMS_LAUNCH_OWNER;
		const child = Object.assign(new EventEmitter(), { pid, unref: () => {} }) as unknown as ChildProcess;
		queueMicrotask(() => child.emit("spawn"));
		return child;
	}) as typeof spawn;
	const launcher = createProcessLaunchers({ platform: "win32", runner, spawnProcess }).find(
		(candidate) => candidate.kind === "headless",
	);
	if (!launcher) throw new Error("windows headless launcher is missing");
	return {
		launcher,
		taskkill,
		spawnedArgv: () => spawnedArgv,
		spawnedOwnerEnv: () => spawnedOwnerEnv,
		useLivePid() {
			const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
			pid = live.pid ?? pid;
			return live;
		},
		dropOwnerToken() {
			ownerless = true;
		},
		reusePid() {
			creationDate = reusedWindowsCreationDate;
		},
		failProbe() {
			probeFails = true;
		},
		failNextTaskkill(code, stderr) {
			taskkillFailures.push({ code, stderr });
		},
	};
}

async function stopLiveChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	child.once("exit", () => resolve());
	child.kill("SIGTERM");
	await promise;
}

function windowsRunDir(): string {
	const runDir = mkdtempSync(join(tmpdir(), "pi-windows-launcher-"));
	tempDirs.push(runDir);
	return runDir;
}

describe("process launcher lifecycle safety", () => {
	it("propagates an interactive launch failure instead of returning a fake handle", async () => {
		const harness = tmuxHarness();
		harness.failSplit();
		await expect(harness.launcher.launch(spec)).rejects.toThrow("split failed");
	});
	it("does not kill a split pane when ownership cannot be verified after transport loss", async () => {
		const harness = tmuxHarness();
		harness.failPaneQuery();
		await expect(harness.launcher.launch(spec)).rejects.toBeInstanceOf(ProcessLaunchCleanupPendingError);
		expect(harness.killed).toEqual([]);
	});

	it("preserves argument boundaries and literal shell metacharacters", async () => {
		const harness = tmuxHarness();
		const argv = ["/usr/bin/printf", "<%s>\\n", "two words", "single'quote", "$(not-a-command)"];
		await harness.launcher.launch({ ...spec, env: {}, interactiveArgv: argv });
		const result = execFileSync("/bin/sh", ["-c", harness.command()], { encoding: "utf8" });
		expect(result).toBe("<two words>\n<single'quote>\n<$(not-a-command)>\n");
	});

	it("refuses cleanup when a reused tmux pane ID no longer matches its owner token", async () => {
		const harness = tmuxHarness();
		const handle = await harness.launcher.launch(spec);
		harness.reusePane();
		expect(await harness.launcher.alive(handle)).toBe(false);
		expect(await harness.launcher.cleanupExited(handle)).toBe(false);
		await expect(harness.launcher.terminate(handle)).rejects.toThrow("unverified tmux pane");
		expect(harness.killed).toEqual([]);
	});

	it("reports unavailable transport as unknown liveness and never kills", async () => {
		const harness = tmuxHarness();
		const handle = await harness.launcher.launch(spec);
		harness.failPaneQuery();
		expect(await harness.launcher.alive(handle)).toBeUndefined();
		expect(await harness.launcher.cleanupExited(handle)).toBe(false);
		await expect(harness.launcher.terminate(handle)).rejects.toThrow("unverified tmux pane");
		expect(harness.killed).toEqual([]);
	});

	it("releases an already-removed tmux pane without killing another resource", async () => {
		const harness = tmuxHarness();
		const handle = await harness.launcher.launch(spec);
		harness.removePane();
		expect(await harness.launcher.alive(handle)).toBe(false);
		await expect(harness.launcher.cleanupExited(handle)).resolves.toBe(true);
		await expect(harness.launcher.terminate(handle)).resolves.toBeUndefined();
		expect(harness.killed).toEqual([]);
	});
	it("releases a pane whose successful tmux query omits pane fields only after confirming server-wide absence", async () => {
		const harness = tmuxHarness();
		const handle = await harness.launcher.launch(spec);
		harness.removePane(true);
		expect(await harness.launcher.alive(handle)).toBe(false);
		await expect(harness.launcher.cleanupExited(handle)).resolves.toBe(true);
		await harness.launcher.terminate(handle);
		expect(harness.killed).toEqual([]);
	});
	it("preserves a present pane with incomplete ownership even when its server is reachable", async () => {
		const harness = tmuxHarness();
		const handle = await harness.launcher.launch(spec);
		harness.reusePane("");
		expect(await harness.launcher.alive(handle)).toBeUndefined();
		expect(await harness.launcher.cleanupExited(handle)).toBe(false);
		await expect(harness.launcher.terminate(handle)).rejects.toThrow("unverified tmux pane");
		expect(harness.killed).toEqual([]);
	});
	it("uses only the saved tmux socket and preserves uncertain endpoint identity", async () => {
		const harness = tmuxHarness();
		const handle = await harness.launcher.launch(spec);
		await expect(harness.launcher.cleanupExited({ ...handle, socketPath: undefined })).rejects.toThrow(
			"Incomplete tmux launcher handle",
		);
		const foreignSocket = { ...handle, socketPath: "/tmp/foreign-tmux.sock" };
		expect(await harness.launcher.cleanupExited(foreignSocket)).toBe(false);
		await expect(harness.launcher.terminate(foreignSocket)).rejects.toThrow("unverified tmux pane");
		expect(await harness.launcher.cleanupExited({ ...handle, socketPath: "/tmp/missing-tmux.sock" })).toBe(true);
		expect(harness.killed).toEqual([]);
	});
	it("closes an owned tmux pane after its verified process group exits", async () => {
		const harness = tmuxHarness();
		const handle = await harness.launcher.launch(spec);
		await expect(harness.launcher.cleanupExited(handle)).resolves.toBe(true);
		await expect(harness.launcher.cleanupExited(handle)).resolves.toBe(true);
		expect(harness.killed).toEqual(["%7"]);
	});

	it("reports headless availability on every supported platform", async () => {
		const headless = createProcessLaunchers().find((candidate) => candidate.kind === "headless");
		if (!headless) throw new Error("headless launcher is missing");
		// Native Windows ships its own headless launcher; Unix keeps the signal-based
		// one. Availability must be true on both.
		await expect(headless.available()).resolves.toBe(true);
	});

	it("treats a headless child already gone after shutdown as successfully terminated", async () => {
		const runDir = mkdtempSync(join(tmpdir(), "pi-process-launcher-"));
		tempDirs.push(runDir);
		let child: ChildProcess | undefined;
		const spawnProcess = ((command: string, args: string[], options: SpawnOptions) => {
			child = spawn(command, args, options);
			return child;
		}) as typeof spawn;
		const headless = createProcessLaunchers({ spawnProcess }).find((candidate) => candidate.kind === "headless");
		if (!headless) throw new Error("headless launcher is missing");
		const handle = await headless.launch({
			...spec,
			runDir,
			env: {},
			interactiveArgv: [],
			headlessCommand: process.execPath,
			headlessArgv: [
				"-e",
				'const server = require("node:net").createServer(); server.listen(process.argv[1]); process.on("SIGTERM", () => server.close(() => process.exit(0)));',
				join(runDir, "keepalive.sock"),
			],
		});
		const launchedChild = child;
		if (!launchedChild) throw new Error("headless process was not created");
		await expect(headless.cleanupExited(handle)).resolves.toBe(false);
		const reusedPidHandle = { ...handle, pid: process.pid };
		expect(await headless.alive(reusedPidHandle)).toBe(false);
		expect(await headless.cleanupExited(reusedPidHandle)).toBe(false);
		await expect(headless.terminate(reusedPidHandle)).rejects.toThrow("unverified headless process");
		expect(process.kill(process.pid, 0)).toBe(true);
		const { promise, resolve } = Promise.withResolvers<void>();
		launchedChild.once("exit", () => resolve());
		launchedChild.kill("SIGTERM");
		await promise;
		await expect(headless.cleanupExited(handle)).resolves.toBe(true);
		expect(await headless.alive(handle)).toBe(false);
		await expect(headless.terminate(handle)).resolves.toBeUndefined();
	});
	it("waits for graceful headless flush and process exit before confirming termination", async () => {
		const runDir = mkdtempSync(join(tmpdir(), "pi-process-launcher-"));
		tempDirs.push(runDir);
		const flushed = join(runDir, "flushed.txt");
		const ready = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<void>();
		let child: ChildProcess | undefined;
		const spawnProcess = ((command: string, args: string[], options: SpawnOptions) => {
			child = spawn(command, args, { ...options, stdio: ["ignore", "ignore", "ignore", "ipc"] });
			child.on("message", (message: unknown) => {
				if (message === "ready") ready.resolve();
			});
			child.once("exit", () => exited.resolve());
			return child;
		}) as typeof spawn;
		const headless = createProcessLaunchers({ spawnProcess }).find((candidate) => candidate.kind === "headless");
		if (!headless) throw new Error("headless launcher is missing");
		try {
			const handle = await headless.launch({
				...spec,
				runDir,
				env: {},
				interactiveArgv: [],
				headlessCommand: process.execPath,
				headlessArgv: [
					"-e",
					'const server = require("node:net").createServer(); process.on("SIGTERM", () => setTimeout(() => server.close(() => { require("node:fs").writeFileSync(process.argv[2], "native-session-flushed"); process.exit(0); }), 75)); server.listen(process.argv[1], () => process.send("ready"));',
					join(runDir, "keepalive.sock"),
					flushed,
				],
			});
			await ready.promise;
			await headless.terminate(handle);
			expect(readFileSync(flushed, "utf8")).toBe("native-session-flushed");
			expect(await headless.cleanupExited(handle)).toBe(true);
		} finally {
			if (child && child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
				await exited.promise;
			}
		}
	}, 20_000);

	it("reports windows headless availability while proving identity through the CIM command line", async () => {
		const harness = windowsHeadlessHarness();
		expect(await harness.launcher.available()).toBe(true);
		const handle = await harness.launcher.launch({ ...spec, runDir: windowsRunDir() });
		const ownerToken = harness.spawnedArgv().at(-1);
		expect(handle.kind).toBe("headless");
		expect(handle.pid).toBe(windowsDeadPid);
		expect(handle.identity).toEqual({ creationDate: windowsCreationDate, ownerToken });
		expect(harness.spawnedArgv().slice(-2)).toEqual(["--launch-owner", ownerToken]);
		expect(harness.spawnedOwnerEnv()).toBe(ownerToken);
		expect(harness.taskkill).toEqual([]);
	});
	it("kills an unowned windows headless spawn instead of returning a fake handle", async () => {
		const harness = windowsHeadlessHarness();
		harness.dropOwnerToken();
		await expect(harness.launcher.launch({ ...spec, runDir: windowsRunDir() })).rejects.toThrow(
			"Unable to establish headless child identity",
		);
		expect(harness.taskkill).toEqual([`/PID ${windowsDeadPid} /T`]);
	});
	it("keeps unverifiable windows launch cleanup visible as pending", async () => {
		const harness = windowsHeadlessHarness();
		const live = harness.useLivePid();
		harness.dropOwnerToken();
		await expect(harness.launcher.launch({ ...spec, runDir: windowsRunDir() })).rejects.toBeInstanceOf(
			ProcessLaunchCleanupPendingError,
		);
		expect(harness.taskkill).toEqual([`/PID ${live.pid} /T`]);
		await stopLiveChild(live);
	}, 10_000);
	it("terminates a verified windows child only after its exit is confirmed", async () => {
		const harness = windowsHeadlessHarness();
		const handle = await harness.launcher.launch({ ...spec, runDir: windowsRunDir() });
		expect(await harness.launcher.alive(handle)).toBe(true);
		await expect(harness.launcher.terminate(handle)).resolves.toBeUndefined();
		expect(harness.taskkill).toEqual([`/PID ${windowsDeadPid} /T`]);
	});
	it("reports a windows termination timeout when the pid survives graceful and forced taskkill", async () => {
		const harness = windowsHeadlessHarness();
		const live = harness.useLivePid();
		const handle = await harness.launcher.launch({ ...spec, runDir: windowsRunDir() });
		await expect(harness.launcher.terminate(handle)).rejects.toThrow(
			"Timed out confirming the owned headless process exited",
		);
		expect(harness.taskkill).toEqual([`/PID ${live.pid} /T`, `/PID ${live.pid} /T /F`]);
		await stopLiveChild(live);
	}, 15_000);
	it("escalates windows termination to a forced tree kill when the graceful taskkill is refused", async () => {
		const harness = windowsHeadlessHarness();
		harness.failNextTaskkill(1, 'ERROR: The process "1900000003" can only be terminated forcefully.');
		const handle = await harness.launcher.launch({ ...spec, runDir: windowsRunDir() });
		await expect(harness.launcher.terminate(handle)).resolves.toBeUndefined();
		expect(harness.taskkill).toEqual([`/PID ${windowsDeadPid} /T`, `/PID ${windowsDeadPid} /T /F`]);
	});
	it("keeps a refused windows forced kill visible with its failure attached", async () => {
		const harness = windowsHeadlessHarness();
		const live = harness.useLivePid();
		harness.failNextTaskkill(1, "ERROR: The process can only be terminated forcefully.");
		harness.failNextTaskkill(5, "Access is denied.");
		const handle = await harness.launcher.launch({ ...spec, runDir: windowsRunDir() });
		const failure = await harness.launcher.terminate(handle).then(
			() => undefined,
			(error: unknown) => error as Error & { cause?: unknown },
		);
		expect(failure?.message).toBe("Timed out confirming the owned headless process exited");
		expect((failure?.cause as { code?: number } | undefined)?.code).toBe(5);
		expect(harness.taskkill).toEqual([`/PID ${live.pid} /T`, `/PID ${live.pid} /T /F`]);
		await stopLiveChild(live);
	}, 10_000);
	it("treats taskkill exit 128 as an already-gone pid and verifies exit without escalation", async () => {
		const harness = windowsHeadlessHarness();
		harness.failNextTaskkill(128, "");
		const handle = await harness.launcher.launch({ ...spec, runDir: windowsRunDir() });
		await expect(harness.launcher.terminate(handle)).resolves.toBeUndefined();
		expect(harness.taskkill).toEqual([`/PID ${windowsDeadPid} /T`]);
	});
	it("refuses to force-kill a reused windows pid before any taskkill", async () => {
		const harness = windowsHeadlessHarness();
		const handle = await harness.launcher.launch({ ...spec, runDir: windowsRunDir() });
		harness.reusePid();
		expect(await harness.launcher.alive(handle)).toBe(false);
		await expect(harness.launcher.forceKill(handle)).rejects.toThrow(
			"Refusing to force-kill: process identity (CreationDate) no longer matches the owned child",
		);
		expect(harness.taskkill).toEqual([]);
	});
	it("refuses to force-kill a windows pid when the identity probe is unavailable", async () => {
		const harness = windowsHeadlessHarness();
		const handle = await harness.launcher.launch({ ...spec, runDir: windowsRunDir() });
		harness.failProbe();
		await expect(harness.launcher.forceKill(handle)).rejects.toThrow(
			"Refusing to force-kill: process identity could not be re-verified",
		);
		expect(harness.taskkill).toEqual([]);
	});
	it("refuses unix force-kill when the identity probe fails or no longer matches", async () => {
		const originalStart = "Mon Oct 13 21:00:00 2025";
		let startTime: string | undefined = originalStart;
		const runner: LauncherCommandRunner = {
			async run(command, args) {
				if (command !== "ps" || !args.includes("lstart="))
					throw new Error(`unexpected command ${command} ${args.join(" ")}`);
				if (startTime === undefined) throw Object.assign(new Error("ps exited unsuccessfully"), { stderr: "" });
				return { stdout: `${startTime}\n`, stderr: "" };
			},
		};
		const headless = createProcessLaunchers({ runner }).find((candidate) => candidate.kind === "headless");
		if (!headless) throw new Error("headless launcher is missing");
		const handle = {
			kind: "headless" as const,
			childId: "child-a",
			pid: 1900000004,
			identity: { startTime: originalStart, ownerToken: "owned-token" },
		};
		startTime = undefined;
		await expect(headless.forceKill?.(handle)).rejects.toThrow(
			"Refusing to force-kill: process identity could not be re-verified",
		);
		startTime = "Tue Oct 14 09:00:00 2025";
		await expect(headless.forceKill?.(handle)).rejects.toThrow(
			"Refusing to force-kill: process start time no longer matches the owned child",
		);
		// A matching probe still proceeds: the never-existing PID yields ESRCH, the
		// tolerated not-found case, and the poll confirms the group is verifiably gone.
		startTime = originalStart;
		await expect(headless.forceKill?.(handle)).resolves.toBeUndefined();
	});
	it("force-kills the verified windows child tree and confirms exit", async () => {
		const harness = windowsHeadlessHarness();
		const handle = await harness.launcher.launch({ ...spec, runDir: windowsRunDir() });
		await expect(harness.launcher.forceKill(handle)).resolves.toBeUndefined();
		expect(harness.taskkill).toEqual([`/PID ${windowsDeadPid} /T /F`]);
	});
	it("confirms windows cleanup only for a verified dead pid", async () => {
		const gone = windowsHeadlessHarness();
		const goneHandle = await gone.launcher.launch({ ...spec, runDir: windowsRunDir() });
		expect(await gone.launcher.cleanupExited(goneHandle)).toBe(true);
		const liveHarness = windowsHeadlessHarness();
		const live = liveHarness.useLivePid();
		const liveHandle = await liveHarness.launcher.launch({ ...spec, runDir: windowsRunDir() });
		expect(await liveHarness.launcher.cleanupExited(liveHandle)).toBe(false);
		await stopLiveChild(live);
		expect(await liveHarness.launcher.cleanupExited(liveHandle)).toBe(true);
	});
});
