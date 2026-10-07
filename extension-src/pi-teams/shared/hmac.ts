// HMAC signing/verification for peer mailbox messages (ADR 0007 §3).
//
// Pure computation over a per-team key distributed through the authenticated
// bootstrap; comparison is constant-time. shared/ stays host-independent
// (ARCH-001) — node:crypto is computation, not host I/O.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Canonical signed payload: exact JSON with fixed field order. */
export function canonicalMessagePayload(message: {
	id: string;
	from: string;
	to: string;
	text: string;
	sentAt: number;
}): string {
	return JSON.stringify([message.id, message.from, message.to, message.text, message.sentAt]);
}

/** Hex HMAC-SHA256 of the canonical payload under the per-team key. */
export function signMessage(key: string, message: Parameters<typeof canonicalMessagePayload>[0]): string {
	return createHmac("sha256", key).update(canonicalMessagePayload(message)).digest("hex");
}

/**
 * Constant-time signature check. Hex-encoded signatures must be 64 chars;
 * malformed lengths simply fail (never throw, never leak timing).
 */
export function verifyMessageSignature(
	key: string,
	message: Parameters<typeof canonicalMessagePayload>[0],
	signature: string,
): boolean {
	if (signature.length !== 64 || !/^[0-9a-f]+$/.test(signature)) return false;
	const expected = Buffer.from(signMessage(key, message), "hex");
	const given = Buffer.from(signature, "hex");
	return expected.byteLength === given.byteLength && timingSafeEqual(expected, given);
}
