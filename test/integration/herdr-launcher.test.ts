import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LauncherCommandRunner } from "../../extension-src/pi-subagents/domain/process-launcher.js";
import { createProcessLaunchers } from "../../extension-src/pi-subagents/pi/process-launchers.js";

function harness() {
	let child: ChildProcess | undefined;
	let terminalId = "term-owned";
	let closed = false;
	let split = false;
	let foregroundPids: number[] = [];
	const paneId = "w9:p1";
	const stop = async () => {
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		child.once("exit", () => resolve());
		child.kill("SIGTERM");
		await promise;
		foregroundPids = child?.pid ? [child.pid] : [];
	};
	const runner: LauncherCommandRunner = {
		async run(command, args, options) {
			if (command === "ps") return { stdout: execFileSync(command, [...args], { encoding: "utf8" }), stderr: "" };
			if (command !== "herdr") throw new Error(`Unexpected command ${command}`);
			if (options?.env?.HERDR_SOCKET_PATH !== "/tmp/herdr-test.sock") throw new Error("HerdR socket unavailable");
			const reply = (result: unknown) => ({ stdout: JSON.stringify({ result }), stderr: "" });
			if (args[0] === "--version" || args[0] === "status" || args[1] === "current") return reply({});
			if (args[1] === "split") {
				split = true;
				return reply({ pane: { pane_id: paneId, terminal_id: terminalId } });
			}
			if (args[1] === "run") {
				// Native pane run joins COMMAND, not execFile-style argv. Exercise that shell boundary.
				child = spawn("/bin/sh", ["-c", args.slice(3).join(" ")], {
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});
				foregroundPids = child.pid ? [child.pid] : [];
				const { promise, resolve, reject } = Promise.withResolvers<void>();
				let stderr = "";
				child.stderr?.on("data", (data) => {
					stderr += String(data);
				});
				child.stdout?.once("data", () => resolve());
				child.once("error", reject);
				child.once("exit", () => reject(new Error(`Fixture exited before readiness: ${stderr}`)));
				await promise;
				return reply({});
			}
			if (args[1] === "get" && args[2] === "w9:p0")
				return reply({ pane: { pane_id: "w9:p0", terminal_id: "term-main" } });
			if (args[1] === "layout")
				return reply({
					layout: {
						area: { x: 0, y: 0, width: 120, height: 40 },
						panes: [
							{ pane_id: "w9:p0", rect: { x: 0, y: 0, width: split && !closed ? 60 : 120, height: 40 } },
							...(split && !closed ? [{ pane_id: paneId, rect: { x: 60, y: 0, width: 60, height: 40 } }] : []),
						],
						splits: [],
					},
				});
			if (closed) throw new Error("pane_not_found");
			if (args[1] === "get") return reply({ pane: { pane_id: paneId, terminal_id: terminalId } });
			if (args[1] === "process-info") {
				if (!child?.pid) throw new Error("No foreground process");
				// This is the actual HerdR schema: argv0, not argv. Pi rewrites its title.
				return reply({
					process_info: {
						pane_id: paneId,
						shell_pid: child.pid,
						foreground_process_group_id: child.pid,
						foreground_processes: foregroundPids.map((pid) => ({ pid, argv0: "pi", name: "node" })),
					},
				});
			}
			if (args[1] === "close") {
				closed = true;
				await stop();
				return reply({});
			}
			throw new Error(`Unexpected HerdR operation ${args.join(" ")}`);
		},
	};
	const launcher = createProcessLaunchers({
		runner,
		env: {
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w9:p0",
			HERDR_SOCKET_PATH: "/tmp/herdr-test.sock",
		},
	}).find((candidate) => candidate.kind === "herdr");
	if (!launcher) throw new Error("Missing HerdR launcher");
	return {
		launcher,
		stop,
		setForegroundProcesses(pids: number[]) {
			foregroundPids = pids;
		},
		isClosed() {
			return closed;
		},
		removePane() {
			closed = true;
		},
		replaceTerminal() {
			terminalId = "term-reused";
		},
	};
}

function invocation(directory: string) {
	const report = join(directory, "report.json");
	const socket = join(directory, "idle.sock");
	const script = `process.title='pi';require('node:fs').writeFileSync(${JSON.stringify(report)},JSON.stringify({argv:process.argv.slice(1),message:process.env.MESSAGE}));require('node:net').createServer().listen(${JSON.stringify(socket)},()=>process.stdout.write('ready'))`;
	return {
		childId: "owned-child",
		runDir: directory,
		cwd: directory,
		env: { MESSAGE: "single'quote $(not-a-command)" },
		interactiveArgv: [process.execPath, "-e", script, "two words", "single'quote", "$(not-a-command)"],
		headlessCommand: process.execPath,
		headlessArgv: [],
		report,
	};
}

describe("HerdR native shell and process identity", () => {
	it("preserves literal arguments and releases a title-rewritten process without relying on ps environment", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-herdr-contract-"));
		const fixture = harness();
		try {
			const input = invocation(directory);
			const handle = await fixture.launcher.launch(input);
			expect(JSON.parse(readFileSync(input.report, "utf8"))).toEqual({
				argv: ["two words", "single'quote", "$(not-a-command)"],
				message: input.env.MESSAGE,
			});
			expect(await fixture.launcher.alive(handle)).toBe(true);
			await fixture.launcher.terminate(handle);
			expect(await fixture.launcher.alive(handle)).toBe(false);
		} finally {
			await fixture.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("refuses to close a pane whose terminal identity was replaced", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-herdr-reuse-"));
		const fixture = harness();
		try {
			const handle = await fixture.launcher.launch(invocation(directory));
			fixture.replaceTerminal();
			expect(await fixture.launcher.alive(handle)).toBe(false);
			expect(await fixture.launcher.cleanupExited(handle)).toBe(false);
			await expect(fixture.launcher.terminate(handle)).rejects.toThrow("unverified HerdR pane");
		} finally {
			await fixture.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("closes a verified-owned empty pane after the original process group exits", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-herdr-exited-"));
		const fixture = harness();
		try {
			const handle = await fixture.launcher.launch(invocation(directory));
			await fixture.stop();
			fixture.setForegroundProcesses([]);
			await expect(fixture.launcher.cleanupExited(handle)).resolves.toBe(true);
			expect(fixture.isClosed()).toBe(true);
			await expect(fixture.launcher.terminate(handle)).resolves.toBeUndefined();
		} finally {
			await fixture.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("accepts a verified-exited child whose owned HerdR pane is already gone", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-herdr-missing-"));
		const fixture = harness();
		try {
			const handle = await fixture.launcher.launch(invocation(directory));
			await fixture.stop();
			fixture.removePane();
			await expect(fixture.launcher.cleanupExited(handle)).resolves.toBe(true);
			await expect(fixture.launcher.terminate(handle)).resolves.toBeUndefined();
		} finally {
			await fixture.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps an owned pane open when a foreign foreground process remains", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-herdr-foreign-"));
		const fixture = harness();
		try {
			const handle = await fixture.launcher.launch(invocation(directory));
			await fixture.stop();
			fixture.setForegroundProcesses([process.pid]);
			expect(await fixture.launcher.cleanupExited(handle)).toBe(false);
			await expect(fixture.launcher.terminate(handle)).rejects.toThrow("unverified HerdR pane");
			expect(fixture.isClosed()).toBe(false);
		} finally {
			await fixture.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("requires the saved HerdR endpoint before cleaning an exited process", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-herdr-endpoint-"));
		const fixture = harness();
		try {
			const handle = await fixture.launcher.launch(invocation(directory));
			await fixture.stop();
			fixture.setForegroundProcesses([]);
			await expect(fixture.launcher.cleanupExited({ ...handle, socketPath: undefined })).rejects.toThrow(
				"Incomplete HerdR launcher handle",
			);
			expect(await fixture.launcher.cleanupExited({ ...handle, socketPath: "/tmp/foreign-herdr.sock" })).toBe(false);
			expect(fixture.isClosed()).toBe(false);
			await expect(fixture.launcher.cleanupExited(handle)).resolves.toBe(true);
		} finally {
			await fixture.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
