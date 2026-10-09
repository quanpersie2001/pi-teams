import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fchmodSync, mkdirSync, openSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type {
	ChildLaunchSpec,
	LauncherCommandRunner,
	LauncherHandle,
	ProcessLauncher,
} from "../domain/process-launcher.js";
import { ProcessLaunchCleanupPendingError } from "../domain/process-launcher.js";
import { createHerdrPaneLayoutAdapter } from "./herdr-pane-layout.js";
import { type PaneSplitPlan, withTerminalPaneLayout } from "./terminal-pane-layout.js";
import { createTmuxPaneLayoutAdapter } from "./tmux-pane-layout.js";

type TerminalLauncher = Omit<ProcessLauncher, "launch"> & {
	launch(spec: ChildLaunchSpec, plan: PaneSplitPlan): Promise<LauncherHandle>;
};

const HERDR_ENV_VAR = "HERDR_ENV";
const HERDR_PANE_ID_VAR = "HERDR_PANE_ID";
const HERDR_SOCKET_PATH_VAR = "HERDR_SOCKET_PATH";

function createDefaultCommandRunner(): LauncherCommandRunner {
	return {
		run(command, args, options = {}) {
			const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string }>();
			execFile(
				command,
				[...args],
				{
					cwd: options.cwd,
					env: options.env,
					encoding: "utf8",
					maxBuffer: 4 * 1024 * 1024,
				},
				(error, stdout, stderr) => {
					if (error) {
						reject(Object.assign(new Error(`${command} exited unsuccessfully`), { stdout, stderr }));
						return;
					}
					resolve({ stdout, stderr });
				},
			);
			return promise;
		},
	};
}

interface ProcessLauncherOptions {
	runner?: LauncherCommandRunner;
	env?: Record<string, string | undefined>;
	spawnProcess?: typeof spawn;
}

function lastLine(value: string): string | undefined {
	return value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
}

function jsonResult<T>(stdout: string, operation: string): T {
	try {
		const decoded = JSON.parse(stdout) as { result?: T };
		return decoded.result ?? (decoded as T);
	} catch {
		throw new Error(`Invalid JSON from ${operation}`);
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellCommand(argv: readonly string[], env: Record<string, string>): string {
	const assignments = Object.entries(env).map(([key, value]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid child environment key: ${key}`);
		return `${key}=${shellQuote(value)}`;
	});
	return [...assignments, ...argv.map(shellQuote)].join(" ");
}

function validateHandle(handle: LauncherHandle, kind: LauncherHandle["kind"]): void {
	if (handle.kind !== kind) throw new Error(`Expected ${kind} launcher handle`);
}

function errorText(error: unknown): string {
	if (error instanceof Error && "stderr" in error && typeof error.stderr === "string") return error.stderr;
	return String(error);
}

interface HerdrForegroundProcess {
	pid: number;
}

interface HerdrPaneProcessInfo {
	paneId: string;
	foregroundProcessGroupId: number;
	processes: HerdrForegroundProcess[];
}
interface TmuxPaneIdentity {
	paneId: string;
	panePid: string;
	serverPid: string;
	startCommand: string;
}

async function readProcessStart(runner: LauncherCommandRunner, pid: number): Promise<string | undefined> {
	try {
		return lastLine((await runner.run("ps", ["-p", String(pid), "-o", "lstart="])).stdout);
	} catch {
		return undefined;
	}
}

async function processHasOwner(
	runner: LauncherCommandRunner,
	pid: number,
	ownerToken: string,
): Promise<boolean | undefined> {
	try {
		return (await runner.run("ps", ["eww", "-p", String(pid), "-o", "command="])).stdout.includes(ownerToken);
	} catch {
		return undefined;
	}
}

function processExists(pid: number): boolean | undefined {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		return undefined;
	}
}
function processGroupExists(pgid: number): boolean | undefined {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		return undefined;
	}
}

function isMissingHerdPane(error: unknown): boolean {
	return /pane_not_found|pane not found|no such pane|can't find pane/i.test(errorText(error));
}

async function closeHerdPaneIfOwned(
	run: (args: readonly string[]) => Promise<{ stdout: string }>,
	paneId: string,
	terminalId: string,
	readProcessInfo: (paneId: string) => Promise<HerdrPaneProcessInfo>,
): Promise<boolean> {
	const paneIsOwned = async (): Promise<boolean | undefined> => {
		try {
			const current = jsonResult<Record<string, unknown>>(
				(await run(["pane", "get", paneId])).stdout,
				"herdr pane get",
			);
			const pane = (current.pane as Record<string, unknown> | undefined) ?? current;
			return pane.pane_id === paneId && pane.terminal_id === terminalId;
		} catch (error) {
			if (isMissingHerdPane(error)) return undefined;
			throw error;
		}
	};
	const initialOwnership = await paneIsOwned();
	if (initialOwnership === undefined) return true;
	if (!initialOwnership || (await readProcessInfo(paneId)).processes.length !== 0) return false;
	const finalOwnership = await paneIsOwned();
	if (finalOwnership === undefined) return true;
	if (!finalOwnership || (await readProcessInfo(paneId)).processes.length !== 0) return false;
	try {
		await run(["pane", "close", paneId]);
		return true;
	} catch (error) {
		if (isMissingHerdPane(error)) return true;
		throw error;
	}
}

function delay(milliseconds: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, milliseconds);
	return promise;
}

function herdrLauncher(runner: LauncherCommandRunner, env: Record<string, string | undefined>): ProcessLauncher {
	const socketPath = env[HERDR_SOCKET_PATH_VAR];
	const run = (args: readonly string[], commandSocketPath = socketPath) =>
		runner.run("herdr", args, {
			env: {
				...process.env,
				...env,
				...(commandSocketPath ? { [HERDR_SOCKET_PATH_VAR]: commandSocketPath } : {}),
			},
		});
	const readPane = async (paneId: string, commandSocketPath = socketPath): Promise<Record<string, unknown>> => {
		const pane = jsonResult<Record<string, unknown>>(
			(await run(["pane", "get", paneId], commandSocketPath)).stdout,
			"herdr pane get",
		);
		return (pane.pane as Record<string, unknown> | undefined) ?? pane;
	};
	const readProcessInfo = async (paneId: string, commandSocketPath = socketPath): Promise<HerdrPaneProcessInfo> => {
		const decoded = jsonResult<Record<string, unknown>>(
			(await run(["pane", "process-info", "--pane", paneId], commandSocketPath)).stdout,
			"herdr pane process-info",
		);
		const value = (decoded.process_info as Record<string, unknown> | undefined) ?? decoded;
		if (
			value.pane_id !== paneId ||
			typeof value.foreground_process_group_id !== "number" ||
			!Array.isArray(value.foreground_processes)
		) {
			throw new Error("HerdR process-info omitted pane process identity");
		}
		const processes: HerdrForegroundProcess[] = [];
		for (const candidate of value.foreground_processes) {
			if (!candidate || typeof candidate !== "object") continue;
			const entry = candidate as Record<string, unknown>;
			if (typeof entry.pid === "number" && Number.isSafeInteger(entry.pid) && entry.pid > 0) {
				processes.push({ pid: entry.pid });
			}
		}
		return {
			paneId,
			foregroundProcessGroupId: value.foreground_process_group_id,
			processes,
		};
	};
	const waitForOwnedProcess = async (
		paneId: string,
		terminalId: string,
	): Promise<{ pid: number; startTime: string; foregroundProcessGroupId: number }> => {
		const deadline = Date.now() + 15_000;
		let lastError: unknown;
		while (Date.now() < deadline) {
			try {
				const pane = await readPane(paneId);
				if (pane.pane_id !== paneId || pane.terminal_id !== terminalId) {
					throw new Error("HerdR pane identity changed during process startup");
				}
				const info = await readProcessInfo(paneId);
				// Pi changes its process title; argv is neither stable nor exposed by HerdR.
				const processEntry = info.processes.find((entry) => entry.pid === info.foregroundProcessGroupId);
				if (processEntry) {
					const startTime = await readProcessStart(runner, processEntry.pid);
					if (startTime) {
						return {
							pid: processEntry.pid,
							startTime,
							foregroundProcessGroupId: info.foregroundProcessGroupId,
						};
					}
				}
			} catch (error) {
				if (/identity changed/.test(String(error))) throw error;
				lastError = error;
			}
			await delay(50);
		}
		throw new Error("Timed out waiting for the owned HerdR child process", { cause: lastError });
	};
	const lifecycle: TerminalLauncher = {
		kind: "herdr",
		async available() {
			if (env[HERDR_ENV_VAR] !== "1" || !env[HERDR_PANE_ID_VAR] || !socketPath || !isAbsolute(socketPath)) return false;
			try {
				// The pane query checks the CLI, active server and current client in one round trip.
				await run(["pane", "current", "--current"]);
				return true;
			} catch {
				return false;
			}
		},
		async launch(spec, plan) {
			if (!socketPath) throw new Error("HerdR socket path is unavailable");
			const sourcePaneId = plan.parent.paneId;
			const created = jsonResult<Record<string, unknown>>(
				(
					await run([
						"pane",
						"split",
						"--pane",
						plan.targetPaneId,
						"--direction",
						plan.direction,
						"--ratio",
						"0.5",
						"--cwd",
						spec.cwd,
						"--no-focus",
					])
				).stdout,
				"herdr pane split",
			);
			const pane = (created.pane as Record<string, unknown> | undefined) ?? created;
			const paneId = String(pane.pane_id ?? "");
			const terminalId = String(pane.terminal_id ?? "");
			if (!paneId || !terminalId) throw new Error("HerdR split did not return pane identity");
			const command = `exec env ${shellCommand(spec.interactiveArgv, spec.env)}`;
			try {
				// HerdR joins COMMAND arguments into shell input; preserve quoting as one command.
				await run(["pane", "run", paneId, command]);
				const owned = await waitForOwnedProcess(paneId, terminalId);
				const identity = {
					paneId,
					terminalId,
					sourcePaneId,
					foregroundProcessGroupId: String(owned.foregroundProcessGroupId),
					startTime: owned.startTime,
				};
				return { kind: "herdr", childId: spec.childId, paneId, terminalId, socketPath, pid: owned.pid, identity };
			} catch (error) {
				const cleanupComplete = await closeHerdPaneIfOwned(run, paneId, terminalId, readProcessInfo).catch(() => false);
				if (!cleanupComplete)
					throw new ProcessLaunchCleanupPendingError("HerdR pane cleanup remains unverified.", { cause: error });
				throw error;
			}
		},
		async alive(handle) {
			validateHandle(handle, "herdr");
			const identity = handle.identity;
			const commandSocketPath = handle.socketPath;
			if (
				!handle.paneId ||
				!handle.terminalId ||
				!handle.pid ||
				!identity?.startTime ||
				!identity.foregroundProcessGroupId ||
				handle.pid !== Number(identity.foregroundProcessGroupId)
			) {
				throw new Error("Incomplete HerdR launcher handle");
			}
			if (!commandSocketPath || !isAbsolute(commandSocketPath)) return undefined;
			try {
				const pane = await readPane(handle.paneId, commandSocketPath);
				if (pane.terminal_id !== handle.terminalId || pane.pane_id !== handle.paneId) return false;
				const startTime = await readProcessStart(runner, handle.pid);
				if (startTime === undefined) return processExists(handle.pid) === false ? false : undefined;
				if (startTime !== identity.startTime) return false;
				// Pi rewrites argv/environment in the OS process title; keep durable kernel/terminal identity.
				const info = await readProcessInfo(handle.paneId, commandSocketPath);
				return (
					String(info.foregroundProcessGroupId) === identity.foregroundProcessGroupId &&
					info.processes.some((entry) => entry.pid === handle.pid)
				);
			} catch (error) {
				if (isMissingHerdPane(error)) return false;
				return undefined;
			}
		},
		async cleanupExited(handle) {
			validateHandle(handle, "herdr");
			const identity = handle.identity;
			const paneId = handle.paneId;
			const terminalId = handle.terminalId;
			const pid = handle.pid;
			const foregroundProcessGroupId = Number(identity?.foregroundProcessGroupId);
			const commandSocketPath = handle.socketPath;
			if (
				!paneId ||
				!terminalId ||
				!pid ||
				!commandSocketPath ||
				!isAbsolute(commandSocketPath) ||
				!identity?.startTime ||
				!Number.isSafeInteger(foregroundProcessGroupId) ||
				foregroundProcessGroupId <= 0 ||
				foregroundProcessGroupId !== pid
			) {
				throw new Error("Incomplete HerdR launcher handle");
			}
			if (processExists(pid) !== false || processGroupExists(foregroundProcessGroupId) !== false) return false;
			let paneConfirmedExists = false;
			try {
				const pane = await readPane(paneId, commandSocketPath);
				if (pane.pane_id !== paneId || pane.terminal_id !== terminalId) return false;
				paneConfirmedExists = true;
				if ((await readProcessInfo(paneId, commandSocketPath)).processes.length !== 0) return false;
				const closed = await closeHerdPaneIfOwned(
					(args) => run(args, commandSocketPath),
					paneId,
					terminalId,
					(currentPaneId) => readProcessInfo(currentPaneId, commandSocketPath),
				);
				if (closed) return true;
				await readPane(paneId, commandSocketPath);
				return false;
			} catch (error) {
				if (!isMissingHerdPane(error)) return false;
				if (!paneConfirmedExists) return true;
				try {
					await readPane(paneId, commandSocketPath);
					return false;
				} catch (recheckError) {
					return isMissingHerdPane(recheckError);
				}
			}
		},
		async terminate(handle) {
			validateHandle(handle, "herdr");
			if ((await this.alive(handle)) === true) {
				try {
					const identity = handle.identity;
					const paneId = handle.paneId;
					const pane = paneId ? await readPane(paneId, handle.socketPath) : undefined;
					if (paneId && identity?.startTime && pane?.pane_id === paneId && pane.terminal_id === handle.terminalId) {
						const startTime = await readProcessStart(runner, handle.pid as number);
						const info = await readProcessInfo(paneId, handle.socketPath);
						if (
							startTime === identity.startTime &&
							String(info.foregroundProcessGroupId) === identity.foregroundProcessGroupId &&
							info.processes.some((entry) => entry.pid === handle.pid)
						) {
							await run(["pane", "close", paneId], handle.socketPath);
							return;
						}
					}
				} catch (error) {
					if (!isMissingHerdPane(error)) throw error;
					if (await this.cleanupExited(handle)) return;
				}
			}
			if (await this.cleanupExited(handle)) return;
			throw new Error("Refusing to close an unverified HerdR pane");
		},
		async attach(handle) {
			validateHandle(handle, "herdr");
			const sourcePaneId = handle.identity?.sourcePaneId;
			const commandSocketPath = handle.socketPath;
			if (!commandSocketPath || !handle.paneId || !sourcePaneId || (await this.alive(handle)) !== true) {
				throw new Error("Cannot focus an unverified HerdR pane");
			}
			await focusNeighbor(handle, [sourcePaneId]);
		},
	};
	async function focusNeighbor(handle: LauncherHandle, sources: readonly string[]): Promise<void> {
		const paneId = handle.paneId;
		if (!paneId || !handle.socketPath) throw new Error("Incomplete HerdR focus identity");
		for (const source of sources) {
			if (source === paneId) continue;
			for (const direction of ["left", "right", "up", "down"] as const) {
				try {
					const payload = jsonResult<Record<string, unknown>>(
						(await run(["pane", "neighbor", "--pane", source, "--direction", direction], handle.socketPath)).stdout,
						"herdr pane neighbor",
					);
					const neighbor = payload.neighbor as Record<string, unknown> | undefined;
					if (neighbor?.pane_id !== source || neighbor.neighbor_pane_id !== paneId) continue;
					if ((await lifecycle.alive(handle)) !== true) throw new Error("HerdR pane identity changed before focus");
					await run(["pane", "focus", "--pane", source, "--direction", direction], handle.socketPath);
					return;
				} catch (error) {
					if (String(error).includes("identity changed")) throw error;
				}
			}
		}
		throw new Error("HerdR pane has no verified neighbor in its managed group");
	}
	return withTerminalPaneLayout(
		lifecycle,
		createHerdrPaneLayoutAdapter(runner, env),
		lifecycle.launch.bind(lifecycle),
		(handle, parent, peers) =>
			focusNeighbor(handle, [parent.paneId, ...peers.flatMap((peer) => (peer.paneId ? [peer.paneId] : []))]),
		async (handle) => {
			const alive = await lifecycle.alive(handle);
			if (alive !== false || !handle.pid || !handle.paneId || !handle.socketPath) return alive;
			if (processExists(handle.pid) !== false || processGroupExists(handle.pid) !== false) return false;
			try {
				const pane = await readPane(handle.paneId, handle.socketPath);
				return (
					pane.pane_id === handle.paneId &&
					pane.terminal_id === handle.terminalId &&
					(await readProcessInfo(handle.paneId, handle.socketPath)).processes.length === 0
				);
			} catch (error) {
				return isMissingHerdPane(error) ? false : undefined;
			}
		},
	);
}

class ConfirmedMissingTmuxPaneError extends Error {
	constructor(readonly serverPid: string) {
		super("tmux pane is absent from the verified server-wide pane listing");
	}
}

function tmuxLauncher(runner: LauncherCommandRunner, env: Record<string, string | undefined>): ProcessLauncher {
	const defaultSocketPath = env.TMUX?.split(",", 1)[0];
	const missingResource =
		/can't find pane|no such pane|pane.*not found|no server running|ENOENT|no such file or directory/i;
	const missingServer = /no server running|ENOENT|no such file or directory/i;
	const run = (args: readonly string[], socketPath = defaultSocketPath) =>
		runner.run("tmux", [...(socketPath ? ["-S", socketPath] : []), ...args], { env: { ...process.env, ...env } });
	const paneIdentity = async (paneId: string, socketPath?: string): Promise<TmuxPaneIdentity> => {
		const result = await run(["display-message", "-p", "-t", paneId, "#{pane_id} #{pane_pid} #{pid}"], socketPath);

		const fields = (lastLine(result.stdout) ?? "").split(/\s+/);
		const command = (
			await run(["display-message", "-p", "-t", paneId, "#{pane_start_command}"], socketPath)
		).stdout.replace(/\r?\n$/, "");
		const [actualPaneId, panePid, serverPid] = fields;
		if (fields.length !== 3 || !actualPaneId || !panePid || !serverPid || !command) {
			// tmux 3.6a returns exit 0 and only #{pid} for a missing -t pane.
			// A malformed identity alone is not absence: prove it against the whole server.
			const before = lastLine((await run(["display-message", "-p", "#{pid}"], socketPath)).stdout);
			const listing = await run(["list-panes", "-a", "-F", "#{pane_id}"], socketPath);
			const after = lastLine((await run(["display-message", "-p", "#{pid}"], socketPath)).stdout);
			if (before && before === after && !listing.stdout.trim().split(/\s+/).includes(paneId))
				throw new ConfirmedMissingTmuxPaneError(before);
			throw new Error("tmux returned incomplete pane identity");
		}
		return { paneId: actualPaneId, panePid, serverPid, startCommand: command };
	};
	const lifecycle: TerminalLauncher = {
		kind: "tmux",
		async available() {
			if (!defaultSocketPath || !isAbsolute(defaultSocketPath)) return false;
			try {
				// A server-backed pane query also proves the tmux CLI is executable.
				await run(["display-message", "-p", "#{pane_id}"]);
				return true;
			} catch {
				return false;
			}
		},
		async launch(spec, plan) {
			if (!defaultSocketPath || !isAbsolute(defaultSocketPath)) throw new Error("tmux socket path is unavailable");
			const ownerToken = randomUUID();
			const command = shellCommand(spec.interactiveArgv, { ...spec.env, PI_TEAMS_LAUNCH_OWNER: ownerToken });
			const result = await run(
				[
					"split-window",
					plan.direction === "right" ? "-h" : "-v",
					"-d",
					"-l",
					"50%",
					"-t",
					plan.targetPaneId,
					"-P",
					"-F",
					"#{pane_id}",
					"-c",
					spec.cwd,
					command,
				],
				defaultSocketPath,
			);
			const paneId = lastLine(result.stdout);
			if (!paneId) throw new Error("tmux split-window returned no pane id");
			try {
				const current = await paneIdentity(paneId, defaultSocketPath);
				if (!current.startCommand.includes(ownerToken)) throw new Error("tmux child identity could not be established");
				const identity = { paneId: current.paneId, panePid: current.panePid, serverPid: current.serverPid, ownerToken };
				return {
					kind: "tmux",
					childId: spec.childId,
					paneId,
					socketPath: defaultSocketPath,
					pid: Number(current.panePid),
					identity,
				};
			} catch (error) {
				let cleanupComplete = false;
				try {
					const current = await paneIdentity(paneId, defaultSocketPath);
					if (current.paneId === paneId && current.startCommand.includes(ownerToken)) {
						await run(["kill-pane", "-t", paneId], defaultSocketPath);
						cleanupComplete = true;
					}
				} catch (cleanupError) {
					cleanupComplete =
						cleanupError instanceof ConfirmedMissingTmuxPaneError
							? cleanupError.serverPid ===
								jsonResult<Record<string, unknown>>(plan.parent.identity, "tmux parent identity").serverPid
							: missingResource.test(errorText(cleanupError));
				}
				if (!cleanupComplete)
					throw new ProcessLaunchCleanupPendingError("tmux pane cleanup remains unverified.", { cause: error });
				throw error;
			}
		},
		async alive(handle) {
			const identity = handle.identity;
			const socketPath = handle.socketPath;
			if (
				!handle.paneId ||
				!handle.pid ||
				!socketPath ||
				!isAbsolute(socketPath) ||
				!identity?.ownerToken ||
				Number(identity.panePid) !== handle.pid
			)
				throw new Error("Incomplete tmux launcher handle");
			try {
				const current = await paneIdentity(handle.paneId, socketPath);
				return (
					current.startCommand.includes(identity.ownerToken) &&
					current.paneId === identity.paneId &&
					current.panePid === identity.panePid &&
					current.serverPid === identity.serverPid
				);
			} catch (error) {
				if (error instanceof ConfirmedMissingTmuxPaneError || missingResource.test(errorText(error))) return false;
				return undefined;
			}
		},
		async cleanupExited(handle) {
			validateHandle(handle, "tmux");
			const paneId = handle.paneId;
			const identity = handle.identity;
			const pid = handle.pid;
			const socketPath = handle.socketPath;
			const serverPid = Number(identity?.serverPid);
			if (
				!paneId ||
				!pid ||
				!socketPath ||
				!isAbsolute(socketPath) ||
				!identity?.ownerToken ||
				Number(identity.panePid) !== pid ||
				!Number.isSafeInteger(serverPid) ||
				serverPid <= 0
			)
				throw new Error("Incomplete tmux launcher handle");
			if (processExists(pid) !== false || processGroupExists(pid) !== false) return false;
			const ownerToken = identity.ownerToken;
			const matchesOwned = (current: TmuxPaneIdentity) =>
				current.paneId === paneId &&
				current.panePid === identity.panePid &&
				current.serverPid === identity.serverPid &&
				current.startCommand.includes(ownerToken);
			try {
				if (!matchesOwned(await paneIdentity(paneId, socketPath))) return false;
				if (!matchesOwned(await paneIdentity(paneId, socketPath))) return false;
				await run(["kill-pane", "-t", paneId], socketPath);
				return true;
			} catch (error) {
				if (error instanceof ConfirmedMissingTmuxPaneError) return error.serverPid === identity.serverPid;
				const message = errorText(error);
				if (!missingResource.test(message)) return false;
				if (missingServer.test(message)) return processExists(serverPid) === false;
				try {
					const currentServerPid = lastLine((await run(["display-message", "-p", "#{pid}"], socketPath)).stdout);
					return currentServerPid === identity.serverPid;
				} catch (serverError) {
					return missingServer.test(errorText(serverError)) && processExists(serverPid) === false;
				}
			}
		},
		async terminate(handle) {
			validateHandle(handle, "tmux");
			const paneId = handle.paneId;
			if (!paneId) throw new Error("Incomplete tmux launcher handle");
			if ((await this.alive(handle)) === true) {
				try {
					await run(["kill-pane", "-t", paneId], handle.socketPath);
					return;
				} catch (error) {
					if (!missingResource.test(errorText(error))) throw error;
				}
			}
			if (await this.cleanupExited(handle)) return;
			throw new Error("Refusing to kill an unverified tmux pane");
		},
		async attach(handle) {
			validateHandle(handle, "tmux");
			const paneId = handle.paneId;
			if (!paneId) throw new Error("Incomplete tmux launcher handle");
			if (!env.TMUX || (await this.alive(handle)) !== true)
				throw new Error("Cannot focus a tmux pane without a verified attached client");
			const socketPath = handle.socketPath;
			if (defaultSocketPath !== socketPath)
				throw new Error("The current tmux client is connected to a different server");
			const session = lastLine(
				(await run(["display-message", "-p", "-t", paneId, "#{session_id}"], socketPath)).stdout,
			);
			if (!session) throw new Error("tmux pane has no focusable session");
			await run(["switch-client", "-t", session], socketPath);
			await run(["select-pane", "-t", paneId], socketPath);
		},
	};
	return withTerminalPaneLayout(lifecycle, createTmuxPaneLayoutAdapter(runner, env), lifecycle.launch.bind(lifecycle));
}

function processLauncher(runner: LauncherCommandRunner, spawnProcess: typeof spawn): ProcessLauncher {
	return {
		kind: "headless",
		async available() {
			return process.platform !== "win32";
		},
		async launch(spec) {
			if (process.platform === "win32") throw new Error("Headless process launcher is unsupported on Windows");
			mkdirSync(spec.runDir, { recursive: true });
			const ownerToken = randomUUID();
			const env = { ...process.env, ...spec.env, PI_TEAMS_LAUNCH_OWNER: ownerToken };
			const logPath = join(spec.runDir, "child.log");
			const logFd = openSync(logPath, "a", 0o600);
			let child: ChildProcess;
			try {
				fchmodSync(logFd, 0o600);
				child = spawnProcess(spec.headlessCommand, spec.headlessArgv, {
					cwd: spec.cwd,
					env,
					detached: true,
					stdio: ["ignore", logFd, logFd],
				});
			} finally {
				closeSync(logFd);
			}
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			child.once("spawn", resolve);
			child.once("error", reject);
			await promise;
			const pid = child.pid;
			if (!pid) throw new Error("Headless child failed to start");
			child.unref();
			try {
				const startTime = await readProcessStart(runner, pid);
				if (!startTime || (await processHasOwner(runner, pid, ownerToken)) !== true) {
					throw new Error(`Unable to establish headless child identity; inspect ${logPath}`);
				}
				return { kind: "headless", childId: spec.childId, pid, identity: { startTime, ownerToken } };
			} catch (error) {
				let cleanupComplete = false;
				let cleanupError: unknown;
				try {
					process.kill(-pid, "SIGTERM");
				} catch (signalError) {
					if ((signalError as NodeJS.ErrnoException).code !== "ESRCH") cleanupError = signalError;
				}
				if (cleanupError === undefined) {
					const deadline = Date.now() + 5_000;
					while (Date.now() < deadline) {
						if (processExists(pid) === false && processGroupExists(pid) === false) {
							cleanupComplete = true;
							break;
						}
						await delay(25);
					}
				}
				if (!cleanupComplete)
					throw new ProcessLaunchCleanupPendingError("Headless process-group cleanup remains unverified.", {
						cause: cleanupError ?? error,
					});
				throw error;
			}
		},
		async alive(handle) {
			validateHandle(handle, "headless");
			if (!handle.pid || !handle.identity?.startTime || !handle.identity.ownerToken)
				throw new Error("Incomplete headless launcher handle");
			const startTime = await readProcessStart(runner, handle.pid);
			if (startTime === undefined) return processExists(handle.pid) === false ? false : undefined;
			if (startTime !== handle.identity.startTime) return false;
			return processHasOwner(runner, handle.pid, handle.identity.ownerToken);
		},
		async cleanupExited(handle) {
			validateHandle(handle, "headless");
			if (!handle.pid || !handle.identity?.startTime || !handle.identity.ownerToken)
				throw new Error("Incomplete headless launcher handle");
			return processExists(handle.pid) === false && processGroupExists(handle.pid) === false;
		},
		async terminate(handle) {
			validateHandle(handle, "headless");
			if (!handle.pid) throw new Error("Incomplete headless launcher handle");
			if ((await this.alive(handle)) === true) {
				try {
					process.kill(-handle.pid, "SIGTERM");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
				const deadline = Date.now() + 5_000;
				while (Date.now() < deadline) {
					if (await this.cleanupExited(handle)) return;
					await delay(25);
				}
				throw new Error("Timed out confirming the owned headless process exited");
			}
			if (await this.cleanupExited(handle)) return;
			throw new Error("Refusing to signal an unverified headless process");
		},
		async forceKill(handle) {
			validateHandle(handle, "headless");
			if (!handle.pid || !handle.identity?.startTime || !handle.identity.ownerToken)
				throw new Error("Incomplete headless launcher handle");
			// Ownership re-check before the forced signal: a recycled or foreign
			// PID must never receive SIGKILL.
			const startTime = await readProcessStart(runner, handle.pid);
			if (startTime !== undefined && startTime !== handle.identity.startTime) {
				throw new Error("Refusing to force-kill: process start time no longer matches the owned child");
			}
			try {
				process.kill(-handle.pid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				if (await this.cleanupExited(handle)) return;
				await delay(25);
			}
			throw new Error("Timed out confirming the forced headless process-group exit");
		},
	};
}

export function createProcessLaunchers(options: ProcessLauncherOptions = {}): readonly ProcessLauncher[] {
	const runner = options.runner ?? createDefaultCommandRunner();
	const env = options.env ?? process.env;
	return [
		herdrLauncher(runner, env),
		tmuxLauncher(runner, env),
		processLauncher(runner, options.spawnProcess ?? spawn),
	];
}
