// Domain contracts for run ownership and result delivery policy.
//
// Ownership answers "who spawned this run"; delivery answers "where may the
// result surface". Neither carries any task-domain semantics — an extension
// owner's `ref` is routing/audit metadata only.

/** Where a completed run's output may be delivered. */
export type DeliveryPolicy = "conversation" | "event" | "both" | "none";

/**
 * Owner of an AgentRun:
 * - `conversation`: spawned directly from a Pi session; direct notification
 *   must never land in any other session.
 * - `extension`: spawned programmatically (e.g. pi-tasks); receives lifecycle
 *   events even after the spawning conversation is gone or switched.
 */
export type AgentOwner = { kind: "conversation"; sessionId: string } | { kind: "extension"; id: string; ref?: string };

/** Reference to the parent conversation a run was spawned from. */
export interface ParentSessionRef {
	sessionId: string;
	/** Leaf node when the parent was on a `/tree` branch at spawn time. */
	leafId?: string;
}

/** Type guard narrowing a conversation owner. */
export function isConversationOwner(owner: AgentOwner): owner is Extract<AgentOwner, { kind: "conversation" }> {
	return owner.kind === "conversation";
}

/** Type guard narrowing an extension owner. */
export function isExtensionOwner(owner: AgentOwner): owner is Extract<AgentOwner, { kind: "extension" }> {
	return owner.kind === "extension";
}

/**
 * pi.sendMessage customType for runtime-authored teammate completion
 * notifications (renderer contract, docs/INTEGRATION.md): `content` is
 * structured plain text (first line `Teammate <id|@name>
 * finished|failed|stopped (<type>, <duration>)`, preview body, final
 * `full result: <path>` line) and `details` is the machine-readable schema.
 * A pi-style host may register a renderer for this type; without one the
 * plain text displays verbatim. The runtime ships no renderer.
 */
export const TEAMMATE_NOTIFICATION_TYPE = "teammate-notification";
