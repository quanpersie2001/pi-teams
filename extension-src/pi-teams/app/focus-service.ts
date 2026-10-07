import type { AgentRun } from "../domain/agent-run.js";
import { isTerminalStatus } from "../domain/agent-run.js";
import type { ChildState } from "../domain/child-protocol.js";
import type { TranscriptItem } from "../domain/transcript.js";
import type { AgentFocusPort, AgentFocusSnapshot } from "../domain/ui-view.js";
import type { AgentManager } from "./agent-manager.js";

export interface AgentFocusServiceOptions {
	manager: AgentManager;
	transcripts: {
		getTranscript(run: AgentRun): Promise<readonly TranscriptItem[]>;
	};
}

/** Remote child state is the sole source of live session metadata. */
export function createAgentFocusPort(options: AgentFocusServiceOptions): AgentFocusPort {
	const { manager, transcripts } = options;

	async function project(runId: string, state?: ChildState): Promise<AgentFocusSnapshot> {
		const run = manager.get(runId);
		if (!run) throw new Error(`Unknown agent: "${runId}".`);
		if (state?.currentRunId && state.currentRunId !== runId) {
			throw new Error("Child state belongs to a different run.");
		}
		const closed = isTerminalStatus(run.status);
		const items = !closed && state ? state.transcript.items : await transcripts.getTranscript(run);
		const focus = state?.focus;
		return {
			runId,
			currentRunId: closed ? null : (state?.currentRunId ?? null),
			model: focus?.model ? `${focus.model.provider}/${focus.model.id}` : (run.model ?? null),
			thinking: focus?.thinking ?? null,
			cwd: focus?.cwd ?? null,
			context: focus?.context ? { usedTokens: focus.context.tokens, windowTokens: focus.context.contextWindow } : null,
			capabilities:
				closed || !focus
					? []
					: [
							...focus.capabilities.commands,
							...focus.capabilities.models.map((model) => `model:${model.provider}/${model.id}`),
							...focus.capabilities.thinking.map((level) => `thinking:${level}`),
						],
			items,
			truncatedHead: state ? state.transcript.truncated || state.transcript.offset > 0 : false,
			closed,
		};
	}

	return {
		async read(runId) {
			return project(runId, await manager.readFocusState(runId));
		},
		subscribe(runId, listener) {
			const unsubscribeFocus = manager.subscribeFocus(runId, listener);
			const unsubscribeLifecycle = manager.subscribe((event) => {
				if (event.agentId === runId) listener();
			});
			return () => {
				unsubscribeFocus();
				unsubscribeLifecycle();
			};
		},
		async steer(runId, text) {
			if (!(await manager.steer(runId, text))) throw new Error("Child did not accept steering.");
		},
		async abort(runId) {
			if (!(await manager.stop(runId))) throw new Error("Child did not accept abort.");
		},
		async control(runId, command) {
			return project(runId, await manager.controlFocus(runId, command));
		},
		async continue(runId, text) {
			const continuation = await manager.resume(runId, text);
			return { runId: continuation.id };
		},
	};
}
