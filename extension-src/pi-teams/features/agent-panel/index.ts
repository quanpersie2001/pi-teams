// Agent panel renderer (docs/ui/AGENT-PANEL-AND-VIEW.md §2).
//
// Renders the immutable AgentListView snapshot BELOW the editor as a
// navigable list: a "main" row plus one row per visible run. The widget is
// display-only; all key handling lives in pi/ui-host.ts via
// ctx.ui.onTerminalInput, so this module performs no I/O (ARCH-007) and every
// emitted line respects the viewport width (truncateToWidth).

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentListRow, AgentListView } from "../../domain/ui-view.js";
import { formatElapsedMs } from "../../shared/elapsed.js";
import { statusBadge } from "../../shared/status.js";
import { bindThemeFg, type ThemeFg } from "../../shared/theme.js";
import { PANEL_PAGE_SIZE, type PanelSelection, selectionIndex } from "./panel-keys.js";

/** Max agent rows rendered at once; extras collapse into "↓ N more" hints. */
/** Alias kept for readability: the rendered window equals the paged jump. */
export const MAX_AGENT_ROWS = PANEL_PAGE_SIZE;

/** Data the host hands the renderer at paint time (already immutable). */
export interface AgentPanelData {
	view: AgentListView;
	selection: PanelSelection;
	/** Run id with an armed two-step stop confirmation, if any. */
	stopArmedFor: string | null;
}

/** Place `right` flush to `width`, truncating `left` so the stats survive. */
function rightAlign(left: string, right: string, width: number): string {
	const rightW = visibleWidth(right);
	const maxLeft = Math.max(0, width - rightW - 1);
	const leftClamped = truncateToWidth(left, maxLeft);
	const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
	return truncateToWidth(`${leftClamped}${" ".repeat(gap)}${right}`, width);
}

function formatAgentRowStats(row: AgentListRow, now: number): string {
	const elapsedMs = Math.max(0, (row.completedAt ?? now) - row.startedAt);
	const elapsed =
		elapsedMs >= 60_000
			? `${Math.floor(elapsedMs / 60_000)}m ${Math.floor(elapsedMs / 1_000) % 60}s`
			: formatElapsedMs(elapsedMs);
	const tokens =
		row.totalTokens >= 1_000_000
			? `${(row.totalTokens / 1_000_000).toFixed(1)}m`
			: row.totalTokens >= 1_000
				? `${(row.totalTokens / 1_000).toFixed(1)}k`
				: String(row.totalTokens);
	return `${elapsed} · ↓ ${tokens} tokens`;
}

function renderRunRow(
	row: AgentListRow,
	selected: boolean,
	stopArmed: boolean,
	fg: ThemeFg,
	width: number,
	now: number,
): string {
	const badge = statusBadge(row.status);
	const bullet = selected ? fg("accent", "⏺") : fg(badge.color, "◯");
	const label = row.teammateName ?? row.type;
	const name = selected ? fg("text", label) : fg("muted", label);
	const description = selected ? fg("text", row.description) : row.description;
	const left = `  ${bullet} ${name}  ${description}`;
	// The armed-stop warning replaces the stats on the right so it can never
	// be truncated away on narrow viewports.
	const statsRight =
		selected && stopArmed
			? fg("error", "x again to ABORT")
			: row.resourceState === "cleanup-unconfirmed"
				? fg("error", "cleanup unconfirmed")
				: selected
					? fg("text", formatAgentRowStats(row, now))
					: fg("dim", formatAgentRowStats(row, now));
	return rightAlign(left, statsRight, width);
}

/**
 * Render the whole panel. Returns [] when there is nothing to show — the host
 * then removes the widget entirely.
 */
export function renderAgentPanel(data: AgentPanelData, fg: ThemeFg, width: number, now: number): string[] {
	const agents = data.view.rows;
	if (agents.length === 0 || width < 8) return [];
	const index = selectionIndex(data.selection, agents) ?? 0;

	const hint = data.selection !== null ? "↑↓ select · enter view · esc back · ←← hub" : "←← hub · ↓ to manage";
	const lines: string[] = [];
	lines.push(truncateToWidth(` agents (${agents.length}) — ${fg("dim", hint)}`, width));
	lines.push("");

	const mainSelected = data.selection === null || index === 0;
	const mainBullet = mainSelected ? fg("accent", "⏺") : fg("dim", "◯");
	const mainLabel = mainSelected ? fg("text", "main") : fg("dim", "main");
	lines.push(truncateToWidth(`  ${mainBullet} ${mainLabel}`, width));

	// Window the agent rows so the selected one stays visible.
	const selAgent = Math.max(0, index - 1);
	const visibleCount = Math.min(MAX_AGENT_ROWS, agents.length);
	const start = selAgent < visibleCount ? 0 : selAgent - visibleCount + 1;
	const hiddenAbove = start;
	const hiddenBelow = agents.length - (start + visibleCount);

	if (hiddenAbove > 0) lines.push(truncateToWidth(rightAlign("", fg("dim", `↑ ${hiddenAbove} more`), width), width));
	for (let i = start; i < start + visibleCount; i++) {
		const row = agents[i];
		if (!row) continue;
		lines.push(renderRunRow(row, i + 1 === index, data.stopArmedFor === row.id, fg, width, now));
	}
	if (hiddenBelow > 0) lines.push(truncateToWidth(rightAlign("", fg("dim", `↓ ${hiddenBelow} more`), width), width));

	return lines;
}

/**
 * Widget component factory for ctx.ui.setWidget(key, factory, belowEditor).
 * `getData` supplies the current immutable snapshot + selection state; the
 * component itself holds none.
 *
 * Renders through {@link bindThemeFg}: Pi's `Theme.fg` is a method that reads
 * `this.fgColors`, so calling it detached crashes the TUI (see shared/theme.ts).
 * The render body is also crash-proofed — a rendering hiccup must never kill
 * the whole app, it degrades to an empty panel.
 */
export function createAgentListComponent(
	_tui: TUI,
	theme: Theme,
	getData: () => AgentPanelData | null,
	getNow: () => number = () => Date.now(),
): Component {
	const fg = bindThemeFg(theme);
	return {
		render(width: number): string[] {
			const data = getData();
			if (!data) return [];
			try {
				return renderAgentPanel(data, fg, width, getNow());
			} catch {
				return [];
			}
		},
		invalidate() {},
	};
}

export function createAgentHubComponent(
	tui: TUI,
	theme: Theme,
	getData: () => AgentPanelData | null,
	onInput: (data: string) => void,
	onFocus: (runId: string) => void,
	onMain: () => void,
	onWheel: (delta: number) => void,
	getNow: () => number = () => Date.now(),
): Component & Focusable {
	const fg = bindThemeFg(theme);
	const bgStart = theme.bg("customMessageBg", "").replace("\x1b[49m", "");
	return {
		focused: true,
		handleInput: onInput,
		handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			if (event.type === "wheel" && event.wheelDelta !== undefined) {
				onWheel(event.wheelDelta < 0 ? -1 : 1);
				return { handled: true, render: true };
			}
			if (event.type !== "click" || event.button !== "left") return undefined;
			const data = getData();
			if (!data) return undefined;
			if (event.y === 2) {
				onMain();
				return { handled: true, render: true };
			}
			const selectedIndex = selectionIndex(data.selection, data.view.rows) ?? 0;
			const selectedAgent = Math.max(0, selectedIndex - 1);
			const visibleCount = Math.min(MAX_AGENT_ROWS, data.view.rows.length);
			const start = selectedAgent < visibleCount ? 0 : selectedAgent - visibleCount + 1;
			const rowStart = 3 + Number(start > 0);
			const index = start + event.y - rowStart;
			const row = data.view.rows[index];
			if (!row?.capabilities.viewable || event.y < rowStart || index >= start + visibleCount) return undefined;
			onFocus(row.id);
			// The callback closes this Hub; mouse dispatch must not focus its removed component afterward.
			return { handled: true, render: true };
		},
		render(width: number): string[] {
			const count = Math.max(0, Math.floor(tui.terminal.rows));
			const data = getData();
			if (!data || width <= 0 || count === 0) return [];
			const content =
				data.view.rows.length === 0
					? [
							" agents (0) — Agents Hub",
							"",
							"  ● main",
							"",
							"  No subagent runs.",
							"",
							"  click a child or use ↑↓ / Enter · Esc returns",
						]
					: [
							...renderAgentPanel(data, fg, width, getNow()),
							"",
							"  click a child or use ↑↓ / Enter · Esc returns · Alt+G closes",
						];
			const lines = content.slice(0, count);
			while (lines.length < count) lines.push("");
			return lines.map((line) => {
				const clipped = truncateToWidth(line, width);
				return `${theme.bg("customMessageBg", clipped)}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}${bgStart}`;
			});
		},
		invalidate() {},
	};
}
