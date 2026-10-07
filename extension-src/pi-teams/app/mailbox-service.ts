// MailboxService — peer mailboxes (ADR 0007 §3, roadmap T3).
//
// Every participant (teammates + `lead`) has a directory
// `.pi/teams/t/<team-id>/inboxes/<name>/`; one JSON file per message written
// temp-then-rename (atomic, lock-free; a malformed entry never blocks the
// mailbox). Messages are HMAC-signed with the per-team key. App layer: fs is
// used directly like app/worktree-service.ts (ARCH-004 forbids pi imports,
// not node built-ins).

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MailboxMessage } from "../domain/mailbox.js";
import { isMailboxAddress, MAILBOX_TEXT_MAX_CHARS, parseMailboxMessage } from "../domain/mailbox.js";
import { signMessage, verifyMessageSignature } from "../shared/hmac.js";

export interface MailboxServiceOptions {
	teamDir: string;
	/** Per-team HMAC key (generated with the roster, distributed via bootstrap). */
	teamKey: string;
	/** This participant's address for outgoing messages. */
	self: string;
	now?: () => number;
	warn?: (message: string) => void;
}

/** One delivery attempt outcome for the send tool surface. */
export type MailboxSendResult = { delivered: true; id: string } | { delivered: false; error: string };

export class MailboxService {
	readonly teamDir: string;
	readonly inboxDir: string;
	private readonly teamKey: string;
	private readonly self: string;
	private readonly now: () => number;
	private readonly warn: (message: string) => void;

	constructor(options: MailboxServiceOptions) {
		if (!isMailboxAddress(options.self)) throw new Error("invalid mailbox participant address");
		this.teamDir = options.teamDir;
		this.inboxDir = join(options.teamDir, "inboxes", options.self);
		this.teamKey = options.teamKey;
		this.self = options.self;
		this.now = options.now ?? (() => Date.now());
		this.warn = options.warn ?? ((message) => console.warn(`[pi-teams] ${message}`));
	}

	/** Absolute path of one participant's mailbox. */
	mailboxOf(participant: string): string {
		return join(this.teamDir, "inboxes", participant);
	}

	/**
	 * Write one signed message file into the target's mailbox (atomic
	 * temp+rename, 0700 dir / 0600 file). Delivery is a filesystem fact: the
	 * recipient's watcher observes the rename and consumes the entry.
	 */
	send(target: string, text: string): MailboxSendResult {
		if (!isMailboxAddress(target)) return { delivered: false, error: "invalid recipient address" };
		if (text.length === 0 || text.length > MAILBOX_TEXT_MAX_CHARS) {
			return { delivered: false, error: `message text must be 1–${MAILBOX_TEXT_MAX_CHARS} characters` };
		}
		const message: MailboxMessage = {
			id: randomUUID(),
			from: this.self,
			to: target,
			text,
			sentAt: this.now(),
			hmac: "",
		};
		message.hmac = signMessage(this.teamKey, message);
		const mailbox = this.mailboxOf(target);
		const file = join(mailbox, `${message.sentAt}-${message.id}.json`);
		const temp = `${file}.${randomUUID()}.tmp`;
		try {
			mkdirSync(mailbox, { recursive: true, mode: 0o700 });
			writeFileSync(temp, JSON.stringify(message), { flag: "wx", mode: 0o600 });
			renameSync(temp, file);
			return { delivered: true, id: message.id };
		} catch (error) {
			try {
				unlinkSync(temp);
			} catch {
				// No temporary entry remains.
			}
			this.warn(`mailbox write to ${target} failed: ${error instanceof Error ? error.message : String(error)}`);
			return { delivered: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * Read the next pending entries from a mailbox, ordered by filename
	 * (timestamp-prefixed → arrival order). Malformed or badly signed entries
	 * are quarantined (`quarantine/` sibling directory) and never delivered.
	 */
	receive(limit = 16): MailboxMessage[] {
		const messages: MailboxMessage[] = [];
		let entries: string[] = [];
		try {
			entries = readdirSync(this.inboxDir)
				.filter((name) => name.endsWith(".json"))
				.sort();
		} catch {
			return messages;
		}
		for (const entry of entries) {
			if (messages.length >= limit) break;
			const file = join(this.inboxDir, entry);
			let message: MailboxMessage | undefined;
			try {
				message = parseMailboxMessage(JSON.parse(readFileSync(file, "utf8")));
				if (message && (message.to !== this.self || !verifyMessageSignature(this.teamKey, message, message.hmac)))
					message = undefined;
			} catch {
				message = undefined;
			}
			if (message) {
				messages.push(message);
				continue;
			}
			this.quarantine(file, entry);
		}
		return messages;
	}

	/** Remove a consumed entry; missing files are already consumed. */
	consume(message: MailboxMessage): void {
		const entries = (() => {
			try {
				return readdirSync(this.inboxDir).filter((name) => name.endsWith(".json"));
			} catch {
				return [];
			}
		})();
		for (const entry of entries) {
			try {
				const candidate = parseMailboxMessage(JSON.parse(readFileSync(join(this.inboxDir, entry), "utf8")));
				if (
					candidate?.id === message.id &&
					candidate.to === this.self &&
					verifyMessageSignature(this.teamKey, candidate, candidate.hmac) &&
					candidate.hmac === message.hmac
				)
					unlinkSync(join(this.inboxDir, entry));
			} catch {
				// A vanished/racy entry is already consumed.
			}
		}
	}

	/** Move an invalid entry aside — never a silent delete, never delivered. */
	private quarantine(file: string, entry: string): void {
		try {
			const dir = join(this.inboxDir, "quarantine");
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			renameSync(file, join(dir, entry));
			this.warn(`quarantined invalid mailbox entry ${entry} (bad JSON, shape or HMAC)`);
		} catch (error) {
			this.warn(
				`failed to quarantine invalid mailbox entry ${entry}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
}
