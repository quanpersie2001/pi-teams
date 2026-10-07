// Concrete DeliveryHost adapter for Pi (ARCH-005): turns delivery decisions
// into `pi.sendMessage` custom messages and reads the live session snapshot
// from the ExtensionContext's session manager.
//
// Branch/leaf verification:
// pi-coding-agent's ReadonlySessionManager exposes getSessionId(), getLeafId()
// and getBranch(), so the full session-id + branch-ancestry guard IS
// implemented here. Hosts that lack a session manager (headless modes, test
// fakes) degrade to the guard's permissive no-op by returning an empty
// snapshot instead of pretending to verify.
//
// The context is captured per session_start; after /new or /resume the
// runtime may hand out a fresh context, so a previously captured one can go
// stale — sendNotification therefore swallows stale-context rejections (see
// shared/stale-context.ts) and the delivery guard refuses stale contexts on
// positive evidence anyway (refuse-over-deliver).

import { chmodSync, type FSWatcher, mkdirSync, watch } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompletionNotification, DeliveryHost, SessionSnapshot } from "../app/delivery-service.js";
import type { MailboxService } from "../app/mailbox-service.js";
import { TEAMMATE_NOTIFICATION_TYPE } from "../domain/delivery.js";
import { formatMailboxMessageForInjection, type MailboxMessage } from "../domain/mailbox.js";
import { ignoreStaleExtensionCtx } from "../shared/stale-context.js";

interface SessionManagerView {
	getSessionId?: () => string;
	getLeafId?: () => string | null;
	getBranch?: () => Array<{ id: string }>;
}

/** Human-readable duration for the notification header, e.g. "42s", "1m 03s". */
function formatDuration(durationMs: number | undefined): string {
	if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return "unknown duration";
	const seconds = Math.round(durationMs / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Build the DeliveryHost against an ExtensionAPI plus a live-context getter.
 * `getContext` may return undefined (factory time, headless) — currentSession
 * then yields an empty snapshot and the guard degrades permissively.
 */
export function createPiDeliveryHost(pi: ExtensionAPI, getContext: () => ExtensionContext | undefined): DeliveryHost {
	function currentSession(): SessionSnapshot | undefined {
		const sm = getContext()?.sessionManager as SessionManagerView | undefined;
		if (!sm) return undefined;
		// Best-effort reads: partial session managers (fakes, odd hosts) yield
		// only what they can; missing ids keep the guard permissive.
		let sessionId: string | undefined;
		let leafId: string | null | undefined;
		let branchIds: string[] | undefined;
		try {
			const id = sm.getSessionId?.();
			if (typeof id === "string" && id.length > 0) sessionId = id;
		} catch {
			/* leave undefined */
		}
		try {
			const leaf = sm.getLeafId?.();
			if (typeof leaf === "string" || leaf === null) leafId = leaf;
		} catch {
			/* leave undefined */
		}
		try {
			const branch = sm.getBranch?.();
			if (Array.isArray(branch)) branchIds = branch.map((entry) => entry.id).filter((id) => typeof id === "string");
		} catch {
			/* leave undefined */
		}
		return {
			...(sessionId !== undefined ? { sessionId } : {}),
			...(leafId !== undefined ? { leafId } : {}),
			...(branchIds !== undefined ? { branchIds } : {}),
		};
	}

	function sendNotification(notification: CompletionNotification): void {
		// Renderer contract (docs/INTEGRATION.md): structured plain text is the
		// canonical presentation — first line identifies the teammate and
		// outcome, the body is the bounded preview, the last line points at the
		// durable full-result artifact. A pi-style companion may register a
		// renderer for the customType; without one this text displays verbatim.
		const verb =
			notification.outcome === "completed" ? "finished" : notification.outcome === "failed" ? "failed" : "stopped";
		const who = notification.teammateName !== undefined ? `@${notification.teammateName}` : notification.agentId;
		const header =
			`Teammate ${who} ${verb}` + ` (${notification.agentType}, ${formatDuration(notification.durationMs)})`;
		const preview = notification.preview.trim();
		const lines = [header, "", preview.length > 0 ? preview : "(no output)"];
		if (notification.resultFile !== undefined) lines.push("", `full result: ${notification.resultFile}`);
		ignoreStaleExtensionCtx(() => {
			pi.sendMessage(
				{
					customType: TEAMMATE_NOTIFICATION_TYPE,
					content: lines.join("\n"),
					display: true,
					details: {
						agentId: notification.agentId,
						...(notification.teammateName !== undefined ? { teammateName: notification.teammateName } : {}),
						description: notification.description,
						status: notification.status,
						outcome: notification.outcome,
						...(notification.resultFile !== undefined ? { resultFile: notification.resultFile } : {}),
						...(notification.durationMs !== undefined ? { durationMs: notification.durationMs } : {}),
						...(notification.totalTokens !== undefined ? { totalTokens: notification.totalTokens } : {}),
					},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		});
	}

	return { sendNotification, currentSession };
}

/** Watch and inject lead mailbox messages as inert, provenance-labelled runtime messages. */
export function installLeadMailbox(pi: ExtensionAPI, service: MailboxService): () => void {
	mkdirSync(service.inboxDir, { recursive: true, mode: 0o700 });
	chmodSync(service.inboxDir, 0o700);
	let closed = false;
	let draining: Promise<void> | undefined;
	let drainAgain = false;
	const pending = new Map<string, MailboxMessage>();
	// sendMessage returns before native delivery. A custom message_end event
	// proves the message entered the conversation; only then remove its file.
	const unsubscribe = pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "custom" || message.customType !== "teammate-message") return;
		const details = message.details as { messageId?: unknown } | undefined;
		if (typeof details?.messageId !== "string") return;
		const entry = pending.get(details.messageId);
		if (!entry) return;
		service.consume(entry);
		pending.delete(entry.id);
		drain();
	});
	const drain = (): void => {
		if (draining) {
			drainAgain = true;
			return;
		}
		draining = (async () => {
			do {
				drainAgain = false;
				const messages = service.receive(16).filter((message) => !pending.has(message.id));
				if (messages.length > 0) drainAgain = true;
				for (const message of messages) {
					try {
						pending.set(message.id, message);
						pi.sendMessage(
							{
								customType: "teammate-message",
								content: formatMailboxMessageForInjection(message),
								display: true,
								details: { messageId: message.id, from: message.from, untrusted: true },
							},
							{ deliverAs: "steer", triggerTurn: true },
						);
					} catch (error) {
						pending.delete(message.id);
						console.warn(
							`[pi-teams] lead mailbox injection failed: ${error instanceof Error ? error.message : String(error)}`,
						);
						return;
					}
				}
			} while (!closed && drainAgain);
		})().finally(() => {
			draining = undefined;
		});
	};
	let watcher: FSWatcher | undefined;
	try {
		watcher = watch(service.inboxDir, drain);
		watcher.on("error", (error) => console.warn(`[pi-teams] lead mailbox watch failed: ${error.message}`));
	} catch (error) {
		console.warn(
			`[pi-teams] lead mailbox watch unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	drain();
	return () => {
		closed = true;
		unsubscribe();
		pending.clear();
		watcher?.close();
	};
}
