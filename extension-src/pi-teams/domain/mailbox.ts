// Mailbox message contracts (ADR 0007 §3).
//
// Every participant — teammates and the lead — has a mailbox directory
// `.pi/teams/t/<team-id>/inboxes/<name>/`; one JSON file per message, written
// temp-then-rename. Messages are HMAC-signed with the per-team key; invalid
// entries are quarantined, never delivered. Pure module.

/** Durable shape of one mailbox file. */
export interface MailboxMessage {
	id: string;
	/** Sender address: teammate name or `lead`. */
	from: string;
	/** Recipient address: teammate name or `lead`. */
	to: string;
	text: string;
	sentAt: number;
	/** Hex HMAC-SHA256 over the canonical payload (shared/hmac.ts). */
	hmac: string;
}

/** Participant addresses are single filesystem-safe path components. */
export function isMailboxAddress(value: unknown): value is string {
	return typeof value === "string" && value.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

/** Upper bound for mailbox text; longer sends are rejected, not truncated. */
export const MAILBOX_TEXT_MAX_CHARS = 32_000;

/** Parse + structurally validate a mailbox file; undefined when malformed. */
export function parseMailboxMessage(value: unknown): MailboxMessage | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (
		typeof raw.id !== "string" ||
		raw.id.length === 0 ||
		!isMailboxAddress(raw.from) ||
		!isMailboxAddress(raw.to) ||
		typeof raw.text !== "string" ||
		typeof raw.sentAt !== "number" ||
		!Number.isSafeInteger(raw.sentAt) ||
		typeof raw.hmac !== "string"
	) {
		return undefined;
	}
	if (raw.text.length === 0 || raw.text.length > MAILBOX_TEXT_MAX_CHARS) return undefined;
	return {
		id: raw.id,
		from: raw.from,
		to: raw.to,
		text: raw.text,
		sentAt: raw.sentAt,
		hmac: raw.hmac,
	};
}

/**
 * The message text injected into a recipient's conversation: sender-labelled,
 * so the model always sees provenance even though delivery is runtime-trusted.
 */
export function formatMailboxMessageForInjection(message: MailboxMessage): string {
	return `Message from @${message.from}:\n\n${message.text}`;
}
