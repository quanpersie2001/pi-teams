import { randomUUID } from "node:crypto";
import type { AgentRun } from "../domain/agent-run.js";
import type {
	ChildMessageReply,
	ChildMessageRequest,
	InboxMessage,
	InboxRecipient,
	MessageEndpoint,
} from "../domain/message.js";

export interface MessageServiceOptions {
	getRun(agentId: string): AgentRun | undefined;
	/** Authenticated live-child hook. False means no live recipient; never revives one. */
	sendToChild(agentId: string, message: InboxMessage): Promise<boolean>;
	sendToParent?(message: InboxMessage): Promise<boolean>;
	idFactory?: () => string;
	now?: () => number;
	maxMessages?: number;
	maxConsumedHistory?: number;
}

const DEFAULT_MAX_MESSAGES = 1_000;
const DEFAULT_MAX_CONSUMED_HISTORY = 1_000;
const MAX_MESSAGE_LENGTH = 32_000;

function copyMessage(message: InboxMessage): InboxMessage {
	return { ...message, from: { ...message.from }, to: { ...message.to } };
}

/**
 * Process-local inbox service. Messages are inspectable for this extension host's
 * lifetime only; callers must not describe this queue as durable across restart.
 */
export class MessageService {
	private readonly messages: InboxMessage[] = [];
	private readonly agentScopes = new Map<string, string>();
	private readonly agentAliases = new Map<string, string>();
	private readonly idFactory: () => string;
	private readonly maxMessages: number;
	private readonly maxConsumedHistory: number;
	private readonly now: () => number;
	constructor(private readonly options: MessageServiceOptions) {
		this.idFactory = options.idFactory ?? randomUUID;
		this.now = options.now ?? Date.now;
		this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
		this.maxConsumedHistory = options.maxConsumedHistory ?? DEFAULT_MAX_CONSUMED_HISTORY;
		if (!Number.isInteger(this.maxMessages) || this.maxMessages < 1) {
			throw new Error("maxMessages must be a positive integer.");
		}
		if (!Number.isInteger(this.maxConsumedHistory) || this.maxConsumedHistory < 0) {
			throw new Error("maxConsumedHistory must be a non-negative integer.");
		}
	}

	async sendFromParent(sessionId: string, targetAgentId: string, text: string): Promise<InboxMessage> {
		if (!sessionId) throw new Error("A parent session is required to send an inbox message.");
		const target = this.requireTarget(targetAgentId, sessionId);
		this.agentScopes.set(target.id, sessionId);
		this.agentScopes.set(targetAgentId, sessionId);
		return this.deliver({ kind: "parent" }, { kind: "agent", agentId: targetAgentId }, sessionId, text);
	}
	/** senderAgentId MUST come from the authenticated child transport, never a caller payload. */
	async sendFromAgent(senderAgentId: string, target: MessageEndpoint, text: string): Promise<InboxMessage> {
		const sender = this.options.getRun(senderAgentId);
		if (!sender) throw new Error(`Agent "${senderAgentId}" is not known.`);
		const ownerSessionId = this.ownerSession(sender);
		if (!ownerSessionId) throw new Error(`Agent "${senderAgentId}" has no parent session scope for messaging.`);
		this.agentScopes.set(senderAgentId, ownerSessionId);
		if (target.kind === "agent") {
			const targetRun = this.requireTarget(target.agentId, ownerSessionId);
			this.agentScopes.set(targetRun.id, ownerSessionId);
			this.agentScopes.set(target.agentId, ownerSessionId);
		}
		return this.deliver({ kind: "agent", agentId: senderAgentId }, target, ownerSessionId, text);
	}
	/** Handle a child inbox RPC after its childId has been authenticated by transport. */
	async handleChildMessage(agentId: string, request: ChildMessageRequest): Promise<ChildMessageReply> {
		if (request.action === "send") {
			const message = await this.sendFromAgent(agentId, request.target, request.text);
			return { action: "sent", message };
		}
		if (request.action === "list") {
			return { action: "listed", messages: this.listInbox({ kind: "agent", agentId }) };
		}
		const message = this.consumeInbox({ kind: "agent", agentId }, request.messageId);
		return { action: "consumed", message };
	}

	/** List all messages visible to this recipient, including already consumed history. */
	listMessages(recipient: InboxRecipient): readonly InboxMessage[] {
		return this.messages.filter((message) => this.isRecipient(message, recipient)).map(copyMessage);
	}

	/** Return pending inbox entries in arrival order. */
	listInbox(recipient: InboxRecipient): readonly InboxMessage[] {
		return this.messages
			.filter((message) => message.consumedAt === undefined && this.isRecipient(message, recipient))
			.map(copyMessage);
	}
	/** Parent-session view of its complete message thread, including sent and sibling traffic. */
	listSessionMessages(sessionId: string): readonly InboxMessage[] {
		if (!sessionId) throw new Error("A parent session is required to inspect inbox messages.");
		return this.messages.filter((message) => message.ownerSessionId === sessionId).map(copyMessage);
	}

	consumeInbox(recipient: InboxRecipient, messageId: string): InboxMessage {
		const message = this.messages.find(
			(candidate) =>
				candidate.id === messageId && candidate.consumedAt === undefined && this.isRecipient(candidate, recipient),
		);
		if (!message) throw new Error(`Inbox message "${messageId}" is unavailable to this recipient.`);
		message.consumedAt = this.now();
		this.trimConsumedHistory();
		return copyMessage(message);
	}
	private trimConsumedHistory(): void {
		while (this.messages.filter((message) => message.consumedAt !== undefined).length > this.maxConsumedHistory) {
			const oldest = this.messages.findIndex((message) => message.consumedAt !== undefined);
			if (oldest < 0) return;
			this.messages.splice(oldest, 1);
		}
	}

	private async deliver(
		from: MessageEndpoint,
		to: MessageEndpoint,
		ownerSessionId: string,
		text: string,
	): Promise<InboxMessage> {
		if (typeof text !== "string" || text.trim().length === 0) throw new Error("Message text must not be empty.");
		if (text.length > MAX_MESSAGE_LENGTH) {
			throw new Error(`Inbox message exceeds the ${MAX_MESSAGE_LENGTH}-character limit.`);
		}
		if (this.messages.filter((entry) => entry.consumedAt === undefined).length >= this.maxMessages) {
			throw new Error(`Pending inbox limit (${this.maxMessages}) reached; consume pending messages before sending.`);
		}
		const message: InboxMessage = {
			id: this.idFactory(),
			ownerSessionId,
			from,
			to,
			text,
			createdAt: this.now(),
		};
		this.messages.push(message);
		if (from.kind === "agent") this.agentScopes.set(from.agentId, ownerSessionId);
		if (to.kind === "agent") {
			this.agentScopes.set(to.agentId, ownerSessionId);
			// An absent/closed child receives a retained inbox item without warm revival.
			await this.deliverToChild(message, this.resolveAgent(to.agentId));
		} else if (this.options.sendToParent) {
			try {
				if (await this.options.sendToParent(copyMessage(message))) message.deliveredAt = this.now();
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				throw new Error(`Inbox message ${message.id} was queued, but live delivery failed: ${reason}`);
			}
		}
		return copyMessage(message);
	}

	/** Retry retained entries after a child process becomes available. */
	async deliverPending(agentId: string): Promise<void> {
		const recipientId = this.resolveAgent(agentId);
		const run = this.options.getRun(recipientId);
		const ownerSessionId = this.ownerSession(run);
		if (!run || !ownerSessionId) return;
		for (const message of this.messages) {
			if (
				message.consumedAt === undefined &&
				message.deliveredAt === undefined &&
				message.to.kind === "agent" &&
				this.resolveAgent(message.to.agentId) === recipientId &&
				message.ownerSessionId === ownerSessionId
			) {
				await this.deliverToChild(message, recipientId);
			}
		}
	}

	private async deliverToChild(message: InboxMessage, agentId: string): Promise<void> {
		let delivered: boolean;
		try {
			delivered = await this.options.sendToChild(agentId, {
				...copyMessage(message),
				to: { kind: "agent", agentId },
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`Inbox message ${message.id} was queued, but live delivery failed: ${reason}`);
		}
		if (delivered) message.deliveredAt = this.now();
	}

	private requireTarget(agentId: string, ownerSessionId: string): AgentRun {
		const resolvedAgentId = this.resolveAgent(agentId);
		const target = this.options.getRun(resolvedAgentId);
		if (!target) throw new Error(`Agent "${agentId}" was not found.`);
		if (this.ownerSession(target) !== ownerSessionId) {
			throw new Error(`Agent "${agentId}" is outside this parent session and cannot receive messages.`);
		}
		return target;
	}

	private ownerSession(run: AgentRun | undefined): string | undefined {
		if (!run) return undefined;
		return run.parentSession?.sessionId ?? (run.owner.kind === "conversation" ? run.owner.sessionId : undefined);
	}
	/** Alias pending messages to an explicitly resumed continuation without changing message IDs/endpoints. */
	async continueInbox(oldAgentId: string, newAgentId: string): Promise<void> {
		const oldRun = this.options.getRun(oldAgentId);
		const newRun = this.options.getRun(newAgentId);
		const retainedMessages = this.messages.some(
			(message) =>
				(message.from.kind === "agent" && message.from.agentId === oldAgentId) ||
				(message.to.kind === "agent" && message.to.agentId === oldAgentId),
		);
		const oldScope = this.ownerSession(oldRun) ?? this.agentScopes.get(oldAgentId);
		if (!retainedMessages && oldScope === undefined) return;
		if (!newRun) throw new Error("The continuation agent must exist.");
		const ownerSessionId = oldScope;
		if (!ownerSessionId || this.ownerSession(newRun) !== ownerSessionId) {
			throw new Error("Inbox continuation must remain within the original parent session.");
		}
		this.agentAliases.set(oldAgentId, newAgentId);
		this.agentScopes.set(oldAgentId, ownerSessionId);
		this.agentScopes.set(newAgentId, ownerSessionId);
		for (const message of this.messages) {
			if (
				message.consumedAt === undefined &&
				message.to.kind === "agent" &&
				this.resolveAgent(message.to.agentId) === newAgentId
			) {
				delete message.deliveredAt;
				await this.deliverToChild(message, newAgentId);
			}
		}
	}

	private resolveAgent(agentId: string): string {
		let resolved = agentId;
		for (let remaining = this.agentAliases.size; remaining > 0; remaining--) {
			const next = this.agentAliases.get(resolved);
			if (!next) break;
			resolved = next;
		}
		return resolved;
	}

	private isRecipient(message: InboxMessage, recipient: InboxRecipient): boolean {
		if (recipient.kind === "parent") {
			return message.to.kind === "parent" && message.ownerSessionId === recipient.sessionId;
		}
		const recipientId = this.resolveAgent(recipient.agentId);
		const currentScope = this.ownerSession(this.options.getRun(recipientId));
		const knownScope = currentScope ?? this.agentScopes.get(recipient.agentId);
		return (
			message.to.kind === "agent" &&
			this.resolveAgent(message.to.agentId) === recipientId &&
			knownScope === message.ownerSessionId
		);
	}
}
