// Normalized child RPC/history transcript items rendered with Pi's native
// message and tool components. Paired tool results attach to their call row,
// and a bounded tail's orphan result remains visible as a standalone row.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getMarkdownTheme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component, MarkdownTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { TranscriptItem } from "../../domain/transcript.js";
import type { ThemeFg } from "../../shared/theme.js";

export interface TranscriptRenderContext {
	tui: TUI;
	cwd: string;
	fg: ThemeFg;
	toolDefinitions?: ReadonlyMap<string, unknown>;
	toolComponents?: Set<ToolExecutionComponent>;
	toolsExpanded?: boolean;
	toolExpansion?: ReadonlyMap<string, boolean>;
	outputPad?: number;
}

/** Plain markdown theme fallback for headless render paths and uninitialized themes. */
export function plainMarkdownTheme(): MarkdownTheme {
	const identity = (text: string) => text;
	return {
		heading: identity,
		link: identity,
		linkUrl: identity,
		code: identity,
		codeBlock: identity,
		codeBlockBorder: identity,
		quote: identity,
		quoteBorder: identity,
		hr: identity,
		listBullet: identity,
		bold: identity,
		italic: identity,
		strikethrough: identity,
		underline: identity,
	};
}

/** Safe markdown theme: Pi's initialized theme when present, plain otherwise. */
export function resolveMarkdownTheme(): MarkdownTheme {
	try {
		return getMarkdownTheme();
	} catch {
		return plainMarkdownTheme();
	}
}

export function toolRenderDefinitions(cwd: string): ReadonlyMap<string, unknown> {
	return new Map<string, unknown>([
		["bash", createBashToolDefinition(cwd)],
		["read", createReadToolDefinition(cwd)],
		["edit", createEditToolDefinition(cwd)],
		["write", createWriteToolDefinition(cwd)],
		["grep", createGrepToolDefinition(cwd)],
		["find", createFindToolDefinition(cwd)],
		["ls", createLsToolDefinition(cwd)],
	]);
}

function resultText(item: TranscriptItem): string {
	if (typeof item.text === "string") return item.text;
	const result = item.result;
	if (typeof result === "string") return result;
	if (Array.isArray(result)) {
		return result
			.map((block) => (block && typeof block === "object" && "text" in block ? String(block.text ?? "") : ""))
			.filter(Boolean)
			.join("\n");
	}
	try {
		return result === undefined ? "" : (JSON.stringify(result) ?? "");
	} catch {
		return String(result ?? "");
	}
}

const renderedResults = new WeakMap<ToolExecutionComponent, TranscriptItem>();

function updateToolResult(tool: ToolExecutionComponent, payload: TranscriptItem): void {
	tool.updateResult({
		content: [{ type: "text", text: resultText(payload) }],
		isError: payload.isError === true,
	});
	renderedResults.set(tool, payload);
}

function assistantMessage(item: TranscriptItem): AssistantMessage {
	return {
		role: "assistant",
		content: item.text?.trim() ? [{ type: "text", text: item.text }] : [],
		api: "openai-completions",
		provider: "pi-subagents",
		model: "normalized-transcript",
		// Normalized history has no native billing fields; this shape is needed
		// only by the message renderer, not used as displayed run usage.
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: item.timestamp,
	};
}

/**
 * Render normalized items using Pi's conversation components. Component
 * instances are reused by item identity so a streaming tool row can receive
 * its result without producing a second output row.
 */
export interface TranscriptHitRegion {
	component: Component;
	start: number;
	end: number;
	toolId?: string;
}

export function renderTranscriptItems(
	items: readonly TranscriptItem[],
	width: number,
	ctx: TranscriptRenderContext,
	cache: WeakMap<TranscriptItem, Component>,
	hitRegions?: TranscriptHitRegion[],
): string[] {
	if (width <= 0) return [];
	const renderContext = ctx.toolDefinitions ? ctx : { ...ctx, toolDefinitions: toolRenderDefinitions(ctx.cwd) };
	const results = new Map<string, TranscriptItem>();
	const calls = new Set<string>();
	for (const item of items) {
		if (item.kind === "toolResult" && typeof item.toolCallId === "string") results.set(item.toolCallId, item);
		if (item.kind === "toolCall" && typeof item.toolCallId === "string") calls.add(item.toolCallId);
	}

	const lines: string[] = [];
	for (const item of items) {
		if (item.kind === "toolResult" && item.toolCallId !== undefined && calls.has(item.toolCallId)) continue;
		let component = cache.get(item);
		const result = item.kind === "toolCall" && item.toolCallId !== undefined ? results.get(item.toolCallId) : undefined;
		if (result && component instanceof ToolExecutionComponent && renderedResults.get(component) !== result) {
			updateToolResult(component, result);
		}
		if (!component) {
			component = componentFor(item, renderContext, results);
			cache.set(item, component);
			if (component instanceof ToolExecutionComponent) renderContext.toolComponents?.add(component);
		}
		let toolId: string | undefined;
		if (component instanceof ToolExecutionComponent) {
			toolId = item.toolCallId ?? item.id ?? `${item.toolName ?? "tool"}:${item.timestamp}`;
			component.setExpanded(renderContext.toolExpansion?.get(toolId) ?? renderContext.toolsExpanded ?? false);
		}
		const start = lines.length;
		lines.push(...component.render(width));
		if (component.handleMouse) {
			hitRegions?.push({
				component,
				start,
				end: lines.length,
				...(toolId !== undefined ? { toolId } : {}),
			});
		}
	}
	return lines.map((line) => truncateToWidth(line, width));
}

function componentFor(
	item: TranscriptItem,
	ctx: TranscriptRenderContext,
	results: ReadonlyMap<string, TranscriptItem>,
): Component {
	if (item.kind === "user") {
		return new UserMessageComponent(item.text ?? "", resolveMarkdownTheme(), ctx.outputPad);
	}
	if (item.kind === "assistant") {
		return new AssistantMessageComponent(assistantMessage(item), undefined, undefined, undefined, ctx.outputPad);
	}
	if (item.kind === "toolCall" || item.kind === "toolResult") {
		const callId = item.toolCallId ?? `${item.toolName ?? "tool"}:${item.timestamp}`;
		const result = results.get(callId);
		const toolName = item.toolName ?? result?.toolName ?? "tool";
		const tool = new ToolExecutionComponent(
			toolName,
			callId,
			item.args ?? {},
			{},
			ctx.toolDefinitions?.get(toolName) as never,
			ctx.tui,
			ctx.cwd,
		);
		if (result === undefined && item.kind === "toolCall") tool.markExecutionStarted();
		if (result !== undefined || item.kind === "toolResult") updateToolResult(tool, result ?? item);
		return tool;
	}
	const text = item.text ?? "";
	return {
		render(w: number): string[] {
			return [ctx.fg("dim", truncateToWidth(text, w, "…"))];
		},
		invalidate() {},
	};
}
