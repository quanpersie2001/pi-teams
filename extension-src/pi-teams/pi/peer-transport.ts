import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { createPrivateKey, createPublicKey, type KeyObject, randomUUID, sign, verify } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PeerRegistry } from "../app/peer-discovery-service.js";
import type { PeerMailbox, PeerOutboundTransport } from "../app/peer-messaging-service.js";
import type { PeerAddress, PeerReceipt } from "../domain/peer.js";
import {
	PEER_LIMITS,
	type PeerMessage,
	validateInboundPeerMessage,
	validatePeerMessage,
} from "../domain/peer-message.js";
import { isWindowsPipeEndpoint } from "./child-endpoint.js";

const MAX_FRAME_BYTES = 24 * 1024;
const execFileAsync = promisify(execFile);
export const WINDOWS_PIPE_HELPER_EXECUTABLE = "pwsh.exe";
export const WINDOWS_PIPE_RUNTIME_PROBE = [
	"$ErrorActionPreference = 'Stop'",
	"if ($PSVersionTable.PSVersion.Major -lt 7 -or [Enum]::GetNames([IO.Pipes.PipeOptions]) -notcontains 'CurrentUserOnly') { [Console]::Error.WriteLine('unsupported'); exit 41 }",
	"[Console]::Out.WriteLine('PI_TEAMS_PIPE_RUNTIME_OK')",
].join("; ");
const WINDOWS_PIPE_RUNTIME_MARKER = "PI_TEAMS_PIPE_RUNTIME_OK";
const WINDOWS_PIPE_REQUIREMENT =
	"Windows peer ingress requires pwsh.exe (PowerShell 7+) with .NET PipeOptions.CurrentUserOnly support; install or repair PowerShell 7. Windows PowerShell 5.1 (powershell.exe) is unsupported for the named-pipe helper.";

export function isSupportedWindowsPipeRuntimeProbe(stdout: string, stderr: string, exitCode: number): boolean {
	return exitCode === 0 && stdout.trim() === WINDOWS_PIPE_RUNTIME_MARKER && stderr.trim() === "";
}

async function requireWindowsPipeRuntime(): Promise<void> {
	try {
		const result = await execFileAsync(
			WINDOWS_PIPE_HELPER_EXECUTABLE,
			["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PIPE_RUNTIME_PROBE],
			{ encoding: "utf8", timeout: 5_000, maxBuffer: 2_048, windowsHide: true },
		);
		if (isSupportedWindowsPipeRuntimeProbe(result.stdout, result.stderr, 0)) return;
		throw new Error("PowerShell did not return the expected capability-probe result");
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`${WINDOWS_PIPE_REQUIREMENT} Probe failed: ${detail.slice(0, 300)}`);
	}
}
interface SignedFrame {
	version: 1;
	message: PeerMessage;
	sentAt: number;
	nonce: string;
	signature: string;
}
interface ResponseFrame {
	ok: boolean;
	receipt?: PeerReceipt;
	error?: string;
}
export interface PeerIngressOptions {
	address: PeerAddress;
	socketPath: string;
	resolveSenderKey(address: PeerAddress, signal?: AbortSignal): Promise<KeyObject | string | Buffer | undefined>;
	mailbox: PeerMailbox;
	now?: () => number;
}
export interface PeerIngress {
	/** Resolves if the listener fails after startup; Unix listeners keep this pending until process exit. */
	failure: Promise<Error>;
	close(): Promise<void>;
}

/** Authenticated Unix-domain ingress. Unsupported platforms fail closed; never falls back to unauthenticated sockets/files. */
export async function startPeerIngress(options: PeerIngressOptions): Promise<PeerIngress> {
	const namedPipe = process.platform === "win32";
	if (namedPipe) {
		if (!isValidPeerEndpointPath(options.socketPath, "win32")) throw new Error("Invalid peer named-pipe endpoint");
	} else {
		if (!isValidPeerEndpointPath(options.socketPath, process.platform))
			throw new Error("Invalid Unix peer socket path");
		const parentPath = dirname(options.socketPath);
		const canonicalParent = await realpath(parentPath);
		const requestedParent = resolve(parentPath);
		const macAlias =
			process.platform === "darwin" && canonicalParent === requestedParent.replace(/^\/(var|tmp)(?=\/)/, "/private/$1");
		if (canonicalParent !== requestedParent && !macAlias)
			throw new Error("Peer socket path must not traverse symlink ancestors");
		const parent = await lstat(parentPath);
		if (
			!parent.isDirectory() ||
			parent.isSymbolicLink() ||
			parent.uid !== process.getuid?.() ||
			(parent.mode & 0o077) !== 0
		)
			throw new Error("Peer socket parent must be a current-user-owned private directory");
		try {
			await lstat(options.socketPath);
			throw new Error("Peer socket path already exists; refusing to replace it");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const seenNonces = new Map<string, number>();
	const activeControllers = new Set<AbortController>();
	const activeRequests = new Set<Promise<void>>();
	const activeSockets = new Set<Socket>();
	let ingressClosing = false;
	const server: Server | undefined = namedPipe
		? undefined
		: createServer((socket) => {
				activeSockets.add(socket);
				socket.once("close", () => activeSockets.delete(socket));
				void serve(socket);
			});
	const serve = async (socket: Socket): Promise<void> => {
		socket.setTimeout(5_000, () => socket.destroy());
		let data = "";
		const controller = new AbortController();
		activeControllers.add(controller);
		socket.once("close", () => {
			activeControllers.delete(controller);
			controller.abort(new Error("Peer client disconnected"));
		});
		socket.on("data", (chunk) => {
			data += chunk.toString("utf8");
			if (Buffer.byteLength(data, "utf8") > MAX_FRAME_BYTES) {
				respond(socket, { ok: false, error: "frame_too_large" });
				return;
			}
			const newline = data.indexOf("\n");
			if (newline < 0) return;
			socket.removeAllListeners("data");
			const request = handleBounded(data.slice(0, newline), controller)
				.then((response) => {
					if (!ingressClosing) respond(socket, response);
				})
				.catch(() => {
					if (!ingressClosing && !socket.destroyed) respond(socket, { ok: false, error: "invalid_request" });
				})
				.finally(() => activeControllers.delete(controller));
			activeRequests.add(request);
			void request.finally(() => activeRequests.delete(request));
		});
	};
	const handle = async (raw: string, signal: AbortSignal): Promise<ResponseFrame> => {
		throwIfAborted(signal);
		let frame: SignedFrame;
		try {
			frame = JSON.parse(raw) as SignedFrame;
		} catch {
			return { ok: false, error: "invalid_request" };
		}
		if (
			frame?.version !== 1 ||
			!validatePeerMessage(frame.message) ||
			typeof frame.nonce !== "string" ||
			frame.nonce.length < 16 ||
			frame.nonce.length > 128 ||
			typeof frame.signature !== "string" ||
			!Number.isFinite(frame.sentAt)
		)
			return { ok: false, error: "invalid_request" };
		if (
			frame.message.recipient.peerSessionId !== options.address.peerSessionId ||
			frame.message.recipient.runtimeId !== options.address.runtimeId
		)
			return { ok: false, error: "stale_runtime" };
		const now = (options.now ?? Date.now)();
		if (Math.abs(now - frame.sentAt) > PEER_LIMITS.futureSkewMs || !validateInboundPeerMessage(frame.message, now))
			return { ok: false, error: "expired" };
		const replayKey = `${frame.message.sender.peerSessionId}/${frame.message.sender.runtimeId}/${frame.nonce}`;
		if (seenNonces.has(replayKey)) return { ok: false, error: "replay" };
		const publicKey = await options.resolveSenderKey(frame.message.sender, signal);
		throwIfAborted(signal);
		if (!publicKey) return { ok: false, error: "unknown_sender" };
		const payload = signedPayload(frame.message, frame.sentAt, frame.nonce);
		if (!verify(null, payload, toPublicKey(publicKey), Buffer.from(frame.signature, "base64")))
			return { ok: false, error: "bad_signature" };
		for (const [key, time] of seenNonces) if (now - time > PEER_LIMITS.rateWindowMs) seenNonces.delete(key);
		if (seenNonces.size >= PEER_LIMITS.metadataRecords) return { ok: false, error: "rate_limited" };
		throwIfAborted(signal);
		seenNonces.set(replayKey, now);
		const result = await options.mailbox.acceptIngress(frame.message, signal);
		throwIfAborted(signal);
		if (result.status === "conflict") return { ok: false, error: "message_id_conflict" };
		if (result.status === "rate_limited") return { ok: false, error: "rate_limited" };
		return { ok: true, receipt: result.status };
	};
	const handleBounded = async (raw: string, controller = new AbortController()): Promise<ResponseFrame> => {
		const timer = setTimeout(() => controller.abort(new Error("Peer ingress handler timed out")), 10_000);
		try {
			return await handle(raw, controller.signal);
		} finally {
			clearTimeout(timer);
		}
	};
	let pipeHelper: ChildProcessWithoutNullStreams | undefined;
	let helperFailureResolve!: (error: Error) => void;
	const helperFailure = new Promise<Error>((resolve) => {
		helperFailureResolve = resolve;
	});
	let helperReady = false;
	let helperClosing = false;
	let helperClosed = false;
	let activeRequestController: AbortController | undefined;
	let helperFailureHandled = false;
	const failHelper = (error: Error) => {
		if (helperFailureHandled || helperClosing) return;
		helperFailureHandled = true;
		helperFailureResolve(error);
		activeRequestController?.abort(error);
	};
	if (namedPipe) {
		const endpointName = options.socketPath.slice("\\\\.\\pipe\\".length);
		const sourceHelper = fileURLToPath(new URL("./windows-peer-pipe.ps1", import.meta.url));
		const packagedHelper = fileURLToPath(
			new URL("../../extension-src/pi-teams/pi/windows-peer-pipe.ps1", import.meta.url),
		);
		const helperPath = existsSync(sourceHelper) ? sourceHelper : packagedHelper;
		if (!existsSync(helperPath)) throw new Error("Windows peer pipe helper source is missing from this installation");
		await requireWindowsPipeRuntime();
		pipeHelper = spawn(
			WINDOWS_PIPE_HELPER_EXECUTABLE,
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				helperPath,
				"-PipeName",
				endpointName,
			],
			{ windowsHide: true, stdio: "pipe" },
		);
		const child = pipeHelper;
		const lines = createInterface({ input: child.stdout });
		let readyResolve!: () => void;
		let readyReject!: (error: Error) => void;
		const ready = new Promise<void>((resolve, reject) => {
			readyResolve = resolve;
			readyReject = reject;
		});
		let handling = false;
		lines.on("line", (line) => {
			if (!helperReady) {
				if (line === "READY") {
					helperReady = true;
					readyResolve();
				} else readyReject(new Error(`Windows peer pipe helper failed: ${line.slice(0, 200)}`));
				return;
			}
			if (handling || Buffer.byteLength(line) > MAX_FRAME_BYTES) {
				failHelper(new Error("Windows peer helper violated the bounded single-request protocol"));
				child.kill();
				return;
			}
			handling = true;
			const controller = new AbortController();
			activeRequestController = controller;
			const task = handleBounded(line, controller).then(async (response) => {
				if (helperClosing || child.stdin.destroyed) return;
				await new Promise<void>((resolve, reject) => {
					child.stdin.write(`${JSON.stringify(response)}\n`, (error) => (error ? reject(error) : resolve()));
				});
			});
			activeControllers.add(controller);
			activeRequests.add(task);
			void task
				.catch((error: unknown) => {
					if (!helperClosing) {
						failHelper(error instanceof Error ? error : new Error(String(error)));
						child.kill();
					}
				})
				.finally(() => {
					handling = false;
					activeRequestController = undefined;
					activeControllers.delete(controller);
					activeRequests.delete(task);
				});
		});
		child.stdout.on("error", (error) => {
			readyReject(error);
			failHelper(error);
		});
		child.stdin.on("error", (error) => {
			readyReject(error);
			failHelper(error);
		});
		child.stderr.on("error", (error) => {
			readyReject(error);
			failHelper(error);
		});
		child.stderr.resume();
		child.once("error", (error) => {
			readyReject(error);
			failHelper(error);
		});
		child.once("exit", (code, signal) => {
			const error = new Error(`Windows peer pipe helper exited (${code ?? signal ?? "unknown"})`);
			if (!helperReady) readyReject(error);
			else failHelper(error);
		});
		child.once("close", () => {
			helperClosed = true;
		});
		let startupTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				ready,
				new Promise<void>((_, reject) => {
					startupTimer = setTimeout(() => reject(new Error("Windows peer pipe helper startup timed out")), 5000);
				}),
			]);
			if (helperFailureHandled) throw new Error("Windows peer pipe helper exited during startup");
		} catch (error) {
			helperClosing = true;
			if (!helperClosed) {
				const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
				child.kill();
				await closed;
			}
			throw error;
		} finally {
			if (startupTimer) clearTimeout(startupTimer);
		}
	} else {
		await new Promise<void>((resolve, reject) => {
			server?.once("error", reject);
			server?.listen(options.socketPath, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		await chmod(options.socketPath, 0o600);
	}
	return {
		failure: namedPipe ? helperFailure : new Promise<Error>(() => {}),
		close: async () => {
			if (pipeHelper) {
				ingressClosing = true;
				helperClosing = true;
				for (const controller of activeControllers) controller.abort(new Error("Peer ingress closed"));
				await Promise.allSettled([...activeRequests]);
				const child = pipeHelper;
				if (!helperClosed) {
					const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
					child.kill();
					await closed;
				}
			} else if (server) {
				ingressClosing = true;
				for (const controller of activeControllers) controller.abort(new Error("Peer ingress closed"));
				for (const socket of activeSockets) socket.destroy();
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
				await Promise.allSettled([...activeRequests]);
				await unlink(options.socketPath).catch(() => {});
			}
		},
	};
}

export function createPeerKeyResolver(registry: PeerRegistry, projectId: string, now = Date.now) {
	return async (address: PeerAddress, signal?: AbortSignal): Promise<KeyObject | undefined> => {
		throwIfAborted(signal);
		const current = now();
		const matches = (await registry.list(projectId, signal)).filter(
			(peer) =>
				peer.peerSessionId === address.peerSessionId &&
				peer.runtimeId === address.runtimeId &&
				Math.abs(current - peer.updatedAt) <= 60_000,
		);
		throwIfAborted(signal);
		if (matches.length !== 1) return undefined;
		const [match] = matches;
		if (!match) return undefined;
		try {
			const key = createPublicKey(match.identityPublicKey);
			return key.asymmetricKeyType === "ed25519" ? key : undefined;
		} catch {
			return undefined;
		}
	};
}

export function createPeerEndpointPath(privateRoot: string, platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") return `\\\\.\\pipe\\pi-teams-peer-${randomUUID()}`;
	return join(privateRoot, `peer-${randomUUID()}.sock`);
}
export function isValidPeerEndpointPath(path: string, platform: NodeJS.Platform): boolean {
	if (platform === "win32") {
		const prefix = "\\\\.\\pipe\\pi-teams-peer-";
		return (
			isWindowsPipeEndpoint(path) &&
			path.startsWith(prefix) &&
			path.length <= 256 &&
			/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(path.slice(prefix.length))
		);
	}
	return (
		!isWindowsPipeEndpoint(path) &&
		path.startsWith("/") &&
		Buffer.byteLength(path) <= (platform === "darwin" ? 103 : 107)
	);
}

export function createPeerTransportSender(
	privateKey: KeyObject | string | Buffer,
	resolveEndpoint: (recipient: PeerAddress) => Promise<string | undefined>,
): PeerOutboundTransport {
	return {
		async send(message) {
			const socketPath = await resolveEndpoint(message.recipient);
			if (!socketPath) return "unavailable";
			return sendPeerMessage({ socketPath, message, privateKey });
		},
	};
}

export async function sendPeerMessage(options: {
	socketPath: string;
	message: PeerMessage;
	privateKey: KeyObject | string | Buffer;
	now?: () => number;
}): Promise<PeerReceipt> {
	if (!isValidPeerEndpointPath(options.socketPath, process.platform))
		throw new Error("Peer endpoint does not match this platform's validated endpoint format");
	if (!validatePeerMessage(options.message)) throw new Error("Invalid peer envelope");
	const sentAt = (options.now ?? Date.now)(),
		nonce = randomUUID();
	const frame: SignedFrame = {
		version: 1,
		message: options.message,
		sentAt,
		nonce,
		signature: sign(null, signedPayload(options.message, sentAt, nonce), toPrivateKey(options.privateKey)).toString(
			"base64",
		),
	};
	const bytes = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
	if (bytes.byteLength > MAX_FRAME_BYTES) throw new Error("Peer transport frame too large");
	return new Promise((resolve, reject) => {
		const socket = connect(options.socketPath);
		let data = "";
		let settled = false;
		const finish = (error?: Error, receipt?: PeerReceipt) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else if (receipt) resolve(receipt);
			else reject(new Error("Invalid peer receipt"));
		};
		const timer = setTimeout(() => {
			socket.destroy();
			finish(new Error("Peer transport request timed out"));
		}, 15_000);
		socket.once("error", (error) => finish(error));
		socket.once("end", () => finish(new Error("Peer ingress closed before returning a receipt")));
		socket.once("close", () => finish(new Error("Peer ingress connection closed before returning a receipt")));
		socket.on("connect", () => socket.write(bytes));
		socket.on("data", (chunk) => {
			data += chunk.toString("utf8");
			if (Buffer.byteLength(data, "utf8") > 4096) {
				socket.destroy();
				finish(new Error("Invalid peer receipt"));
				return;
			}
			const newline = data.indexOf("\n");
			if (newline < 0) return;
			try {
				const response = JSON.parse(data.slice(0, newline)) as ResponseFrame;
				socket.end();
				if (!response.ok || !response.receipt) finish(new Error(response.error ?? "Peer ingress rejected request"));
				else finish(undefined, response.receipt);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	});
}
function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	const error = new Error("Peer ingress operation aborted");
	error.name = "AbortError";
	throw error;
}
function signedPayload(message: PeerMessage, sentAt: number, nonce: string): Buffer {
	return Buffer.from(JSON.stringify({ version: 1, message, sentAt, nonce }), "utf8");
}
function toPrivateKey(key: KeyObject | string | Buffer): KeyObject {
	return typeof key === "string" || Buffer.isBuffer(key) ? createPrivateKey(key) : key;
}
function toPublicKey(key: KeyObject | string | Buffer): KeyObject {
	if (typeof key === "string" || Buffer.isBuffer(key)) return createPublicKey(key);
	return key.type === "private" ? createPublicKey(key) : key;
}
function respond(socket: Socket, response: ResponseFrame): void {
	if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
}
