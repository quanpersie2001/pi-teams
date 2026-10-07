// Native session JSONL history/recovery reader.
//
// Live execution state and settlement come from authenticated child RPC/events.
// JSONL parsing reconstructs historical transcript and terminal recovery only;
// it must not be polled to control an active run. Filesystem reads only —
// process launch/ownership operations live in process-launchers.ts.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptItem } from "../domain/transcript.js";

interface JsonlMessageEntry {
	type?: string;
	timestamp?: string;
	message?: {
		role?: string;
		content?: unknown;
		stopReason?: string;
		errorMessage?: string;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
	};
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		const block = part as { type?: unknown; text?: unknown } | null;
		if (block?.type !== "text") continue;
		if (typeof block.text === "string" && block.text.trim().length > 0) parts.push(block.text.trim());
	}
	return parts.join("\n");
}

/**
 * A file matches when its `session_info` row carries the expected name.
 * Guards against stale sibling session files in shared directories.
 * No name filter (or no rows at all in the file) → match everything except
 * files that carry a DIFFERENT explicit name.
 */
function fileMatchesSessionName(content: string, sessionName?: string): boolean {
	if (!sessionName) return true;
	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		try {
			const entry = JSON.parse(line) as { type?: string; name?: string; session_info?: { name?: string } };
			if (entry.type === "session_info") {
				// A session_info row WITHOUT an explicit name is not exclusive:
				// only a DIFFERENT explicit name excludes the file.
				const found = entry.name ?? entry.session_info?.name;
				return found === undefined ? true : found === sessionName;
			}
		} catch {
			/* skip malformed JSONL rows */
		}
	}
	// No session_info row at all: nothing excludes the file.
	return true;
}

function listSessionFiles(sessionDir: string): string[] {
	if (!existsSync(sessionDir)) return [];
	try {
		return readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.sort()
			.map((f) => join(sessionDir, f));
	} catch {
		return [];
	}
}

function parseEntry(line: string): JsonlMessageEntry | undefined {
	try {
		return JSON.parse(line) as JsonlMessageEntry;
	} catch {
		return undefined;
	}
}

function entryTimestampMs(entry: JsonlMessageEntry): number {
	if (typeof entry.timestamp === "string") {
		const parsed = Date.parse(entry.timestamp);
		if (Number.isFinite(parsed)) return parsed;
	}
	return Date.now();
}

/**
 * Cheap change signature for a session directory: mtime+size of the newest
 * .jsonl file (no content read). The UI transcript adapter re-parses only
 * when this changes instead of re-reading on every repaint (reference
 * pi-task transcript.ts pattern). Empty string when nothing is readable.
 */
export function transcriptDirSignature(sessionDir: string): string {
	if (!existsSync(sessionDir)) return "";
	let files: string[] = [];
	try {
		files = readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.sort();
	} catch {
		return "";
	}
	if (files.length === 0) return "";
	try {
		const st = statSync(join(sessionDir, files[files.length - 1] as string));
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return "";
	}
}

/**
 * Normalize the persisted JSONL onto the shared TranscriptItem model so UI
 * surfaces treat interactive and headless history identically.
 */
export function readTranscriptItems(sessionDir: string, sessionName?: string): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	for (const filePath of listSessionFiles(sessionDir)) {
		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		if (!fileMatchesSessionName(content, sessionName)) continue;
		for (const rawLine of content.split("\n")) {
			const line = rawLine.trim();
			if (!line) continue;
			const entry = parseEntry(line);
			if (entry?.type !== "message") continue;
			const timestamp = entryTimestampMs(entry);
			const msg = entry.message;
			if (!msg) continue;

			if (msg.role === "user") {
				items.push({ kind: "user", timestamp, text: extractText(msg.content) });
				continue;
			}
			if (msg.role === "toolResult") {
				items.push({
					kind: "toolResult",
					timestamp,
					result: msg.content,
					isError: msg.isError === true,
					...(typeof msg.toolCallId === "string" ? { toolCallId: msg.toolCallId } : {}),
					...(typeof msg.toolName === "string" ? { toolName: msg.toolName } : {}),
				});
				continue;
			}
			if (msg.role !== "assistant") continue;
			const text = extractText(msg.content);
			if (text.length > 0) {
				items.push({
					kind: "assistant",
					timestamp,
					text,
					...(typeof msg.stopReason === "string" ? { metadata: { stopReason: msg.stopReason } } : {}),
				});
			}
			if (!Array.isArray(msg.content)) continue;
			for (const part of msg.content) {
				const block = part as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown } | null;
				if (block?.type !== "toolCall") continue;
				if (typeof block.id !== "string" || typeof block.name !== "string") continue;
				items.push({
					kind: "toolCall",
					timestamp,
					toolName: block.name,
					toolCallId: block.id,
					args: block.arguments,
				});
			}
		}
	}
	return items;
}
