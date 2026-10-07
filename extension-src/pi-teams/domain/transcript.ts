// Normalized child-RPC transcript projection, also used by durable history.

export type TranscriptItemKind = "user" | "assistant" | "toolCall" | "toolResult" | "system";

/** One normalized, backend-agnostic transcript entry. */
export interface TranscriptItem {
	kind: TranscriptItemKind;
	/** Stable identity across streamed revisions and reconnect snapshots. */
	id?: string;
	/** Monotonic revision for upserting partial content with the same id. */
	revision?: number;
	/** True while the native Pi message is still streaming. */
	partial?: boolean;
	/** Epoch ms when the entry occurred. */
	timestamp: number;
	/** Plain text content (message text, system notice). */
	text?: string;
	/** Tool name for toolCall/toolResult entries. */
	toolName?: string;
	/** Correlates a toolResult with its originating toolCall. */
	toolCallId?: string;
	/** Parsed tool-call arguments (JSON-safe). */
	args?: unknown;
	/** Tool result payload (JSON-safe); error payload when isError is true. */
	result?: unknown;
	/** True when a toolResult represents a failed tool execution. */
	isError?: boolean;
	/** Backend-specific extras that survived normalization. */
	metadata?: Record<string, unknown>;
}

/**
 * Immutable transcript projection. `cursor` is the absolute ordinal after the
 * latest item; bounded tails identify their first retained item with `offset`.
 */
export interface TranscriptSnapshot {
	items: readonly TranscriptItem[];
	cursor: number;
	/** Absolute ordinal of the first retained item; zero for complete history. */
	offset?: number;
	/** Some earlier content or individual payloads were omitted from the projection. */
	truncated?: boolean;
}

export function emptyTranscriptSnapshot(): TranscriptSnapshot {
	return { items: [], cursor: 0 };
}

/** Items recorded after the given cursor position. */
export function transcriptItemsAfter(snapshot: TranscriptSnapshot, cursor: number): TranscriptItem[] {
	return snapshot.items.slice(Math.max(0, cursor - (snapshot.offset ?? 0)));
}
