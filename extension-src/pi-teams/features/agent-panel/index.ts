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
	const label = row.teammateName ? `@${row.teammateName}` : row.type;
	const color = row.teammateColor;
	const name =
		color && /^#[\da-f]{6}$/i.test(color)
			? `\u001b[38;2;${Number.parseInt(color.slice(1, 3), 16)};${Number.parseInt(color.slice(3, 5), 16)};${Number.parseInt(color.slice(5, 7), 16)}m${label}\u001b[39m`
			: selected
				? fg("text", label)
				: fg("muted", label);
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
export function renderAgentPanel(data: AgentPanelData, fg: ThemeFg, width: number, now: number, hub = false): string[] {
	const agents = data.view.rows;
	if (agents.length === 0 || width < 8) return [];
	const index = selectionIndex(data.selection, agents) ?? 0;

	const hint = data.selection !== null ? "↑↓ select · enter view · esc back · ←← hub" : "←← hub · ↓ to manage";
	const lines: string[] = [];
	lines.push(truncateToWidth(` team (${agents.length})${hub ? " — Team Hub" : ""} — ${fg("dim", hint)}`, width));
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

/** Hub-only data; never inferred from cumulative run usage. */
export interface AgentHubData extends AgentPanelData {
	focus: import("../../domain/ui-view.js").AgentFocusSnapshot | null;
}

function compactTokens(value: number): string {
	if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
	return String(value);
}

function hubStatus(row: AgentListRow): string {
	if (row.resourceState === "cleanup-unconfirmed") return "cleanup unconfirmed";
	if (row.resourceState === "idle") return "idle";
	return row.status;
}

function hubIdentity(row: AgentListRow, label: string, fg: ThemeFg, fallback: "text" | "muted" | "accent"): string {
	const color = row.teammateColor;
	if (!row.teammateName || !color || !/^#[\da-f]{6}$/i.test(color)) return fg(fallback, label);
	return `\x1b[38;2;${Number.parseInt(color.slice(1, 3), 16)};${Number.parseInt(color.slice(3, 5), 16)};${Number.parseInt(color.slice(5, 7), 16)}m${label}\x1b[39m`;
}

function hubStatusColor(row: AgentListRow, fg: ThemeFg): string {
	const status = hubStatus(row);
	return fg(
		status === "idle" ? "muted" : status === "cleanup-unconfirmed" ? "error" : statusBadge(row.status).color,
		status,
	);
}

function hubRosterWidth(width: number): number {
	const inner = Math.max(0, Math.floor(width) - 2);
	return width >= 70 ? Math.max(22, Math.floor(inner * 0.38)) : inner;
}

/** Pure layout and click targets share the same window, including short terminals. */
export function renderAgentHub(
	data: AgentHubData,
	fg: ThemeFg,
	width: number,
	height: number,
	now: number,
): { lines: string[]; targets: ReadonlyMap<number, string> } {
	const w = Math.max(0, Math.floor(width));
	const h = Math.max(0, Math.floor(height));
	if (!w || !h) return { lines: [], targets: new Map() };
	const inner = Math.max(0, w - 2);
	const split = w >= 70;
	const rosterWidth = hubRosterWidth(w);
	const detailWidth = split ? Math.max(0, inner - rosterWidth - 1) : inner;
	const selected = selectionIndex(data.selection, data.view.rows) ?? 0;
	const row = selected > 0 ? data.view.rows[selected - 1] : undefined;
	const targets = new Map<number, string>();
	const lines: string[] = [];
	const frame = (left: string, right = "") => {
		const part = (text: string, size: number) => {
			const clipped = truncateToWidth(text, size);
			return clipped + " ".repeat(Math.max(0, size - visibleWidth(clipped)));
		};
		const body = split
			? `${part(left, rosterWidth)}${fg("borderMuted", "│")}${part(right, detailWidth)}`
			: part(left, inner);
		lines.push(truncateToWidth(`${fg("borderMuted", "│")}${body}${fg("borderMuted", "│")}`, w));
	};
	const border = (label = "") =>
		truncateToWidth(
			`${fg("borderMuted", "┌")}${label}${fg("borderMuted", `${"─".repeat(Math.max(0, inner - visibleWidth(label)))}┐`)}`,
			w,
		);
	lines.push(border(fg("accent", " Team Hub ")));
	if (h === 1) return { lines, targets };
	const footerY = h - 2;
	const bodyEnd = Math.max(0, h - 3);
	const rosterSlots = Math.max(0, bodyEnd - 2); // header, main, then windowed runs
	const visibleCount = Math.min(MAX_AGENT_ROWS, rosterSlots, data.view.rows.length);
	const selAgent = Math.max(0, selected - 1);
	const start = selAgent < visibleCount ? 0 : selAgent - visibleCount + 1;
	const roster = new Map<number, string>();
	roster.set(1, ` ${fg("text", `team (${data.view.rows.length})`)}${start > 0 ? fg("dim", ` · ↑ ${start} more`) : ""}`);
	if (bodyEnd > 2) {
		roster.set(
			2,
			`${selected === 0 ? fg("accent", "▸") : " "} ${fg(selected === 0 ? "text" : "muted", "main")}  ${fg("accent", "● running")}`,
		);
		targets.set(2, "main");
	}
	for (let i = start; i < start + visibleCount; i++) {
		const run = data.view.rows[i];
		if (!run) continue;
		const y = i - start + 3;
		const label = run.teammateName ? `@${run.teammateName}` : run.type;
		const isSelected = selected === i + 1;
		roster.set(
			y,
			`${isSelected ? hubIdentity(run, "▸", fg, "accent") : " "} ${hubIdentity(run, label, fg, isSelected ? "text" : "muted")}  ${hubStatusColor(run, fg)}${fg("dim", ` · ${run.description}`)}`,
		);
		targets.set(y, run.id);
	}
	const hiddenBelow = data.view.rows.length - start - visibleCount;
	if (hiddenBelow > 0 && visibleCount > 0) {
		const hintY = 3 + visibleCount;
		if (hintY <= bodyEnd) roster.set(hintY, fg("dim", ` ↓ ${hiddenBelow} more`));
	}
	const detail: string[] = [];
	if (row) {
		const focus =
			data.focus?.runId === row.id && (data.focus.currentRunId === null || data.focus.currentRunId === row.id)
				? data.focus
				: null;
		// A settled named teammate retains its child and last focus snapshot; closed history does not.
		const context =
			row.resourceState === "idle" || (row.resourceState !== "closed" && !focus?.closed) ? focus?.context : null;
		const used = context?.usedTokens;
		const window = context?.windowTokens;
		const valid =
			used != null && window != null && Number.isFinite(used) && Number.isFinite(window) && used >= 0 && window > 0;
		const rawPercent = valid ? (used / window) * 100 : 0;
		const percent = Math.round(rawPercent);
		const filled = valid ? Math.max(0, Math.min(10, Math.round(percent / 10))) : 0;
		const contextColor = rawPercent < 70 ? "success" : rawPercent < 90 ? "warning" : "error";
		const label = row.teammateName ? `@${row.teammateName}` : row.type;
		detail.push(` ${hubIdentity(row, label, fg, "text")}  ${hubStatusColor(row, fg)}`);
		detail.push(` ${fg("muted", "Model     ")}${fg("text", focus?.model ?? "unknown")}`);
		detail.push(` ${fg("muted", "Thinking  ")}${fg("text", focus?.thinking ?? "unknown")}`);
		detail.push(` ${fg("text", row.description)}`);
		detail.push(
			valid
				? ` ${fg("muted", "Context   ")}${fg(contextColor, "━".repeat(filled))}${fg("borderMuted", "─".repeat(10 - filled))} ${fg("text", `${compactTokens(used)}/${compactTokens(window)} ${percent}%`)}`
				: ` ${fg("muted", "Context   unknown")}`,
		);
		detail.push(
			` ${fg("muted", "Elapsed   ")}${fg("text", formatElapsedMs(Math.max(0, (row.completedAt ?? now) - row.startedAt)))}`,
		);
		detail.push(` ${fg("muted", "Run tokens  ")}${fg("text", compactTokens(row.totalTokens))}`);
		if (data.stopArmedFor === row.id) detail.push(fg("error", " x again to ABORT"));
		else if (row.resourceState === "cleanup-unconfirmed") detail.push(fg("error", " cleanup unconfirmed"));
	} else {
		detail.push(` ${fg("text", "main")}  ${fg("accent", "● running")}`);
		detail.push(fg("muted", " Select an agent to see its details."));
	}
	if (split) {
		for (let y = 1; y <= bodyEnd; y++) frame(roster.get(y) ?? "", detail[y - 1] ?? "");
	} else {
		// On narrow terminals only the selected agent's details follow the roster header.
		for (let y = 1; y <= bodyEnd; y++) {
			if (y === 1) frame(roster.get(1) ?? "");
			else frame(detail[y - 2] ?? "");
		}
		targets.clear();
	}
	if (footerY >= 1) {
		const hint = truncateToWidth(fg("dim", " ↑↓ select · Enter view · x stop/dismiss · Esc back · Alt+G close"), inner);
		lines.push(
			truncateToWidth(
				`${fg("borderMuted", "│")}${hint}${" ".repeat(Math.max(0, inner - visibleWidth(hint)))}${fg("borderMuted", "│")}`,
				w,
			),
		);
	}
	if (h >= 2) lines.push(truncateToWidth(fg("borderMuted", `└${"─".repeat(inner)}┘`), w));
	return { lines: lines.slice(0, h), targets };
}

export function createAgentHubComponent(
	tui: TUI,
	theme: Theme,
	getData: () => AgentHubData | null,
	onInput: (data: string) => void,
	onFocus: (runId: string) => void,
	onMain: () => void,
	onWheel: (delta: number) => void,
	getNow: () => number = () => Date.now(),
): Component & Focusable {
	const fg = bindThemeFg(theme);
	let renderedWidth = tui.terminal.columns;
	return {
		focused: true,
		handleInput: onInput,
		handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			if (event.type === "wheel" && event.wheelDelta !== undefined) {
				onWheel(event.wheelDelta < 0 ? -1 : 1);
				return { handled: true, render: true };
			}
			if (event.type !== "click" || event.button !== "left") return undefined;
			// x=0 is the border; the divider and details begin after the roster.
			if (event.x < 1 || event.x > hubRosterWidth(renderedWidth)) return undefined;
			const data = getData();
			if (!data) return undefined;
			// Recompute mapping after selection/lifecycle changes, even before the next paint.
			const target = renderAgentHub(data, fg, renderedWidth, tui.terminal.rows, getNow()).targets.get(event.y);
			if (!target) return undefined;
			if (target === "main") onMain();
			else if (data.view.rows.find((row) => row.id === target)?.capabilities.viewable) onFocus(target);
			else return undefined;
			return { handled: true, render: true };
		},
		render(width: number): string[] {
			const data = getData();
			if (!data) return [];
			renderedWidth = width;
			const result = renderAgentHub(data, fg, width, tui.terminal.rows, getNow());
			return result.lines;
		},
		invalidate() {},
	};
}
