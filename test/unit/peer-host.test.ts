import { generateKeyPairSync } from "node:crypto";
import { access, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PeerAdvertisement } from "../../extension-src/pi-teams/domain/peer.js";
import { type PeerMessage, peerMessageFingerprint } from "../../extension-src/pi-teams/domain/peer-message.js";
import { LocalPeerHost } from "../../extension-src/pi-teams/pi/peer-host.js";
import { createPeerEndpointPath } from "../../extension-src/pi-teams/pi/peer-transport.js";
import * as windowsPeerAcl from "../../extension-src/pi-teams/pi/windows-peer-acl.js";

const windowsAclTestTimeout = process.platform === "win32" ? 30_000 : 5_000;
const hostIt = (name: string, fn: () => unknown, timeout = windowsAclTestTimeout) => it(name, fn, timeout);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function host() {
	const root = await mkdtemp(join(tmpdir(), "peer-host-"));
	roots.push(root);
	return new LocalPeerHost(root);
}
const ad: PeerAdvertisement = {
	protocolVersion: 1,
	peerSessionId: "session",
	runtimeId: "run1",
	displayName: "Pi",
	projectId: "project",
	status: "idle",
	updatedAt: 1,
	capabilities: [],
	identityPublicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString(),
	endpoint:
		process.platform === "win32"
			? { kind: "named_pipe", path: createPeerEndpointPath("", "win32") }
			: { kind: "unix", path: "/tmp/peer.sock" },
};
const makeMessage = (id: string, body = "hello"): PeerMessage => ({
	protocolVersion: 1,
	messageId: id,
	sender: { peerSessionId: "s1", runtimeId: "r1" },
	recipient: { peerSessionId: "session", runtimeId: "run1" },
	body,
	createdAt: 10,
	expiresAt: Date.now() + 10_000,
});
describe("local peer host durability, quotas and receipt state", () => {
	hostIt("aborts quota-lock wait without late binding, rate, receipt, or inbox writes", async () => {
		const h = await host();
		await h.list("project");
		const root = (h as unknown as { root: string }).root;
		const lockDir = join(root, "locks");
		await mkdir(lockDir, { recursive: true, mode: 0o700 });
		await writeFile(join(lockDir, "quota.lock"), JSON.stringify({ token: "barrier", pid: process.pid }));
		(h as unknown as { lastPruneAt: number }).lastPruneAt = Date.now();
		const controller = new AbortController();
		const stop = new Error("close while waiting for quota lock");
		const operation = h.acceptIngress(makeMessage("cancelled-ingress"), controller.signal);
		const rejected = expect(operation).rejects.toBe(stop);
		await new Promise((resolve) => setTimeout(resolve, 25));
		controller.abort(stop);
		await rm(join(lockDir, "quota.lock"), { force: true });
		await rejected;
		expect(await h.getBinding("cancelled-ingress")).toBeUndefined();
		await expect(access(join(root, "rates", "s1-r1.json"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await h.receiptState("cancelled-ingress")).toBeUndefined();
		expect(await h.pending({ peerSessionId: "session", runtimeId: "run1" })).toEqual([]);
	});

	hostIt("completes the enqueue receipt when abort races after the real inbox hard link commits", async () => {
		const root = await mkdtemp(join(tmpdir(), "peer-host-link-commit-"));
		roots.push(root);
		let reached!: () => void;
		let release!: () => void;
		const linkCommitted = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		class LinkBarrierHost extends LocalPeerHost {
			protected override async linkInboxEntry(temp: string, target: string): Promise<void> {
				await link(temp, target);
				reached();
				await gate;
			}
		}
		const h = new LinkBarrierHost(root);
		(h as unknown as { lastPruneAt: number }).lastPruneAt = Date.now();
		const m = makeMessage("abort-after-link");
		const controller = new AbortController();
		const operation = h.acceptIngress(m, controller.signal);
		try {
			await linkCommitted;
			const target = join(root, "inbox", m.recipient.peerSessionId, m.recipient.runtimeId, `${m.messageId}.json`);
			await expect(access(target)).resolves.toBeUndefined();
			controller.abort(new Error("shutdown after inbox link commit"));
			release();
			await expect(operation).resolves.toEqual({ status: "queued" });
		} finally {
			release();
		}
		expect(await h.receiptState(m.messageId)).toBe("queued");
		expect(await h.getBinding(m.messageId)).toMatchObject({
			sender: m.sender,
			fingerprint: peerMessageFingerprint(m),
		});
		expect(await h.pending(m.recipient)).toEqual([m]);
	});

	hostIt("honors cancellation before creating a per-message claim", async () => {
		const h = await host();
		const controller = new AbortController();
		const stop = new Error("session stopped");
		controller.abort(stop);
		await expect(h.claim("cancelled-claim", controller.signal)).rejects.toBe(stop);
	});

	it.skipIf(process.platform !== "win32")("propagates held-pruning cancellation into ACL validation", async () => {
		let started!: () => void;
		const aclStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const controller = new AbortController();
		const reason = new Error("cancel during held-prune ACL validation");
		const aclSpy = vi.spyOn(windowsPeerAcl, "ensureWindowsPeerStorage").mockImplementation(async (_path, signal) => {
			started();
			if (!signal) throw new Error("ACL validation lost the abort signal");
			return new Promise<boolean>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		});
		try {
			const root = join("C:\\", "peer-acl-cancel-test");
			const h = new LocalPeerHost(root);
			const operation = h.listHeld(controller.signal);
			await aclStarted;
			controller.abort(reason);
			await expect(operation).rejects.toBe(reason);
			const verificationSignal = aclSpy.mock.calls[0]?.[1];
			expect(verificationSignal).toBeInstanceOf(AbortSignal);
			expect(verificationSignal).not.toBe(controller.signal);
			expect(verificationSignal?.aborted).toBe(true);
			expect(verificationSignal?.reason).toBe(reason);
		} finally {
			aclSpy.mockRestore();
		}
	});

	it.skipIf(process.platform !== "win32")(
		"isolates aborting waiters and cancels the shared verifier only after its last waiter leaves",
		async () => {
			const h = await host();
			const root = (h as unknown as { root: string }).root;
			await mkdir(join(root, "held"));
			let markStarted!: () => void;
			let finishRootCheck!: () => void;
			const started = new Promise<void>((resolve) => {
				markStarted = resolve;
			});
			const rootCheckGate = new Promise<void>((resolve) => {
				finishRootCheck = resolve;
			});
			let sharedSignal: AbortSignal | undefined;
			const aclSpy = vi.spyOn(windowsPeerAcl, "ensureWindowsPeerStorage").mockImplementation(async (path, signal) => {
				if (path === root) {
					sharedSignal = signal;
					markStarted();
					await rootCheckGate;
				}
				return true;
			});
			const firstController = new AbortController();
			const secondController = new AbortController();
			const firstReason = new Error("first waiter canceled");
			try {
				const first = h.listHeld(firstController.signal);
				const second = h.listHeld(secondController.signal);
				await started;
				firstController.abort(firstReason);
				await expect(first).rejects.toBe(firstReason);
				expect(sharedSignal?.aborted).toBe(false);
				finishRootCheck();
				await expect(second).resolves.toEqual([]);
				expect(sharedSignal?.aborted).toBe(false);
			} finally {
				finishRootCheck();
				aclSpy.mockRestore();
			}
		},
	);

	hostIt("filters malformed registrations and scopes ads", async () => {
		const h = await host();
		await h.publish(ad);
		expect(await h.list("project")).toEqual([ad]);
		expect(await h.list("other")).toEqual([]);
	});
	hostIt(
		"rejects malformed advertisements",
		async () => {
			const h = await host();
			await expect(h.publish({ ...ad, displayName: "x".repeat(200) })).rejects.toThrow(/invalid/i);
		},
		windowsAclTestTimeout,
	);
	it.skipIf(process.platform === "win32")(
		"rejects a symlinked storage directory on Unix",
		async () => {
			const h = await host();
			const root = roots.at(-1);
			if (!root) throw new Error("test root missing");
			const outside = await mkdtemp(join(tmpdir(), "peer-outside-"));
			try {
				await symlink(outside, join(root, "registry"));
				await expect(h.list("project")).rejects.toThrow(/symlink/i);
			} finally {
				await rm(outside, { recursive: true, force: true });
			}
		},
		windowsAclTestTimeout,
	);
	hostIt("deduplicates concurrent identical ingress and rejects conflicting ID content", async () => {
		const h = await host(),
			m = makeMessage("racing-duplicate");
		const results = await Promise.all([h.acceptIngress(m), h.acceptIngress(m)]);
		expect(results.map((r) => r.status)).toEqual(["queued", "queued"]);
		expect(await h.pending(m.recipient)).toHaveLength(1);
		expect(await h.acceptIngress({ ...m, body: "different body" })).toEqual({ status: "conflict" });
	});
	hostIt(
		"atomically enforces aggregate inbox+held quota under concurrent ingress",
		async () => {
			const h = await host(),
				messages = Array.from({ length: 130 }, (_, i) => ({
					...makeMessage(`quota-${i}`),
					sender: { peerSessionId: `sender-${Math.floor(i / 10)}`, runtimeId: "runtime" },
				}));
			const results = await Promise.all(messages.map((m) => h.acceptIngress(m)));
			expect(results.filter((r) => r.status === "queued")).toHaveLength(100);
			expect(results.filter((r) => r.status === "unavailable")).toHaveLength(30);
			const firstMessage = messages[0];
			if (!firstMessage) throw new Error("test message missing");
			const pending = await h.pending(firstMessage.recipient);
			expect(pending).toHaveLength(100);
			const firstPending = pending[0];
			if (!firstPending) throw new Error("pending inbox unexpectedly empty");
			expect(await h.holdMessage(firstPending)).toBe(true);
			expect(await h.pending(firstMessage.recipient)).toHaveLength(99);
			expect(await h.listHeld()).toHaveLength(1);
			expect(await h.acceptIngress(makeMessage("after-held"))).toEqual({ status: "unavailable" });
		},
		15_000,
	);
	hostIt("binds message IDs immutably and keeps terminal receipts monotonic", async () => {
		const h = await host(),
			m = makeMessage("bound");
		expect(await h.acceptIngress(m)).toEqual({ status: "queued" });
		expect(await h.acceptIngress(m)).toEqual({ status: "queued" });
		expect(await h.acceptIngress(makeMessage("bound", "different"))).toEqual({ status: "conflict" });
		await h.setReceipt(m.messageId, "held", peerMessageFingerprint(m));
		const terminalResults = await Promise.all([
			h.setReceipt(m.messageId, "refused", peerMessageFingerprint(m)),
			h.setReceipt(m.messageId, "delivered", peerMessageFingerprint(m)),
		]);
		expect(new Set(terminalResults).size).toBe(1);
		const terminal = await h.receiptState(m.messageId);
		expect(["refused", "delivered"]).toContain(terminal);
		expect(await h.setReceipt(m.messageId, "queued", peerMessageFingerprint(m))).toBe(terminal);
	});
	hostIt("retains terminal fingerprint tombstones through message expiry plus retention", async () => {
		const h = await host(),
			now = Date.now(),
			m = { ...makeMessage("retention"), createdAt: now, expiresAt: now + 60_000 };
		await h.acceptIngress(m);
		await h.setReceipt(m.messageId, "refused", peerMessageFingerprint(m));
		await h.prune(m.expiresAt + 60_000 + 1);
		expect(await h.getBinding(m.messageId)).toBeDefined();
		expect(await h.receiptState(m.messageId)).toBe("refused");
		await h.prune(m.expiresAt + 7 * 24 * 60 * 60 * 1000 + 1);
		expect(await h.getBinding(m.messageId)).toBeUndefined();
		expect(await h.receiptState(m.messageId)).toBeUndefined();
	});
	hostIt("claims an ID atomically across service instances", async () => {
		const h = await host();
		const first = await h.claim("cross-instance");
		expect(first).toBeTypeOf("function");
		expect(await h.claim("cross-instance")).toBeUndefined();
		await first?.();
		expect(await h.claim("cross-instance")).toBeTypeOf("function");
	});
	hostIt("persists bindings, held messages, and terminal expiry tombstones", async () => {
		const h = await host(),
			m = makeMessage("expiry");
		await h.acceptIngress(m);
		await h.holdMessage(m);
		await h.setReceipt(m.messageId, "held", peerMessageFingerprint(m));
		expect(await h.getBinding(m.messageId)).toMatchObject({ sender: m.sender, fingerprint: peerMessageFingerprint(m) });
		const held = { ...m, messageId: "held-expired", createdAt: 0, expiresAt: 1 };
		await h.acceptIngress(held);
		await h.holdMessage(held);
		await h.listHeld();
		expect(await h.receiptState(held.messageId)).toBe("expired");
		expect(await h.getHeld(held.messageId)).toBeUndefined();
	});
});
