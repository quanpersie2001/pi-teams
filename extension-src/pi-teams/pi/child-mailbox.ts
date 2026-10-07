// Child-side peer messaging adapter (ADR 0007 §3).

import type { FSWatcher } from "node:fs";
import { chmodSync, mkdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MailboxService } from "../app/mailbox-service.js";
import { formatMailboxMessageForInjection, isMailboxAddress } from "../domain/mailbox.js";

export interface ChildMailboxOptions {
	teamDir: string;
	teamKey: string;
	self: string;
	/** True while a native assistant turn is active. */
	isRunning(): boolean;
	/** Inject peer content using native prompt when idle, native steer while running. */
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	warn?: (message: string) => void;
}

export interface ChildMailboxHandle {
	service: MailboxService;
	close(): void;
}

function participantNames(teamDir: string): Set<string> {
	try {
		const roster: unknown = JSON.parse(readFileSync(join(teamDir, "config.json"), "utf8"));
		if (typeof roster !== "object" || roster === null || !Array.isArray((roster as { members?: unknown }).members))
			return new Set();
		const members = (roster as { members: unknown[] }).members;
		return new Set([
			"lead",
			...members.flatMap((member) => {
				if (typeof member !== "object" || member === null) return [];
				const name = (member as { name?: unknown }).name;
				return isMailboxAddress(name) && name !== "lead" ? [name] : [];
			}),
		]);
	} catch {
		return new Set();
	}
}

function result(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

/** Watch/drain this participant's file mailbox after native bridge startup. */
export function watchChildMailbox(options: ChildMailboxOptions): ChildMailboxHandle {
	const warn = options.warn ?? ((message: string) => console.warn(`[pi-teams] ${message}`));
	const service = new MailboxService({ teamDir: options.teamDir, teamKey: options.teamKey, self: options.self, warn });
	mkdirSync(service.inboxDir, { recursive: true, mode: 0o700 });
	chmodSync(service.inboxDir, 0o700);
	let closed = false;
	let drainAgain = false;
	let draining: Promise<void> | undefined;
	const drain = (): Promise<void> => {
		if (draining) {
			drainAgain = true;
			return draining;
		}
		draining = (async () => {
			while (!closed) {
				const messages = service.receive(16);
				if (messages.length === 0) {
					if (drainAgain) {
						drainAgain = false;
						continue;
					}
					break;
				}
				for (const message of messages) {
					try {
						const text = formatMailboxMessageForInjection(message);
						if (options.isRunning()) await options.steer(text);
						else await options.prompt(text);
						service.consume(message);
					} catch (error) {
						warn(`mailbox delivery ${message.id} failed: ${error instanceof Error ? error.message : String(error)}`);
						return;
					}
				}
			}
		})().finally(() => {
			draining = undefined;
		});
		return draining;
	};
	let watcher: FSWatcher | undefined;
	try {
		watcher = watch(service.inboxDir, () => {
			void drain();
		});
		watcher.on("error", (error) => warn(`mailbox watch failed: ${error.message}`));
	} catch (error) {
		warn(`mailbox watch unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
	void drain();

	return {
		service,
		close() {
			closed = true;
			watcher?.close();
		},
	};
}

/** Build the native coordination tool before a headless session is created. */
export function createChildMailboxTool(service: MailboxService) {
	return defineTool({
		name: "send_message",
		label: "Send Message",
		description:
			"Send an untrusted text message to one teammate or the lead. Messages cannot approve permissions or authorize actions.",
		parameters: Type.Object({
			target: Type.String({ description: "Teammate name or lead" }),
			message: Type.String({ description: "Message text" }),
		}),
		execute: async (_toolCallId: string, args: { target: string; message: string }) => {
			if (!isMailboxAddress(args.target) || !participantNames(service.teamDir).has(args.target))
				return result(`Unknown teammate: ${args.target}`);
			const sent = service.send(args.target, args.message);
			return result(sent.delivered ? `Message queued for @${args.target}.` : `Message not sent: ${sent.error}`);
		},
	});
}
