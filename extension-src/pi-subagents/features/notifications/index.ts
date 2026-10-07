// Completion notification renderer (docs/ui/AGENT-PANEL-AND-VIEW.md §7).
//
// pi/delivery-host.ts injects completion settlements as custom messages with
// customType "subagent-notification"; this feature registers a message
// renderer that styles them as a compact box: outcome icon, agent type +
// status label, optional owner reference, stats and a result preview.
//
// Grouping: one box per run — the delivery service emits exactly one
// notification per settled run, so each rendered message IS one run's box.
//
// Render path performs no I/O (ARCH-007): everything comes from the message
// payload. Width discipline: every line is truncated to the viewport width.

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { bindThemeFg, type ThemeFg, type UiColorToken } from "../../shared/theme.js";

/** pi.sendMessage customType for completion notifications. */
export const SUBAGENT_NOTIFICATION_TYPE = "subagent-notification";

export type NotificationOutcome = "completed" | "failed" | "stopped";

export interface NotificationDetails {
	agentId?: string;
	type?: string;
	description?: string;
	status?: string;
	outcome?: NotificationOutcome;
	branch?: string;
	ownerRef?: string;
	durationMs?: number;
	toolUses?: number;
}

export interface NotificationMessageLike {
	customType: string;
	content?: unknown;
	details?: unknown;
}

export interface NotificationRenderOptionsLike {
	expanded: boolean;
}

const PREVIEW_MAX_CHARS = 400;
const PREVIEW_MAX_LINES_COLLAPSED = 4;

function outcomeIcon(outcome: NotificationOutcome): string {
	switch (outcome) {
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		default:
			return "■"; // stopped / aborted
	}
}

function outcomeColor(outcome: NotificationOutcome): UiColorToken {
	switch (outcome) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		default:
			return "dim";
	}
}

function outcomeLabel(outcome: NotificationOutcome): string {
	switch (outcome) {
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		default:
			return "stopped";
	}
}

/** Extract readable preview text from arbitrary content (string or blocks). */
export function previewTextFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		const text = (block as { text?: unknown } | null)?.text;
		if (typeof text === "string" && text.trim().length > 0) parts.push(text.trim());
	}
	return parts.join("\n");
}

/** Parse details from a raw notification message, tolerating absent data. */
export function notificationDetailsOf(message: NotificationMessageLike): {
	details: NotificationDetails;
	preview: string;
} {
	const details =
		typeof message.details === "object" && message.details !== null ? (message.details as NotificationDetails) : {};
	const previewSource = typeof message.content === "string" ? message.content : previewTextFromContent(message.content);
	return { details, preview: previewSource };
}

/**
 * Render the compact notification box lines. `expanded` shows the full
 * result; collapsed form caps the preview length and line count.
 */
export function renderNotificationLines(
	message: NotificationMessageLike,
	options: NotificationRenderOptionsLike,
	fg: ThemeFg,
	width: number,
): string[] {
	if (width < 8) return [];
	const { details, preview } = notificationDetailsOf(message);
	const outcome: NotificationOutcome =
		details.outcome === "completed" || details.outcome === "failed" || details.outcome === "stopped"
			? details.outcome
			: "stopped";
	const icon = fg(outcomeColor(outcome), outcomeIcon(outcome));
	const type = details.type ?? "agent";
	const titleParts = [`${type} ${outcomeLabel(outcome)}`];
	if (details.ownerRef) titleParts.push(fg("dim", details.ownerRef));
	if (details.branch) titleParts.push(fg("dim", `branch: ${details.branch}`));

	const stats: string[] = [];
	if (typeof details.durationMs === "number" && Number.isFinite(details.durationMs)) {
		stats.push(`${Math.max(0, Math.round(details.durationMs / 1000))}s`);
	}
	if (typeof details.toolUses === "number" && details.toolUses > 0) {
		stats.push(`${details.toolUses} tool${details.toolUses === 1 ? "" : "s"}`);
	}
	const statsSuffix = stats.length > 0 ? ` ${fg("dim", `· ${stats.join(" · ")}`)}` : "";

	const border = new DynamicBorder((str) => fg("border", str));
	const lines: string[] = [...border.render(width)];

	const innerWidth = width - 2;
	lines.push(truncateToWidth(` ${icon} ${titleParts.join(" ")}${statsSuffix}`, width));
	for (const line of previewLines(preview, options.expanded, innerWidth)) {
		lines.push(truncateToWidth(fg("muted", `  ⎿ ${line}`), width));
	}
	if (!options.expanded && preview.length > PREVIEW_MAX_CHARS) {
		lines.push(truncateToWidth(fg("dim", "  ⎿ … (expand for full result)"), width));
	}
	lines.push(...border.render(width));
	return lines.map((line) => truncateToWidth(line, width));
}

function previewLines(preview: string, expanded: boolean, width: number): string[] {
	const trimmed = preview.trim();
	if (trimmed.length === 0) return ["(no output)"];
	let body = trimmed;
	if (!expanded && body.length > PREVIEW_MAX_CHARS) body = body.slice(0, PREVIEW_MAX_CHARS);
	const wrapped = wrapTextWithAnsi(body, Math.max(8, width - 4));
	if (expanded || wrapped.length <= PREVIEW_MAX_LINES_COLLAPSED) {
		return wrapped.length > 0 ? wrapped : ["(no output)"];
	}
	const head = wrapped.slice(0, PREVIEW_MAX_LINES_COLLAPSED);
	head.push(`… (+${wrapped.length - PREVIEW_MAX_LINES_COLLAPSED} more lines)`);
	return head;
}

/**
 * MessageRenderer-compatible renderer for registerMessageRenderer(). Returns
 * a stateless component — the box derives entirely from the message payload.
 */
export function createSubagentNotificationRenderer(): (
	message: NotificationMessageLike,
	options: NotificationRenderOptionsLike,
	theme: { fg: ThemeFg },
) => { render(width: number): string[]; invalidate(): void } {
	return (message, options, theme) => ({
		render(width) {
			try {
				return renderNotificationLines(message, options, bindThemeFg(theme), width);
			} catch {
				return [];
			}
		},
		invalidate() {},
	});
}
