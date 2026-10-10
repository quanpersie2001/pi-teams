import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { ChildProtocolError } from "../domain/child-protocol.js";

/**
 * Portable child-control endpoints. Unix keeps pathname sockets in one fresh
 * owner-only temporary directory; Windows uses named pipes, kernel objects
 * addressed by name, so no filesystem artifact exists and cleanup is a no-op.
 * This is the only module that inspects `process.platform`; every rule is a
 * pure function taking an explicit platform so tests can force either OS.
 */

/** Full named-pipe path limit enforced by the Windows kernel. */
const MAX_PIPE_PATH_CHARS = 256;
/** `\\.\pipe\pi-teams-<childId>\<endpoint>`; the fresh UUID rules out stale collisions. */
const WINDOWS_PIPE_PATTERN =
	/^\\\\\.\\pipe\\pi-teams-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\(control|terminal)$/;

export interface ControlEndpoint {
	socketPath: string;
	terminalSocketPath?: string;
	/** Removes every filesystem artifact of the endpoints; a no-op for named pipes. */
	cleanup(): void;
}

/** The transport's single process.platform decision point. */
export function currentPlatform(): NodeJS.Platform {
	return process.platform;
}

/** True when the path addresses a Windows named pipe rather than a filesystem entry. */
export function isWindowsPipeEndpoint(path: string): boolean {
	return path.startsWith("\\\\.\\pipe\\");
}

function unixMaxSocketPathBytes(platform: NodeJS.Platform): number {
	return platform === "darwin" ? 103 : 107;
}

function windowsPipePath(childId: string, endpoint: "control" | "terminal"): string {
	return `\\\\.\\pipe\\pi-teams-${childId}\\${endpoint}`;
}

function validateWindowsPipe(path: string, field: string, endpoint: "control" | "terminal"): string {
	const match = WINDOWS_PIPE_PATTERN.exec(path);
	const childId = match?.[1];
	if (childId === undefined || match?.[2] !== endpoint || path.length > MAX_PIPE_PATH_CHARS) {
		throw new ChildProtocolError(
			"invalid_bootstrap",
			`${field} must be the named pipe \\\\.\\pipe\\pi-teams-<childId>\\${endpoint} of at most ${MAX_PIPE_PATH_CHARS} characters`,
		);
	}
	return childId;
}

export function validateControlEndpoints(
	paths: { socketPath: string; terminalSocketPath?: string },
	platform: NodeJS.Platform,
): void {
	if (platform === "win32") {
		const childId = validateWindowsPipe(paths.socketPath, "Child socketPath", "control");
		if (paths.terminalSocketPath !== undefined) {
			const terminalId = validateWindowsPipe(paths.terminalSocketPath, "terminalSocketPath", "terminal");
			if (terminalId !== childId) {
				throw new ChildProtocolError(
					"invalid_bootstrap",
					"terminalSocketPath must share the control socket's child pipe prefix",
				);
			}
		}
		return;
	}
	const maxBytes = unixMaxSocketPathBytes(platform);
	if (!isAbsolute(paths.socketPath) || Buffer.byteLength(paths.socketPath) > maxBytes) {
		throw new ChildProtocolError(
			"invalid_bootstrap",
			`Child socketPath must be absolute and fit in ${maxBytes} UTF-8 bytes`,
		);
	}
	const terminalSocketPath = paths.terminalSocketPath;
	if (
		terminalSocketPath !== undefined &&
		(!isAbsolute(terminalSocketPath) ||
			Buffer.byteLength(terminalSocketPath) > maxBytes ||
			dirname(terminalSocketPath) !== dirname(paths.socketPath) ||
			terminalSocketPath === paths.socketPath)
	) {
		throw new ChildProtocolError(
			"invalid_bootstrap",
			"terminalSocketPath must be a distinct short absolute socket path in the child control directory",
		);
	}
}

export function createControlEndpoints(
	childId: string,
	options: { terminal: boolean; platform?: NodeJS.Platform },
): ControlEndpoint {
	const platform = options.platform ?? currentPlatform();
	if (platform === "win32") {
		// Named pipes are kernel objects: no directory, no stale file, no mode.
		// The fresh childId UUID in the name makes collisions impossible.
		const socketPath = windowsPipePath(childId, "control");
		const terminalSocketPath = options.terminal ? windowsPipePath(childId, "terminal") : undefined;
		const endpoint: ControlEndpoint = {
			socketPath,
			...(terminalSocketPath !== undefined ? { terminalSocketPath } : {}),
			cleanup: () => {},
		};
		validateControlEndpoints(endpoint, platform);
		return endpoint;
	}
	// Unix socket pathname limits are small; project/session paths may be arbitrarily long.
	const controlDir = mkdtempSync(join(tmpdir(), "pi-teams-"));
	chmodSync(controlDir, 0o700);
	return {
		socketPath: join(controlDir, "control.sock"),
		...(options.terminal ? { terminalSocketPath: join(controlDir, "terminal.sock") } : {}),
		cleanup: () => rmSync(controlDir, { recursive: true, force: true }),
	};
}

/** Removes the control directory behind a Unix socket path; named pipes leave nothing behind. */
export function cleanupControlEndpointPath(path: string, platform: NodeJS.Platform): void {
	if (platform === "win32") return;
	rmSync(dirname(path), { recursive: true, force: true });
}
