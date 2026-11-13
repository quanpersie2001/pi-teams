import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentFocusSnapshot, AgentTranscriptView } from "../../domain/ui-view.js";
import { formatElapsedMs } from "../../shared/elapsed.js";
import { identityColor } from "../../shared/identity-color.js";
import { statusBadge } from "../../shared/status.js";
import { updateAgentSteerEditor } from "./editor.js";
import { agentStatusSnapshot, renderAgentStatus } from "./status.js";
import type { AgentTranscriptPane } from "./transcript-pane.js";

export interface AgentViewEditor extends Pick<Component, "render" | "invalidate"> {
	handleInput(data: string): void;
	getText(): string;
	setText(text: string): void;
	isShowingAutocomplete?(): boolean;
	getExpandedText?(): string;
	getCursor?(): { line: number; col: number };
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
	renderNavigation?(width: number, maxAgentRows: number): { lines: string[]; targets: ReadonlyMap<number, string> };
	onSelect?(runId: string): void;
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

export function createAgentViewOverlay(options: {
	tui: TUI;
	theme: Theme;
	keybindings: Pick<KeybindingsManager, "matches">;
	pane: AgentTranscriptPane;
	editor: AgentViewEditor;
	host: AgentViewOverlayHost;
}): AgentViewOverlay {
	const { tui, theme, keybindings, pane, editor, host } = options;
	let disposed = false;
	let focused = true;
	let abortArmed = false;
	let submitFeedback: string | undefined;
	let submitting = false;
	let panelTargets: ReadonlyMap<number, string> = new Map();

	function canCompose(view: AgentTranscriptView): boolean {
		return view.capabilities.steerable || view.capabilities.resumable;
	}

	function requestRender(): void {
		host.requestRender();
	}

	function submitText(submitted: string): void {
		const text = submitted.trim();
		abortArmed = false;
		if (!text || submitting) return;
		const draft = editor.getText();
		const finish = (accepted: boolean): void => {
			if (disposed) return;
			if (!accepted) {
				submitFeedback ??= text.startsWith("/")
					? "Command unavailable or failed; draft retained."
					: "Message unavailable or failed; draft retained.";
			} else {
				submitFeedback = undefined;
				if (editor.getText() === draft) editor.setText("");
			}
			requestRender();
		};
		const failed = (error: unknown): void => {
			if (disposed) return;
			submitFeedback = error instanceof Error ? error.message : String(error);
			requestRender();
		};
		submitting = true;
		try {
			const result = host.onSubmit(text);
			if (result instanceof Promise) {
				void result.then(finish, failed).finally(() => {
					submitting = false;
				});
			} else {
				submitting = false;
				finish(result);
			}
		} catch (error) {
			submitting = false;
			failed(error);
		}
	}

	function color(token: string, text: string): string {
		return theme.fg(token as never, text);
	}

	function header(view: AgentTranscriptView, focus: AgentFocusSnapshot | undefined, width: number): string {
		const badge = statusBadge(view.status);
		const state =
			view.resourceState === "closed"
				? " · Pi process closed (history only)"
				: view.resourceState === "cleanup-unconfirmed"
					? " · Pi process close unconfirmed"
					: view.resourceState === "idle"
						? " · Pi process idle (retained teammate)"
						: "";
		const name = view.teammateName ? identityColor(theme, view.teammateColor, `@${view.teammateName}`) : view.type;
		const truncation = focus?.truncatedHead || view.truncatedHead ? " · transcript is a bounded tail" : "";
		const elapsed = Math.max(0, (view.completedAt ?? view.generatedAt) - view.startedAt);
		const stats = [formatElapsedMs(elapsed)];
		if (view.toolUses > 0) stats.push(`${view.toolUses} tool${view.toolUses === 1 ? "" : "s"}`);
		if (view.turns > 0) stats.push(`${view.turns} turn${view.turns === 1 ? "" : "s"}`);
		const prefix = ` ${color(badge.color, badge.icon)} ${name}${state}${truncation} · `;
		const suffix = color("dim", ` · ${stats.join(" · ")}`);
		const description = truncateToWidth(
			view.description,
			Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix)),
		);
		return truncateToWidth(`${prefix}${color("dim", description)}${suffix}`, width);
	}

	function statusLines(view: AgentTranscriptView, focus: AgentFocusSnapshot | undefined, width: number): string[] {
		const native = agentStatusSnapshot(view, focus);
		const styled = renderAgentStatus(theme, width, view, focus);
		const lines = styled
			? styled
			: [
					color("dim", `${view.usage.inputTokens} in / ${view.usage.outputTokens} out`),
					color(
						"dim",
						`${native.model ?? "model unavailable"} · thinking ${native.thinkingLevel ?? "unavailable"} · context ${native.context.currentTokens ?? "?"}/${native.context.windowTokens ?? "?"} · ${native.cwd ?? "cwd unavailable"}`,
					),
				];
		if (abortArmed) lines.unshift(color("warning", "ctrl+x again to abort"));
		return lines.map((line) => truncateToWidth(line, width));
	}

	function maskLine(line: string, width: number): string {
		const clipped = truncateToWidth(line, width);
		const padded = `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
		return `\x1b[49m${padded}`;
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
		if (
			keybindings.matches(data, "tui.input.submit") ||
			(matchesKey(data, "return") && !keybindings.matches(data, "tui.input.newLine"))
		) {
			if (autocompleteActive) {
				editor.handleInput(data);
				requestRender();
				return;
			}
			const cursor = editor.getCursor?.();
			if (cursor && cursor.col > 0 && text.split("\n")[cursor.line]?.[cursor.col - 1] === "\\") {
				editor.handleInput(data); // Preserve native backslash/newline submit escape.
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

	editor.onSubmit = (text) => {
		// Native alternate submit paths clear the buffer before invoking this
		// callback. Preserve their expanded content before awaiting acceptance.
		if (editor.getText() === "") editor.setText(text);
		submitText(text);
	};
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
				const target = panelTargets.get(event.y);
				if (target) {
					if (target === "main") host.onReturnMain?.();
					else host.onSelect?.(target);
					return { handled: true, render: true };
				}
				const result = pane.handleMouse({ ...event, y: event.y - 1 - Number(submitFeedback !== undefined) });
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
			panelTargets = new Map();
			const rows = Math.max(0, Math.floor(tui.terminal.rows));
			if (rows === 0 || width <= 0) return [];
			const data = host.getData();
			const view = data?.view;
			const focus = data?.focus;
			updateAgentSteerEditor(editor, view, focus);
			const lines: string[] = [];
			if (!view) {
				for (let row = 0; row < rows; row++) lines.push(maskLine("", width));
				return lines;
			}
			lines.push(header(view, focus, width));
			if (submitFeedback) lines.push(color("error", submitFeedback));
			const footer = statusLines(view, focus, width).slice(0, Math.max(0, rows - lines.length));
			const bodyBudget = Math.max(0, rows - lines.length - footer.length);
			const editorReserve = canCompose(view) ? Math.min(4, Math.max(1, Math.floor(rows / 6))) : 0;
			// Reserve a transcript line and the panel's main row plus both window hints.
			const panel = host.renderNavigation?.(width, Math.max(0, bodyBudget - editorReserve - 1 - 3)) ?? {
				lines: [],
				targets: new Map<number, string>(),
			};
			const available = Math.max(0, bodyBudget - panel.lines.length);
			const editorBudget = available > 0 ? Math.min(editorReserve, Math.max(1, available - 1)) : 0;
			const editorLines = fitEditorViewport(canCompose(view) ? editor.render(width) : [], editorBudget);
			const paneRows = Math.max(0, available - editorLines.length);
			lines.push(...pane.render(width, paneRows));
			lines.push(...editorLines);
			lines.push(...footer);
			panelTargets = new Map([...panel.targets].map(([y, id]) => [lines.length + y, id]));
			lines.push(...panel.lines);
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
