// Immutable UI snapshot builders (ARCH-008).
//
// Pure projection of AgentManager state (plus injected transcript stats)
// onto the domain/ui-view.ts contracts. No I/O here: transcript reads happen
// in the pi/ transcript adapter and arrive as plain TranscriptItem arrays.
//
// Ordering mirrors the reference panel model: active runs first in spawn
// order, then finished runs newest-first — so the cursor follows a run when
// the list reorders and completions surface at the top of the settled block.

import type { AgentRun } from "../domain/agent-run.js";
import { isTerminalStatus } from "../domain/agent-run.js";
import type { TranscriptItem } from "../domain/transcript.js";
import type { AgentListRow, AgentListView, AgentTranscriptView } from "../domain/ui-view.js";
import { deriveCapabilities, deriveResourceState, ownerRefLabel } from "../domain/ui-view.js";

/** Default tail window for transcript views (~400 items, reference scale). */
export const TRANSCRIPT_TAIL_ITEMS = 400;

export interface BuildAgentListViewOptions {
	now?: () => number;
	/** Rows dismissed from the panel by the user (finished runs). */
	dismissedIds?: ReadonlySet<string>;
	/** Latest bounded transcript preview; counters remain authoritative per-run data. */
	activityByRunId?: ReadonlyMap<string, string>;
}

/** Project one run record onto a panel row. Exported for direct testing. */
export function agentRowFromRecord(
	record: AgentRun,
	options: { activity?: string; attachable?: boolean; now: number },
): AgentListRow {
	const capabilities = deriveCapabilities({
		status: record.status,
		hasHandle: record.handle !== undefined,
		hasSessionFile: typeof record.sessionFile === "string" && record.sessionFile.length > 0,
		attachable: options.attachable ?? false,
	});
	const row: AgentListRow = {
		id: record.id,
		type: record.type,
		description: record.description,
		status: record.status,
		backend: record.backend,
		resourceState: deriveResourceState(record.status, record.handle !== undefined),
		startedAt: record.startedAt,
		...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
		toolUses: record.toolUses,
		turns: record.turns,
		isBackground: record.isBackground === true,
		capabilities,
	};
	// A continuation appends to the same JSONL; settled rows keep their own outcome.
	const activity = isTerminalStatus(record.status)
		? previewLine(record.result ?? record.error ?? "", 64)
		: options.activity;
	if (activity !== undefined && activity.length > 0) row.activity = activity;
	const branch = record.worktreeResult?.branch ?? record.worktree?.branch;
	if (branch !== undefined) row.branch = branch;
	const ownerRef = ownerRefLabel(record.owner);
	if (ownerRef !== undefined) row.ownerRef = ownerRef;
	return row;
}

/**
 * Build the immutable panel snapshot: active runs first (spawn order), then
 * terminal runs newest-first. Dismissed finished rows are hidden; dismissing
 * never touches manager state.
 */
export function buildAgentListView(
	manager: {
		list(): AgentRun[];
		canAttachPane?(agentId: string): boolean;
	},
	options: BuildAgentListViewOptions = {},
): AgentListView {
	const now = options.now?.() ?? Date.now();
	const dismissed = options.dismissedIds;
	const activityByRunId = options.activityByRunId;

	const active: AgentListRow[] = [];
	const finished: AgentListRow[] = [];
	for (const record of manager.list()) {
		if (isTerminalStatus(record.status) && dismissed?.has(record.id)) continue;
		const activity = activityByRunId?.get(record.id);
		const attachable = manager.canAttachPane?.(record.id) ?? false;
		const row = agentRowFromRecord(record, {
			...(activity !== undefined ? { activity } : {}),
			attachable,
			now,
		});
		if (isTerminalStatus(record.status)) finished.push(row);
		else active.push(row);
	}
	active.sort((a, b) => a.startedAt - b.startedAt);
	finished.sort((a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt));
	const rows = [...active, ...finished];
	return {
		rows,
		runningCount: rows.filter((row) => !isTerminalStatus(row.status)).length,
		generatedAt: now,
	};
}

/** Latest visible activity, not counters: a resumed/truncated transcript includes other runs. */
export function activityFromTranscript(items: readonly TranscriptItem[]): string | undefined {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (!item) continue;
		if (item.kind === "toolCall") return describeToolActivity(item);
		if (item.kind === "assistant") {
			const firstLine = previewLine(item.text ?? "", 64);
			if (firstLine.length > 0) return firstLine;
		}
	}
	return undefined;
}

function describeToolActivity(item: TranscriptItem): string | undefined {
	const args = (item.args ?? {}) as Record<string, unknown>;
	const fileArg = args.file_path ?? args.path ?? args.file ?? args.pattern ?? args.query;
	if (typeof fileArg === "string" && fileArg.length > 0) {
		const short = fileArg.includes("/") ? (fileArg.split("/").pop() ?? fileArg) : fileArg;
		return `${item.toolName ?? "tool"} ${short}`;
	}
	const command = args.command;
	if (typeof command === "string" && command.length > 0) {
		// Never paste a whole multi-line script into the panel: show only the
		// first line, collapsed and capped (bash here-docs etc. stay readable).
		const firstLine = (command.split("\n", 1)[0] ?? "").trim().replace(/\s+/g, " ");
		return `${item.toolName ?? "tool"} ${previewLine(firstLine, 48)}`;
	}
	return item.toolName;
}

/** First line of free text, capped at `max` chars with an ellipsis. */
function previewLine(text: string, max: number): string {
	const first = text.split("\n", 1)[0]?.trim() ?? "";
	if (first.length <= max) return first;
	return `${first.slice(0, max - 1)}…`;
}

export interface BuildAgentTranscriptViewOptions {
	/** Tail window; defaults to TRANSCRIPT_TAIL_ITEMS. */
	tail?: number;
	now?: () => number;
	/** Native pane availability verified by the manager's live launcher ownership. */
	attachable?: boolean;
}

/**
 * Build the immutable transcript snapshot for one selected run, keeping only
 * the latest `tail` items (the live view tails the conversation).
 */
export function buildAgentTranscriptView(
	record: AgentRun,
	items: readonly TranscriptItem[],
	options: BuildAgentTranscriptViewOptions = {},
): AgentTranscriptView {
	const tail = Math.max(1, Math.floor(options.tail ?? TRANSCRIPT_TAIL_ITEMS));
	// A settled preflight rejection has no native messages, but its diagnostic is authoritative.
	const displayItems: readonly TranscriptItem[] =
		items.length === 0 && isTerminalStatus(record.status)
			? [
					{
						kind: "system",
						timestamp: record.completedAt ?? record.startedAt,
						text: record.error?.trim() || record.result?.trim() || "No transcript was recorded for this settled run.",
					},
				]
			: items;
	const truncatedHead = displayItems.length > tail;
	const windowed = truncatedHead ? displayItems.slice(displayItems.length - tail) : displayItems;
	return {
		agentId: record.id,
		type: record.type,
		description: record.description,
		status: record.status,
		backend: record.backend,
		resourceState: deriveResourceState(record.status, record.handle !== undefined),
		startedAt: record.startedAt,
		...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
		toolUses: record.toolUses,
		turns: record.turns,
		usage: record.usage,
		items: windowed,
		truncatedHead,
		capabilities: deriveCapabilities({
			status: record.status,
			hasHandle: record.handle !== undefined,
			hasSessionFile: typeof record.sessionFile === "string" && record.sessionFile.length > 0,
			attachable: options.attachable ?? false,
		}),
		generatedAt: options.now?.() ?? Date.now(),
	};
}
