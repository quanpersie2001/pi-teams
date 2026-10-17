import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PeerAdvertisement } from "../../extension-src/pi-teams/domain/peer.js";
import { type PeerMessage, peerMessageFingerprint } from "../../extension-src/pi-teams/domain/peer-message.js";
import { LocalPeerHost } from "../../extension-src/pi-teams/pi/peer-host.js";

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
	endpoint: { kind: "unix", path: "/tmp/peer.sock" },
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
	it("filters malformed registrations and scopes ads", async () => {
		const h = await host();
		await h.publish(ad);
		expect(await h.list("project")).toEqual([ad]);
		expect(await h.list("other")).toEqual([]);
	});
	it("rejects malformed ads and symlinked storage directories", async () => {
		const h = await host();
		await expect(h.publish({ ...ad, displayName: "x".repeat(200) })).rejects.toThrow(/invalid/i);
		const root = roots.at(-1);
		if (!root) throw new Error("test root missing");
		const outside = await mkdtemp(join(tmpdir(), "peer-outside-"));
		try {
			await symlink(outside, join(root, "registry"));
			await expect(h.list("project")).rejects.toThrow(/symlink/i);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
	it("deduplicates concurrent identical ingress and rejects conflicting ID content", async () => {
		const h = await host(),
			m = makeMessage("racing-duplicate");
		const results = await Promise.all([h.acceptIngress(m), h.acceptIngress(m)]);
		expect(results.map((r) => r.status)).toEqual(["queued", "queued"]);
		expect(await h.pending(m.recipient)).toHaveLength(1);
		expect(await h.acceptIngress({ ...m, body: "different body" })).toEqual({ status: "conflict" });
	});
	it("atomically enforces aggregate inbox+held quota under concurrent ingress", async () => {
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
	}, 15_000);
	it("binds message IDs immutably and keeps terminal receipts monotonic", async () => {
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
	it("retains terminal fingerprint tombstones through message expiry plus retention", async () => {
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
	it("claims an ID atomically across service instances", async () => {
		const h = await host();
		const first = await h.claim("cross-instance");
		expect(first).toBeTypeOf("function");
		expect(await h.claim("cross-instance")).toBeUndefined();
		await first?.();
		expect(await h.claim("cross-instance")).toBeTypeOf("function");
	});
	it("persists bindings, held messages, and terminal expiry tombstones", async () => {
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
