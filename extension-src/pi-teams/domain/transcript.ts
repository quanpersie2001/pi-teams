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
	/** Bounded native renderer details (diffs, truncation metadata, etc.). */
	details?: unknown;
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

/** Native display blocks only. Never send a clipped image to Pi's decoder. */
export type TranscriptResultBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Shared live/history projection. Caps allocations before cloning or serializing. */
export function boundedToolResult(
	content: unknown,
	details?: unknown,
): {
	result: TranscriptResultBlock[];
	details?: unknown;
	metadata?: Record<string, unknown>;
} {
	let truncated = false;
	let remaining = 32_768;
	const result: TranscriptResultBlock[] = [];
	const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
	if (Array.isArray(blocks)) {
		if (blocks.length > 64) truncated = true;
		for (const block of blocks.slice(0, 64)) {
			if (!block || typeof block !== "object") {
				truncated = true;
				continue;
			}
			if (block.type === "text" && typeof block.text === "string") {
				const text = block.text.slice(0, Math.min(8_192, remaining));
				remaining -= text.length;
				if (text.length !== block.text.length) truncated = true;
				result.push({ type: "text", text });
			} else if (
				block.type === "image" &&
				typeof block.data === "string" &&
				typeof block.mimeType === "string" &&
				/^image\/(png|jpeg|gif|webp)$/.test(block.mimeType) &&
				block.data.length <= Math.min(16_384, remaining) &&
				/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(block.data)
			) {
				remaining -= block.data.length;
				result.push({ type: "image", data: block.data, mimeType: block.mimeType });
			} else truncated = true;
		}
	} else if (content !== undefined) truncated = true;

	let nodes = 0;
	let detailBudget = 8_192;
	function clone(value: unknown, depth: number): unknown {
		if (++nodes > 64 || depth > 6 || detailBudget <= 0) {
			truncated = true;
			return "[truncated]";
		}
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string") {
			const text = value.slice(0, detailBudget);
			detailBudget -= text.length;
			if (text.length !== value.length) truncated = true;
			return text;
		}
		if (Array.isArray(value)) {
			const output: unknown[] = [];
			for (const item of value) {
				if (nodes >= 64 || detailBudget <= 0) {
					truncated = true;
					break;
				}
				output.push(clone(item, depth + 1));
			}
			return output;
		}
		if (value && typeof value === "object") {
			const output: Record<string, unknown> = Object.create(null);
			for (const key in value) {
				if (!Object.hasOwn(value, key)) continue;
				if (nodes >= 64 || key.length > detailBudget) {
					truncated = true;
					break;
				}
				detailBudget -= key.length;
				output[key] = clone((value as Record<string, unknown>)[key], depth + 1);
			}
			return output;
		}
		truncated = true;
		return null;
	}
	const safeDetails = details === undefined ? undefined : clone(details, 0);
	if (truncated) result.push({ type: "text", text: "[tool result truncated: content, image or details omitted]" });
	return {
		result,
		...(safeDetails === undefined ? {} : { details: safeDetails }),
		...(truncated ? { metadata: { resultTruncated: true } } : {}),
	};
}
