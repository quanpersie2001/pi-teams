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
	membershipId?: string;
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

interface ParticipantAvailability {
	state?: "idle" | "busy" | "released" | "retired";
	availability?: "available" | "unavailable";
	membershipId?: string;
	operation?: string;
	recoveryError?: string;
}

function participantAvailability(teamDir: string): Map<string, ParticipantAvailability> {
	try {
		const roster: unknown = JSON.parse(readFileSync(join(teamDir, "config.json"), "utf8"));
		if (typeof roster !== "object" || roster === null || !Array.isArray((roster as { members?: unknown }).members))
			return new Map();
		const members = (roster as { members: unknown[] }).members;
		const participants = new Map<string, ParticipantAvailability>([["lead", {}]]);
		for (const member of members) {
			if (typeof member !== "object" || member === null) continue;
			const entry = member as {
				name?: unknown;
				lifecycle?: unknown;
				availability?: unknown;
				membershipId?: unknown;
				operation?: unknown;
				recoveryError?: unknown;
			};
			if (!isMailboxAddress(entry.name) || entry.name === "lead") continue;
			participants.set(entry.name, {
				...(typeof entry.membershipId === "string" ? { membershipId: entry.membershipId } : {}),
				...(typeof entry.operation === "object" && entry.operation !== null ? { operation: "shutting_down" } : {}),
				...(entry.lifecycle === "idle" ||
				entry.lifecycle === "busy" ||
				entry.lifecycle === "released" ||
				entry.lifecycle === "retired"
					? { state: entry.lifecycle }
					: {}),
				...(entry.availability === "available" || entry.availability === "unavailable"
					? { availability: entry.availability }
					: {}),
				...(typeof entry.recoveryError === "string" ? { recoveryError: entry.recoveryError } : {}),
			});
		}
		return participants;
	} catch {
		return new Map();
	}
}

function result(text: string, details?: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

/** Watch/drain this participant's file mailbox after native bridge startup. */
export function watchChildMailbox(options: ChildMailboxOptions): ChildMailboxHandle {
	const warn = options.warn ?? ((message: string) => console.warn(`[pi-teams] ${message}`));
	const service = new MailboxService({
		teamDir: options.teamDir,
		teamKey: options.teamKey,
		self: options.self,
		...(options.membershipId !== undefined ? { selfMembershipId: options.membershipId } : {}),
		warn,
	});
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
				if (options.membershipId !== undefined) {
					const self = participantAvailability(options.teamDir).get(options.self);
					if (!self || self.membershipId !== options.membershipId || self.operation === "shutting_down") {
						warn(`mailbox stopped: membership incarnation for @${options.self} is no longer current`);
						closed = true;
						break;
					}
				}
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
			if (!isMailboxAddress(args.target))
				return result(`Unknown teammate: ${args.target}`, { target: args.target, queued: false });
			const participant = participantAvailability(service.teamDir).get(args.target);
			if (!participant) return result(`Unknown teammate: ${args.target}`, { target: args.target, queued: false });
			if (
				participant.state === "released" ||
				participant.state === "retired" ||
				participant.operation === "shutting_down" ||
				participant.availability === "unavailable"
			) {
				const reason = participant.recoveryError ? `: ${participant.recoveryError}` : "";
				const blockedAs =
					participant.state === "released" || participant.state === "retired" ? participant.state : "unavailable";
				return result(
					`Message not sent: @${args.target} is ${blockedAs}${participant.state ? ` (state ${participant.state})` : ""}${reason}.`,
					{
						target: args.target,
						state: participant.state,
						availability: participant.availability,
						queued: false,
					},
				);
			}
			const sent = service.send(args.target, args.message, participant.membershipId);
			return result(sent.delivered ? `Message queued for @${args.target}.` : `Message not sent: ${sent.error}`);
		},
	});
}
