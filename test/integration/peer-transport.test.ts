import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PeerMailbox, PeerMessagingService } from "../../extension-src/pi-teams/app/peer-messaging-service.js";
import type { PeerAddress } from "../../extension-src/pi-teams/domain/peer.js";
import type { PeerMessage } from "../../extension-src/pi-teams/domain/peer-message.js";
import { LocalPeerHost } from "../../extension-src/pi-teams/pi/peer-host.js";
import {
	createPeerEndpointPath,
	createPeerKeyResolver,
	sendPeerMessage,
	startPeerIngress,
} from "../../extension-src/pi-teams/pi/peer-transport.js";
import { ensureWindowsPeerStorage } from "../../extension-src/pi-teams/pi/windows-peer-acl.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function runClient(socket: string, key: string, message: PeerMessage, nonce?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const worker = spawn(process.execPath, [
			fileURLToPath(new URL("../helpers/peer-transport-client.mjs", import.meta.url)),
			socket,
			Buffer.from(key).toString("base64"),
			JSON.stringify(message),
			...(nonce ? [nonce] : []),
		]);
		let stdout = "",
			stderr = "";
		worker.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		worker.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		worker.once("error", reject);
		worker.once("close", (code) =>
			code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout || `child exited ${code}`)),
		);
	});
}
const addr = (peerSessionId: string, runtimeId: string): PeerAddress => ({ peerSessionId, runtimeId });
function message(sender: PeerAddress, recipient: PeerAddress, id: string): PeerMessage {
	return {
		protocolVersion: 1,
		messageId: id,
		sender,
		recipient,
		body: "authenticated peer payload",
		createdAt: Date.now(),
		expiresAt: Date.now() + 60_000,
	};
}
async function advertiseSender(
	host: LocalPeerHost,
	sender: PeerAddress,
	projectId: string,
	publicKey: string,
	endpoint: string,
) {
	await host.publish({
		protocolVersion: 1,
		...sender,
		displayName: "sender",
		projectId,
		status: "idle",
		updatedAt: Date.now(),
		capabilities: [],
		identityPublicKey: publicKey,
		endpoint: { kind: process.platform === "win32" ? "named_pipe" : "unix", path: endpoint },
	});
}
describe("authenticated peer ingress across processes", () => {
	it("aborts and joins in-flight mailbox work before ingress close completes on Unix and Windows", async () => {
		const root = await mkdtemp(join(tmpdir(), "peer-abort-"));
		roots.push(root);
		const socketPath = process.platform === "win32" ? createPeerEndpointPath(root) : join(root, "abort.sock"),
			sender = addr("abort-sender", "sender-run"),
			receiver = addr("receiver", "abort-run");
		if (process.platform === "win32") expect(await ensureWindowsPeerStorage(root)).toBe(true);
		const keys = generateKeyPairSync("ed25519");
		let entered!: () => void;
		let aborted!: () => void;
		let handlerEntered = false;
		let handlerAborted = false;
		let release!: () => void;
		const enteredWait = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const abortedWait = new Promise<void>((resolve) => {
			aborted = resolve;
		});
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		let lateMutation = false;
		const mailbox = {
			async acceptIngress(_message: PeerMessage, signal?: AbortSignal) {
				handlerEntered = true;
				entered();
				await new Promise<void>((resolve) =>
					signal?.addEventListener(
						"abort",
						() => {
							handlerAborted = true;
							aborted();
							resolve();
						},
						{ once: true },
					),
				);
				await barrier;
				if (signal?.aborted) throw signal.reason;
				lateMutation = true;
				return { status: "queued" as const };
			},
		} as unknown as PeerMailbox;
		const ingress = await startPeerIngress({
			address: receiver,
			socketPath,
			resolveSenderKey: async () => keys.publicKey,
			mailbox,
		});
		let sendError: unknown;
		const send = sendPeerMessage({
			socketPath,
			message: message(sender, receiver, "abort-work"),
			privateKey: keys.privateKey,
		}).catch((error) => {
			sendError = error;
		});
		let closing: Promise<void> | undefined;
		try {
			await vi.waitFor(() => expect(handlerEntered || sendError).toBeTruthy(), { timeout: 5000 });
			if (sendError) throw sendError;
			await enteredWait;
			let closed = false;
			closing = ingress.close().then(() => {
				closed = true;
			});
			await vi.waitFor(() => expect(handlerAborted).toBe(true), { timeout: 5000 });
			await abortedWait;
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(closed).toBe(false);
			release();
			await closing;
			await send;
			expect(lateMutation).toBe(false);
		} finally {
			release();
			if (closing) await closing;
			else await ingress.close();
		}
	}, 30_000);

	it("accepts signed durable enqueue, rejects spoof/replay/stale runtime, and refuses closed targets", async () => {
		if (process.platform === "win32") return; // Windows exercises the source helper in a conditional integration below.
		const root = await mkdtemp(join(tmpdir(), "peer-ipc-"));
		roots.push(root);
		const socketPath = join(root, "runtime.sock"),
			receiver = addr("receiver", "incarnation-2"),
			sender = addr("sender", "sender-run"),
			projectId = "project";
		const senderKeys = generateKeyPairSync("ed25519"),
			attackerKeys = generateKeyPairSync("ed25519"),
			mailbox = new LocalPeerHost(join(root, "data")),
			ingressNow = Date.now();
		await advertiseSender(
			mailbox,
			sender,
			projectId,
			senderKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
			join(root, "sender.sock"),
		);
		const ingress = await startPeerIngress({
			address: receiver,
			socketPath,
			resolveSenderKey: createPeerKeyResolver(mailbox, projectId),
			mailbox,
			now: () => ingressNow,
		});
		try {
			const valid = message(sender, receiver, "message-1");
			expect(
				JSON.parse(
					await runClient(
						socketPath,
						senderKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
						valid,
						"nonce-valid-000001",
					),
				),
			).toEqual({ ok: true, receipt: "queued" });
			expect((await mailbox.pending(receiver)).map((item) => item.messageId)).toContain(valid.messageId);
			expect((await mailbox.getBinding(valid.messageId))?.sender).toEqual(sender);
			const receiverService = new PeerMessagingService(
				receiver,
				mailbox,
				{ deliver: async () => {}, hold: async () => {} },
				() => "hold",
			);
			expect((await receiverService.receive(valid)).receipt).toBe("held");
			const refused = message(sender, receiver, "terminal-refusal");
			await runClient(
				socketPath,
				senderKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
				refused,
				"nonce-refused-0001",
			);
			const refusingService = new PeerMessagingService(
				receiver,
				mailbox,
				{ deliver: async () => {}, hold: async () => {} },
				() => "refuse",
			);
			expect((await refusingService.receive(refused)).receipt).toBe("refused");
			const replay = JSON.parse(
				await runClient(
					socketPath,
					senderKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
					refused,
					"nonce-refused-0002",
				),
			);
			expect(replay.receipt).toBe("refused");
			await expect(
				runClient(
					socketPath,
					senderKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
					{ ...refused, body: "altered after refusal" },
					"nonce-refused-0003",
				),
			).rejects.toThrow(/message_id_conflict/);
			await expect(
				runClient(
					socketPath,
					attackerKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
					message(sender, receiver, "spoof"),
					"nonce-spoof-00001",
				),
			).rejects.toThrow(/bad_signature/);
			await expect(
				runClient(
					socketPath,
					senderKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
					valid,
					"nonce-valid-000001",
				),
			).rejects.toThrow(/replay/);
			await expect(
				runClient(
					socketPath,
					senderKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
					message(sender, addr("receiver", "old-runtime"), "stale-target"),
					"nonce-stale-000001",
				),
			).rejects.toThrow(/stale_runtime/);
			await expect(
				runClient(
					socketPath,
					senderKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
					message(addr("sender", "old-run"), receiver, "stale-sender"),
					"nonce-oldsender-001",
				),
			).rejects.toThrow(/unknown_sender/);
			const tooLong = { ...message(sender, receiver, "too-long"), expiresAt: Date.now() + 3_600_001 };
			await expect(
				runClient(
					socketPath,
					senderKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
					tooLong,
					"nonce-too-long-001",
				),
			).rejects.toThrow(/expired/);
			const future = {
				...message(sender, receiver, "future"),
				createdAt: Date.now() + 120_000,
				expiresAt: Date.now() + 180_000,
			};
			await expect(
				runClient(
					socketPath,
					senderKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
					future,
					"nonce-future-0001",
				),
			).rejects.toThrow(/expired/);
			for (let i = 0; i < 8; i++) {
				const accepted = JSON.parse(
					await runClient(
						socketPath,
						senderKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
						message(sender, receiver, `burst-${i}`),
						`nonce-burst-${String(i).padStart(4, "0")}`,
					),
				);
				expect(accepted.receipt).toBe("queued");
			}
			await expect(
				runClient(
					socketPath,
					senderKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
					message(sender, receiver, "burst-over"),
					"nonce-burst-over-01",
				),
			).rejects.toThrow(/rate_limited/);
		} finally {
			await ingress.close();
		}
		await expect(
			sendPeerMessage({ socketPath, message: message(sender, receiver, "closed"), privateKey: senderKeys.privateKey }),
		).rejects.toThrow();
	}, 15_000);
	it.skipIf(process.platform !== "win32")(
		"closes the Windows helper while accepted ingress waits on the real quota lock",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "peer-win-lock-close-"));
			roots.push(root);
			expect(await ensureWindowsPeerStorage(root)).toBe(true);
			const socketPath = createPeerEndpointPath(root);
			const sender = addr("lock-sender", "windows-run");
			const receiver = addr("lock-receiver", "windows-run");
			const keys = generateKeyPairSync("ed25519");
			const mailbox = new LocalPeerHost(join(root, "data"));
			await advertiseSender(
				mailbox,
				sender,
				"project",
				keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
				socketPath,
			);
			const lockDir = join(root, "data", "locks");
			await mkdir(lockDir, { recursive: true });
			await writeFile(join(lockDir, "quota.lock"), JSON.stringify({ token: "test-barrier", pid: process.pid }));
			let entered!: () => void;
			let hasEntered = false;
			const lockWait = new Promise<void>((resolve) => {
				entered = () => {
					hasEntered = true;
					resolve();
				};
			});
			type WithQuotaLock = <T>(fn: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
			const internals = mailbox as unknown as { withQuotaLock: WithQuotaLock };
			const original = internals.withQuotaLock.bind(mailbox);
			internals.withQuotaLock = (fn, signal) => {
				entered();
				return original(fn, signal);
			};
			const ingress = await startPeerIngress({
				address: receiver,
				socketPath,
				resolveSenderKey: createPeerKeyResolver(mailbox, "project"),
				mailbox,
			});
			try {
				const send = sendPeerMessage({
					socketPath,
					message: message(sender, receiver, "windows-lock-close"),
					privateKey: keys.privateKey,
				});
				await vi.waitFor(() => expect(hasEntered).toBe(true), { timeout: 10_000 });
				await lockWait;
				await ingress.close();
				await expect(send).rejects.toThrow();
				expect(await mailbox.getBinding("windows-lock-close")).toBeUndefined();
				expect(await mailbox.receiptState("windows-lock-close")).toBeUndefined();
				expect(await mailbox.pending(receiver)).toEqual([]);
			} finally {
				await ingress.close();
			}
		},
	);
	it.skipIf(process.platform !== "win32")("closes the Windows helper with a partial pipe frame", async () => {
		const root = await mkdtemp(join(tmpdir(), "peer-partial-frame-"));
		roots.push(root);
		expect(await ensureWindowsPeerStorage(root)).toBe(true);
		const socketPath = createPeerEndpointPath(root);
		const receiver = addr("partial-frame-receiver", "windows-run");
		const keys = generateKeyPairSync("ed25519");
		const ingress = await startPeerIngress({
			address: receiver,
			socketPath,
			resolveSenderKey: async () => keys.publicKey,
			mailbox: { acceptIngress: async () => ({ status: "queued" }) } as unknown as PeerMailbox,
		});
		const client = createConnection(socketPath);
		try {
			await new Promise<void>((resolve, reject) => {
				client.once("connect", resolve);
				client.once("error", reject);
			});
			client.write('{"partial":');
			await ingress.close();
		} finally {
			client.destroy();
		}
	});
	it.skipIf(process.platform !== "win32")("rejects unsafe storage descendants and reparse ancestors", async () => {
		const root = await mkdtemp(join(tmpdir(), "peer-acl-"));
		const outside = await mkdtemp(join(tmpdir(), "peer-acl-outside-"));
		roots.push(root, outside);
		const protectedFile = join(root, "protected-broad.txt");
		await writeFile(protectedFile, "must not be silently accepted");
		execFileSync("icacls.exe", [protectedFile, "/inheritance:r", "/grant:r", "*S-1-1-0:(F)"], {
			timeout: 5000,
			windowsHide: true,
		});
		expect(await ensureWindowsPeerStorage(root)).toBe(false);
		await symlink(outside, join(root, "junction"), "junction");
		expect(await ensureWindowsPeerStorage(join(root, "junction", "redirected"))).toBe(false);
	});
	it.skipIf(process.platform !== "win32")(
		"provisions user-only storage and accepts signed ingress through CurrentUserOnly pipe helper",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "peer-ipc-"));
			roots.push(root);
			expect(await ensureWindowsPeerStorage(root)).toBe(true);
			const socketPath = createPeerEndpointPath(root),
				receiver = addr("receiver", "windows-run"),
				sender = addr("sender", "windows-run");
			const keys = generateKeyPairSync("ed25519"),
				mailbox = new LocalPeerHost(join(root, "data"));
			await advertiseSender(
				mailbox,
				sender,
				"project",
				keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
				socketPath,
			);
			const ingress = await startPeerIngress({
				address: receiver,
				socketPath,
				resolveSenderKey: createPeerKeyResolver(mailbox, "project"),
				mailbox,
			});
			try {
				const result = JSON.parse(
					await runClient(
						socketPath,
						keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
						message(sender, receiver, "win-message"),
					),
				);
				expect(result.receipt).toBe("queued");
				expect((await mailbox.getBinding("win-message"))?.sender).toEqual(sender);
				const deliveries: string[] = [];
				const receiverService = new PeerMessagingService(
					receiver,
					mailbox,
					{
						deliver: async (m) => {
							deliveries.push(m.messageId);
						},
						hold: async () => {},
					},
					() => "hold",
				);
				const [pending] = await mailbox.pending(receiver);
				expect(pending).toBeDefined();
				if (!pending) throw new Error("Windows ingress did not persist the message");
				expect((await receiverService.receive(pending)).receipt).toBe("held");
				expect((await receiverService.heldMessages()).map((m) => m.messageId)).toContain("win-message");
				expect((await receiverService.approveHeld("win-message")).receipt).toBe("delivered");
				expect(deliveries).toEqual(["win-message"]);
				expect(await mailbox.receiptState("win-message")).toBe("delivered");
				expect(await receiverService.heldMessages()).toHaveLength(0);
			} finally {
				await ingress.close();
			}
		},
	);
});
