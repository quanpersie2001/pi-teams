export type LauncherKind = "herdr" | "tmux" | "headless";

export interface ChildLaunchSpec {
	childId: string;
	runDir: string;
	cwd: string;
	env: Record<string, string>;
	interactiveArgv: string[];
	headlessCommand: string;
	headlessArgv: string[];
}

/** Durable identifiers needed to prove ownership before interacting with a child. */
export interface LauncherHandle {
	kind: LauncherKind;
	childId: string;
	pid?: number;
	paneId?: string;
	terminalId?: string;
	socketPath?: string;
	identity?: Record<string, string>;
}

export interface ProcessLauncher {
	/** Restore layout membership; geometry mutations still require live ownership verification. */
	restore?(handle: LauncherHandle): void;
	readonly kind: LauncherKind;
	available(): Promise<boolean>;
	launch(spec: ChildLaunchSpec): Promise<LauncherHandle>;
	alive(handle: LauncherHandle): Promise<boolean | undefined>;
	/** Clean up only after proving the original process/group is gone and owned resources are safe to release. */
	cleanupExited(handle: LauncherHandle): Promise<boolean>;
	terminate(handle: LauncherHandle): Promise<void>;
	/**
	 * Budget-enforcement escalation only: forced SIGKILL of the verified owned
	 * process group after the graceful terminate was refused/ignored. Must
	 * re-verify handle ownership before signaling and resolve only after the
	 * group exit is proven. Absent on transports without an owned PID group
	 * (multiplexer panes) — enforcement then fails visibly instead.
	 */
	forceKill?(handle: LauncherHandle): Promise<void>;
	attach?(handle: LauncherHandle): Promise<void>;
}
export class ProcessLaunchCleanupPendingError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ProcessLaunchCleanupPendingError";
	}
}

export interface LauncherCommandRunner {
	run(
		command: string,
		args: readonly string[],
		options?: { cwd?: string; env?: Record<string, string | undefined> },
	): Promise<{ stdout: string; stderr: string }>;
}
