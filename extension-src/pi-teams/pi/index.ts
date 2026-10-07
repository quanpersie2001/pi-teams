import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createAgentFocusPort } from "../app/focus-service.js";
import { createPiSubagentsApp } from "../app/index.js";
import type { RestoreObservers } from "../app/run-registry.js";
import { WorktreeService } from "../app/worktree-service.js";
import { isTerminalStatus } from "../domain/agent-run.js";
import { DEFAULT_SUBAGENTS_SETTINGS } from "../domain/config.js";
import type { InboxRecipient } from "../domain/message.js";
import { loadAgentMarkdownFiles, resolveAgentSourceDirs } from "./agent-files.js";
import { installAgentMentionAutocomplete } from "./agent-mention-autocomplete.js";
import { shouldSkipExtensionInChildSession } from "./child-guard.js";
import { registerAgentsCommand, registerBackendCommand } from "./commands.js";
import { loadSubagentsSettings } from "./config-host.js";
import { createPiDeliveryHost, createPiInboxDelivery } from "./delivery-host.js";
import { ProcessAgentExecutionBackend, resolveLauncherHint, resolveSessionLauncherHint } from "./process-backend.js";
import { createSubagentRunStore } from "./registry-host.js";
import { type SubagentsRpcWiring, wireSubagentsRpc } from "./rpc.js";
import { registerInboxTools, registerParentMessageInspectionTool, registerSubagentTools } from "./tools.js";
import { createPiTranscriptSource } from "./transcript-host.js";
import { installSubagentsUi, type SubagentsUiHandle } from "./ui-host.js";
import { createGitRunner, worktreeTmpRoot } from "./worktree-host.js";

function restoreObservers(backend: ProcessAgentExecutionBackend): RestoreObservers {
	return {
		sessionPresent: (entry) => entry.handle?.kind === "process",
		async detectCompletion(entry) {
			if (!entry.handle) return { finished: false };
			const status = await backend.probeSerialized(entry.handle, entry.id);
			if (status.outcomeUnavailable && isTerminalStatus(entry.status)) return { finished: false };
			if (status.state === "completed" || status.state === "failed" || status.state === "stopped") {
				return {
					finished: true,
					outcome: status.state === "failed" ? "failed" : status.state,
					...(status.result !== undefined ? { result: status.result } : {}),
				};
			}
			return { finished: false };
		},
		async resourceAlive(entry) {
			if (!entry.handle) return false;
			const status = await backend.probeSerialized(entry.handle, entry.id);
			return status.state === "disconnected" ? undefined : true;
		},
	};
}

/** Parent extension. Child sessions load only their explicit control bridge. */
export default function (pi: ExtensionAPI): void {
	if (shouldSkipExtensionInChildSession()) return;
	const configCwd = process.cwd();
	const agentDir = getAgentDir();
	let latestCtx: ExtensionContext | undefined;
	const backend = new ProcessAgentExecutionBackend({
		launcherHint: resolveLauncherHint(),
		getParentModel: () => {
			const model = latestCtx?.model;
			return model ? `${model.provider}/${model.id}` : undefined;
		},
	});
	const app = createPiSubagentsApp({
		sources: resolveAgentSourceDirs(configCwd, agentDir),
		loader: loadAgentMarkdownFiles,
		settings: { ...DEFAULT_SUBAGENTS_SETTINGS },
		backends: [backend],
		cwd: configCwd,
		configCwd,
		getSessionId: () => latestCtx?.sessionManager.getSessionId() ?? "unknown-session",
		worktreeService: new WorktreeService({
			runGit: createGitRunner(),
			tmpRoot: worktreeTmpRoot(configCwd),
			settings: { ...DEFAULT_SUBAGENTS_SETTINGS },
		}),
		runStore: createSubagentRunStore(configCwd),
		restoreObservers: restoreObservers(backend),
		deliveryHost: createPiDeliveryHost(pi, () => latestCtx),
		sendToParent: createPiInboxDelivery(pi, () => latestCtx),
	});
	const transcripts = createPiTranscriptSource({ backends: [backend] });
	let uiHandle: SubagentsUiHandle | undefined;
	let rpc: SubagentsRpcWiring | undefined;
	// No message renderer is registered: the teammate-notification customType
	// plus its structured plain-text content IS the renderer contract exported
	// for pi-style companions (docs/INTEGRATION.md); hosts without a renderer
	// display the content verbatim.
	registerAgentsCommand(pi, { manager: app.manager, openHub: () => uiHandle?.openHub() });
	registerBackendCommand(pi, { backend });
	registerSubagentTools(pi, app.manager, app.registry);
	const resolveInboxRecipient = (): InboxRecipient => {
		const sessionId = latestCtx?.sessionManager.getSessionId();
		if (!sessionId) throw new Error("Inbox tools require an active parent session.");
		return { kind: "parent", sessionId };
	};
	registerInboxTools(pi, app.messages, resolveInboxRecipient);
	registerParentMessageInspectionTool(pi, app.messages, resolveInboxRecipient);
	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		rpc?.dispose();
		rpc = wireSubagentsRpc({ events: pi.events, manager: app.manager });
		uiHandle?.dispose();
		const settings = await loadSubagentsSettings(configCwd);
		app.updateSettings(settings);
		// Env override (four launchers) wins over the settings key (auto|headless).
		backend.setLauncherHint(resolveSessionLauncherHint(process.env, settings.backend));
		await app.sessionStart();
		if (ctx.mode === "tui") installAgentMentionAutocomplete(ctx, app.registry);
		uiHandle = installSubagentsUi(ctx, {
			manager: app.manager,
			focus: createAgentFocusPort({ manager: app.manager, transcripts }),
			settings: () => app.manager.currentSettings,
			transcripts,
		});
		rpc.announceReady();
	});
	pi.on("session_before_switch", () => {
		app.delivery?.handleSessionSwitch();
		// Session-bound lifetime (ADR 0007 §1): switching sessions ends the
		// owning session's team — tear its children down before the next
		// session_start re-arms the manager.
		void app.sessionShutdown().catch((error: unknown) => {
			console.warn(`[pi-teams] session teardown failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	});
	pi.on("session_shutdown", async () => {
		rpc?.dispose();
		rpc = undefined;
		uiHandle?.dispose();
		uiHandle = undefined;
		await app.sessionShutdown();
		latestCtx = undefined;
	});
}
