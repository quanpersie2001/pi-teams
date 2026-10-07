import { DynamicBorder, type Theme, type ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { TranscriptItem } from "../../domain/transcript.js";
import {
	renderTranscriptItems,
	type TranscriptHitRegion,
	type TranscriptRenderContext,
	toolRenderDefinitions,
} from "./transcript-renderer.js";
export interface AgentTranscriptPaneState {
	scrollBack: number;
	toolsExpanded: boolean;
	toolExpansion: readonly (readonly [string, boolean])[];
}

export interface AgentTranscriptPane {
	render(width: number, rows: number): string[];
	scrollBy(delta: number): void;
	resetScroll(): void;
	toggleToolsExpanded(): boolean;
	getState(): AgentTranscriptPaneState;
	restoreState(state: AgentTranscriptPaneState | undefined): void;
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	invalidate(): void;
	dispose(): void;
}

export function createAgentTranscriptPane(
	tui: TUI,
	theme: Pick<Theme, "fg">,
	options: {
		cwd: string;
		read(): readonly TranscriptItem[];
		signature(): string;
		outputPad?: number;
	},
): AgentTranscriptPane {
	let scrollBack = 0;
	let toolsExpanded = false;
	let lastSignature: string | undefined;
	let cachedItems: readonly TranscriptItem[] = [];
	let cachedBody: { signature: string; width: number; lines: string[] } | undefined;
	let itemCache = new WeakMap<TranscriptItem, Component>();
	let canonicalItemsById = new Map<string, TranscriptItem>();
	let cachedRegions: TranscriptHitRegion[] = [];
	let visibleBodyStart = 0;
	let visibleBodyRows = 0;
	let visibleBodyTop = 0;
	const toolExpansion = new Map<string, boolean>();
	const toolComponents = new Set<ToolExecutionComponent>();
	const context: TranscriptRenderContext = {
		tui,
		cwd: options.cwd,
		fg: (color, text) => theme.fg(color as never, text),
		toolDefinitions: toolRenderDefinitions(options.cwd),
		toolComponents,
		...(options.outputPad !== undefined ? { outputPad: options.outputPad } : {}),
		toolsExpanded,
		toolExpansion,
	};
	const border = new DynamicBorder((line: string) => theme.fg("border", line));

	function ensureBody(width: number): string[] {
		const signature = options.signature();
		if (signature !== lastSignature) {
			lastSignature = signature;
			const nextCanonical = new Map<string, TranscriptItem>();
			cachedItems = options.read().map((item) => {
				if (!item.id || item.revision === undefined) return item;
				const previous = canonicalItemsById.get(item.id);
				const canonical = previous?.revision === item.revision ? previous : item;
				nextCanonical.set(item.id, canonical);
				return canonical;
			});
			canonicalItemsById = nextCanonical;
			cachedBody = undefined;
		}
		if (!cachedBody || cachedBody.signature !== signature || cachedBody.width !== width) {
			context.toolsExpanded = toolsExpanded;
			cachedRegions = [];
			const lines = renderTranscriptItems(cachedItems, width, context, itemCache, cachedRegions);
			cachedBody = {
				signature,
				width,
				lines: lines.length > 0 ? lines : [theme.fg("dim", "(waiting for first output…)")],
			};
		}
		return cachedBody.lines;
	}

	return {
		render(width: number, rows: number): string[] {
			if (width <= 0 || rows <= 0) return [];
			const body = ensureBody(width);
			const borderLines = border.render(width);
			const chromeRows = borderLines.length + 2;
			const showChrome = rows > chromeRows;
			const bodyRows = Math.max(0, rows - (showChrome ? chromeRows : 0));
			scrollBack = Math.max(0, Math.min(scrollBack, Math.max(0, body.length - bodyRows)));
			const end = body.length - scrollBack;
			const start = Math.max(0, end - bodyRows);
			visibleBodyStart = start;
			visibleBodyRows = bodyRows;
			visibleBodyTop = showChrome ? borderLines.length + 1 : 0;
			const visible = body.slice(start, end);
			const lines: string[] = [];
			if (showChrome) {
				lines.push(...borderLines);
				lines.push(start > 0 ? theme.fg("dim", ` ↑ ${start} earlier line(s) · pgup`) : "");
			}
			lines.push(...visible);
			if (showChrome) lines.push(scrollBack > 0 ? theme.fg("dim", ` ↓ ${scrollBack} newer line(s) · pgdn`) : "");
			while (lines.length < rows) lines.push("");
			return lines.slice(0, rows).map((line) => truncateToWidth(line, width));
		},
		scrollBy(delta: number): void {
			scrollBack = Math.max(0, scrollBack + delta);
			cachedBody = undefined;
		},
		resetScroll(): void {
			scrollBack = 0;
			cachedBody = undefined;
		},
		toggleToolsExpanded(): boolean {
			toolExpansion.clear();
			toolsExpanded = !toolsExpanded;
			for (const component of toolComponents) component.setExpanded(toolsExpanded);
			cachedBody = undefined;
			return toolsExpanded;
		},
		getState(): AgentTranscriptPaneState {
			return { scrollBack, toolsExpanded, toolExpansion: [...toolExpansion] };
		},
		restoreState(state: AgentTranscriptPaneState | undefined): void {
			scrollBack = Math.max(0, state?.scrollBack ?? 0);
			toolsExpanded = state?.toolsExpanded ?? false;
			toolExpansion.clear();
			for (const [id, expanded] of state?.toolExpansion ?? []) toolExpansion.set(id, expanded);
			for (const component of toolComponents) component.setExpanded(toolsExpanded);
			cachedBody = undefined;
		},
		handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			if (event.type !== "click" || event.button !== "left") return undefined;
			const bodyRow = event.y - visibleBodyTop;
			if (bodyRow < 0 || bodyRow >= visibleBodyRows) return undefined;
			const line = visibleBodyStart + bodyRow;
			const region = cachedRegions.find((candidate) => line >= candidate.start && line < candidate.end);
			if (!region?.component.handleMouse) return undefined;
			const result = region.component.handleMouse({
				...event,
				y: line - region.start,
				height: Math.max(1, region.end - region.start),
			});
			if (result?.handled && region.toolId) {
				const wasExpanded = toolExpansion.get(region.toolId) ?? toolsExpanded;
				toolExpansion.set(region.toolId, !wasExpanded);
				cachedBody = undefined;
			}
			return result;
		},
		invalidate(): void {
			itemCache = new WeakMap();
			toolComponents.clear();
			cachedBody = undefined;
		},
		dispose(): void {
			itemCache = new WeakMap();
			toolComponents.clear();
			toolExpansion.clear();
			cachedItems = [];
			cachedBody = undefined;
		},
	};
}
