import type { ChildProcess, SpawnOptions } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
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

	it("reports headless availability accurately and rejects unsupported Windows launches before spawning", async () => {
		let spawned = false;
		const headless = createProcessLaunchers({
			spawnProcess: ((...args: Parameters<typeof spawn>) => {
				spawned = true;
				return spawn(...args);
			}) as typeof spawn,
		}).find((candidate) => candidate.kind === "headless");
		if (!headless) throw new Error("headless launcher is missing");
		expect(await headless.available()).toBe(process.platform !== "win32");
		if (process.platform === "win32") {
			await expect(
				headless.launch({ ...spec, runDir: join(tmpdir(), "pi-teams-unsupported-windows") }),
			).rejects.toThrow("unsupported on Windows");
			expect(spawned).toBe(false);
		}
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
});
