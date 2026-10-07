/**
 * Explicit IRC-style inbox message. This is independent of run completion,
 * result delivery and composer steering.
 */
export interface InboxMessage {
	id: string;
	ownerSessionId: string;
	from: MessageEndpoint;
	to: MessageEndpoint;
	text: string;
	createdAt: number;
	/** Set only after an authenticated live child acknowledges receipt. */
	deliveredAt?: number;
	consumedAt?: number;
}

export type MessageEndpoint = { kind: "parent" } | { kind: "agent"; agentId: string };

export type InboxRecipient = { kind: "parent"; sessionId: string } | { kind: "agent"; agentId: string };

/** Authenticated child-side inbox RPC. Sender identity is deliberately absent. */
export type ChildMessageRequest =
	| { action: "send"; target: MessageEndpoint; text: string }
	| { action: "list" }
	| { action: "consume"; messageId: string };

export type ChildMessageReply =
	| { action: "sent"; message: InboxMessage }
	| { action: "listed"; messages: readonly InboxMessage[] }
	| { action: "consumed"; message: InboxMessage };
