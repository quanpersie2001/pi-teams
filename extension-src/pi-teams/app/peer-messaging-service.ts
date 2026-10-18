import type { PeerAddress, PeerPolicy, PeerReceipt } from "../domain/peer.js";
import {
	PEER_LIMITS,
	type PeerMessage,
	type PeerSendResult,
	peerMessageFingerprint,
	validatePeerMessage,
} from "../domain/peer-message.js";

export interface PeerMessageBinding {
	sender: PeerAddress;
	fingerprint: string;
}
export interface PeerMailbox {
	acceptIngress(
		message: PeerMessage,
		signal?: AbortSignal,
	): Promise<{
		status: "queued" | "held" | "delivered" | "refused" | "expired" | "unavailable" | "conflict" | "rate_limited";
	}>;
	getBinding(messageId: string): Promise<PeerMessageBinding | undefined>;
	claim(messageId: string, signal?: AbortSignal): Promise<(() => Promise<void>) | undefined>;
	receiptState(messageId: string): Promise<PeerReceipt | undefined>;
	setReceipt(messageId: string, receipt: PeerReceipt, fingerprint?: string, signal?: AbortSignal): Promise<PeerReceipt>;
	removeFromInbox(messageId: string, recipient: PeerAddress, signal?: AbortSignal): Promise<void>;
	holdMessage(message: PeerMessage, signal?: AbortSignal): Promise<boolean>;
	getHeld(messageId: string): Promise<PeerMessage | undefined>;
	listHeld(): Promise<PeerMessage[]>;
	removeHeld(messageId: string, signal?: AbortSignal): Promise<void>;
}
export interface PeerOutboundTransport {
	send(message: PeerMessage): Promise<PeerReceipt>;
}
export interface PeerDelivery {
	deliver(message: PeerMessage): Promise<void>;
	hold(message: PeerMessage): Promise<void>;
}

export class PeerMessagingService {
	private readonly sentAt = new Map<string, number[]>();
	constructor(
		private readonly local: PeerAddress,
		private readonly mailbox: PeerMailbox,
		private readonly delivery: PeerDelivery,
		private readonly policy: () => PeerPolicy,
		private readonly now = Date.now,
		private readonly transport?: PeerOutboundTransport,
	) {}
	async send(recipient: PeerAddress, body: string): Promise<PeerSendResult> {
		if (!body.trim() || Buffer.byteLength(body, "utf8") > PEER_LIMITS.bodyBytes)
			throw new Error("Peer message must be nonempty and at most 16 KiB UTF-8");
		const now = this.now(),
			senderKey = `${this.local.peerSessionId}/${this.local.runtimeId}`;
		const history = (this.sentAt.get(senderKey) ?? []).filter((t) => now - t < PEER_LIMITS.rateWindowMs);
		if (history.length >= PEER_LIMITS.rateCount) throw new Error("Peer send rate limit exceeded");
		history.push(now);
		this.sentAt.set(senderKey, history);
		const message: PeerMessage = {
			protocolVersion: 1,
			messageId: crypto.randomUUID(),
			sender: this.local,
			recipient,
			body,
			createdAt: now,
			expiresAt: now + PEER_LIMITS.ttlMs,
		};
		if (!this.transport) throw new Error("Authenticated peer transport is required for cross-session send");
		const receipt = await this.transport.send(message);
		return {
			messageId: message.messageId,
			receipt: await this.mailbox.setReceipt(message.messageId, receipt, peerMessageFingerprint(message)),
		};
	}
	async receive(value: unknown, signal?: AbortSignal): Promise<PeerSendResult> {
		throwIfAborted(signal);
		if (!validatePeerMessage(value)) throw new Error("Invalid peer envelope");
		const message = value;
		const release = await this.mailbox.claim(message.messageId, signal);
		if (!release) return this.resultFor(message.messageId, "queued");
		try {
			throwIfAborted(signal);
			const binding = await this.mailbox.getBinding(message.messageId),
				fingerprint = peerMessageFingerprint(message);
			if (
				!binding ||
				binding.fingerprint !== fingerprint ||
				binding.sender.peerSessionId !== message.sender.peerSessionId ||
				binding.sender.runtimeId !== message.sender.runtimeId
			)
				throw new Error("Peer message lacks matching immutable authenticated ingress evidence");
			if (!this.isLocalRecipient(message)) return { messageId: message.messageId, receipt: "unavailable" };
			const terminal = await this.mailbox.receiptState(message.messageId);
			throwIfAborted(signal);
			if (isTerminal(terminal)) {
				await this.mailbox.removeHeld(message.messageId, signal);
				await this.mailbox.removeFromInbox(message.messageId, message.recipient, signal);
				return this.resultFor(message.messageId, terminal);
			}
			if (message.expiresAt <= this.now()) {
				const receipt = await this.mailbox.setReceipt(message.messageId, "expired", fingerprint, signal);
				await this.mailbox.removeHeld(message.messageId, signal);
				await this.mailbox.removeFromInbox(message.messageId, message.recipient, signal);
				return this.resultFor(message.messageId, receipt);
			}
			if (await this.mailbox.getHeld(message.messageId)) {
				throwIfAborted(signal);
				const receipt = await this.mailbox.setReceipt(message.messageId, "held", fingerprint, signal);
				return this.resultFor(message.messageId, receipt);
			}
			if (this.policy() === "refuse") {
				throwIfAborted(signal);
				const receipt = await this.mailbox.setReceipt(message.messageId, "refused", fingerprint, signal);
				await this.mailbox.removeFromInbox(message.messageId, message.recipient, signal);
				return this.resultFor(message.messageId, receipt);
			}
			if (this.policy() === "hold") {
				throwIfAborted(signal);
				if (!(await this.mailbox.holdMessage(message, signal))) return this.resultFor(message.messageId, "unavailable");
				throwIfAborted(signal);
				const receipt = await this.mailbox.setReceipt(message.messageId, "held", fingerprint, signal);
				throwIfAborted(signal);
				await this.delivery.hold(message);
				return this.resultFor(message.messageId, receipt);
			}
			throwIfAborted(signal);
			await this.serialDeliver(message);
			throwIfAborted(signal);
			const receipt = await this.mailbox.setReceipt(message.messageId, "delivered", fingerprint, signal);
			await this.mailbox.removeFromInbox(message.messageId, message.recipient, signal);
			return this.resultFor(message.messageId, receipt);
		} finally {
			await release();
		}
	}
	async heldMessages(): Promise<PeerMessage[]> {
		return (await this.mailbox.listHeld()).filter((m) => this.isLocalRecipient(m) && m.expiresAt > this.now());
	}
	async approveHeld(messageId: string): Promise<PeerSendResult> {
		const candidate = await this.mailbox.getHeld(messageId);
		if (!candidate || !this.isLocalRecipient(candidate)) return { messageId, receipt: "unavailable" };
		const release = await this.mailbox.claim(messageId);
		if (!release) return this.resultFor(messageId, "held");
		try {
			const message = await this.mailbox.getHeld(messageId);
			if (!message) return this.resultFor(messageId, "unavailable");
			if (!this.isLocalRecipient(message)) return { messageId, receipt: "unavailable" };
			const binding = await this.mailbox.getBinding(messageId),
				fingerprint = peerMessageFingerprint(message);
			if (
				!binding ||
				binding.fingerprint !== fingerprint ||
				binding.sender.peerSessionId !== message.sender.peerSessionId ||
				binding.sender.runtimeId !== message.sender.runtimeId
			)
				throw new Error("Held message fingerprint does not match ingress binding");
			const terminal = await this.mailbox.receiptState(messageId);
			if (isTerminal(terminal)) {
				await this.mailbox.removeHeld(messageId);
				return this.resultFor(messageId, terminal);
			}
			if (message.expiresAt <= this.now()) {
				const receipt = await this.mailbox.setReceipt(messageId, "expired", fingerprint);
				await this.mailbox.removeHeld(messageId);
				return this.resultFor(messageId, receipt);
			}
			await this.serialDeliver(message);
			const receipt = await this.mailbox.setReceipt(messageId, "delivered", fingerprint);
			await this.mailbox.removeHeld(messageId);
			await this.mailbox.removeFromInbox(messageId, message.recipient);
			return this.resultFor(messageId, receipt);
		} finally {
			await release();
		}
	}
	async refuseHeld(messageId: string): Promise<PeerSendResult> {
		const candidate = await this.mailbox.getHeld(messageId);
		if (!candidate || !this.isLocalRecipient(candidate)) return { messageId, receipt: "unavailable" };
		const release = await this.mailbox.claim(messageId);
		if (!release) return this.resultFor(messageId, "held");
		try {
			const message = await this.mailbox.getHeld(messageId);
			if (!message) return this.resultFor(messageId, "unavailable");
			if (!this.isLocalRecipient(message)) return { messageId, receipt: "unavailable" };
			const binding = await this.mailbox.getBinding(messageId),
				fingerprint = peerMessageFingerprint(message);
			if (
				!binding ||
				binding.fingerprint !== fingerprint ||
				binding.sender.peerSessionId !== message.sender.peerSessionId ||
				binding.sender.runtimeId !== message.sender.runtimeId
			)
				throw new Error("Held message fingerprint does not match ingress binding");
			const receipt = await this.mailbox.setReceipt(messageId, "refused", fingerprint);
			await this.mailbox.removeHeld(messageId);
			await this.mailbox.removeFromInbox(messageId, message.recipient);
			return this.resultFor(messageId, receipt);
		} finally {
			await release();
		}
	}
	private isLocalRecipient(message: PeerMessage): boolean {
		return (
			message.recipient.peerSessionId === this.local.peerSessionId &&
			message.recipient.runtimeId === this.local.runtimeId
		);
	}
	private async serialDeliver(message: PeerMessage): Promise<void> {
		const next = this.deliveryQueue.then(() => this.delivery.deliver(message));
		this.deliveryQueue = next.catch(() => {});
		await next;
	}
	private deliveryQueue: Promise<void> = Promise.resolve();
	async receipt(messageId: string, receipt?: PeerReceipt): Promise<PeerSendResult> {
		if (receipt) await this.mailbox.setReceipt(messageId, receipt);
		return this.resultFor(messageId, (await this.mailbox.receiptState(messageId)) ?? "unavailable");
	}
	private async resultFor(messageId: string, fallback: PeerReceipt): Promise<PeerSendResult> {
		return { messageId, receipt: (await this.mailbox.receiptState(messageId)) ?? fallback };
	}
}
function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	const error = new Error("Peer message processing aborted");
	error.name = "AbortError";
	throw error;
}
function isTerminal(receipt: PeerReceipt | undefined): receipt is "delivered" | "refused" | "expired" {
	return receipt === "delivered" || receipt === "refused" || receipt === "expired";
}
