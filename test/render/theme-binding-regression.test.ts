// Regression test: Pi's Theme.fg is a METHOD that reads `this.fgColors` (an
// instance Map built in the constructor). Calling it detached throws
// "Cannot read properties of undefined (reading 'fgColors')".
//
// These tests drive the real panel and fullscreen overlay component paths with
// a method-style theme that behaves like Pi's ResolvedTheme.

import { describe, expect, it } from "vitest";
import { EMPTY_USAGE } from "../../extension-src/pi-subagents/domain/agent-run.js";
import type {
	AgentListRow,
	AgentListView,
	AgentTranscriptView,
} from "../../extension-src/pi-subagents/domain/ui-view.js";
import { createAgentListComponent } from "../../extension-src/pi-subagents/features/agent-panel/index.js";
import {
	type AgentViewEditor,
	createAgentTranscriptPane,
	createAgentViewOverlay,
} from "../../extension-src/pi-subagents/features/agent-view/index.js";
import { createSubagentNotificationRenderer } from "../../extension-src/pi-subagents/features/notifications/index.js";
import { bindThemeFg } from "../../extension-src/pi-subagents/shared/theme.js";

/**
 * A theme whose `fg` is a real method reading `this.fgColors` — structurally
 * identical to pi-coding-agent's ResolvedTheme (dist/modes/interactive/
 * theme/theme.js). Calling it detached is exactly the crash we must prevent.
 */
function methodStyleTheme(): { fgColors: Map<string, string>; fg: (color: string, text: string) => string } {
	return {
		fgColors: new Map<string, string>([
			["accent", "\x1b[36m"],
			["dim", "\x1b[90m"],
			["text", "\x1b[97m"],
			["error", "\x1b[91m"],
			["border", "\x1b[90m"],
		]),
		fg(color: string, text: string): string {
			// Reading this.fgColors is the crash point when `this` is undefined.
			const ansi = this.fgColors.get(color);
			return `${ansi ?? ""}${text}\x1b[39m`;
		},
	};
}
function transcriptView(): AgentTranscriptView {
	return {
		agentId: "run-1",
		type: "explore",
		description: "Find auth files",
		status: "running",
		backend: "process",
		resourceState: "open",
		usage: { ...EMPTY_USAGE },
		startedAt: 1_000,
		completedAt: undefined,
		toolUses: 1,
		turns: 2,
		items: [{ kind: "assistant", timestamp: 2_000, text: "hello" }],
		capabilities: { attachable: true, viewable: true, steerable: true, stoppable: true, resumable: false },
		truncatedHead: false,
		generatedAt: 2_000,
	};
}

function panelData(rows: readonly AgentListRow[]): {
	view: AgentListView;
	selection: "main" | string | null;
	stopArmedFor: string | null;
} {
	return {
		view: { rows, runningCount: rows.length, generatedAt: Date.now() },
		selection: null,
		stopArmedFor: null,
	};
}

function panelRow(overrides: Partial<AgentListRow> = {}): AgentListRow {
	return {
		id: "run-1",
		type: "explore",
		description: "Find auth files",
		status: "running",
		backend: "process",
		resourceState: "open",
		startedAt: 1_000,
		completedAt: undefined,
		toolUses: 3,
		turns: 5,
		isBackground: true,
		capabilities: { attachable: false, viewable: true, steerable: true, stoppable: true, resumable: false },
		...overrides,
	};
}

describe("component factories with a method-style theme (regression: detached fg)", () => {
	it("agent panel component renders without throwing", () => {
		const theme = methodStyleTheme();
		const component = createAgentListComponent({} as never, theme, () => panelData([panelRow()]));
		expect(() => {
			const lines = component.render(80);
			expect(lines.length).toBeGreaterThan(0);
		}).not.toThrow();
		// The bound path must still emit ANSI (colors actually work).
		const lines = component.render(80);
		expect(lines.join("\n")).toContain("\x1b[");
	});

	it("fullscreen agent overlay renders without detaching method-style theme callbacks", () => {
		const methodTheme = methodStyleTheme();
		const theme = {
			...methodTheme,
			bg(_color: string, text: string) {
				return `\x1b[49m${text}\x1b[49m`;
			},
		};
		const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} } as never;
		const view = transcriptView();
		const editor: AgentViewEditor = {
			focused: false,
			getText: () => "",
			setText() {},
			handleInput() {},
			render: () => ["│ editor"],
			invalidate() {},
		};
		const pane = createAgentTranscriptPane(tui, theme as never, {
			cwd: "/tmp",
			read: () => view.items,
			signature: () => "stable",
		});
		const component = createAgentViewOverlay({
			tui,
			theme: theme as never,
			keybindings: { matches: () => false },
			pane,
			editor,
			host: {
				getData: () => ({ view }),
				onSubmit() {},
				onAbort() {},
				onAttachPane() {},
				onClose() {},
				requestRender() {},
			},
		});
		expect(() => component.render(80)).not.toThrow();
		expect(component.render(80).join("\n")).toContain("\x1b[");
		component.dispose();
	});

	it("notification renderer degrades instead of throwing on a broken theme", () => {
		// A theme whose fg THROWS on every call: bindThemeFg must swallow it.
		const broken = {
			fg: () => {
				throw new Error("theme broken");
			},
		};
		// bindThemeFg itself never throws.
		const safe = bindThemeFg(broken);
		expect(safe("dim", "x")).toBe("x");

		const renderer = createSubagentNotificationRenderer();
		const component = renderer(
			{
				customType: "subagent-notification",
				content: [{ type: "text", text: "done" }],
				display: "done",
				details: { id: "run-1", type: "explore", result: "ok" },
			},
			{ width: 80 },
			broken as never,
		);
		expect(() => component.render(80)).not.toThrow();
	});
});
