// Unit: features/agent-panel/panel-keys.ts — selection identity + the full
// keyboard table from docs/ui/AGENT-PANEL-AND-VIEW.md §5, plus the two-step
// stop confirmation state machine.

import { describe, expect, it } from "vitest";
import {
	activatePanel,
	applyStopConfirm,
	dispatchPanelKey,
	type PanelRowLike,
	selectAtIndex,
	selectionIndex,
} from "../../extension-src/pi-teams/features/agent-panel/panel-keys.js";

const rows: readonly PanelRowLike[] = [{ id: "a" }, { id: "b" }, { id: "c" }];

// Raw escape sequences the TUI feeds onTerminalInput handlers.
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";
const HOME = "\x1b[H";
const END = "\x1b[F";
const ESC = "\x1b";

describe("panel selection identity", () => {
	it("maps main to index 0 and run ids past it; unknown runs self-correct to main", () => {
		expect(selectionIndex(null, rows)).toBeNull();
		expect(selectionIndex("main", rows)).toBe(0);
		expect(selectionIndex("b", rows)).toBe(2);
		expect(selectionIndex("vanished", rows)).toBe(0);
	});

	it("clamps selection moves in both directions", () => {
		expect(selectAtIndex(rows, -5)).toBe("main");
		expect(selectAtIndex(rows, 0)).toBe("main");
		expect(selectAtIndex(rows, 1)).toBe("a");
		expect(selectAtIndex(rows, 2)).toBe("b");
		expect(selectAtIndex(rows, 99)).toBe("c");
		expect(activatePanel()).toBe("main");
	});
});

describe("dispatchPanelKey — panel mode", () => {
	it("moves down/up through main then agent rows", () => {
		expect(dispatchPanelKey(DOWN, "main", rows, "panel")).toEqual({ kind: "select", selection: "a" });
		expect(dispatchPanelKey(DOWN, "c", rows, "panel")).toEqual({ kind: "select", selection: "c" }); // clamped
		expect(dispatchPanelKey(UP, "main", rows, "panel")).toEqual({ kind: "clear" });
		expect(dispatchPanelKey(UP, "a", rows, "panel")).toEqual({ kind: "select", selection: "main" });
	});

	it("enter opens an agent view or returns to main", () => {
		expect(dispatchPanelKey(ENTER, "b", rows, "panel")).toEqual({ kind: "enter", taskId: "b" });
		expect(dispatchPanelKey(ENTER, "main", rows, "panel")).toEqual({ kind: "enter", taskId: null });
	});

	it("escape clears navigation", () => {
		expect(dispatchPanelKey(ESC, "c", rows, "panel")).toEqual({ kind: "clear" });
	});

	it("pageUp/pageDown jump selection by one rendered window (clamped)", () => {
		const many: readonly PanelRowLike[] = Array.from({ length: 14 }, (_, i) => ({ id: `r${i}` }));
		// From main, pageDown lands on the first row of the next window (index 6 → r5).
		expect(dispatchPanelKey(PAGE_DOWN, "main", many, "panel")).toEqual({
			kind: "select",
			selection: "r5",
		});
		// pageUp from there returns to main.
		expect(dispatchPanelKey(PAGE_UP, "r5", many, "panel")).toEqual({ kind: "select", selection: "main" });
		// Clamping: pageDown past the end stays on the last row.
		expect(dispatchPanelKey(PAGE_DOWN, "r13", many, "panel")).toEqual({ kind: "select", selection: "r13" });
		expect(dispatchPanelKey(PAGE_UP, "main", many, "panel")).toEqual({ kind: "select", selection: "main" });
	});

	it("home/end jump to the top and bottom of the list", () => {
		const many: readonly PanelRowLike[] = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}` }));
		expect(dispatchPanelKey(HOME, "r7", many, "panel")).toEqual({ kind: "select", selection: "main" });
		expect(dispatchPanelKey(END, "main", many, "panel")).toEqual({ kind: "select", selection: "r9" });
		expect(dispatchPanelKey(END, "r9", many, "panel")).toEqual({ kind: "select", selection: "r9" }); // clamped
	});

	it("x targets only agent rows, never main", () => {
		expect(dispatchPanelKey("x", "b", rows, "panel")).toEqual({ kind: "stop", taskId: "b" });
		expect(dispatchPanelKey("x", "main", rows, "panel")).toEqual({ kind: "unhandled" });
	});

	it("any other key is unhandled so it can type into the editor", () => {
		expect(dispatchPanelKey("q", "a", rows, "panel")).toEqual({ kind: "unhandled" });
	});
});

describe("dispatchPanelKey — view mode (transcript open)", () => {
	it("up at main HOLDS instead of clearing, so down+enter returns to the conversation", () => {
		expect(dispatchPanelKey(UP, "main", rows, "view")).toEqual({ kind: "select", selection: "main" });
	});

	it("down/up switch between viewed runs", () => {
		expect(dispatchPanelKey(DOWN, "main", rows, "view")).toEqual({ kind: "select", selection: "a" });
		expect(dispatchPanelKey(UP, "a", rows, "view")).toEqual({ kind: "select", selection: "main" });
	});

	it("enter on main means back to the conversation", () => {
		expect(dispatchPanelKey(ENTER, "main", rows, "view")).toEqual({ kind: "enter", taskId: null });
	});
});

describe("two-step stop confirmation", () => {
	it("first x arms, second x fires, other keys disarm", () => {
		const armed = applyStopConfirm(null, "run-1", { confirm: true });
		expect(armed).toEqual({ armedFor: "run-1", fire: false });

		const fired = applyStopConfirm("run-1", "run-1", { confirm: true });
		expect(fired).toEqual({ armedFor: null, fire: true });

		const disarmed = applyStopConfirm("run-1", "run-1", { confirm: false });
		expect(disarmed).toEqual({ armedFor: null, fire: false });

		// x on a different row re-targets the arm instead of firing.
		const retargeted = applyStopConfirm("run-1", "run-2", { confirm: true });
		expect(retargeted).toEqual({ armedFor: "run-2", fire: false });
	});
});
