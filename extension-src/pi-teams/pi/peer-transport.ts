import { createPrivateKey, createPublicKey, type KeyObject, randomUUID, sign, verify } from "node:crypto";
import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
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
	resolveSenderKey(address: PeerAddress): Promise<KeyObject | string | Buffer | undefined>;
	mailbox: PeerMailbox;
	now?: () => number;
	/** Required on Windows: caller must verify private per-user storage ACLs before enabling ingress. */
	verifyWindowsStorage?: () => Promise<boolean>;
}
export interface PeerIngress {
	close(): Promise<void>;
}

/** Authenticated Unix-domain ingress. Unsupported platforms fail closed; never falls back to unauthenticated sockets/files. */
export async function startPeerIngress(options: PeerIngressOptions): Promise<PeerIngress> {
	const namedPipe = process.platform === "win32";
	if (namedPipe) {
		if (!options.verifyWindowsStorage || !(await options.verifyWindowsStorage()))
			throw new Error("Windows peer ingress requires a successful per-user storage ACL verifier");
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
	const server: Server = createServer((socket) => {
		void serve(socket);
	});
	const serve = async (socket: Socket): Promise<void> => {
		socket.setTimeout(5_000, () => socket.destroy());
		let data = "";
		socket.on("data", (chunk) => {
			data += chunk.toString("utf8");
			if (Buffer.byteLength(data, "utf8") > MAX_FRAME_BYTES) {
				respond(socket, { ok: false, error: "frame_too_large" });
				return;
			}
			const newline = data.indexOf("\n");
			if (newline < 0) return;
			socket.removeAllListeners("data");
			void handle(data.slice(0, newline))
				.then((response) => respond(socket, response))
				.catch(() => respond(socket, { ok: false, error: "invalid_request" }));
		});
	};
	const handle = async (raw: string): Promise<ResponseFrame> => {
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
		const publicKey = await options.resolveSenderKey(frame.message.sender);
		if (!publicKey) return { ok: false, error: "unknown_sender" };
		const payload = signedPayload(frame.message, frame.sentAt, frame.nonce);
		if (!verify(null, payload, toPublicKey(publicKey), Buffer.from(frame.signature, "base64")))
			return { ok: false, error: "bad_signature" };
		for (const [key, time] of seenNonces) if (now - time > PEER_LIMITS.rateWindowMs) seenNonces.delete(key);
		if (seenNonces.size >= PEER_LIMITS.metadataRecords) return { ok: false, error: "rate_limited" };
		seenNonces.set(replayKey, now);
		const result = await options.mailbox.acceptIngress(frame.message);
		if (result.status === "conflict") return { ok: false, error: "message_id_conflict" };
		if (result.status === "rate_limited") return { ok: false, error: "rate_limited" };
		return { ok: true, receipt: result.status };
	};
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.socketPath, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	if (!namedPipe) await chmod(options.socketPath, 0o600);
	return {
		close: async () => {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			if (!namedPipe) await unlink(options.socketPath).catch(() => {});
		},
	};
}

export function createPeerKeyResolver(registry: PeerRegistry, projectId: string, now = Date.now) {
	return async (address: PeerAddress): Promise<KeyObject | undefined> => {
		const current = now();
		const matches = (await registry.list(projectId)).filter(
			(peer) =>
				peer.peerSessionId === address.peerSessionId &&
				peer.runtimeId === address.runtimeId &&
				Math.abs(current - peer.updatedAt) <= 60_000,
		);
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
		socket.once("error", reject);
		socket.on("connect", () => socket.write(bytes));
		socket.on("data", (chunk) => {
			data += chunk.toString("utf8");
			if (Buffer.byteLength(data, "utf8") > 4096) {
				socket.destroy();
				reject(new Error("Invalid peer receipt"));
				return;
			}
			const newline = data.indexOf("\n");
			if (newline < 0) return;
			try {
				const response = JSON.parse(data.slice(0, newline)) as ResponseFrame;
				socket.end();
				if (!response.ok || !response.receipt) reject(new Error(response.error ?? "Peer ingress rejected request"));
				else resolve(response.receipt);
			} catch (error) {
				reject(error);
			}
		});
	});
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
