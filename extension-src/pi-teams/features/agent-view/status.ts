import { isAbsolute } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type {
	AgentFocusSnapshot,
	AgentGitSnapshot,
	AgentSessionUsage,
	AgentTranscriptView,
} from "../../domain/ui-view.js";

interface DetachedStatusProvider {
	readGit?(cwd: string): Promise<AgentGitSnapshot | undefined>;
	renderStatus?(
		theme: Theme,
		width: number,
		snapshot: {
			model?: string | undefined;
			provider?: string | undefined;
			reasoning?: boolean | undefined;
			git?: AgentGitSnapshot | undefined;
			thinkingLevel?: string | undefined;
			cwd?: string | undefined;
			sessionName?: string | undefined;
			context?: { currentTokens?: number | undefined; windowTokens?: number | undefined; percent?: number | undefined };
			usage?: (AgentSessionUsage & { streaming: boolean }) | undefined;
		},
	): string[] | undefined;
}

/** Optional pi-style renderer, supplied only with the selected child's data. */
export function renderAgentStatus(
	theme: Theme,
	width: number,
	view: AgentTranscriptView,
	focus: AgentFocusSnapshot | undefined,
): string[] | undefined {
	const provider = (globalThis as Record<symbol, DetachedStatusProvider | undefined>)[
		Symbol.for("@quandev104/pi-style:detached-editor")
	];
	return provider?.renderStatus?.(theme, width, agentStatusSnapshot(view, focus));
}

/** Shared child-only metadata for the footer and detached composer. */
export function agentStatusSnapshot(view: AgentTranscriptView, focus: AgentFocusSnapshot | undefined) {
	const native =
		!focus?.closed &&
		focus?.runId === view.agentId &&
		(focus.currentRunId === null || focus.currentRunId === view.agentId) &&
		view.resourceState !== "closed"
			? focus
			: undefined;
	const used = native?.context?.usedTokens;
	const window = native?.context?.windowTokens;
	return {
		model: native?.modelName ?? native?.model ?? undefined,
		provider: native?.provider,
		reasoning: native?.reasoning,
		git: native?.git,
		thinkingLevel: native?.thinking ?? undefined,
		cwd: native?.cwd ?? undefined,
		sessionName: view.teammateName ? `@${view.teammateName}` : view.type,
		context: {
			currentTokens: used ?? undefined,
			windowTokens: window ?? undefined,
			percent: used != null && window != null && window > 0 ? (used / window) * 100 : undefined,
		},
		usage: native?.sessionUsage ? { ...native.sessionUsage, streaming: view.status === "running" } : undefined,
	};
}

/** Called by the UI host only, never from a render path. */
export async function readAgentGit(cwd: string): Promise<AgentGitSnapshot | undefined> {
	if (!isAbsolute(cwd)) return undefined;
	const provider = (globalThis as Record<symbol, DetachedStatusProvider | undefined>)[
		Symbol.for("@quandev104/pi-style:detached-editor")
	];
	return provider?.readGit?.(cwd);
}
