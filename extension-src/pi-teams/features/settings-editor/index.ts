// Settings list editor (the `/teams-settings` group screen).
//
// A list, not a stack of dialogs: ↑↓ move, ←→ change the selected value in
// place, `r` resets it, Esc goes back. The component holds no data of its own —
// the command owns the snapshot and re-reads it after every write, exactly like
// the Team Hub roster.

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SettingSpec } from "../../domain/settings-schema.js";
import { bindThemeFg, type ThemeFg } from "../../shared/theme.js";

export interface SettingsEditorItem {
	/** Dotted key, e.g. `tasks.inlineRows`. */
	key: string;
	label: string;
	spec: SettingSpec;
	/** Formatted effective value. */
	value: string;
	origin: "project" | "global" | "default";
	/** The edited scope itself holds this key, so a reset has something to remove. */
	overridden: boolean;
	restart: boolean;
}

export interface SettingsEditorData {
	title: string;
	items: readonly SettingsEditorItem[];
}

export interface SettingsEditorHandlers {
	getData(): SettingsEditorData;
	/** Arrow press on the selected row. */
	onStep(item: SettingsEditorItem, direction: -1 | 1): void;
	/** Typed entry for open-ended kinds. */
	onEdit(item: SettingsEditorItem): void;
	onReset(item: SettingsEditorItem): void;
	onBack(): void;
}

export type SettingsEditorKey = "up" | "down" | "stepLeft" | "stepRight" | "edit" | "reset" | "back";

/** Map raw terminal input to one editor intent. */
export function settingsEditorKey(data: string): SettingsEditorKey | undefined {
	if (matchesKey(data, "up")) return "up";
	if (matchesKey(data, "down")) return "down";
	if (matchesKey(data, "left")) return "stepLeft";
	if (matchesKey(data, "right")) return "stepRight";
	if (matchesKey(data, "enter")) return "edit";
	if (matchesKey(data, "r")) return "reset";
	if (matchesKey(data, "escape")) return "back";
	return undefined;
}

/**
 * Height of the editor: just tall enough for its rows plus the frame (title,
 * hints, selected label, bottom rule), clamped to the terminal. The overlay
 * sizes itself from the rendered line count, so padding to the full terminal
 * height would open a mostly empty fullscreen box.
 */
export function settingsEditorHeight(itemCount: number, terminalRows: number): number {
	return Math.max(3, Math.min(Math.max(0, Math.floor(terminalRows)), Math.max(0, itemCount) + 4));
}

/** Kinds whose value is changed by typing rather than by cycling a ladder. */
export function isTypedKind(spec: SettingSpec): boolean {
	return spec.kind === "integer" || spec.kind === "seconds" || spec.kind === "text";
}

function rightAlign(left: string, right: string, width: number): string {
	const rightW = visibleWidth(right);
	const leftClamped = truncateToWidth(left, Math.max(0, width - rightW - 1));
	const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
	return truncateToWidth(`${leftClamped}${" ".repeat(gap)}${right}`, width);
}

/**
 * Render the editor at a fixed height. Every line is width-clamped: the editor
 * owns the whole screen, so one overlong row would wrap and corrupt the frame.
 */
export function renderSettingsEditor(
	data: SettingsEditorData,
	index: number,
	fg: ThemeFg,
	width: number,
	height: number,
): string[] {
	const w = Math.max(0, Math.floor(width));
	const h = Math.max(0, Math.floor(height));
	if (w < 8 || h < 3) return [];
	const inner = w - 2;
	const footerHeight = 2;
	const bodyHeight = Math.max(0, h - 2 - footerHeight);
	const typed = data.items.some((item) => isTypedKind(item.spec));
	const hints = [`↑↓ move · ←→ change`, typed ? "enter set" : "", "r reset", "esc back"].filter(Boolean).join(" · ");

	const padTo = (text: string, size: number): string => {
		const clipped = truncateToWidth(text, size);
		return clipped + " ".repeat(Math.max(0, size - visibleWidth(clipped)));
	};
	const lines: string[] = [];
	const title = truncateToWidth(` ${data.title} `, Math.max(0, inner - 1));
	const topRule = `${"─".repeat(Math.max(0, inner - visibleWidth(title) - 1))}╮`;
	lines.push(`${fg("accent", "╭─")}${title}${fg("accent", topRule)}`);

	const selected = Math.max(0, Math.min(index, data.items.length - 1));
	const start = Math.max(0, Math.min(selected - bodyHeight + 1, data.items.length - bodyHeight));
	for (let line = 0; line < bodyHeight; line++) {
		const item = data.items[start + line];
		if (!item) {
			lines.push(`${fg("accent", "│")}${" ".repeat(inner)}${fg("accent", "│")}`);
			continue;
		}
		const isSelected = start + line === selected;
		const marker = isSelected ? fg("accent", "›") : " ";
		const left = ` ${marker} ${fg(isSelected ? "text" : "muted", `${item.key} = ${item.value}`)}`;
		const right = fg("dim", `${item.origin}${item.restart ? " · next session" : ""}`);
		lines.push(`${fg("accent", "│")}${rightAlign(left, right, inner)}${fg("accent", "│")}`);
	}
	lines.push(`${fg("accent", "│")}${fg("dim", padTo(` ${hints}`, inner))}${fg("accent", "│")}`);
	const selectedItem = data.items[selected];
	lines.push(`${fg("accent", "│")}${fg("muted", padTo(` ${selectedItem?.label ?? ""}`, inner))}${fg("accent", "│")}`);
	lines.push(fg("accent", `╰${"─".repeat(Math.max(0, inner))}╯`));
	return lines.slice(0, h);
}

/**
 * Widget component for `ctx.ui.custom`. Owns only the cursor: data, writes and
 * file I/O stay with the command, which re-snapshots after each change.
 */
export function createSettingsEditorComponent(tui: TUI, theme: Theme, handlers: SettingsEditorHandlers): Component {
	const fg = bindThemeFg(theme);
	let index = 0;
	return {
		render(width: number): string[] {
			try {
				const data = handlers.getData();
				return renderSettingsEditor(data, index, fg, width, settingsEditorHeight(data.items.length, tui.terminal.rows));
			} catch {
				return [];
			}
		},
		handleInput(data: string): void {
			const key = settingsEditorKey(data);
			if (!key) return;
			const items = handlers.getData().items;
			if (key === "back") {
				handlers.onBack();
				return;
			}
			if (key === "up" || key === "down") {
				if (items.length === 0) return;
				index = Math.max(0, Math.min(index + (key === "down" ? 1 : -1), items.length - 1));
				tui.requestRender();
				return;
			}
			const item = items[Math.min(index, items.length - 1)];
			if (!item) return;
			if (key === "stepLeft" || key === "stepRight") handlers.onStep(item, key === "stepRight" ? 1 : -1);
			else if (key === "reset") handlers.onReset(item);
			else if (key === "edit" && isTypedKind(item.spec)) handlers.onEdit(item);
		},
		invalidate() {},
	};
}
