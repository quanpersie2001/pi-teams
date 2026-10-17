import { describe, expect, it } from "vitest";
import { type PeerMailbox, PeerMessagingService } from "../../extension-src/pi-teams/app/peer-messaging-service.js";
import type { PeerAddress, PeerReceipt } from "../../extension-src/pi-teams/domain/peer.js";
import {
	type PeerMessage,
	peerMessageFingerprint,
	validateInboundPeerMessage,
	validatePeerMessage,
} from "../../extension-src/pi-teams/domain/peer-message.js";

const a: PeerAddress = { peerSessionId: "a", runtimeId: "a1" },
	b: PeerAddress = { peerSessionId: "b", runtimeId: "b1" };
class MemoryMailbox implements PeerMailbox {
	bindings = new Map<string, { sender: PeerAddress; fingerprint: string }>();
	receipts = new Map<string, PeerReceipt>();
	inbox = new Map<string, PeerMessage>();
	held = new Map<string, PeerMessage>();
	locks = new Set<string>();
	async acceptIngress(m: PeerMessage) {
		const fingerprint = peerMessageFingerprint(m),
			old = this.bindings.get(m.messageId),
			state = this.receipts.get(m.messageId);
		if (old && old.fingerprint !== fingerprint) return { status: "conflict" as const };
		if (state === "delivered" || state === "refused" || state === "expired" || state === "held")
			return { status: state };
		this.bindings.set(m.messageId, { sender: m.sender, fingerprint });
		this.inbox.set(m.messageId, m);
		this.receipts.set(m.messageId, "queued");
		return { status: "queued" as const };
	}
	async enqueue(m: PeerMessage) {
		this.inbox.set(m.messageId, m);
		return true;
	}
	async bind(m: PeerMessage) {
		const old = this.bindings.get(m.messageId),
			fingerprint = peerMessageFingerprint(m);
		if (!old) {
			this.bindings.set(m.messageId, { sender: m.sender, fingerprint });
			return "new" as const;
		}
		return old.fingerprint === fingerprint ? ("duplicate" as const) : ("conflict" as const);
	}
	async getBinding(id: string) {
		return this.bindings.get(id);
	}
	async claim(id: string) {
		if (this.locks.has(id)) return undefined;
		this.locks.add(id);
		return async () => {
			this.locks.delete(id);
		};
	}
	async receiptState(id: string) {
		return this.receipts.get(id);
	}
	async setReceipt(id: string, receipt: PeerReceipt, fingerprint?: string): Promise<PeerReceipt> {
		const old = this.receipts.get(id);
		if (old && ["delivered", "refused", "expired"].includes(old)) return old;
		if (receipt === "queued" && old) return old;
		if (fingerprint && this.bindings.get(id) && this.bindings.get(id)?.fingerprint !== fingerprint)
			throw new Error("fingerprint conflict");
		this.receipts.set(id, receipt);
		return receipt;
	}
	async removeFromInbox(id: string) {
		this.inbox.delete(id);
	}
	async holdMessage(m: PeerMessage) {
		this.held.set(m.messageId, m);
		this.inbox.delete(m.messageId);
		return true;
	}
	async getHeld(id: string) {
		return this.held.get(id);
	}
	async listHeld() {
		return [...this.held.values()];
	}
	async removeHeld(id: string) {
		this.held.delete(id);
	}
}
function message(id: string, body = "hello"): PeerMessage {
	return {
		protocolVersion: 1,
		messageId: id,
		sender: a,
		recipient: b,
		body,
		createdAt: 1000,
		expiresAt: 1000 + 60_000,
	};
}
function service(
	mailbox: MemoryMailbox,
	policy: () => "accept" | "hold" | "refuse",
	deliver: (m: PeerMessage) => Promise<void> = async () => {},
	local: PeerAddress = b,
) {
	return new PeerMessagingService(local, mailbox, { deliver, hold: async () => {} }, policy, () => 2000, {
		send: async () => "queued",
	});
}
describe("peer messaging invariants", () => {
	it("bounds UTF-8 payload, rejects overlong inbound TTL/future timestamps, and fails closed without transport", async () => {
		const box = new MemoryMailbox(),
			svc = service(box, () => "hold");
		expect((await svc.send(a, "💬")).receipt).toBe("queued");
		await expect(svc.send(a, "💬".repeat(4097))).rejects.toThrow(/16 KiB/i);
		expect(validateInboundPeerMessage({ ...message("long"), expiresAt: 1000 + 3_600_001 }, 2000)).toBe(false);
		expect(validateInboundPeerMessage({ ...message("future"), createdAt: 100_000 }, 2000)).toBe(false);
		const noTransport = new PeerMessagingService(
			b,
			box,
			{ deliver: async () => {}, hold: async () => {} },
			() => "hold",
		);
		await expect(noTransport.send(a, "blocked")).rejects.toThrow(/authenticated peer transport/i);
	});
	it("treats refusal as terminal and rejects reused ID with changed body", async () => {
		const box = new MemoryMailbox(),
			svc = service(box, () => "hold"),
			m = message("immutable");
		await box.acceptIngress(m);
		expect((await svc.receive(m)).receipt).toBe("held");
		expect((await svc.refuseHeld(m.messageId)).receipt).toBe("refused");
		expect(await box.acceptIngress(m)).toEqual({ status: "refused" }); // terminal tombstone prevents resurrection
		expect((await svc.receive(m)).receipt).toBe("refused");
		const changed = { ...m, body: "reused id different content" };
		expect(await box.bind(changed)).toBe("conflict");
		await expect(svc.receive(changed)).rejects.toThrow(/immutable authenticated ingress evidence/);
	});
	it("claims one message across concurrent receives and approvals", async () => {
		const box = new MemoryMailbox(),
			m = message("race");
		await box.acceptIngress(m);
		let releaseDelivery!: () => void,
			deliveries = 0;
		const svc = service(
			box,
			() => "accept",
			async () => {
				deliveries++;
				await new Promise<void>((resolve) => {
					releaseDelivery = resolve;
				});
			},
		);
		const first = svc.receive(m);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const second = await svc.receive(m);
		expect(second.receipt).toBe("queued");
		expect(deliveries).toBe(1);
		releaseDelivery();
		expect((await first).receipt).toBe("delivered");
		expect((await svc.receive(m)).receipt).toBe("delivered");
		expect(deliveries).toBe(1);
	});
	it("keeps held messages held until explicit approval; expiry is terminal", async () => {
		const box = new MemoryMailbox(),
			m = message("held");
		await box.acceptIngress(m);
		const svc = service(box, () => "hold");
		expect((await svc.receive(m)).receipt).toBe("held");
		expect((await svc.heldMessages()).map((x) => x.messageId)).toEqual([m.messageId]);
		const approve = service(box, () => "accept");
		expect((await approve.approveHeld(m.messageId)).receipt).toBe("delivered");
		const expired = message("expired");
		expired.expiresAt = 1500;
		await box.acceptIngress(expired);
		const late = new PeerMessagingService(
			b,
			box,
			{ deliver: async () => {}, hold: async () => {} },
			() => "hold",
			() => 2000,
			{ send: async () => "queued" },
		);
		expect((await late.receive(expired)).receipt).toBe("expired");
		expect((await late.receive(expired)).receipt).toBe("expired");
		await expect(late.receive({ ...expired, body: "altered expired envelope" })).rejects.toThrow(
			/immutable authenticated ingress/,
		);
	});
	it("confines held mail to the exact recipient runtime while allowing its approval", async () => {
		const box = new MemoryMailbox(),
			m = message("old-runtime-held");
		let oldInjected = 0,
			outsiderInjected = 0;
		await box.acceptIngress(m);
		const oldRuntime = service(
			box,
			() => "hold",
			async () => {
				oldInjected++;
			},
		);
		expect((await oldRuntime.receive(m)).receipt).toBe("held");
		const sameSessionRestart = service(
			box,
			() => "accept",
			async () => {
				outsiderInjected++;
			},
			{ peerSessionId: b.peerSessionId, runtimeId: "b2" },
		);
		const unrelated = service(
			box,
			() => "accept",
			async () => {
				outsiderInjected++;
			},
			{ peerSessionId: "other-session", runtimeId: "other1" },
		);
		for (const outsider of [sameSessionRestart, unrelated]) {
			expect(await outsider.heldMessages()).toEqual([]);
			expect(await outsider.approveHeld(m.messageId)).toEqual({ messageId: m.messageId, receipt: "unavailable" });
			expect(await outsider.refuseHeld(m.messageId)).toEqual({ messageId: m.messageId, receipt: "unavailable" });
			expect((await outsider.receive(m)).receipt).toBe("unavailable");
		}
		expect(await box.getHeld(m.messageId)).toEqual(m);
		expect(await box.receiptState(m.messageId)).toBe("held");
		expect(outsiderInjected).toBe(0);
		expect((await oldRuntime.heldMessages()).map((held) => held.messageId)).toEqual([m.messageId]);
		expect((await oldRuntime.approveHeld(m.messageId)).receipt).toBe("delivered");
		expect(oldInjected).toBe(1);
		expect(outsiderInjected).toBe(0);
	});
	it("shares the message claim between receive and concurrent approval", async () => {
		const box = new MemoryMailbox(),
			m = message("receive-approve-race");
		await box.acceptIngress(m);
		const holding = service(box, () => "hold");
		await holding.receive(m);
		let release!: () => void,
			count = 0;
		const approving = service(
			box,
			() => "accept",
			async () => {
				count++;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			},
		);
		const approval = approving.approveHeld(m.messageId);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const duplicateReceive = await approving.receive(m);
		expect(duplicateReceive.receipt).toBe("held");
		expect(count).toBe(1);
		release();
		expect((await approval).receipt).toBe("delivered");
		expect(count).toBe(1);
	});
	it("serializes deliveries and keeps sender burst quota", async () => {
		const box = new MemoryMailbox();
		let active = 0,
			maxActive = 0;
		const svc = service(
			box,
			() => "accept",
			async () => {
				active++;
				maxActive = Math.max(active, maxActive);
				await new Promise((resolve) => setTimeout(resolve, 5));
				active--;
			},
		);
		const x = message("x"),
			y = message("y");
		await box.acceptIngress(x);
		await box.acceptIngress(y);
		await Promise.all([svc.receive(x), svc.receive(y)]);
		expect(maxActive).toBe(1);
		for (let i = 0; i < 10; i++) await svc.send(a, `out-${i}`);
		await expect(svc.send(a, "out-limit")).rejects.toThrow(/rate limit/i);
	});
	it("validates envelopes and stable fingerprints", () => {
		const m = message("valid");
		expect(validatePeerMessage(m)).toBe(true);
		expect(peerMessageFingerprint(m)).not.toBe(peerMessageFingerprint({ ...m, body: "changed" }));
		expect(validatePeerMessage({ ...m, body: "x".repeat(17_000) })).toBe(false);
	});
});
