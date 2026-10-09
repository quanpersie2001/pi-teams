import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";
import type { Terminal } from "@earendil-works/pi-tui";

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_COLUMNS = 500;
const MAX_ROWS = 300;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const MAX_INPUT_EVENT_BYTES = 4 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 5_000;

type NativeTerminalOptions = { socketPath: string; childId: string; token: string };
type Frame = Record<string, unknown>;

// Pi >=1.1.0 extended the TUI `Terminal` contract with OSC 7501 program status.
// Encoded locally so this extension keeps working against host Pi 1.0.x, where the type and method do not exist.
type NativeProgramStatus = {
	state: "idle" | "working" | "blocked" | "done" | "error" | "clear";
	app?: string;
	kind?: "permission" | "question" | "auth";
	message?: string;
};

const PROGRAM_STATUS_APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;

function encodeProgramStatus(status: NativeProgramStatus): string {
	const pairs = [`state=${status.state}`];
	if (status.app !== undefined && PROGRAM_STATUS_APP_PATTERN.test(status.app)) pairs.push(`app=${status.app}`);
	if (status.state === "blocked" && status.kind) pairs.push(`kind=${status.kind}`);
	const message = (status.message ?? "").replace(/\p{Cc}/gu, " ").trim();
	if (message) pairs.push(`msg=${Buffer.from(message, "utf8").toString("base64")}`);
	return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}

function validDimension(value: unknown, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;
}

function encode(frame: Frame): string {
	const line = `${JSON.stringify(frame)}\n`;
	if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error("Native terminal frame exceeds limit");
	return line;
}

function decode(line: Buffer): Frame | undefined {
	if (line.length > MAX_FRAME_BYTES) return undefined;
	try {
		const value: unknown = JSON.parse(line.toString("utf8"));
		return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Frame) : undefined;
	} catch {
		return undefined;
	}
}

function equalSecret(actual: unknown, expected: string): boolean {
	if (typeof actual !== "string") return false;
	const left = Buffer.from(actual);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

export class NativeTerminal implements Terminal {
	private server: Server;
	private socketIdentity: { dev: number; ino: number; uid: number };
	private socket?: Socket;
	private connections = new Set<Socket>();
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private repaint?: () => void;
	private pendingOutput: string[] = [];
	private pendingBytes = 0;
	private writing = false;
	private closed = false;
	private _columns = DEFAULT_COLUMNS;
	private _rows = DEFAULT_ROWS;
	private _kittyProtocolActive = false;
	private lastInputAt = 0;
	private inputDrainCount = 0;
	private inputWaiters = new Set<() => void>();
	private inputEventChunks: Buffer[] = [];
	private inputEventBytes = 0;

	private constructor(
		private readonly options: NativeTerminalOptions,
		server: Server,
		socketIdentity: { dev: number; ino: number; uid: number },
	) {
		this.server = server;
		this.socketIdentity = socketIdentity;
		server.on("connection", (socket) => this.accept(socket));
	}

	static async create(options: NativeTerminalOptions): Promise<NativeTerminal> {
		if (!isAbsolute(options.socketPath)) throw new Error("Native terminal socket path must be absolute");
		if (!options.childId || options.childId.length > 128 || !options.token || options.token.length > 256) {
			throw new Error("Invalid native terminal identity");
		}
		const uid = process.getuid?.();
		if (uid === undefined) throw new Error("Native terminal requires a Unix user identity");
		const parent = await lstat(dirname(options.socketPath));
		if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0) {
			throw new Error("Native terminal directory must be private and owned by this user");
		}
		try {
			const existing = await lstat(options.socketPath);
			if (!existing.isSocket() || existing.uid !== uid || (existing.mode & 0o077) !== 0) {
				throw new Error("Existing native terminal path is not a private owned socket");
			}
			const probe = connect(options.socketPath);
			const result = await new Promise<"active" | "stale">((resolve, reject) => {
				probe.once("connect", () => {
					probe.destroy();
					resolve("active");
				});
				probe.once("error", (error: Error) => {
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "ECONNREFUSED" || code === "ENOENT") resolve("stale");
					else reject(error);
				});
			});
			if (result === "active") throw new Error("Native terminal socket is already active");
			const current = await lstat(options.socketPath);
			if (current.dev !== existing.dev || current.ino !== existing.ino || !current.isSocket() || current.uid !== uid) {
				throw new Error("Native terminal socket changed during startup");
			}
			await unlink(options.socketPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const server = createServer();
		server.listen(options.socketPath);
		await once(server, "listening");
		await chmod(options.socketPath, 0o600);
		const socketStat = await lstat(options.socketPath);
		if (!socketStat.isSocket() || socketStat.uid !== uid || (socketStat.mode & 0o077) !== 0) {
			throw new Error("Created native terminal socket is not private");
		}
		return new NativeTerminal(options, server, { dev: socketStat.dev, ino: socketStat.ino, uid });
	}

	get columns(): number {
		return this._columns;
	}
	get rows(): number {
		return this._rows;
	}
	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}

	setRepaint(callback: () => void): void {
		this.repaint = callback;
		if (this.socket) callback();
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		if (this.closed) throw new Error("Native terminal is closed");
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		delete this.inputHandler;
		delete this.resizeHandler;
	}

	async drainInput(maxMs = 1_000, idleMs = 50): Promise<void> {
		if (maxMs <= 0) return;
		const deadline = Date.now() + Math.max(0, maxMs);
		this.inputDrainCount++;
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			while (true) {
				const remaining = deadline - Date.now();
				const idleRemaining = idleMs - (Date.now() - this.lastInputAt);
				if (remaining <= 0 || idleRemaining <= 0) return;
				const waitMs = Math.min(remaining, idleRemaining);
				const { promise, resolve } = Promise.withResolvers<void>();
				let timer: NodeJS.Timeout;
				const waiter = (): void => {
					clearTimeout(timer);
					this.inputWaiters.delete(waiter);
					resolve();
				};
				timer = setTimeout(waiter, waitMs);
				this.inputWaiters.add(waiter);
				await promise;
			}
		} finally {
			this.inputDrainCount--;
		}
	}

	write(data: string): void {
		if (!this.socket || !data) return;
		const bytes = Buffer.from(data);
		for (let offset = 0; offset < bytes.length; offset += 24 * 1024) {
			this.send({ type: "output", data: bytes.subarray(offset, offset + 24 * 1024).toString("base64") });
		}
	}

	moveBy(lines: number): void {
		const distance = Math.trunc(lines);
		if (distance !== 0) this.write(`\x1b[${Math.abs(distance)}${distance < 0 ? "A" : "B"}`);
	}
	hideCursor(): void {
		this.write("\x1b[?25l");
	}
	showCursor(): void {
		this.write("\x1b[?25h");
	}
	clearLine(): void {
		this.write("\x1b[2K");
	}
	clearFromCursor(): void {
		this.write("\x1b[J");
	}
	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}
	setTitle(title: string): void {
		this.write(`\x1b]2;${title.replace(/\p{Cc}/gu, "")}\x07`);
	}
	setProgress(active: boolean): void {
		this.write(`\x1b]9;4;${active ? "1;1" : "0"}\x07`);
	}

	// Required by Pi >=1.1.0's ProgramStatusReporter; ignored by earlier Pi versions.
	setProgramStatus(status: NativeProgramStatus): void {
		this.write(encodeProgramStatus(status));
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.stop();
		for (const socket of this.connections) socket.destroy();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
		try {
			const current = await lstat(this.options.socketPath);
			if (
				current.isSocket() &&
				current.uid === this.socketIdentity.uid &&
				current.dev === this.socketIdentity.dev &&
				current.ino === this.socketIdentity.ino
			) {
				await unlink(this.options.socketPath);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	private accept(socket: Socket): void {
		if (this.closed || this.connections.size >= 8) {
			socket.destroy();
			return;
		}
		this.connections.add(socket);
		let frameBuffer = Buffer.alloc(0);
		let authenticated = false;
		const authTimer = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS);
		socket.on("data", (chunk) => {
			frameBuffer = Buffer.concat([frameBuffer, chunk]);
			if (frameBuffer.length > MAX_FRAME_BYTES && !frameBuffer.includes(10)) {
				socket.destroy();
				return;
			}
			for (;;) {
				const newline = frameBuffer.indexOf(10);
				if (newline < 0) break;
				const line = frameBuffer.subarray(0, newline);
				frameBuffer = frameBuffer.subarray(newline + 1);
				const frame = decode(line);
				if (!frame) {
					socket.destroy();
					return;
				}
				if (!authenticated) {
					if (
						frame.type !== "auth" ||
						frame.childId !== this.options.childId ||
						!equalSecret(frame.token, this.options.token)
					) {
						socket.destroy();
						return;
					}
					authenticated = true;
					clearTimeout(authTimer);
					// A new authenticated pane replaces a closing presentation, never the execution.
					const previous = this.socket;
					this.socket = socket;
					previous?.destroy();
					this.writing = false;
					this._kittyProtocolActive = false;
					this.inputEventChunks = [];
					this.inputEventBytes = 0;
					this.pendingOutput = [];
					this.pendingBytes = 0;
					this.send({ type: "ready", columns: this.columns, rows: this.rows });
					this.resizeHandler?.();
					this.repaint?.();
					continue;
				}
				if (socket !== this.socket || !this.handleFrame(frame)) {
					socket.destroy();
					return;
				}
			}
		});
		socket.on("close", () => {
			this.connections.delete(socket);
			clearTimeout(authTimer);
			if (this.socket === socket) {
				delete this.socket;
				this.inputEventChunks = [];
				this.inputEventBytes = 0;
				this.pendingOutput = [];
				this.pendingBytes = 0;
				this.writing = false;
			}
		});
		socket.on("error", () => {});
	}

	private handleFrame(frame: Frame): boolean {
		if (
			frame.type === "input" &&
			typeof frame.data === "string" &&
			frame.data.length <= 48 * 1024 &&
			typeof frame.final === "boolean"
		) {
			const chunk = Buffer.from(frame.data, "base64");
			if (chunk.toString("base64") !== frame.data || chunk.length > 24 * 1024) return false;
			this.inputEventBytes += chunk.length;
			if (this.inputEventBytes > MAX_INPUT_EVENT_BYTES) return false;
			this.inputEventChunks.push(chunk);
			if (typeof frame.kittyProtocolActive === "boolean") this._kittyProtocolActive = frame.kittyProtocolActive;
			if (!frame.final) return true;
			const eventBytes = Buffer.concat(this.inputEventChunks, this.inputEventBytes);
			this.inputEventChunks = [];
			this.inputEventBytes = 0;
			const data = eventBytes.toString("utf8");
			if (!Buffer.from(data).equals(eventBytes)) return false;
			this.lastInputAt = Date.now();
			for (const waiter of this.inputWaiters) waiter();
			if (!this.inputDrainCount) this.inputHandler?.(data);
			return true;
		}
		if (frame.type === "resize" && validDimension(frame.columns, MAX_COLUMNS) && validDimension(frame.rows, MAX_ROWS)) {
			const changed = this._columns !== frame.columns || this._rows !== frame.rows;
			this._columns = frame.columns;
			this._rows = frame.rows;
			if (changed) this.resizeHandler?.();
			return true;
		}
		return false;
	}

	private send(frame: Frame): void {
		const socket = this.socket;
		if (!socket || socket.destroyed) return;
		let encoded: string;
		try {
			encoded = encode(frame);
		} catch {
			socket.destroy();
			return;
		}
		this.pendingOutput.push(encoded);
		this.pendingBytes += Buffer.byteLength(encoded);
		if (this.pendingBytes > MAX_PENDING_BYTES) {
			socket.destroy();
			return;
		}
		this.flushOutput();
	}

	private flushOutput(): void {
		const socket = this.socket;
		if (!socket || socket.destroyed || this.writing) return;
		this.writing = true;
		while (this.pendingOutput.length) {
			const frame = this.pendingOutput.shift();
			if (frame === undefined) break;
			this.pendingBytes -= Buffer.byteLength(frame);
			if (!socket.write(frame)) {
				socket.once("drain", () => {
					if (this.socket !== socket) return;
					this.writing = false;
					this.flushOutput();
				});
				return;
			}
		}
		this.writing = false;
	}
}

export function createNativeTerminal(options: NativeTerminalOptions): Promise<NativeTerminal> {
	return NativeTerminal.create(options);
}
