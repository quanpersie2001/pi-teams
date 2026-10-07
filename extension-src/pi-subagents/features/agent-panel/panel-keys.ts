// Pure panel key/selection logic (docs/ui/AGENT-PANEL-AND-VIEW.md §5).
//
// No TUI or extension imports beyond pi-tui's key matcher, so the behavior
// table is unit-testable in isolation. Ported from the reference panel-core:
// row 0 is the implicit "main" entry, rows 1..N are agent runs; selection is
// tracked by identity so the cursor follows a run when the list reorders and
// self-corrects to "main" when a run vanishes.
//
// `mode` distinguishes panel navigation (up at main exits navigation) from
// the transcript view (up at main holds, so one down + enter always returns
// to the conversation).

import { matchesKey } from "@earendil-works/pi-tui";

/** Selection identity: null = not navigating, "main" = editor row, run id otherwise. */
export type PanelSelection = "main" | string | null;

/**
 * Rows of the agent list rendered per page. Shared by the panel windowing
 * (features/agent-panel/index.ts) and the paged selection jumps below, so a
 * PageUp/PageDown always moves exactly one rendered window.
 */
export const PANEL_PAGE_SIZE = 6;

export interface PanelRowLike {
	id: string;
}

/** Index of the selection; 0 = main, i >= 1 = rows[i - 1]. Null when inactive. */
export function selectionIndex(selection: PanelSelection, rows: readonly PanelRowLike[]): number | null {
	if (selection === null) return null;
	if (selection === "main") return 0;
	const index = rows.findIndex((row) => row.id === selection);
	return index >= 0 ? index + 1 : 0;
}

/** Clamped selection move; index 0 selects main. */
export function selectAtIndex(rows: readonly PanelRowLike[], index: number): PanelSelection {
	const clamped = Math.max(0, Math.min(rows.length, Math.floor(index)));
	return clamped === 0 ? "main" : (rows[clamped - 1]?.id ?? "main");
}

/** First navigation step onto the panel: always lands on main. */
export function activatePanel(): PanelSelection {
	return "main";
}

export type PanelKeyAction =
	| { kind: "select"; selection: PanelSelection }
	| { kind: "clear" }
	/**
	 * Enter: on an agent row opens its transcript view (taskId set); on main
	 * it means "back to the conversation" (taskId null).
	 */
	| { kind: "enter"; taskId: string | null }
	/** x on an agent row: stop a running run or dismiss a finished one. */
	| { kind: "stop"; taskId: string }
	/** Not a panel key; the caller forwards input to the editor. */
	| { kind: "unhandled" };

export function dispatchPanelKey(
	data: string,
	selection: PanelSelection,
	rows: readonly PanelRowLike[],
	mode: "panel" | "view",
): PanelKeyAction {
	const index = selectionIndex(selection, rows) ?? 0;
	if (matchesKey(data, "up")) {
		if (index === 0 && mode === "panel") return { kind: "clear" };
		return { kind: "select", selection: selectAtIndex(rows, index - 1) };
	}
	if (matchesKey(data, "down")) {
		return { kind: "select", selection: selectAtIndex(rows, index + 1) };
	}
	// Paged jumps: scroll the panel list by one rendered window (clamped), so
	// long agent lists are reachable without stepping through every row.
	if (matchesKey(data, "pageUp")) {
		return { kind: "select", selection: selectAtIndex(rows, index - PANEL_PAGE_SIZE) };
	}
	if (matchesKey(data, "pageDown")) {
		return { kind: "select", selection: selectAtIndex(rows, index + PANEL_PAGE_SIZE) };
	}
	// Home/End: jump straight to the top (main) or the bottom of the list.
	if (matchesKey(data, "home")) {
		return { kind: "select", selection: "main" };
	}
	if (matchesKey(data, "end")) {
		return { kind: "select", selection: selectAtIndex(rows, rows.length) };
	}
	if (matchesKey(data, "escape")) return { kind: "clear" };
	if (matchesKey(data, "return")) {
		const taskId = index > 0 ? (rows[index - 1]?.id ?? null) : null;
		return { kind: "enter", taskId };
	}
	if (matchesKey(data, "x") && index > 0) {
		const taskId = rows[index - 1]?.id;
		if (taskId !== undefined) return { kind: "stop", taskId };
	}
	return { kind: "unhandled" };
}

/**
 * Two-step stop confirmation state: the first x arms the target, the second
 * confirms, any other target/key disarms. Pure so the table is testable.
 *
 * @returns the next armed id (`null` when disarmed) and whether the action
 * should now fire for `targetId`.
 */
export function applyStopConfirm(
	armedFor: string | null,
	targetId: string,
	input: { confirm: boolean },
): { armedFor: string | null; fire: boolean } {
	if (!input.confirm) return { armedFor: null, fire: false }; // any other key disarms
	if (armedFor === targetId) return { armedFor: null, fire: true };
	return { armedFor: targetId, fire: false };
}
