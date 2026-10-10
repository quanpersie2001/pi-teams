import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SerializableBackendHandle } from "../app/run-registry.js";
import type {
	AgentBackendHandle,
	AgentExecutionBackend,
	AgentLaunchInput,
	AgentResumeInput,
	BackendStatus,
	ModelAdmission,
	ModelAdmissionInput,
} from "../domain/backend.js";
import {
	type ChildBootstrap,
	type ChildControlCommand,
	type ChildEvent,
	ChildProtocolError,
	type ChildState,
} from "../domain/child-protocol.js";
import type { BackendMode, BackendSelector } from "../domain/config.js";
import type { LauncherHandle, LauncherKind, ProcessLauncher } from "../domain/process-launcher.js";
import { ProcessLaunchCleanupPendingError } from "../domain/process-launcher.js";
import type { TranscriptSnapshot } from "../domain/transcript.js";
import { cleanupControlEndpointPath, createControlEndpoints, currentPlatform } from "./child-endpoint.js";
import { deriveViewerToken } from "./child-rpc-auth.js";
import { ChildRpcClient } from "./child-rpc-client.js";
import { createModelAdmission } from "./model-admission.js";
import { createProcessLaunchers } from "./process-launchers.js";
import { teamsArtifactDir } from "./registry-host.js";
import { TEAM_TASK_TOOL_NAMES } from "./team-task-tools.js";

const TEAM_COORDINATION_TOOLS: readonly string[] = ["send_message", ...TEAM_TASK_TOOL_NAMES];

/**
 * Honest per-kind availability requirements for diagnostics. available() is a
 * boolean probe by contract, so failed selection reports these static reasons
 * instead of a bare hint; the headless entry is platform-dependent by design.
 */
const LAUNCHER_REQUIREMENTS: Readonly<Record<LauncherKind, string>> = {
	herdr: "requires the HerdR terminal environment",
	tmux: "requires a tmux server socket",
	headless: "requires a platform with a supported headless process launcher",
};

interface ChildConnection {
	bootstrap: ChildBootstrap;
	runDir: string;
	launcher: ProcessLauncher;
	launcherHandle: LauncherHandle;
	presentationLauncher?: ProcessLauncher;
	viewerHandle?: LauncherHandle;
	viewerBootstrapFile?: string;
	modelFallback?: string;
	client: ChildRpcClient;
	snapshot?: ChildState;
	connected: boolean;
	detached: boolean;
	presentationListeners: Set<(available: boolean) => void>;
	closed: boolean;
	identityFailure?: ChildProtocolError;
	refreshing: boolean;
	refreshAgain: boolean;
	reconnectTimer?: NodeJS.Timeout;
	unlisten: (() => void)[];
	focusListeners: Set<(state: ChildState) => void>;
	assignmentListeners: Set<(assignment: { runId: string }) => void>;
	pendingAssignments: { runId: string }[];
}
interface RunConnection {
	runId: string;
	child: ChildConnection;
	status: BackendStatus;
	listeners: Set<(status: BackendStatus) => void>;
	admissionUncertain?: boolean;
	admissionError?: string;
}
export interface ProcessBackendOptions {
	launcherHint?: BackendSelector;
	launchers?: readonly ProcessLauncher[];
	connectTimeoutMs?: number;
	/** Built runtime entrypoints; overridable for independently launched integration fixtures. */
	entryPaths?: { headless: string; terminalClient: string; moduleLoader?: string };
	agentDir?: string;
	getParentModel?: () => string | undefined;
	/** Public loaded Main resource paths, including temporary CLI extensions. */
	getParentExtensionPaths?: () => readonly string[];
}

export function resolveLauncherHint(env: NodeJS.ProcessEnv = process.env): BackendSelector {
	const value = env.PI_TEAMS_BACKEND?.trim() ?? "auto";
	if (value !== "auto" && value !== "herdr" && value !== "tmux" && value !== "headless") {
		throw new Error(`Unsupported PI_TEAMS_BACKEND "${value}"; use auto, herdr, tmux or headless.`);
	}
	return value;
}

/**
 * Effective launcher hint at session start: an explicit `PI_TEAMS_BACKEND`
 * (full four-launcher selection) overrides the `backend` settings key
 * (auto/headless only); without either, launchers auto-detect.
 */
export function resolveSessionLauncherHint(env: NodeJS.ProcessEnv, settingsBackend: BackendMode): BackendSelector {
	const raw = env.PI_TEAMS_BACKEND?.trim();
	if (raw !== undefined && raw.length > 0) return resolveLauncherHint(env);
	return settingsBackend;
}

function entryPaths(): { headless: string; terminalClient: string; moduleLoader: string } {
	const adjacent = {
		headless: fileURLToPath(new URL("./headless-child.js", import.meta.url)),
		terminalClient: fileURLToPath(new URL("./terminal-client.js", import.meta.url)),
		moduleLoader: fileURLToPath(new URL("./child-module-loader.js", import.meta.url)),
	};
	if (Object.values(adjacent).every((path) => existsSync(path))) return adjacent;
	const built = {
		headless: fileURLToPath(new URL("../../../dist/extensions/headless-child.js", import.meta.url)),
		terminalClient: fileURLToPath(new URL("../../../dist/extensions/terminal-client.js", import.meta.url)),
		moduleLoader: fileURLToPath(new URL("../../../dist/extensions/child-module-loader.js", import.meta.url)),
	};
	if (!Object.values(built).every((path) => existsSync(path)))
		throw new Error("Child runtime is not built. Run npm run build before launching subagents.");
	return built;
}

/** Use the actual CLI installation, not the extension's npm tree (which has no host peers). */
function hostModuleEntry(): string {
	let directory = dirname(realpathSync(process.argv[1] ?? process.execPath));
	while (true) {
		const manifest = join(directory, "package.json");
		if (existsSync(manifest)) {
			try {
				if (JSON.parse(readFileSync(manifest, "utf8")).name === "@earendil-works/pi-coding-agent") {
					const entry = join(directory, "dist/index.js");
					if (existsSync(entry)) return entry;
				}
			} catch {
				// Keep looking for the package that owns the CLI.
			}
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	// Vitest and local SDK consumers aren't started through the Pi CLI.
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	if (!existsSync(entry)) throw new Error("Cannot locate the Pi SDK used by the parent process");
	return entry;
}
export class ProcessAgentExecutionBackend implements AgentExecutionBackend {
	readonly kind = "process" as const;
	private readonly launchers: readonly ProcessLauncher[];
	private readonly runs = new Map<string, RunConnection>();
	private readonly children = new Map<string, ChildConnection>();
	private readonly options: ProcessBackendOptions;
	private readonly admitModel: (input: ModelAdmissionInput) => Promise<ModelAdmission>;
	private launcherHint: BackendSelector;
	private readonly pendingChildren = new Set<string>();
	private presentationQueue: Promise<void> = Promise.resolve();
	private presentationActive = true;

	constructor(options: ProcessBackendOptions = {}) {
		this.options = options;
		this.launchers = options.launchers ?? createProcessLaunchers();
		this.launcherHint = options.launcherHint ?? "auto";
		this.admitModel = createModelAdmission({
			...(options.agentDir !== undefined ? { agentDir: options.agentDir } : {}),
			...(options.getParentModel !== undefined ? { getParentModel: options.getParentModel } : {}),
		});
	}
	/** Current launcher selection hint; `auto` means multiplexer auto-detection. */
	getLauncherHint(): BackendSelector {
		return this.launcherHint;
	}
	/** Replace the launcher hint for future launches; started children keep theirs. */
	setLauncherHint(hint: BackendSelector): void {
		this.launcherHint = hint;
	}
	setPresentationActive(active: boolean): void {
		this.presentationActive = active;
	}
	/** Launcher kind the current hint resolves to; rejects when none is available. */
	async detectLauncherKind(): Promise<ProcessLauncher["kind"]> {
		return (await this.chooseLauncher()).kind;
	}
	async available(): Promise<boolean> {
		try {
			await this.chooseLauncher();
			return true;
		} catch {
			return false;
		}
	}
	prepareModel(input: ModelAdmissionInput): Promise<ModelAdmission> {
		return this.admitModel(input);
	}
	private async chooseLauncher(): Promise<ProcessLauncher> {
		const hint = this.launcherHint;
		const unavailable: LauncherKind[] = [];
		for (const launcher of this.launchers) {
			if (hint !== "auto" && launcher.kind !== hint) continue;
			if (await launcher.available()) return launcher;
			unavailable.push(launcher.kind);
		}
		if (unavailable.length === 0) throw new Error(`No process launcher for "${hint}" is registered.`);
		throw new Error(
			`No available process launcher for "${hint}": ${unavailable
				.map((kind) => `${kind} ${LAUNCHER_REQUIREMENTS[kind]}`)
				.join("; ")}.`,
		);
	}
	private async withPresentationLock<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.presentationQueue;
		let release!: () => void;
		this.presentationQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	private livingChildCount(): number {
		let count = this.pendingChildren.size;
		for (const [id, child] of this.children) if (!child.closed && !this.pendingChildren.has(id)) count += 1;
		return count;
	}

	private async openViewer(child: ChildConnection): Promise<void> {
		if (child.closed || child.viewerHandle || !child.presentationLauncher) return;
		const paths = { ...entryPaths(), ...this.options.entryPaths };
		if (!child.bootstrap.terminalSocketPath) throw new Error("Native child terminal transport is unavailable.");
		const viewerBootstrapFile = join(child.runDir, "terminal-bootstrap.json");
		writeFileSync(
			viewerBootstrapFile,
			JSON.stringify({
				childId: child.bootstrap.childId,
				token: deriveViewerToken(child.bootstrap.childId, child.bootstrap.token),
				socketPath: child.bootstrap.terminalSocketPath,
			}),
			{ mode: 0o600 },
		);
		const viewerId = `${child.bootstrap.childId}-viewer`;
		try {
			child.viewerHandle = await child.presentationLauncher.launch({
				childId: viewerId,
				runDir: child.runDir,
				cwd: child.bootstrap.cwd,
				env: { PI_TEAMS_TERMINAL_BOOTSTRAP: viewerBootstrapFile, PI_TEAMS_HOST_MODULE: hostModuleEntry() },
				interactiveArgv: [process.execPath, "--import", paths.moduleLoader, paths.terminalClient],
				headlessCommand: process.execPath,
				headlessArgv: [],
			});
			child.viewerBootstrapFile = viewerBootstrapFile;
			for (const listener of [...child.presentationListeners]) listener(true);
		} catch (error) {
			rmSync(viewerBootstrapFile, { force: true });
			throw error;
		}
	}

	private async closeViewer(child: ChildConnection): Promise<void> {
		const handle = child.viewerHandle;
		const launcher = child.presentationLauncher;
		if (!handle || !launcher) return;
		try {
			await launcher.terminate(handle);
		} catch (error) {
			if (!(await launcher.cleanupExited(handle).catch(() => false))) throw error;
		}
		delete child.viewerHandle;
		if (child.viewerBootstrapFile) rmSync(child.viewerBootstrapFile, { force: true });
		delete child.viewerBootstrapFile;
		for (const listener of [...child.presentationListeners]) listener(false);
	}

	private async reconcilePresentationLocked(): Promise<void> {
		const withinThreshold = this.livingChildCount() <= 6;
		for (const child of this.children.values()) {
			if (child.closed || !child.presentationLauncher) continue;
			if (child.viewerHandle) {
				const exited = (await child.presentationLauncher.alive(child.viewerHandle).catch(() => undefined)) === false;
				if (exited && (await child.presentationLauncher.cleanupExited(child.viewerHandle).catch(() => false))) {
					delete child.viewerHandle;
					if (child.viewerBootstrapFile) rmSync(child.viewerBootstrapFile, { force: true });
					delete child.viewerBootstrapFile;
					for (const listener of [...child.presentationListeners]) listener(false);
				}
			}
			if (!this.presentationActive || !withinThreshold || child.snapshot?.execution !== "running")
				await this.closeViewer(child);
			else if (!child.viewerHandle) await this.openViewer(child);
		}
	}

	private async reconcilePresentation(): Promise<void> {
		await this.withPresentationLock(() => this.reconcilePresentationLocked());
	}

	async launch(input: AgentLaunchInput): Promise<AgentBackendHandle> {
		return this.launchChild(input);
	}
	private async launchChild(input: AgentLaunchInput, sessionFile?: string): Promise<AgentBackendHandle> {
		// Recheck after queueing and before creating any filesystem/process/pane resource.
		const admission = await this.prepareModel({
			...(input.model !== undefined ? { model: input.model } : {}),
			...(sessionFile !== undefined ? { sessionFile } : {}),
		});
		input = {
			...input,
			model: admission.model,
			...(admission.fallback !== undefined ? { modelFallback: admission.fallback } : {}),
		};
		const configuredLauncher = await this.chooseLauncher();
		const launcher = this.launchers.find((candidate) => candidate.kind === "headless");
		if (!launcher) throw new Error("Native headless execution launcher is unavailable.");
		const paths = { ...entryPaths(), ...this.options.entryPaths };
		const childId = randomUUID();
		const presentationLauncher = configuredLauncher.kind !== "headless" ? configuredLauncher : undefined;
		const runDir = join(teamsArtifactDir(input.configCwd), "sessions", childId);
		mkdirSync(runDir, { recursive: true, mode: 0o700 });
		chmodSync(runDir, 0o700);
		const control = createControlEndpoints(childId, { terminal: presentationLauncher !== undefined });
		const tools = input.tools === undefined ? undefined : [...input.tools];
		if (input.team && tools) {
			for (const tool of TEAM_COORDINATION_TOOLS) {
				if (!tools.includes(tool)) tools.push(tool);
			}
		}
		const bootstrap: ChildBootstrap = {
			childId,
			token: randomBytes(32).toString("hex"),
			socketPath: control.socketPath,
			...(presentationLauncher && control.terminalSocketPath !== undefined
				? { terminalSocketPath: control.terminalSocketPath }
				: {}),
			...(presentationLauncher && this.options.getParentExtensionPaths
				? { presentationExtensionPaths: [...this.options.getParentExtensionPaths()] }
				: {}),
			sessionDir: sessionFile ? dirname(sessionFile) : runDir,
			cwd: input.cwd,
			configCwd: input.configCwd,
			systemPrompt: input.systemPrompt,
			promptMode: input.promptMode,
			...(sessionFile ? { sessionFile } : {}),
			...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
			...(input.model !== undefined ? { model: input.model } : {}),
			...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
			...(tools !== undefined ? { tools } : {}),
			...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
			...(input.graceTurns !== undefined ? { graceTurns: input.graceTurns } : {}),
			...(input.team !== undefined
				? {
						teamDir: input.team.teamDir,
						teamKey: input.team.teamKey,
						teammateName: input.team.teammateName,
						...(input.team.teammateColor !== undefined ? { teammateColor: input.team.teammateColor } : {}),
					}
				: {}),
		};
		const configFile = join(runDir, "bootstrap.json");
		writeFileSync(configFile, JSON.stringify(bootstrap), { mode: 0o600 });
		let handle: LauncherHandle | undefined;
		let child: ChildConnection | undefined;
		try {
			await this.withPresentationLock(async () => {
				this.pendingChildren.add(childId);
				await this.reconcilePresentationLocked();
			});
			handle = await launcher.launch({
				childId,
				runDir,
				cwd: input.cwd,
				env: {
					PI_TEAMS_BOOTSTRAP: configFile,
					PI_TEAMS_CHILD: "1",
					PI_TEAMS_HOST_MODULE: hostModuleEntry(),
					...(this.options.agentDir !== undefined ? { PI_CODING_AGENT_DIR: this.options.agentDir } : {}),
				},
				interactiveArgv: [],
				headlessCommand: process.execPath,
				headlessArgv: ["--import", paths.moduleLoader, paths.headless],
			});
			const client = new ChildRpcClient({
				socketPath: bootstrap.socketPath,
				childId,
				token: bootstrap.token,
				connectTimeoutMs: this.options.connectTimeoutMs ?? 20_000,
			});
			const snapshot = await client.connect();
			child = {
				bootstrap,
				runDir,
				launcher,
				launcherHandle: handle,
				...(presentationLauncher ? { presentationLauncher } : {}),
				...(input.modelFallback !== undefined ? { modelFallback: input.modelFallback } : {}),
				client,
				snapshot,
				connected: true,
				detached: false,
				closed: false,
				refreshing: false,
				refreshAgain: false,
				unlisten: [],
				focusListeners: new Set(),
				assignmentListeners: new Set(),
				presentationListeners: new Set(),
				pendingAssignments: [],
			};
			this.verifyChildPid(handle, snapshot);
			const registeredChild = child;
			await this.withPresentationLock(async () => {
				this.children.set(childId, registeredChild);
				this.pendingChildren.delete(childId);
				await this.reconcilePresentationLocked();
			});
			this.watchChild(child);
			const run = this.createRun(input.runId, child);
			await client.prompt(input.runId, input.prompt);
			await this.refreshChild(child);
			return { kind: "process", handle: run.runId };
		} catch (error) {
			if (error instanceof ProcessLaunchCleanupPendingError)
				throw new AggregateError(
					[error],
					`Child launcher cleanup remains unverified. Recovery bootstrap: ${configFile}`,
				);
			if (error instanceof ChildProtocolError && error.code === "prompt_failed" && child) {
				try {
					this.acceptSnapshot(child, await child.client.state());
				} catch (snapshotError) {
					if (child.identityFailure)
						throw new AggregateError(
							[error, snapshotError],
							`Child prompt failed and its authenticated outcome could not be reconciled. Recovery bootstrap: ${configFile}`,
						);
				}
				const run = this.runs.get(input.runId);
				if (run?.child === child) {
					this.publish(run, {
						state: "failed",
						...(child.snapshot?.sessionFile && existsSync(child.snapshot.sessionFile)
							? { sessionFile: child.snapshot.sessionFile }
							: {}),
						error: error.message,
					});
					return { kind: "process", handle: input.runId };
				}
			}
			const alive = handle ? await launcher.alive(handle).catch(() => undefined) : undefined;
			const failure =
				error instanceof ChildProtocolError && error.code === "connect_timeout"
					? new Error(
							`Child control startup deadline expired (launcher=${launcher.kind}, alive=${String(alive)}). ${launcher.kind === "headless" ? `Inspect ${join(runDir, "child.log")}.` : `Native pane: ${handle?.paneId ?? "unavailable"}.`} Bootstrap: ${configFile}`,
							{ cause: error },
						)
					: error;
			if (handle) {
				try {
					await launcher.terminate(handle);
				} catch (cleanupError) {
					throw new AggregateError(
						[failure, cleanupError],
						`Child launch failed; cleanup failed. Recovery bootstrap: ${configFile}`,
					);
				}
			}
			if (child) {
				try {
					await this.closeViewer(child);
				} catch (cleanupError) {
					throw new AggregateError([failure, cleanupError], "Child launch failed and viewer cleanup was not verified.");
				}
				this.releaseChild(child);
				this.children.delete(childId);
				this.runs.delete(input.runId);
			} else {
				control.cleanup();
			}
			await this.withPresentationLock(async () => {
				this.pendingChildren.delete(childId);
				await this.reconcilePresentationLocked();
			});
			throw failure;
		}
	}
	private createRun(runId: string, child: ChildConnection): RunConnection {
		const run: RunConnection = {
			runId,
			child,
			status: {
				state: "starting",
				...(child.snapshot?.sessionFile && existsSync(child.snapshot.sessionFile)
					? { sessionFile: child.snapshot.sessionFile }
					: {}),
			},
			listeners: new Set(),
		};
		this.runs.set(runId, run);
		this.updateRun(run);
		return run;
	}
	private verifyChildPid(handle: LauncherHandle, snapshot: ChildState): void {
		if (handle.kind !== "tmux" && handle.pid !== snapshot.pid) {
			throw new ChildProtocolError(
				"identity_mismatch",
				"Authenticated child PID does not match its owned launcher process",
			);
		}
	}

	private acceptSnapshot(child: ChildConnection, snapshot: ChildState): void {
		if (child.identityFailure) throw child.identityFailure;
		try {
			this.verifyChildPid(child.launcherHandle, snapshot);
		} catch (error) {
			if (error instanceof ChildProtocolError && error.code === "identity_mismatch") {
				child.identityFailure = error;
				child.connected = false;
				this.unwatch(child);
				child.client.disconnect();
				for (const run of this.runs.values())
					if (run.child === child && !isSettled(run.status))
						this.publish(run, { state: "disconnected", detail: error.message });
			}
			throw error;
		}
		if (!child.snapshot || snapshot.seq >= child.snapshot.seq) child.snapshot = snapshot;
		child.connected = true;
		for (const run of this.runs.values()) if (run.child === child) this.updateRun(run);
		const current = child.snapshot;
		if (current) for (const listener of [...child.focusListeners]) listener(current);
	}
	private watchChild(child: ChildConnection): void {
		child.unlisten.push(
			child.client.subscribe((event: ChildEvent) => {
				if (
					event.event === "mailbox_assignment" &&
					typeof event.payload.runId === "string" &&
					event.payload.runId.length > 0
				) {
					const assignment = { runId: event.payload.runId };
					if (!this.runs.has(assignment.runId)) this.createRun(assignment.runId, child);
					if (child.assignmentListeners.size === 0) child.pendingAssignments.push(assignment);
					else for (const listener of [...child.assignmentListeners]) listener(assignment);
				}
				void this.refreshChild(child).catch((error: unknown) => {
					console.error("Native child pane reconciliation failed:", error);
				});
			}),
		);
		child.unlisten.push(
			child.client.subscribeConnection((connected) => {
				child.connected = connected;
				if (connected) return; // The connect caller accepts its authenticated snapshot.
				for (const run of this.runs.values()) if (run.child === child) this.updateRun(run);
				this.scheduleReconnect(child);
			}),
		);
	}
	private unwatch(child: ChildConnection): void {
		for (const off of child.unlisten.splice(0)) off();
		clearTimeout(child.reconnectTimer);
		delete child.reconnectTimer;
	}
	private releaseChild(child: ChildConnection): void {
		this.unwatch(child);
		child.client.disconnect();
		cleanupControlEndpointPath(child.bootstrap.socketPath, currentPlatform());
		child.closed = true;
	}

	private scheduleReconnect(child: ChildConnection): void {
		if (child.detached || child.closed || child.identityFailure || child.reconnectTimer) return;
		child.reconnectTimer = setTimeout(() => {
			delete child.reconnectTimer;
			void child.client
				.connect()
				.then(async (snapshot) => {
					this.acceptSnapshot(child, snapshot);
					await this.refreshChild(child);
				})
				.catch(async () => {
					if (child.identityFailure) return;
					// Verified disappearance is an execution failure, never a successful result.
					const exited = await child.launcher.cleanupExited(child.launcherHandle).catch(() => false);
					if (exited) {
						for (const run of this.runs.values())
							if (run.child === child && !isSettled(run.status))
								this.publish(run, {
									state: "failed",
									outcomeUnavailable: true,
									error: "Child process exited before an RPC outcome was recovered.",
									detail: "Child process exited before an RPC outcome was recovered.",
								});
						await this.closeViewer(child);
						this.releaseChild(child);
						await this.reconcilePresentation();
						return;
					}
					this.scheduleReconnect(child);
				});
		}, 500);
		child.reconnectTimer.unref?.();
	}
	private async refreshChild(child: ChildConnection): Promise<void> {
		if (child.closed || child.detached || !child.connected) return;
		if (child.refreshing) {
			child.refreshAgain = true;
			return;
		}
		child.refreshing = true;
		try {
			do {
				child.refreshAgain = false;
				this.acceptSnapshot(child, await child.client.state());
			} while (child.refreshAgain && child.connected && !child.detached);
		} catch {
			if (child.identityFailure) return;
			child.connected = false;
			for (const run of this.runs.values()) if (run.child === child) this.updateRun(run);
			this.scheduleReconnect(child);
		} finally {
			child.refreshing = false;
		}
		if (
			child.presentationLauncher &&
			!child.closed &&
			!child.identityFailure &&
			Boolean(child.viewerHandle) !==
				(this.presentationActive && this.livingChildCount() <= 6 && child.snapshot?.execution === "running")
		)
			await this.reconcilePresentation();
	}
	private updateRun(run: RunConnection): void {
		if (isSettled(run.status)) return;
		const snapshot = run.child.snapshot;
		if (!snapshot) {
			this.publish(run, { state: "disconnected", detail: "Awaiting an authenticated child snapshot." });
			return;
		}
		const outcome = snapshot.lastOutcome?.runId === run.runId ? snapshot.lastOutcome : undefined;
		const ownsSnapshot = outcome !== undefined || snapshot.currentRunId === run.runId;
		const meta = {
			// Pi assigns a filename before its first persisted entry; rejected preflight has no resumable JSONL.
			...(snapshot.sessionFile && existsSync(snapshot.sessionFile) ? { sessionFile: snapshot.sessionFile } : {}),
			...(ownsSnapshot && snapshot.usage ? { usage: snapshot.usage } : {}),
			...(ownsSnapshot && snapshot.turns !== undefined ? { turns: snapshot.turns } : {}),
			...(ownsSnapshot && snapshot.toolUses !== undefined ? { toolUses: snapshot.toolUses } : {}),
		};
		if (outcome) {
			this.publish(run, {
				state: outcome.status,
				...meta,
				...(outcome.result !== undefined ? { result: outcome.result } : {}),
				...(outcome.resultFile !== undefined ? { resultFile: outcome.resultFile } : {}),
				...(outcome.resultTruncated !== undefined ? { resultTruncated: outcome.resultTruncated } : {}),
				...(outcome.resultOriginalLength !== undefined ? { resultOriginalLength: outcome.resultOriginalLength } : {}),
				...(outcome.error !== undefined ? { error: outcome.error } : {}),
			});
		} else if (!run.child.connected)
			this.publish(run, { state: "disconnected", ...meta, detail: "Child control connection lost; reconnecting." });
		else if (run.admissionUncertain && snapshot.currentRunId !== run.runId) {
			this.publish(run, {
				state: "failed",
				...meta,
				error: run.admissionError ?? "Child snapshot confirms the prompt was not admitted.",
			});
		} else {
			if (snapshot.currentRunId === run.runId) run.admissionUncertain = false;
			this.publish(run, {
				state: snapshot.currentRunId === run.runId && snapshot.execution === "running" ? "running" : "starting",
				...meta,
			});
		}
	}
	private publish(run: RunConnection, status: BackendStatus): void {
		const selected = run.child.snapshot?.focus?.model;
		const next: BackendStatus = {
			...(selected
				? { model: `${selected.provider}/${selected.id}` }
				: run.child.bootstrap.model !== undefined
					? { model: run.child.bootstrap.model }
					: {}),
			...(run.child.modelFallback !== undefined ? { modelFallback: run.child.modelFallback } : {}),
			...status,
		};
		const previous = run.status;
		const usageMatches =
			previous.usage === next.usage ||
			(previous.usage !== undefined &&
				next.usage !== undefined &&
				previous.usage.inputTokens === next.usage.inputTokens &&
				previous.usage.outputTokens === next.usage.outputTokens &&
				previous.usage.cacheReadTokens === next.usage.cacheReadTokens &&
				previous.usage.cacheWriteTokens === next.usage.cacheWriteTokens &&
				previous.usage.totalTokens === next.usage.totalTokens);
		if (
			previous.state === next.state &&
			previous.model === next.model &&
			previous.modelFallback === next.modelFallback &&
			previous.detail === next.detail &&
			previous.result === next.result &&
			previous.error === next.error &&
			previous.outcomeUnavailable === next.outcomeUnavailable &&
			previous.sessionFile === next.sessionFile &&
			previous.turns === next.turns &&
			previous.toolUses === next.toolUses &&
			usageMatches
		)
			return;
		run.status = next;
		for (const listener of [...run.listeners]) {
			try {
				listener({ ...run.status });
			} catch {
				/* One observer cannot disrupt child reconciliation. */
			}
		}
	}
	private requireRun(handle: AgentBackendHandle): RunConnection {
		const run = this.runs.get(handle.handle);
		if (handle.kind !== "process" || !run) throw new Error("Unknown process run handle.");
		return run;
	}
	async status(handle: AgentBackendHandle): Promise<BackendStatus> {
		const run = this.requireRun(handle);
		if (run.child.identityFailure) return { ...run.status };
		if (run.child.detached) {
			this.publish(run, { state: "disconnected", detail: "Child control was released." });
			return { ...run.status };
		}
		if (!run.child.connected && !run.child.detached && !run.child.closed) {
			try {
				this.acceptSnapshot(run.child, await run.child.client.connect());
			} catch (error) {
				if (!isSettled(run.status))
					this.publish(run, {
						state: "disconnected",
						detail: `Child reconnect failed: ${error instanceof Error ? error.message : String(error)}`,
					});
				this.scheduleReconnect(run.child);
				return { ...run.status };
			}
		}
		await this.refreshChild(run.child);
		return { ...run.status };
	}
	subscribe(handle: AgentBackendHandle, listener: (status: BackendStatus) => void): () => void {
		const run = this.requireRun(handle);
		run.listeners.add(listener);
		return () => run.listeners.delete(listener);
	}
	async readFocusState(handle: AgentBackendHandle): Promise<ChildState | undefined> {
		const run = this.requireRun(handle);
		if (run.child.identityFailure) throw run.child.identityFailure;
		if (run.child.closed) return run.child.snapshot;
		if (run.child.connected) await this.refreshChild(run.child);
		return run.child.snapshot;
	}

	async controlFocus(handle: AgentBackendHandle, command: ChildControlCommand): Promise<ChildState> {
		const run = this.requireRun(handle);
		if (!run.child.connected && !run.child.closed && !run.child.detached) await this.status(handle);
		this.requireControl(run.child);
		const state = await run.child.client.control(command);
		this.acceptSnapshot(run.child, state);
		return run.child.snapshot ?? state;
	}

	subscribeFocus(handle: AgentBackendHandle, listener: (state: ChildState) => void): () => void {
		const child = this.requireRun(handle).child;
		child.focusListeners.add(listener);
		if (child.snapshot) listener(child.snapshot);
		return () => child.focusListeners.delete(listener);
	}

	subscribeAssignments(handle: AgentBackendHandle, listener: (assignment: { runId: string }) => void): () => void {
		const child = this.requireRun(handle).child;
		child.assignmentListeners.add(listener);
		for (const assignment of child.pendingAssignments.splice(0)) listener(assignment);
		return () => child.assignmentListeners.delete(listener);
	}

	async admitAssignment(handle: AgentBackendHandle): Promise<void> {
		const run = this.requireRun(handle);
		this.requireControl(run.child);
		await run.child.client.admitAssignment(run.runId);
	}

	async assign(
		handle: AgentBackendHandle,
		input: { runId: string; prompt: string; maxTurns?: number; graceTurns?: number },
	): Promise<AgentBackendHandle> {
		const child = this.requireRun(handle).child;
		if (!child.connected && !child.closed && !child.detached) await this.status(handle);
		this.requireControl(child);
		const run = this.createRun(input.runId, child);
		try {
			await child.client.prompt(input.runId, input.prompt, {
				...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
				...(input.graceTurns !== undefined ? { graceTurns: input.graceTurns } : {}),
			});
		} catch (error) {
			// Once sent, reconcile this assignment's handle against native state;
			// never expose the previous run's handle as its admission receipt.
			run.admissionUncertain = true;
			run.admissionError = error instanceof Error ? error.message : String(error);
		}
		await this.refreshChild(child);
		return { kind: "process", handle: input.runId };
	}

	private requireControl(child: ChildConnection): void {
		if (child.identityFailure) throw child.identityFailure;
		if (child.closed || child.detached || !child.connected)
			throw new ChildProtocolError("disconnected", "Child control requires an authenticated connection");
	}
	async steer(handle: AgentBackendHandle, message: string): Promise<boolean> {
		const run = this.requireRun(handle);
		this.requireControl(run.child);
		await run.child.client.steer(run.runId, message);
		return true;
	}
	async stop(handle: AgentBackendHandle): Promise<boolean> {
		const run = this.requireRun(handle);
		this.requireControl(run.child);
		await run.child.client.abort(run.runId);
		await this.refreshChild(run.child);
		return true;
	}
	/**
	 * Budget-only hard stop for a child that ignored the cooperative abort.
	 * Entirely RPC-free on the identity path: a frozen child cannot answer, so
	 * ownership is proven from the cached authenticated bootstrap (childId,
	 * token, socketPath), the last authenticated snapshot PID and the owned
	 * launcher handle. Graceful terminate first; SIGKILL escalation when the
	 * owned group survives. Resolves only after a verified group exit —
	 * identity refusal or unverifiable termination throws (visible failure,
	 * retained receipt), never a fabricated outcome.
	 */
	async enforceTerminate(handle: AgentBackendHandle, graceMs: number): Promise<BackendStatus> {
		const run = this.requireRun(handle);
		const child = run.child;
		if (child.closed) return { ...run.status };
		// Cached-identity ownership gate — no RPC, no reconnect, no reattach.
		// The run→child mapping was authenticated at launch (bootstrap childId,
		// token+socketPath); the launcher handle must belong to that child, and a cached
		// authenticated snapshot must keep matching its PID.
		if (child.identityFailure) throw child.identityFailure;
		if (child.bootstrap.childId !== child.launcherHandle.childId) {
			throw new Error("Budget enforcement refused: launcher handle does not belong to the owned child identity.");
		}
		if (child.snapshot !== undefined) this.verifyChildPid(child.launcherHandle, child.snapshot);
		if (graceMs > 0 && !isSettled(run.status)) {
			const deadline = Date.now() + graceMs;
			while (Date.now() < deadline && !isSettled(run.status)) {
				if (child.connected) {
					try {
						await this.refreshChild(child);
					} catch {
						// A frozen child cannot refresh; keep the bounded wait honest.
					}
				}
				if (isSettled(run.status)) break;
				await enforcementDelay(100);
			}
			if (isSettled(run.status)) return { ...run.status };
		}
		const snapshot = child.snapshot;
		await this.closeViewer(child);
		try {
			await child.launcher.terminate(child.launcherHandle);
		} catch (terminateError) {
			if (!child.launcher.forceKill) {
				throw new Error(
					`Budget enforcement failed: graceful termination was not confirmed and this launcher has no forced kill: ${
						terminateError instanceof Error ? terminateError.message : String(terminateError)
					}`,
				);
			}
			// The group survived SIGTERM (e.g. SIGSTOP-frozen): escalate while the
			// identity is still the verified owned one.
			await child.launcher.forceKill(child.launcherHandle);
		}
		this.releaseChild(child);
		await this.reconcilePresentation();
		// The owned process group is gone: sibling runs sharing this child lost
		// their resource; publish the verified-loss outcome honestly.
		for (const other of this.runs.values()) {
			if (other !== run && other.child === child && !isSettled(other.status)) {
				this.publish(other, {
					state: "failed",
					outcomeUnavailable: true,
					error: "Owned child process group was terminated by budget enforcement.",
				});
			}
		}
		return {
			state: "stopped",
			...(snapshot?.sessionFile && existsSync(snapshot.sessionFile) ? { sessionFile: snapshot.sessionFile } : {}),
			...(snapshot?.usage ? { usage: { ...snapshot.usage } } : {}),
			...(snapshot?.turns !== undefined ? { turns: snapshot.turns } : {}),
			...(snapshot?.toolUses !== undefined ? { toolUses: snapshot.toolUses } : {}),
			detail: "budget enforcement: owned child process group terminated after ignoring the cooperative abort",
		};
	}
	async resume(input: AgentResumeInput): Promise<AgentBackendHandle> {
		const bootstrapFile = join(dirname(input.sessionFile), "bootstrap.json");
		if (!existsSync(bootstrapFile))
			throw new Error("Cannot resume a child without its persisted invocation bootstrap.");
		const bootstrap = JSON.parse(readFileSync(bootstrapFile, "utf8")) as ChildBootstrap;
		return this.launchChild(
			{
				runId: input.runId,
				type: "resumed",
				description: "Resumed agent",
				prompt: input.prompt,
				cwd: input.cwd,
				configCwd: bootstrap.configCwd,
				systemPrompt: bootstrap.systemPrompt,
				promptMode: bootstrap.promptMode,
				background: input.background,
				...(bootstrap.instructions !== undefined ? { instructions: bootstrap.instructions } : {}),
				...(input.model !== undefined ? { model: input.model } : {}),
				...(input.modelFallback !== undefined ? { modelFallback: input.modelFallback } : {}),
				...(bootstrap.thinking !== undefined ? { thinking: bootstrap.thinking } : {}),
				...(bootstrap.tools !== undefined
					? {
							tools: input.team
								? bootstrap.tools
								: bootstrap.tools.filter((tool) => !TEAM_COORDINATION_TOOLS.includes(tool)),
						}
					: {}),
				...(bootstrap.maxTurns !== undefined ? { maxTurns: bootstrap.maxTurns } : {}),
				...(bootstrap.graceTurns !== undefined ? { graceTurns: bootstrap.graceTurns } : {}),
				...(input.team !== undefined ? { team: input.team } : {}),
			},
			input.sessionFile,
		);
	}
	async readTranscript(handle: AgentBackendHandle): Promise<TranscriptSnapshot> {
		const run = this.requireRun(handle);
		const transcript = run.child.snapshot?.transcript;
		return transcript ? { ...transcript, items: [...transcript.items] } : { items: [], cursor: 0 };
	}
	hasViewer(handle: AgentBackendHandle): boolean {
		return Boolean(this.requireRun(handle).child.viewerHandle);
	}
	subscribePresentation(handle: AgentBackendHandle, listener: (available: boolean) => void): () => void {
		const child = this.requireRun(handle).child;
		child.presentationListeners.add(listener);
		listener(Boolean(child.viewerHandle));
		return () => child.presentationListeners.delete(listener);
	}
	async attach(handle: AgentBackendHandle): Promise<boolean> {
		const child = this.requireRun(handle).child;
		if (child.closed) return false;
		if (child.identityFailure) throw child.identityFailure;
		if (!child.viewerHandle || !child.presentationLauncher?.attach) return false;
		await child.presentationLauncher.attach(child.viewerHandle);
		return true;
	}
	detach(handle: AgentBackendHandle): void {
		const child = this.requireRun(handle).child;
		child.detached = true;
		child.connected = false;
		this.unwatch(child);
		child.client.disconnect();
	}
	async dispose(handle: AgentBackendHandle): Promise<void> {
		const child = this.requireRun(handle).child;
		if (child.closed) return;
		if (child.identityFailure) throw child.identityFailure;
		if (!child.connected) {
			try {
				this.acceptSnapshot(child, await child.client.connect());
			} catch (error) {
				if (child.identityFailure) throw child.identityFailure;
				if (await child.launcher.cleanupExited(child.launcherHandle)) {
					await this.closeViewer(child);
					this.releaseChild(child);
					await this.reconcilePresentation();
					return;
				}
				throw error;
			}
		}
		await this.refreshChild(child);
		if (!child.connected || !child.snapshot) {
			if (child.identityFailure) throw child.identityFailure;
			if (await child.launcher.cleanupExited(child.launcherHandle)) {
				await this.closeViewer(child);
				this.releaseChild(child);
				await this.reconcilePresentation();
				return;
			}
			throw new Error("Cannot dispose a child without an authenticated current snapshot.");
		}
		if (child.snapshot.execution !== "idle")
			throw new Error("Cannot dispose a child while its native process is running another run.");
		// Terminate while launcher identity is still verifiable. Headless SIGTERM
		// closes the native session gracefully; an RPC shutdown first races PID exit.
		await this.closeViewer(child);
		await child.launcher.terminate(child.launcherHandle);
		this.releaseChild(child);
		await this.reconcilePresentation();
	}
	serializeHandle(handle: AgentBackendHandle, sessionFile?: string): SerializableBackendHandle | undefined {
		const child = this.requireRun(handle).child;
		if (child.closed) return undefined;
		return {
			kind: "process",
			childId: child.bootstrap.childId,
			socketPath: child.bootstrap.socketPath,
			token: child.bootstrap.token,
			runDir: child.runDir,
			launcher: child.launcherHandle,
			...(child.viewerHandle ? { viewer: child.viewerHandle } : {}),
			...(sessionFile ? { sessionFile } : {}),
		};
	}
	async disposePersisted(serialized: SerializableBackendHandle): Promise<boolean> {
		if (serialized.kind !== "process") return false;
		const launcher = this.launchers.find((candidate) => candidate.kind === serialized.launcher.kind);
		if (!launcher) return false;
		const bootstrapFile = join(serialized.runDir, "bootstrap.json");
		if (!existsSync(bootstrapFile)) return false;
		const bootstrap = JSON.parse(readFileSync(bootstrapFile, "utf8")) as ChildBootstrap;
		if (
			serialized.launcher.childId !== serialized.childId ||
			bootstrap.childId !== serialized.childId ||
			bootstrap.token !== serialized.token ||
			bootstrap.socketPath !== serialized.socketPath ||
			(serialized.viewer !== undefined &&
				(serialized.viewer.childId !== `${serialized.childId}-viewer` ||
					(serialized.viewer.kind !== "herdr" && serialized.viewer.kind !== "tmux")))
		)
			return false;
		launcher.restore?.(serialized.launcher);
		const viewerLauncher = serialized.viewer
			? this.launchers.find((candidate) => candidate.kind === serialized.viewer?.kind)
			: undefined;
		if (serialized.viewer && !viewerLauncher) return false;
		if (serialized.viewer) viewerLauncher?.restore?.(serialized.viewer);
		const client = new ChildRpcClient({
			socketPath: serialized.socketPath,
			childId: serialized.childId,
			token: serialized.token,
			connectTimeoutMs: this.options.connectTimeoutMs ?? 2000,
		});
		try {
			const snapshot = await client.connect();
			this.verifyChildPid(serialized.launcher, snapshot);
			if (serialized.viewer && viewerLauncher) {
				try {
					await viewerLauncher.terminate(serialized.viewer);
				} catch (error) {
					if (!(await viewerLauncher.cleanupExited(serialized.viewer).catch(() => false))) throw error;
				}
			}
			await launcher.terminate(serialized.launcher);
			cleanupControlEndpointPath(serialized.socketPath, currentPlatform());
			return true;
		} catch (error) {
			if (error instanceof ChildProtocolError && error.code === "identity_mismatch") throw error;
			if (!(await launcher.cleanupExited(serialized.launcher))) return false;
			if (serialized.viewer && viewerLauncher) {
				try {
					await viewerLauncher.terminate(serialized.viewer);
				} catch {
					if (!(await viewerLauncher.cleanupExited(serialized.viewer).catch(() => false))) return false;
				}
			}
			return true;
		} finally {
			client.disconnect();
		}
	}
}
function isSettled(status: BackendStatus): boolean {
	return (
		status.state === "completed" ||
		status.state === "stopped" ||
		status.state === "failed" ||
		status.state === "timeout"
	);
}

function enforcementDelay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	// Bounded enforcement wait only; never holds the parent process open.
	timer.unref();
	return promise;
}
