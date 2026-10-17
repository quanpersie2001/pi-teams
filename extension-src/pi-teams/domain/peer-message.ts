import type { PeerAddress, PeerReceipt } from "./peer.js";
export interface PeerMessage {
	protocolVersion: 1;
	messageId: string;
	sender: PeerAddress;
	recipient: PeerAddress;
	body: string;
	createdAt: number;
	expiresAt: number;
}
export interface PeerSendResult {
	messageId: string;
	receipt: PeerReceipt;
}
export const PEER_LIMITS = {
	bodyBytes: 16 * 1024,
	pending: 100,
	ttlMs: 60 * 60 * 1000,
	futureSkewMs: 60_000,
	rateCount: 10,
	rateWindowMs: 10_000,
	retentionMs: 7 * 24 * 60 * 60 * 1000,
	metadataRecords: 10_000,
} as const;
export function validatePeerMessage(value: unknown): value is PeerMessage {
	if (!value || typeof value !== "object") return false;
	const m = value as Partial<PeerMessage>;
	return (
		m.protocolVersion === 1 &&
		typeof m.messageId === "string" &&
		m.messageId.length > 0 &&
		m.messageId.length <= 128 &&
		isAddress(m.sender) &&
		isAddress(m.recipient) &&
		typeof m.body === "string" &&
		Buffer.byteLength(m.body, "utf8") <= PEER_LIMITS.bodyBytes &&
		typeof m.createdAt === "number" &&
		typeof m.expiresAt === "number" &&
		Number.isFinite(m.createdAt) &&
		Number.isFinite(m.expiresAt) &&
		m.expiresAt > m.createdAt
	);
}
export function validateInboundPeerMessage(value: unknown, now = Date.now()): value is PeerMessage {
	return (
		validatePeerMessage(value) &&
		value.expiresAt > now &&
		value.createdAt <= now + PEER_LIMITS.futureSkewMs &&
		value.expiresAt <= value.createdAt + PEER_LIMITS.ttlMs
	);
}
export function peerMessageFingerprint(message: PeerMessage): string {
	return JSON.stringify([
		message.protocolVersion,
		message.messageId,
		message.sender.peerSessionId,
		message.sender.runtimeId,
		message.recipient.peerSessionId,
		message.recipient.runtimeId,
		message.body,
		message.createdAt,
		message.expiresAt,
	]);
}
function isAddress(a: unknown): a is PeerAddress {
	return (
		!!a &&
		typeof a === "object" &&
		typeof (a as PeerAddress).peerSessionId === "string" &&
		/^[\w.-]{1,128}$/.test((a as PeerAddress).peerSessionId) &&
		typeof (a as PeerAddress).runtimeId === "string" &&
		/^[\w.-]{1,128}$/.test((a as PeerAddress).runtimeId)
	);
}
