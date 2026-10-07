// Render and interaction coverage for the fullscreen transcript overlay.

import {
	CURSOR_MARKER,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { buildAgentTranscriptView } from "../../extension-src/pi-teams/app/ui-snapshot.js";
import { EMPTY_USAGE } from "../../extension-src/pi-teams/domain/agent-run.js";
import type { TranscriptItem } from "../../extension-src/pi-teams/domain/transcript.js";
import type { AgentTranscriptView } from "../../extension-src/pi-teams/domain/ui-view.js";
import {
	type AgentViewEditor,
	type AgentViewOverlay,
	createAgentTranscriptPane,
	createAgentViewOverlay,
} from "../../extension-src/pi-teams/features/agent-view/index.js";
import { renderTranscriptItems } from "../../extension-src/pi-teams/features/agent-view/transcript-renderer.js";
import { renderTheme } from "../helpers/render-theme.js";

const theme = renderTheme();
const fg = theme.fg.bind(theme);
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const ENTER = "\r";
const ESC = "\x1b";
const CTRL_X = "\x18";
const ALT_O = "\x1bo";

function viewOf(items: readonly TranscriptItem[], overrides: Partial<AgentTranscriptView> = {}): AgentTranscriptView {
	return {
		agentId: "run-1",
		type: "explore",
		description: "Find auth files",
		status: "running",
		backend: "process",
		resourceState: "open",
		usage: EMPTY_USAGE,
		startedAt: 1_000,
		completedAt: undefined,
		toolUses: 2,
		turns: 3,
		items,
		truncatedHead: false,
		capabilities: { attachable: true, viewable: true, steerable: true, stoppable: true, resumable: false },
		generatedAt: 2_000,
		...overrides,
	};
}

class TestEditor implements AgentViewEditor {
	text = "";
	focused = false;
	inputs: string[] = [];
	private cursor = 0;
	onSubmit?: (text: string) => void;

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
		this.cursor = text.length;
	}

	handleInput(data: string): void {
		this.inputs.push(data);
		if (matchesKey(data, "left")) {
			this.cursor = Math.max(0, this.cursor - 1);
			return;
		}
		if (matchesKey(data, "right")) {
			this.cursor = Math.min(this.text.length, this.cursor + 1);
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.cursor > 0) {
				this.text = `${this.text.slice(0, this.cursor - 1)}${this.text.slice(this.cursor)}`;
				this.cursor--;
			}
			return;
		}
		if (data.length === 1 && data >= " ") {
			this.text = `${this.text.slice(0, this.cursor)}${data}${this.text.slice(this.cursor)}`;
			this.cursor++;
		}
	}

	render(width: number): string[] {
		return [
			truncateToWidth(`╭${"─".repeat(Math.max(0, width - 2))}╮`, width),
			truncateToWidth(`│ ${this.text}${this.focused ? CURSOR_MARKER : ""}`, width),
			truncateToWidth(`╰${"─".repeat(Math.max(0, width - 2))}╯`, width),
		];
	}

	invalidate(): void {}
}

function makeOverlay(items: readonly TranscriptItem[], overrides: Partial<AgentTranscriptView> = {}) {
	const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} } as never;
	let view = viewOf(items, overrides);
	let revision = 0;
	const editor = new TestEditor();
	const state = {
		submitted: [] as string[],
		commands: [] as string[],
		aborts: 0,
		attaches: 0,
		closes: 0,
	};
	let overlay: AgentViewOverlay;
	const pane = createAgentTranscriptPane(tui, theme, {
		cwd: "/fake",
		read: () => view.items,
		signature: () => String(revision),
	});
	overlay = createAgentViewOverlay({
		tui,
		theme,
		keybindings: {
			matches: (data, action) => action === "app.tools.expand" && matchesKey(data, "ctrl+o"),
		},
		pane,
		editor,
		host: {
			getData: () => ({ view }),
			onSubmit: (text) => {
				state.submitted.push(text);
				return !text.startsWith("/");
			},
			onAbort: () => {
				state.aborts++;
			},
			onAttachPane: () => {
				state.attaches++;
			},
			onClose: () => {
				state.closes++;
				overlay.dispose();
			},
			requestRender() {},
		},
	});
	return {
		overlay,
		editor,
		state,
		update(nextItems: readonly TranscriptItem[]) {
			view = viewOf(nextItems, overrides);
			revision++;
		},
	};
}

function fixtureItems(count = 6): TranscriptItem[] {
	return Array.from({ length: count }, (_, index) => ({
		kind: "user" as const,
		timestamp: index,
		text: `message-${index}`,
	}));
}

describe("fullscreen agent transcript", () => {
	it("shows the runtime failure when auth rejection produced no native transcript", () => {
		const diagnostic = "Authentication rejected. Login to the selected provider.";
		const view = buildAgentTranscriptView(
			{
				id: "failed-auth",
				type: "explore",
				description: "Read source",
				status: "error",
				backend: "process",
				startedAt: 1_000,
				completedAt: 2_000,
				toolUses: 0,
				turns: 0,
				usage: EMPTY_USAGE,
				error: diagnostic,
			},
			[],
		);
		const fixture = makeOverlay(view.items, view);
		try {
			const rendered = stripTerminalSequences(fixture.overlay.render(80).join("\n"));
			expect(rendered).toContain(diagnostic);
			expect(view.capabilities.resumable).toBe(false);
		} finally {
			fixture.overlay.dispose();
		}
	});

	it("restores an expanded tool and detached viewport before the first focused render", () => {
		const items: TranscriptItem[] = [
			{
				kind: "toolCall",
				id: "call",
				revision: 1,
				toolCallId: "restored-tool",
				toolName: "bash",
				timestamp: 1,
				args: { command: "printf output" },
			},
			{
				kind: "toolResult",
				id: "result",
				revision: 1,
				toolCallId: "restored-tool",
				toolName: "bash",
				timestamp: 2,
				text: Array.from({ length: 60 }, (_, index) => `RESTORED_OUTPUT_${index + 1}`).join("\n"),
			},
			{ kind: "assistant", id: "tail", revision: 1, timestamp: 3, text: "LATEST_TAIL_MARKER" },
		];
		const first = makeOverlay(items);
		first.overlay.pane.restoreState({ scrollBack: 12, toolsExpanded: false, toolExpansion: [["restored-tool", true]] });
		const before = stripTerminalSequences(first.overlay.render(80).join("\n"));
		expect(before).not.toContain("LATEST_TAIL_MARKER");
		const next = makeOverlay(items);
		next.overlay.pane.restoreState(first.overlay.pane.getState());
		expect(stripTerminalSequences(next.overlay.render(80).join("\n"))).toBe(before);
		first.overlay.dispose();
		next.overlay.dispose();
	});

	it("masks the parent viewport, fills terminal rows, and tails new output while detached scroll preserves position", () => {
		const messages = fixtureItems(80);
		const fixture = makeOverlay(messages);
		const initial = fixture.overlay.render(80);
		expect(initial).toHaveLength(24);
		expect(initial.every((line) => visibleWidth(line) === 80)).toBe(true);
		const initialText = stripTerminalSequences(initial.join("\n"));
		expect(initialText).toContain("message-79");
		expect(initialText).not.toContain("PARENT_CONVERSATION_SENTINEL");

		fixture.overlay.handleInput(PAGE_UP);
		const scrolled = stripTerminalSequences(fixture.overlay.render(80).join("\n"));
		expect(scrolled).not.toContain("message-79");
		expect(scrolled).toContain("message-");

		fixture.update([...messages, { kind: "assistant", timestamp: 81, text: "LATEST_RPC_OUTPUT" }]);
		expect(stripTerminalSequences(fixture.overlay.render(80).join("\n"))).not.toContain("LATEST_RPC_OUTPUT");
		fixture.overlay.handleInput(PAGE_DOWN);
		const returnedToTail = stripTerminalSequences(fixture.overlay.render(80).join("\n"));
		expect(returnedToTail).toContain("LATEST_RPC_OUTPUT");
		fixture.overlay.dispose();
	});

	it("keeps printable and cursor input in the native editor and submits steers", () => {
		const fixture = makeOverlay(fixtureItems());
		fixture.editor.setText("ac");
		fixture.overlay.handleInput(LEFT);
		fixture.overlay.handleInput("b");
		expect(fixture.editor.getText()).toBe("abc");
		fixture.overlay.handleInput(UP);
		expect(fixture.editor.inputs).toContain(UP);
		fixture.overlay.handleInput(ENTER);
		expect(fixture.state.submitted).toEqual(["abc"]);
		expect(fixture.editor.getText()).toBe("");
		fixture.overlay.dispose();
	});

	it("reserves abort for a confirmed non-printable shortcut and Esc only closes", () => {
		const fixture = makeOverlay(fixtureItems());
		fixture.overlay.handleInput("x");
		expect(fixture.editor.getText()).toBe("x");
		expect(fixture.state.aborts).toBe(0);
		fixture.editor.setText("");
		fixture.overlay.handleInput(CTRL_X);
		expect(stripTerminalSequences(fixture.overlay.render(80).join("\n"))).toContain("ctrl+x again to abort");
		fixture.overlay.handleInput(CTRL_X);
		expect(fixture.state.aborts).toBe(1);
		fixture.overlay.handleInput(ESC);
		expect(fixture.state.closes).toBe(1);
		fixture.overlay.dispose();
	});

	it("routes slash-prefixed child control text through the host child-command port", () => {
		const command = makeOverlay(fixtureItems());
		command.editor.setText("/agents");
		command.overlay.handleInput(ENTER);
		expect(command.editor.getText()).toBe("/agents");
		expect(stripTerminalSequences(command.overlay.render(80).join("\n"))).toContain(
			"Command unavailable or failed; draft retained.",
		);
		const history = makeOverlay(fixtureItems(), {
			status: "completed",
			resourceState: "closed",
			capabilities: { attachable: false, viewable: true, steerable: false, stoppable: false, resumable: true },
		});
		expect(stripTerminalSequences(history.overlay.render(80).join("\n"))).toContain("type + enter cold resume");
		history.editor.setText("continue the fix");
		history.overlay.handleInput(ENTER);
		expect(history.state.submitted).toEqual(["continue the fix"]);

		const live = makeOverlay(fixtureItems());
		live.overlay.handleInput(ALT_O);
		expect(live.state.attaches).toBe(1);
		const headless = makeOverlay(fixtureItems(), {
			resourceState: "open",
			capabilities: { attachable: false, viewable: true, steerable: true, stoppable: true, resumable: false },
		});
		headless.overlay.handleInput(ALT_O);
		expect(headless.state.attaches).toBe(0);
		expect(stripTerminalSequences(headless.overlay.render(80).join("\n"))).not.toContain("alt+o open pane");
		command.overlay.dispose();
		history.overlay.dispose();
		live.overlay.dispose();
		headless.overlay.dispose();
	});

	it("renders each paired tool output once, updates an active row, and preserves orphan results", () => {
		const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} } as never;
		const call: TranscriptItem = {
			kind: "toolCall",
			timestamp: 1,
			toolName: "bash",
			toolCallId: "paired",
			args: { command: "pwd" },
		};
		const result: TranscriptItem = {
			kind: "toolResult",
			timestamp: 2,
			toolName: "bash",
			toolCallId: "paired",
			result: "PAIRED_OUTPUT",
		};
		const orphan: TranscriptItem = {
			kind: "toolResult",
			timestamp: 3,
			toolName: "bash",
			toolCallId: "evicted-call",
			result: "ORPHAN_OUTPUT",
		};
		const cache = new WeakMap();
		const context = { tui, cwd: "/fake", fg };
		const rendered = stripTerminalSequences(
			renderTranscriptItems([call, result, orphan], 80, context, cache).join("\n"),
		);
		expect(rendered.match(/PAIRED_OUTPUT/g)).toHaveLength(1);
		expect(rendered.match(/ORPHAN_OUTPUT/g)).toHaveLength(1);
		const updated = stripTerminalSequences(
			renderTranscriptItems([call, { ...result, result: "UPDATED_OUTPUT" }], 80, context, cache).join("\n"),
		);
		expect(updated).not.toContain("PAIRED_OUTPUT");
		expect(updated.match(/UPDATED_OUTPUT/g)).toHaveLength(1);
	});
});

describe("usage sanity", () => {
	it("keeps the shared usage zero value untouched", () => {
		expect(EMPTY_USAGE.totalTokens).toBe(0);
	});
});
