import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentFocusSnapshot, AgentTranscriptView } from "../../domain/ui-view.js";
import { formatElapsedMs } from "../../shared/elapsed.js";
import { statusBadge } from "../../shared/status.js";
import type { AgentTranscriptPane } from "./transcript-pane.js";

export interface AgentViewEditor extends Pick<Component, "render" | "invalidate"> {
	handleInput(data: string): void;
	getText(): string;
	setText(text: string): void;
	isShowingAutocomplete?(): boolean;
	getExpandedText?(): string;
	onSubmit?: (text: string) => void;
	focused?: boolean;
	dispose?(): void;
}

export interface AgentViewData {
	view: AgentTranscriptView;
	focus?: AgentFocusSnapshot;
}

export interface AgentViewOverlayHost {
	getData(): AgentViewData | null;
	onSubmit(text: string): boolean | Promise<boolean>;
	onNavigate?(delta: number): void;
	onReturnMain?(): void;
	onAbort(): void | Promise<void>;
	onAttachPane(): void | Promise<void>;
	onClose(): void;
	requestRender(): void;
}

export interface AgentViewOverlay extends Component, Focusable {
	dispose(): void;
	pane: AgentTranscriptPane;
	editor: AgentViewEditor;
	showFeedback(message: string): void;
}

const ARROW_SCROLL = 3;
const PAGE_SCROLL = 10;
const AUTOCOMPLETE_ROUTING_KEYBINDINGS = [
	"tui.select.cancel",
	"tui.select.up",
	"tui.select.down",
	"tui.editor.pageUp",
	"tui.editor.pageDown",
] as const;

function fitEditorViewport(lines: string[], maxRows: number): string[] {
	if (maxRows <= 0) return [];
	if (lines.length <= maxRows) return lines;
	const cursorRow = lines.findIndex((line) => line.includes(CURSOR_MARKER));
	const maxStart = lines.length - maxRows;
	const start = cursorRow < 0 ? maxStart : Math.min(maxStart, Math.max(0, cursorRow - Math.floor(maxRows / 2)));
	return lines.slice(start, start + maxRows);
}

function restoreOverlayBackground(line: string, bgStart: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: CSI SGR escapes are the protocol being parsed.
	return line.replace(/\x1b\[([0-9;]*)m/g, (sequence, parameters: string) => {
		const codes = parameters === "" ? [0] : parameters.split(";").map(Number);
		for (let index = 0; index < codes.length; index++) {
			const code = codes[index];
			if (code === 0 || code === 49) return `${sequence}${bgStart}`;
			if (code === 38 || code === 48 || code === 58) {
				if (codes[index + 1] === 5) index += 2;
				else if (codes[index + 1] === 2) index += 4;
			}
		}
		return sequence;
	});
}

export function createAgentViewOverlay(options: {
	tui: TUI;
	theme: Theme;
	keybindings: Pick<KeybindingsManager, "matches">;
	pane: AgentTranscriptPane;
	editor: AgentViewEditor;
	host: AgentViewOverlayHost;
}): AgentViewOverlay {
	const { tui, theme, keybindings, pane, editor, host } = options;
	const bgStart = theme.bg("customMessageBg", "").replace("\x1b[49m", "");
	let disposed = false;
	let focused = true;
	let abortArmed = false;
	let submitFeedback: string | undefined;

	function canCompose(view: AgentTranscriptView): boolean {
		return view.capabilities.steerable || view.capabilities.resumable;
	}

	function requestRender(): void {
		host.requestRender();
	}

	function submitText(submitted: string): void {
		const text = submitted.trim();
		abortArmed = false;
		if (!text) return;
		if (text.startsWith("/")) {
			const draft = editor.getText();
			const result = host.onSubmit(text);
			if (result instanceof Promise) {
				void result
					.then((accepted) => {
						if (accepted === false) submitFeedback ??= "Command unavailable or failed; draft retained.";
						else {
							submitFeedback = undefined;
							if (editor.getText() === draft) editor.setText("");
						}
						requestRender();
					})
					.catch((error: unknown) => {
						submitFeedback = error instanceof Error ? error.message : String(error);
						requestRender();
					});
			} else if (result === false) submitFeedback ??= "Command unavailable or failed; draft retained.";
			else {
				submitFeedback = undefined;
				editor.setText("");
			}
			requestRender();
			return;
		}
		editor.setText("");
		void host.onSubmit(text);
		requestRender();
	}

	function color(token: string, text: string): string {
		return theme.fg(token as never, text);
	}

	function header(view: AgentTranscriptView, focus: AgentFocusSnapshot | undefined, width: number): string {
		const badge = statusBadge(view.status);
		const elapsed = Math.max(0, (view.completedAt ?? view.generatedAt) - view.startedAt);
		const stats: string[] = [formatElapsedMs(elapsed)];
		if (view.toolUses > 0) stats.push(`${view.toolUses} tool${view.toolUses === 1 ? "" : "s"}`);
		if (view.turns > 0) stats.push(`${view.turns} turn${view.turns === 1 ? "" : "s"}`);
		const state =
			view.resourceState === "closed"
				? " · Pi process closed (history only)"
				: view.resourceState === "cleanup-unconfirmed"
					? " · Pi process close unconfirmed"
					: view.resourceState === "idle"
						? " · Pi process idle (retained teammate)"
						: "";
		const usage = `${view.usage.inputTokens} in / ${view.usage.outputTokens} out`;
		const title = ` ${color(badge.color, badge.icon)} ${view.type} · ${usage} — ${view.description} · ${stats.join(" · ")}${state}`;
		const truncation = focus?.truncatedHead || view.truncatedHead ? " · transcript is a bounded tail" : "";
		return truncateToWidth(`${title}${truncation}`, width);
	}

	function focusDetails(focus: AgentFocusSnapshot | undefined, width: number): string {
		if (!focus) return truncateToWidth("child state unavailable", width);
		const models = focus.capabilities.filter((item) => item.startsWith("model:")).map((item) => item.slice(6));
		const thinking = focus.capabilities.filter((item) => item.startsWith("thinking:")).map((item) => item.slice(9));
		const details = `${focus.model ?? "model unavailable"} · thinking ${focus.thinking ?? "unavailable"} · context ${focus.context?.usedTokens ?? "?"}/${focus.context?.windowTokens ?? "?"} · ${focus.cwd ?? "cwd unavailable"}`;
		const options = [
			...(models.length ? [`models: ${models.join(", ")}`] : []),
			...(thinking.length ? [`thinking levels: ${thinking.join(", ")}`] : []),
		];
		return truncateToWidth([details, ...options].join(" · "), width);
	}

	function footer(view: AgentTranscriptView, focus: AgentFocusSnapshot | undefined, width: number): string {
		const actions: string[] = [];
		if (canCompose(view)) actions.push(view.capabilities.steerable ? "type + enter steer" : "type + enter cold resume");
		for (const command of ["model", "thinking", "compact"]) {
			if (focus?.capabilities.includes(command)) {
				actions.push(
					command === "model" ? "/model <provider/id>" : command === "thinking" ? "/thinking <level>" : "/compact",
				);
			}
		}
		if (view.capabilities.stoppable) actions.push(abortArmed ? "ctrl+x again to abort" : "ctrl+x abort");
		if (view.capabilities.attachable) actions.push("alt+o open pane");
		const left = color("dim", actions.join(" · "));
		const right = color("dim", "↑↓ / pgup / pgdn scroll");
		const roomForLeft = Math.max(0, width - visibleWidth(right) - 2);
		if (visibleWidth(left) > roomForLeft) return truncateToWidth(left, width);
		return `${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)))}${right}`;
	}

	function maskLine(line: string, width: number): string {
		const clipped = truncateToWidth(line, width);
		const padded = `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
		return restoreOverlayBackground(theme.bg("customMessageBg", padded), bgStart);
	}

	function handleInput(data: string): void {
		if (disposed) return;
		const dataView = host.getData()?.view;
		if (!dataView) return;
		if (data.length > 0) submitFeedback = undefined;
		const autocompleteActive = editor.isShowingAutocomplete?.() ?? false;
		if (matchesKey(data, "escape") && !(autocompleteActive && keybindings.matches(data, "tui.select.cancel"))) {
			abortArmed = false;
			host.onClose();
			return;
		}
		if (autocompleteActive && AUTOCOMPLETE_ROUTING_KEYBINDINGS.some((action) => keybindings.matches(data, action))) {
			editor.handleInput(data);
			requestRender();
			return;
		}
		if (editor.getText().length === 0 && matchesKey(data, "alt+left")) {
			host.onNavigate?.(-1);
			return;
		}
		if (editor.getText().length === 0 && matchesKey(data, "alt+right")) {
			host.onNavigate?.(1);
			return;
		}
		if (editor.getText().length === 0 && matchesKey(data, "alt+up")) {
			host.onReturnMain?.();
			return;
		}
		if (keybindings.matches(data, "app.tools.expand")) {
			pane.toggleToolsExpanded();
			abortArmed = false;
			requestRender();
			return;
		}
		const text = editor.getText();
		if (text.length === 0 && dataView.capabilities.attachable && matchesKey(data, "alt+o")) {
			abortArmed = false;
			void host.onAttachPane();
			return;
		}
		if (text.length === 0 && matchesKey(data, "ctrl+x") && dataView.capabilities.stoppable) {
			if (abortArmed) {
				abortArmed = false;
				void host.onAbort();
			} else {
				abortArmed = true;
			}
			requestRender();
			return;
		}
		if (text.length === 0 && matchesKey(data, "up")) {
			abortArmed = false;
			pane.scrollBy(ARROW_SCROLL);
			requestRender();
			return;
		}
		if (text.length === 0 && matchesKey(data, "down")) {
			abortArmed = false;
			pane.scrollBy(-ARROW_SCROLL);
			requestRender();
			return;
		}
		if (text.length === 0 && matchesKey(data, "pageUp")) {
			abortArmed = false;
			pane.scrollBy(PAGE_SCROLL);
			requestRender();
			return;
		}
		if (text.length === 0 && matchesKey(data, "pageDown")) {
			abortArmed = false;
			pane.scrollBy(-PAGE_SCROLL);
			requestRender();
			return;
		}
		if (matchesKey(data, "return")) {
			if (autocompleteActive) {
				editor.handleInput(data);
				requestRender();
				return;
			}
			const submitted = editor.getExpandedText?.() ?? text;
			submitText(submitted);
			return;
		}
		abortArmed = false;
		if (canCompose(dataView)) editor.handleInput(data);
		requestRender();
	}

	editor.onSubmit = (text) => submitText(text);
	const initialView = host.getData()?.view;
	editor.focused = initialView !== undefined && canCompose(initialView);

	return {
		showFeedback(message: string) {
			submitFeedback = message;
			requestRender();
		},
		pane,
		editor,
		get focused() {
			return focused;
		},
		set focused(value: boolean) {
			focused = value;
			const view = host.getData()?.view;
			editor.focused = value && view !== undefined && canCompose(view);
		},
		handleInput,
		handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			if (event.type === "wheel" && event.wheelDelta !== undefined) {
				pane.scrollBy(-event.wheelDelta);
				requestRender();
				return { handled: true, render: true };
			}
			if (event.type === "click" && event.button === "left") {
				const result = pane.handleMouse({ ...event, y: event.y - 1 });
				if (result) {
					requestRender();
					return result;
				}
			}
			// Drag/release remain unhandled for native visible-screen selection.
			return undefined;
		},
		invalidate(): void {
			pane.invalidate();
			editor.invalidate();
		},
		render(width: number): string[] {
			const rows = Math.max(0, Math.floor(tui.terminal.rows));
			if (rows === 0 || width <= 0) return [];
			const data = host.getData();
			const view = data?.view;
			const focus = data?.focus;
			const lines: string[] = [];
			if (!view) {
				for (let row = 0; row < rows; row++) lines.push(maskLine("", width));
				return lines;
			}
			lines.push(header(view, focus, width));
			lines.push(focusDetails(focus, width));
			if (submitFeedback) lines.push(color("error", submitFeedback));
			const hasFooter = rows > 1;
			const available = Math.max(0, rows - lines.length - Number(hasFooter));
			const editorBudget =
				canCompose(view) && available > 0
					? Math.min(4, Math.max(1, Math.floor(rows / 6)), Math.max(1, available - 1))
					: 0;
			const editorLines = fitEditorViewport(canCompose(view) ? editor.render(width) : [], editorBudget);
			const paneRows = Math.max(0, available - editorLines.length);
			lines.push(...pane.render(width, paneRows));
			lines.push(...editorLines);
			if (hasFooter) lines.push(footer(view, focus, width));
			while (lines.length < rows) lines.push("");
			return lines.slice(0, rows).map((line) => maskLine(line, width));
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			focused = false;
			editor.focused = false;
			pane.dispose();
			editor.dispose?.();
		},
	};
}
