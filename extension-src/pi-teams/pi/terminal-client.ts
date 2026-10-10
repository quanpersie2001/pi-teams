import { realpathSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { connect } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { isWindowsPipeEndpoint } from "./child-endpoint.js";

const BOOTSTRAP_ENV = "PI_TEAMS_TERMINAL_BOOTSTRAP";
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_COLUMNS = 500;
const MAX_ROWS = 300;

type Bootstrap = { socketPath: string; childId: string; token: string };
type Frame = Record<string, unknown>;

function validateBootstrap(value: unknown): Bootstrap {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid terminal bootstrap");
	if (Object.keys(value).some((key) => !["socketPath", "childId", "token"].includes(key)))
		throw new Error("Invalid terminal bootstrap");
	const input = value as Record<string, unknown>;
	if (
		typeof input.socketPath !== "string" ||
		(!input.socketPath.startsWith("/") && !isWindowsPipeEndpoint(input.socketPath)) ||
		typeof input.childId !== "string" ||
		input.childId.length < 1 ||
		input.childId.length > 128 ||
		typeof input.token !== "string" ||
		input.token.length < 1 ||
		input.token.length > 256
	) {
		throw new Error("Invalid terminal bootstrap");
	}
	return { socketPath: input.socketPath, childId: input.childId, token: input.token };
}

async function readBootstrap(): Promise<Bootstrap> {
	const path = process.env[BOOTSTRAP_ENV];
	if (!path) throw new Error(`${BOOTSTRAP_ENV} is required`);
	const metadata = await lstat(path);
	// Windows permission bits only mirror the read-only attribute (files read
	// 0o666) and stats carry no owner, so owner-only proof there is the
	// parent-written bootstrap inheriting the user's NTFS ACLs; the mode and
	// uid assertions are POSIX-only.
	if (
		!metadata.isFile() ||
		(process.platform !== "win32" && ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()))
	) {
		throw new Error("Terminal bootstrap must be a private file owned by this user");
	}
	if (metadata.size > 4096) throw new Error("Terminal bootstrap exceeds limit");
	return validateBootstrap(JSON.parse(await readFile(path, "utf8")));
}

function frameLine(frame: Frame): string {
	const line = `${JSON.stringify(frame)}\n`;
	if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error("Terminal frame exceeds limit");
	return line;
}

function dimensions(value: unknown, max: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max ? value : 0;
}

export async function runTerminalClient(): Promise<void> {
	const bootstrap = await readBootstrap();
	const socket = connect(bootstrap.socketPath);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	const nativeWrite = process.stdout.write.bind(process.stdout);
	const terminal = new ProcessTerminal();
	let buffer = Buffer.alloc(0);
	let ready = false;
	const { promise: readyPromise, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>();
	const pending: string[] = [];

	let pendingBytes = 0;
	let socketBlocked = false;
	let stdoutBlocked = false;
	let stopped = false;
	const send = (frame: Frame): void => {
		if (stopped || socket.destroyed) return;
		let encoded: string;
		try {
			encoded = frameLine(frame);
		} catch {
			socket.destroy();
			return;
		}
		pending.push(encoded);
		pendingBytes += Buffer.byteLength(encoded);
		if (pendingBytes > MAX_PENDING_BYTES) {
			socket.destroy();
			return;
		}
		flush();
	};
	const flush = (): void => {
		if (!ready || socketBlocked || socket.destroyed) return;
		while (pending.length) {
			const next = pending.shift();
			if (next === undefined) break;
			pendingBytes -= Buffer.byteLength(next);
			if (!socket.write(next)) {
				socketBlocked = true;
				socket.once("drain", () => {
					socketBlocked = false;
					flush();
				});
				return;
			}
		}
	};
	const onResize = (): void => {
		const columns = dimensions(process.stdout.columns, MAX_COLUMNS);
		const rows = dimensions(process.stdout.rows, MAX_ROWS);
		if (columns && rows) send({ type: "resize", columns, rows });
	};
	function processFrames(): void {
		while (!stdoutBlocked) {
			const newline = buffer.indexOf(10);
			if (newline < 0) break;
			const line = buffer.subarray(0, newline);
			buffer = buffer.subarray(newline + 1);
			if (line.length > MAX_FRAME_BYTES) {
				socket.destroy();
				return;
			}
			let message: unknown;
			try {
				message = JSON.parse(line.toString("utf8"));
			} catch {
				socket.destroy();
				return;
			}
			if (message === null || typeof message !== "object" || Array.isArray(message)) {
				socket.destroy();
				return;
			}
			const frame = message as Frame;
			if (!ready) {
				if (
					frame.type !== "ready" ||
					dimensions(frame.columns, MAX_COLUMNS) === 0 ||
					dimensions(frame.rows, MAX_ROWS) === 0
				) {
					socket.destroy();
					return;
				}
				ready = true;
				resolveReady();
				flush();
				continue;
			}
			if (frame.type !== "output" || typeof frame.data !== "string" || frame.data.length > 48 * 1024) {
				socket.destroy();
				return;
			}
			const bytes = Buffer.from(frame.data, "base64");
			if (bytes.length > 32 * 1024 || bytes.toString("base64") !== frame.data) {
				socket.destroy();
				return;
			}
			if (!nativeWrite(bytes)) {
				stdoutBlocked = true;
				socket.pause();
				process.stdout.once("drain", () => {
					stdoutBlocked = false;
					processFrames();
					if (!stdoutBlocked) socket.resume();
				});
				return;
			}
		}
	}
	const onSocketData = (chunk: Buffer): void => {
		buffer = Buffer.concat([buffer, chunk]);
		if (buffer.length > MAX_FRAME_BYTES && !buffer.includes(10)) {
			socket.destroy();
			return;
		}
		processFrames();
	};
	socket.on("data", onSocketData);
	socket.on("error", () => {});
	const shutdown = Promise.withResolvers<void>();
	const onSocketClose = (): void => {
		if (!ready) rejectReady(new Error("Native terminal closed before becoming ready"));
		shutdown.resolve();
	};
	const onSignal = (): void => shutdown.resolve();
	socket.once("close", onSocketClose);
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	socket.write(frameLine({ type: "auth", childId: bootstrap.childId, token: bootstrap.token }));
	try {
		await readyPromise;
		terminal.start((data) => {
			const bytes = Buffer.from(data);
			if (bytes.length > MAX_INPUT_EVENT_BYTES) {
				socket.destroy();
				return;
			}
			if (bytes.length === 0) {
				send({ type: "input", data: "", final: true, kittyProtocolActive: terminal.kittyProtocolActive });
				return;
			}
			for (let offset = 0; offset < bytes.length; offset += 24 * 1024) {
				const chunk = bytes.subarray(offset, offset + 24 * 1024);
				send({
					type: "input",
					data: chunk.toString("base64"),
					final: offset + chunk.length === bytes.length,
					kittyProtocolActive: terminal.kittyProtocolActive,
				});
			}
		}, onResize);
		onResize();
		await shutdown.promise;
	} finally {
		stopped = true;
		socket.removeListener("close", onSocketClose);
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
		socket.removeListener("data", onSocketData);
		terminal.stop();
		socket.destroy();
	}
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(realpathSync(resolve(entryPath))).href) {
	runTerminalClient().catch((error: unknown) => {
		process.stderr.write(`pi-teams terminal client: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
