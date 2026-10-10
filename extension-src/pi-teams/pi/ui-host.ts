// Inline UI host (docs/ui/AGENT-PANEL-AND-VIEW.md).
//
// Owns the below-editor agent panel, fullscreen transcript overlay, keyboard
// routing for panel selection, and compact statusline. Closing a transcript
// overlay only detaches UI; it never stops or disposes a child resource.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Editor, isKeyRelease, isKeyRepeat, matchesKey, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import type { AgentManager } from "../app/agent-manager.js";
import { activityFromTranscript, buildAgentListView, buildAgentTranscriptView } from "../app/ui-snapshot.js";
import type { ThinkingLevel } from "../domain/agent-definition.js";
import { isActiveStatus } from "../domain/agent-run.js";
import type { ChildControlCommand } from "../domain/child-protocol.js";
import type { SubagentsSettings } from "../domain/config.js";
import type { AgentFocusPort, AgentFocusSnapshot, AgentListView } from "../domain/ui-view.js";
import {
	type AgentPanelData,
	createAgentHubComponent,
	createAgentListComponent,
} from "../features/agent-panel/index.js";
import {
	activatePanel,
	applyStopConfirm,
	dispatchPanelKey,
	type PanelSelection,
	selectAtIndex,
	selectionIndex,
} from "../features/agent-panel/panel-keys.js";
import {
	type AgentViewData,
	type AgentViewOverlay,
	createAgentSteerEditor,
	createAgentTranscriptPane,
	createAgentViewOverlay,
} from "../features/agent-view/index.js";
import type { TranscriptSource } from "./transcript-host.js";

/** Elapsed/stats re-render cadence while something is active. */
const TICK_MS = 1000;
/** Two deliberate presses, rather than a held key or an old boundary press. */
const HUB_DOUBLE_LEFT_MS = 500;

const PANEL_WIDGET_KEY = "teams-agents";
const STATUS_KEY = "teams";

export interface SubagentsUiOptions {
	manager: AgentManager;
	focus: AgentFocusPort;
	settings: () => SubagentsSettings;
	transcripts: TranscriptSource;
	now?: () => number;
}
export interface SubagentsUiHandle {
	/** Open the transcript view for a run (defaults to the newest visible one). */
	openView(runId?: string): void;
	openHub(): void;
	closeView(): void;
	/** Rebuild snapshots + widgets (also called on lifecycle events/ticks). */
	refresh(): void;
	dispose(): void;
	/** True while a fullscreen transcript overlay owns the view. */
	isViewOpen(): boolean;
	/** True only when the main composer, not an overlay or completion menu, owns input. */
	isMainEditorFocused(): boolean;
}

export function installSubagentsUi(ctx: ExtensionContext, options: SubagentsUiOptions): SubagentsUiHandle {
	const { manager, transcripts } = options;
	const now = options.now ?? (() => Date.now());

	// -- UI state -------------------------------------------------------------
	let selection: PanelSelection = null;
	let viewRunId: string | null = null;
	let stopArmedFor: string | null = null;
	let viewData: AgentViewData | null = null;
	let focusData: AgentFocusSnapshot | null = null;
	let focusUnsubscribe: (() => void) | undefined;
	let focusGeneration = 0;
	let hubOpen = false;
	let hubFocus: AgentFocusSnapshot | null = null;
	let hubFocusRunId: string | null = null;
	let hubFocusUnsubscribe: (() => void) | undefined;
	let hubFocusGeneration = 0;
	let focusReadRevision = 0;
	let disposed = false;
	let refreshing = false;
	let refreshQueued = false;
	let leftArmed: { editor: Editor | undefined; sessionId: string; text: string; pressedAt: number } | undefined;

	let panelRegistered = false;
	let tui: TUI | undefined;
	let overlayDone: (() => void) | undefined;
	let overlayHandle: OverlayHandle | undefined;
	let overlayComponent: AgentViewOverlay | undefined;
	let overlayPromise: Promise<void> | undefined;
	let overlayGeneration = 0;
	let viewRevision = 0;
	let hubDone: (() => void) | undefined;
	let hubHandle: OverlayHandle | undefined;
	let hubComponent: Component | undefined;
	let hubPromise: Promise<void> | undefined;
	let hubGeneration = 0;

	const activityByRunId = new Map<string, string>();
	const dismissed = new Set<string>();
	const viewDrafts = new Map<string, string>();
	const viewUiState = new Map<
		string,
		{ scrollBack: number; toolsExpanded: boolean; toolExpansion: readonly (readonly [string, boolean])[] }
	>();
	let listView: AgentListView | null = null;
	let inlineListView: AgentListView | null = null;
	const disposers: Array<() => void> = [];
	let tickTimer: NodeJS.Timeout | undefined;

	function enabled(): boolean {
		return !disposed && options.settings().agentPanel;
	}

	function requestRender(): void {
		try {
			tui?.requestRender();
		} catch {
			/* rendering is best-effort */
		}
	}

	function editorText(): string {
		try {
			return ctx.ui.getEditorText();
		} catch {
			return "";
		}
	}

	function foreignEditor(): boolean {
		// Re-read live: another extension may claim/release the editor anytime.
		try {
			return ctx.ui.getEditorComponent() !== undefined;
		} catch {
			return false;
		}
	}

	// -- widgets -----------------------------------------------------------------

	function installPanel(): void {
		ctx.ui.setWidget(
			PANEL_WIDGET_KEY,
			(widgetTui, theme) => {
				tui = widgetTui;
				return createAgentListComponent(
					widgetTui,
					theme,
					() => {
						if (!inlineListView) return null;
						const data: AgentPanelData = { view: inlineListView, selection, stopArmedFor };
						return data;
					},
					now,
				);
			},
			{ placement: "belowEditor" },
		);
		panelRegistered = true;
	}

	function startViewOverlay(): void {
		if (ctx.mode !== "tui") {
			closeView();
			return;
		}
		if (viewRunId === null || viewData === null || overlayPromise !== undefined || focusData?.runId !== viewRunId)
			return;
		const runId = viewRunId;
		const generation = ++overlayGeneration;
		let opening: Promise<void>;
		try {
			opening = ctx.ui.custom<void>(
				(overlayTui, theme, keybindings, done) => {
					if (disposed || generation !== overlayGeneration || viewRunId !== runId) {
						done(undefined);
						return { render: () => [], invalidate() {} };
					}
					tui = overlayTui;
					const pane = createAgentTranscriptPane(overlayTui, theme, {
						cwd: focusData?.runId === runId ? (focusData.cwd ?? "") : "",
						read: () => (viewRunId === runId ? (viewData?.view.items ?? []) : []),
						signature: () => `${runId}:${viewRevision}`,
					});
					const editor = createAgentSteerEditor(overlayTui, theme, keybindings, viewData?.view);
					editor.setText(viewDrafts.get(runId) ?? "");
					pane.restoreState(viewUiState.get(runId));
					const component = createAgentViewOverlay({
						tui: overlayTui,
						theme,
						keybindings,
						pane,
						editor,
						host: {
							getData: () => (viewRunId === runId ? viewData : null),
							onSubmit: (text) => routeComposer(text, runId),
							onAbort: () => abortViewedRun(runId),
							onAttachPane: () => handleAttach(runId),
							onNavigate: (delta) => navigateViewedRun(runId, delta),
							onReturnMain: closeView,
							onClose: closeView,
							requestRender,
						},
					});
					overlayDone = () => done(undefined);
					overlayComponent = component;
					return component;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "top-left",
						width: "100%",
						maxHeight: "100%",
						margin: 0,
					},
					onHandle: (handle) => {
						if (generation === overlayGeneration) overlayHandle = handle;
						else handle.hide();
					},
				},
			);
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), "error");
			closeView();
			return;
		}
		overlayPromise = opening;
		void opening
			.catch((error) => {
				if (generation !== overlayGeneration) return;
				notify(error instanceof Error ? error.message : String(error), "error");
				closeView();
			})
			.finally(() => {
				if (generation !== overlayGeneration) return;
				overlayPromise = undefined;
				overlayDone = undefined;
				overlayHandle = undefined;
				overlayComponent = undefined;
				if (viewRunId === runId) {
					viewRunId = null;
					viewData = null;
					selection = null;
					stopArmedFor = null;
				}
				requestRender();
			});
	}
	function closeHub(): void {
		leftArmed = undefined;
		hubFocusGeneration++;
		hubFocusUnsubscribe?.();
		hubFocusUnsubscribe = undefined;
		hubFocusRunId = null;
		hubFocus = null;
		hubOpen = false;
		hubGeneration++;
		const done = hubDone;
		const handle = hubHandle;
		const component = hubComponent;
		hubDone = undefined;
		hubHandle = undefined;
		hubComponent = undefined;
		hubPromise = undefined;
		selection = null;
		if (done) done();
		else {
			component?.invalidate();
			handle?.hide();
		}
		requestRender();
	}

	function activateHubRow(runId: string): void {
		closeHub();
		openView(runId);
	}

	function handleHubInput(data: string): void {
		if (matchesKey(data, "alt+g")) {
			closeHub();
			return;
		}
		const rows = listView?.rows ?? [];
		if (selection === null) selection = activatePanel();
		const action = dispatchPanelKey(data, selection, rows, "panel");
		switch (action.kind) {
			case "select":
				selection = action.selection;
				syncHubFocus();
				requestRender();
				return;
			case "clear":
				closeHub();
				return;
			case "enter":
				if (action.taskId === null) closeHub();
				else activateHubRow(action.taskId);
				return;
			case "stop":
				void handleStop(action.taskId);
				return;
			default:
				return;
		}
	}

	function moveHubSelection(delta: number): void {
		const rows = listView?.rows ?? [];
		const current = selectionIndex(selection, rows) ?? 0;
		selection = selectAtIndex(rows, current + delta);
		syncHubFocus();
		requestRender();
	}

	function syncHubFocus(): void {
		const index = selectionIndex(selection, listView?.rows ?? []) ?? 0;
		const runId = hubOpen && index > 0 ? (listView?.rows[index - 1]?.id ?? null) : null;
		if (runId === hubFocusRunId) return;
		hubFocusGeneration++;
		hubFocusUnsubscribe?.();
		hubFocusUnsubscribe = undefined;
		hubFocusRunId = runId;
		hubFocus = null;
		if (!runId) return;
		const generation = hubFocusGeneration;
		let revision = 0;
		const load = async () => {
			const reading = ++revision;
			try {
				const snapshot = await options.focus.read(runId);
				if (
					hubOpen &&
					generation === hubFocusGeneration &&
					reading === revision &&
					snapshot.runId === runId &&
					(snapshot.currentRunId === null || snapshot.currentRunId === runId)
				) {
					hubFocus = snapshot;
					requestRender();
				}
			} catch {
				// Missing child metadata remains unknown; never infer it from run usage.
			}
		};
		hubFocusUnsubscribe = options.focus.subscribe(runId, () => {
			void load();
		});
		void load();
	}

	function startHubOverlay(): void {
		if (!hubOpen || ctx.mode !== "tui" || hubPromise !== undefined) return;
		const generation = ++hubGeneration;
		let opening: Promise<void>;
		try {
			opening = ctx.ui.custom<void>(
				(hubTui, theme, _keybindings, done) => {
					if (disposed || generation !== hubGeneration || !hubOpen) {
						done(undefined);
						return { render: () => [], invalidate() {} };
					}
					tui = hubTui;
					const component = createAgentHubComponent(
						hubTui,
						theme,
						() => (hubOpen && listView ? { view: listView, selection, stopArmedFor, focus: hubFocus } : null),
						handleHubInput,
						activateHubRow,
						closeHub,
						moveHubSelection,
						now,
					);
					hubDone = () => done(undefined);
					hubComponent = component;
					return component;
				},
				{
					overlay: true,
					overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
					onHandle: (handle) => {
						if (generation === hubGeneration) hubHandle = handle;
						else handle.hide();
					},
				},
			);
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), "error");
			closeHub();
			return;
		}
		hubPromise = opening;
		void opening
			.catch((error) => {
				if (generation === hubGeneration) notify(error instanceof Error ? error.message : String(error), "error");
			})
			.finally(() => {
				if (generation !== hubGeneration) return;
				hubPromise = undefined;
				hubDone = undefined;
				hubHandle = undefined;
				hubComponent = undefined;
				if (hubOpen) closeHub();
				requestRender();
			});
	}

	function removeWidgets(...keys: string[]): void {
		for (const key of keys) ctx.ui.setWidget(key, undefined);
		if (keys.includes(PANEL_WIDGET_KEY)) panelRegistered = false;
	}

	// -- actions ---------------------------------------------------------------

	function updateStatusLine(): void {
		const view = listView;
		try {
			if (!view || (view.runningCount === 0 && !hasQueued(view))) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				return;
			}
			const queued = view.rows.filter((row) => row.status === "queued").length;
			const parts = [`subagents: ${view.runningCount} running`];
			if (queued > 0) parts.push(`${queued} queued`);
			ctx.ui.setStatus(STATUS_KEY, parts.join(", "));
		} catch {
			/* statusline is best-effort */
		}
	}

	function hasQueued(view: AgentListView): boolean {
		return view.rows.some((row) => row.status === "queued");
	}

	function closeView(): void {
		leftArmed = undefined;
		const oldRunId = viewRunId;
		viewRunId = null;
		focusGeneration++;
		focusUnsubscribe?.();
		focusUnsubscribe = undefined;
		focusData = null;
		if (oldRunId !== null && overlayComponent) {
			viewDrafts.set(oldRunId, overlayComponent.editor.getText());
			viewUiState.set(oldRunId, overlayComponent.pane.getState());
		}
		viewData = null;
		selection = null;
		hubOpen = false;
		stopArmedFor = null;
		overlayGeneration++;
		overlayPromise = undefined;
		const done = overlayDone;
		const component = overlayComponent;
		const handle = overlayHandle;
		overlayDone = undefined;
		overlayComponent = undefined;
		overlayHandle = undefined;
		if (done) done();
		else {
			component?.dispose();
			handle?.hide();
		}
		requestRender();
	}

	function openView(runId?: string): void {
		leftArmed = undefined;
		if (hubOpen) closeHub();
		const target = runId ?? manager.list().find((record) => isActiveStatus(record.status))?.id ?? listView?.rows[0]?.id;
		if (target === undefined) return;
		if (viewRunId !== target) {
			if (viewRunId !== null) closeView();
			viewRunId = target;
			const generation = ++focusGeneration;
			focusUnsubscribe = options.focus.subscribe(target, () => {
				if (disposed || generation !== focusGeneration || viewRunId !== target) return;
				void loadFocus(target, generation);
			});
		}
		hubOpen = false;
		selection = target;
		stopArmedFor = null;
		void refresh();
		void loadFocus(target, focusGeneration);
	}
	function navigateViewedRun(runId: string, delta: number): void {
		const rows = listView?.rows.filter((row) => row.capabilities.viewable) ?? [];
		const index = rows.findIndex((row) => row.id === runId);
		if (index < 0 || rows.length < 2) return;
		const next = rows[(index + delta + rows.length) % rows.length];
		if (next) openView(next.id);
	}
	function openHub(): void {
		leftArmed = undefined;
		if (ctx.mode !== "tui") {
			notify("The Team Hub is available in Pi's interactive TUI.", "warning");
			return;
		}
		if (hubOpen) {
			closeHub();
			return;
		}
		if (viewRunId !== null) closeView();
		hubOpen = true;
		selection = activatePanel();
		syncHubFocus();
		stopArmedFor = null;
		void refresh();
		startHubOverlay();
		requestRender();
	}

	/** x on a row: two-step stop for active runs, immediate dismiss for finished ones. */
	async function handleStop(taskId: string): Promise<void> {
		const row = listView?.rows.find((candidate) => candidate.id === taskId);
		if (!row) return;
		if (row.capabilities.stoppable) {
			const outcome = applyStopConfirm(stopArmedFor, taskId, { confirm: true });
			stopArmedFor = outcome.armedFor;
			if (outcome.fire) {
				stopArmedFor = null;
				try {
					if (await manager.stop(taskId)) notify(`Abort accepted for "${row.description}".`, "info");
					else notify(`Cannot abort "${row.description}" right now.`, "warning");
				} catch (error) {
					notify(error instanceof Error ? error.message : String(error), "error");
				}
			}
			requestRender();
			return;
		}
		if (row.status === "completed" || row.status === "stopped" || row.status === "error" || row.status === "aborted") {
			dismissed.add(taskId);
			stopArmedFor = null;
			if (viewRunId === taskId) closeView();
			void refresh();
			return;
		}
		stopArmedFor = null;
		notify(`"${row.type}" has no attachable handle here — it cannot be aborted from this session.`, "warning");
		requestRender();
	}

	async function abortViewedRun(runId: string): Promise<void> {
		const row = listView?.rows.find((candidate) => candidate.id === runId);
		if (!row?.capabilities.stoppable) {
			notify(`Cannot abort "${row?.type ?? runId}" in its current state.`, "warning");
			return;
		}
		try {
			await options.focus.abort(runId);
			notify(`Abort accepted for "${row.description}".`, "info");
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), "error");
		}
		void refresh();
		requestRender();
	}

	async function handleAttach(agentId: string): Promise<void> {
		try {
			if (await manager.attachPane(agentId)) notify(`Attached to "${agentId}".`, "info");
			else notify(`No live process pane is available for "${agentId}".`, "warning");
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), "error");
		}
	}

	async function loadFocus(runId: string, generation: number): Promise<void> {
		const revision = ++focusReadRevision;
		try {
			const snapshot = await options.focus.read(runId);
			if (
				disposed ||
				generation !== focusGeneration ||
				revision !== focusReadRevision ||
				viewRunId !== runId ||
				snapshot.runId !== runId ||
				(snapshot.currentRunId !== null && snapshot.currentRunId !== runId)
			)
				return;
			focusData = snapshot;
			updateFocusedView(runId, generation, snapshot);
		} catch (error) {
			if (generation === focusGeneration && revision === focusReadRevision && viewRunId === runId) {
				notify(error instanceof Error ? error.message : String(error), "error");
			}
		}
	}
	function updateFocusedView(runId: string, generation: number, snapshot: AgentFocusSnapshot): void {
		const record = manager.get(runId);
		if (!record || disposed || generation !== focusGeneration || viewRunId !== runId) return;
		if (snapshot.runId !== runId || (snapshot.currentRunId !== null && snapshot.currentRunId !== runId)) return;
		viewData = {
			view: buildAgentTranscriptView(record, snapshot.items, {
				now,
				attachable: manager.canAttachPane(runId),
			}),
			focus: snapshot,
		};
		viewRevision++;
		startViewOverlay();
		requestRender();
	}

	/** Composer routes only explicit child controls, steer, or cold continuation. */
	async function routeComposer(text: string, expectedRunId?: string): Promise<boolean> {
		const runId = expectedRunId ?? viewRunId;
		if (!runId || viewRunId !== runId) return false;
		const generation = focusGeneration;
		const row = listView?.rows.find((candidate) => candidate.id === runId);
		if (!row) return false;
		if (text.startsWith("/")) {
			const [command, ...parts] = text.trim().split(/\s+/);
			const value = parts.join(" ");
			const controls = focusData?.runId === runId ? focusData.capabilities : [];
			let control: ChildControlCommand | undefined;
			if (command === "/model" && value && controls.includes("model")) control = { type: "model", model: value };
			else if (command === "/thinking" && value && controls.includes("thinking"))
				control = { type: "thinking", thinking: value as ThinkingLevel };
			else if (command === "/compact" && parts.length === 0 && controls.includes("compact"))
				control = { type: "compact" };
			if (!control) {
				notify(`Unsupported or unavailable child command: ${text}.`, "warning");
				return false;
			}
			const controlRevision = focusReadRevision;
			try {
				const next = await options.focus.control(runId, control);
				if (
					generation !== focusGeneration ||
					viewRunId !== runId ||
					next.runId !== runId ||
					(next.currentRunId !== null && next.currentRunId !== runId)
				)
					return false;
				if (focusReadRevision === controlRevision) {
					focusReadRevision++;
					focusData = next;
				}
				updateFocusedView(runId, generation, focusData?.runId === runId ? focusData : next);
				return true;
			} catch (error) {
				if (generation === focusGeneration && viewRunId === runId)
					overlayComponent?.showFeedback(error instanceof Error ? error.message : String(error));
				return false;
			}
		}
		try {
			if (row.capabilities.steerable) {
				await options.focus.steer(runId, text);
				if (generation === focusGeneration && viewRunId === runId)
					notify(`Steering accepted by "${row.type}".`, "info");
			} else if (row.capabilities.resumable) {
				const resumed = await options.focus.continue(runId, text);
				if (generation === focusGeneration && viewRunId === runId) openView(resumed.runId);
			} else {
				notify(`"${row.type}" accepts neither steering nor resume in its current state.`, "warning");
				return false;
			}
		} catch (error) {
			if (generation === focusGeneration && viewRunId === runId)
				overlayComponent?.showFeedback(error instanceof Error ? error.message : String(error));
			return false;
		}
		if (generation === focusGeneration && viewRunId === runId) void refresh();
		return true;
	}

	function notify(message: string, type?: "info" | "warning" | "error"): void {
		if (viewRunId !== null && overlayComponent) {
			overlayComponent.showFeedback(message);
			return;
		}
		try {
			ctx.ui.notify(message, type);
		} catch {
			/* notifications are best-effort */
		}
	}

	// -- key routing (docs/ui/AGENT-PANEL-AND-VIEW.md §5) -------------------------

	function mainEditorOwnsInput(): boolean {
		const focused: unknown = (tui as unknown as { focusedComponent?: unknown } | undefined)?.focusedComponent;
		const editor = focused instanceof Editor ? focused : undefined;
		return (
			!(tui?.hasOverlay?.() ?? false) &&
			(focused == null || editor !== undefined) &&
			!(editor?.isShowingAutocomplete() ?? false) &&
			!(editor === undefined && foreignEditor())
		);
	}

	const unsubscribeInput = ctx.ui.onTerminalInput((data) => {
		const released = isKeyRelease(data);
		const repeated = isKeyRepeat(data);
		const leftPress = !released && matchesKey(data, "left");
		// Releases do not interrupt a pair of deliberate Left presses. Repeats
		// disarm it, so Kitty-aware terminals cannot open the Hub by holding Left.
		if (repeated) leftArmed = undefined;
		else if (!released && !leftPress) leftArmed = undefined;
		if (!enabled()) {
			if (viewRunId !== null) {
				closeView();
				return { consume: true };
			}
			if (hubOpen) {
				closeHub();
				return { consume: true };
			}
			leftArmed = undefined;
			return undefined;
		}
		if (hubOpen) {
			if (hubHandle && !hubHandle.isFocused()) return undefined;
			if (!released) handleHubInput(data);
			return { consume: true };
		}
		if (released) return undefined;
		if (matchesKey(data, "alt+g")) {
			openHub();
			return { consume: true };
		}
		if (viewRunId !== null) {
			leftArmed = undefined;
			return undefined;
		}
		// Terminal listeners precede Pi's focused component. getEditorText()
		// alone can read a detached, empty Main editor while a dialog owns input.
		// Pi exposes overlay visibility but not the focus owner: follow the
		// reference fleet-list's narrowly typed peek, then use Editor's public
		// cursor/autocomplete APIs.
		//
		// A foreign editor that still IS an Editor (a styled subclass, e.g.
		// pi-style's CustomEditor derivative) keeps public cursor/autocomplete
		// semantics, so the document-start gestures stay observable and safe.
		// Defer only when a foreign editor is installed AND no Editor-shaped
		// component is focused: an opaque component — or an unobservable focus
		// owner — can make cursor/autocomplete reads lie, so its keys are never
		// claimed.
		const focused: unknown = (tui as unknown as { focusedComponent?: unknown } | undefined)?.focusedComponent;
		const editor = focused instanceof Editor ? focused : undefined;
		const text = editorText();
		const ownsMain = mainEditorOwnsInput();
		if (!ownsMain) {
			leftArmed = undefined;
			stopArmedFor = null;
			if (selection !== null) {
				selection = null;
				requestRender();
			}
			return undefined;
		}

		if (leftPress && !repeated) {
			if (stopArmedFor !== null || (text !== "" && selection !== null)) {
				stopArmedFor = null;
				if (text !== "") selection = null;
				requestRender();
			}
			const cursor = editor?.getCursor();
			// Without an observed native editor, only an empty prompt is safe.
			// With one, require the start of the entire document, not a line start.
			const atStart = cursor ? cursor.line === 0 && cursor.col === 0 : text === "";
			if (atStart) {
				const sessionId = ctx.sessionManager.getSessionId();
				const pressedAt = now();
				if (
					leftArmed !== undefined &&
					leftArmed.editor === editor &&
					leftArmed.sessionId === sessionId &&
					leftArmed.text === text &&
					pressedAt - leftArmed.pressedAt >= 0 &&
					pressedAt - leftArmed.pressedAt <= HUB_DOUBLE_LEFT_MS
				) {
					openHub();
					return { consume: true };
				}
				leftArmed = { editor, sessionId, text, pressedAt };
			} else leftArmed = undefined;
			// The first press (and ordinary cursor movement) belongs to Pi.
			return undefined;
		}

		const rows = inlineListView?.rows ?? [];
		if (text !== "" || rows.length === 0) {
			leftArmed = undefined;
			stopArmedFor = null;
			if (selection !== null) {
				selection = null;
				requestRender();
			}
			return undefined;
		}

		if (selection !== null) {
			if (data === "o" && selection !== "main" && rows.find((row) => row.id === selection)?.capabilities.attachable) {
				void handleAttach(selection);
				return { consume: true };
			}
			const action = dispatchPanelKey(data, selection, rows, "panel");
			switch (action.kind) {
				case "select":
					selection = action.selection;
					stopArmedFor = null;
					requestRender();
					return { consume: true };
				case "clear":
					if (hubOpen) closeHub();
					else selection = null;
					stopArmedFor = null;
					requestRender();
					return { consume: true };
				case "enter":
					if (action.taskId === null) {
						if (hubOpen) closeHub();
						else selection = null;
						requestRender();
						return { consume: true };
					}
					openView(action.taskId);
					return { consume: true };
				case "stop":
					void handleStop(action.taskId);
					return { consume: true };
				default:
					if (hubOpen) closeHub();
					else selection = null;
					stopArmedFor = null;
					requestRender();
					return undefined;
			}
		}

		if (rows.length > 0 && matchesKey(data, "down")) {
			selection = activatePanel();
			stopArmedFor = null;
			requestRender();
			return { consume: true };
		}
		return undefined;
	});

	disposers.push(unsubscribeInput);

	// -- snapshot refresh ----------------------------------------------------------

	async function refresh(): Promise<void> {
		if (disposed) return;
		if (!enabled() && viewRunId !== null) closeView();
		if (refreshing) {
			refreshQueued = true;
			return;
		}
		refreshing = true;
		try {
			await collectActivity();
			if (disposed) return;
			listView = buildAgentListView(manager, {
				dismissedIds: dismissed,
				activityByRunId,
				now,
			});
			inlineListView = {
				...listView,
				rows: listView.rows.filter((row) => isActiveStatus(row.status) || row.resourceState === "cleanup-unconfirmed"),
			};

			if (hubOpen) syncHubFocus();
			updateStatusLine();

			if (enabled() && inlineListView.rows.length > 0) {
				if (!panelRegistered) installPanel();
			} else if (panelRegistered) {
				removeWidgets(PANEL_WIDGET_KEY);
			}

			const runId = viewRunId;
			if (runId !== null) {
				const record = manager.get(runId);
				if (!record) {
					closeView();
				} else {
					const historicalItems = await transcripts.getTranscript(record);
					const candidate = focusData?.runId === runId ? focusData : null;
					const focused =
						candidate && (candidate.currentRunId === null || candidate.currentRunId === runId) ? candidate : null;
					const items = focused && !focused.closed ? focused.items : historicalItems;
					if (!disposed && viewRunId === runId) {
						viewData = {
							view: buildAgentTranscriptView(record, items, {
								now,
								attachable: manager.canAttachPane(runId),
							}),
							...(focused ? { focus: focused } : {}),
						};
						viewRevision++;
						startViewOverlay();
					}
				}
			}

			ensureTick();
		} finally {
			refreshing = false;
		}
		requestRender();
		if (refreshQueued) {
			refreshQueued = false;
			void refresh();
		}
	}

	/** Fetch bounded transcripts only for latest activity; RPC supplies run counters. */
	async function collectActivity(): Promise<void> {
		const records = manager
			.list()
			.filter((record) => !(dismissed.has(record.id) && !isActiveStatus(record.status)))
			.slice(0, 12);
		const entries = await Promise.all(
			records.map(async (record) => {
				try {
					const items = await transcripts.getTranscript(record);
					const activity = activityFromTranscript(items);
					return activity === undefined ? undefined : ([record.id, activity] as const);
				} catch {
					return undefined;
				}
			}),
		);
		activityByRunId.clear();
		for (const entry of entries) {
			if (entry !== undefined) activityByRunId.set(entry[0], entry[1]);
		}
	}

	function ensureTick(): void {
		const anyActive = manager.list().some((record) => isActiveStatus(record.status));
		if (anyActive) {
			if (tickTimer === undefined) tickTimer = setInterval(() => void refresh(), TICK_MS);
			return;
		}
		clearTick();
	}

	function clearTick(): void {
		if (tickTimer !== undefined) {
			clearInterval(tickTimer);
			tickTimer = undefined;
		}
	}

	// Lifecycle events trigger a debounced snapshot refresh.
	const unsubscribeLifecycle = manager.subscribe(() => {
		if (!disposed) void refresh();
	});
	disposers.push(unsubscribeLifecycle);
	const unsubscribePresentation = manager.subscribePresentation(() => {
		if (!disposed) void refresh();
	});
	disposers.push(unsubscribePresentation);
	// setWidget invokes its factory synchronously in Pi. Capture the native TUI
	// even before the first child exists, then remove the empty widget: Hub
	// shortcuts must still respect dialogs when there is no inline roster.
	if (enabled() && ctx.mode === "tui") {
		installPanel();
		removeWidgets(PANEL_WIDGET_KEY);
	}
	void refresh();

	return {
		openView,
		openHub,
		closeView,
		refresh: () => {
			void refresh();
		},
		isViewOpen: () => viewRunId !== null,
		isMainEditorFocused: () => !hubOpen && viewRunId === null && selection === null && mainEditorOwnsInput(),
		dispose(): void {
			if (disposed) return;
			disposed = true;
			leftArmed = undefined;
			clearTick();
			for (const dispose of disposers.splice(0)) {
				try {
					dispose();
				} catch {
					/* teardown is best-effort */
				}
			}
			try {
				closeView();
				closeHub();
				removeWidgets(PANEL_WIDGET_KEY);
				ctx.ui.setStatus(STATUS_KEY, undefined);
			} catch {
				/* stale context during shutdown */
			}
			viewData = null;
			listView = null;
			inlineListView = null;
			selection = null;
			viewDrafts.clear();
			viewUiState.clear();
		},
	};
}
