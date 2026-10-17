import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PeerMessagingService } from "../../extension-src/pi-teams/app/peer-messaging-service.js";
import type { PeerAddress } from "../../extension-src/pi-teams/domain/peer.js";
import type { PeerMessage } from "../../extension-src/pi-teams/domain/peer-message.js";
import { LocalPeerHost } from "../../extension-src/pi-teams/pi/peer-host.js";
import {
	createPeerEndpointPath,
	createPeerKeyResolver,
	sendPeerMessage,
	startPeerIngress,
} from "../../extension-src/pi-teams/pi/peer-transport.js";

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
	it("accepts signed durable enqueue, rejects spoof/replay/stale runtime, and refuses closed targets", async () => {
		if (process.platform === "win32") return; // Separate Windows named-pipe conditional test below; ACL verifier remains external.
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
		"uses signed named-pipe ingress in a child process (ACL verifier is a host prerequisite)",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "peer-ipc-"));
			roots.push(root);
			const socketPath = createPeerEndpointPath(root),
				receiver = addr("receiver", "windows-run"),
				sender = addr("sender", "windows-run");
			const keys = generateKeyPairSync("ed25519"),
				mailbox = new LocalPeerHost(join(root, "data"), async () => true);
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
				verifyWindowsStorage: async () => true,
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
			} finally {
				await ingress.close();
			}
		},
	);
});
