import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createAgentFocusPort } from "../app/focus-service.js";
import { createPiSubagentsApp } from "../app/index.js";
import { TaskBoardService } from "../app/task-board-service.js";
import { WorktreeService } from "../app/worktree-service.js";
import { DEFAULT_SUBAGENTS_SETTINGS } from "../domain/config.js";
import { loadAgentMarkdownFiles, resolveAgentSourceDirs } from "./agent-files.js";
import { installAgentMentionAutocomplete, installTeammateMentionRouting } from "./agent-mention-autocomplete.js";
import { shouldSkipExtensionInChildSession } from "./child-guard.js";
import { registerAgentsCommand, registerBackendCommand } from "./commands.js";
import { loadSubagentsSettings } from "./config-host.js";
import { createPiDeliveryHost, installLeadMailbox } from "./delivery-host.js";
import { ProcessAgentExecutionBackend, resolveLauncherHint, resolveSessionLauncherHint } from "./process-backend.js";
import { createSubagentRunStore } from "./registry-host.js";
import { type SubagentsRpcWiring, wireSubagentsRpc } from "./rpc.js";
import { createTeamTaskTools } from "./team-task-tools.js";
import { createPiTeamStore } from "./teams-host.js";
import { registerLeadSendMessageTool, registerSubagentTools } from "./tools.js";
import { createPiTranscriptSource } from "./transcript-host.js";
import { installSubagentsUi, type SubagentsUiHandle } from "./ui-host.js";
import { createGitRunner, worktreeTmpRoot } from "./worktree-host.js";

/** Parent extension. Children load only specialist tools and allowlisted presentation extensions. */
export default function (pi: ExtensionAPI): void {
	if (shouldSkipExtensionInChildSession()) return;
	const configCwd = process.cwd();
	const agentDir = getAgentDir();
	let latestCtx: ExtensionContext | undefined;
	const backend = new ProcessAgentExecutionBackend({
		launcherHint: resolveLauncherHint(),
		getParentExtensionPaths: () => [
			...new Set(
				pi
					.getCommands()
					.filter((command) => command.source === "extension" && isAbsolute(command.sourceInfo.path))
					.map((command) => command.sourceInfo.path),
			),
		],
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
		deliveryHost: createPiDeliveryHost(pi, () => latestCtx),
		// turn_end joins slow parallel Agent calls; a long safety fallback avoids
		// trapping completions if a turn is aborted before its boundary fires.
		deliveryOptions: { batchWindowMs: 60_000 },
		createTeamStore: (sessionId) => createPiTeamStore(configCwd, sessionId),
	});
	const transcripts = createPiTranscriptSource({ backends: [backend] });
	let uiHandle: SubagentsUiHandle | undefined;
	let board: TaskBoardService | undefined;
	let closeLeadMailbox: (() => void) | undefined;
	let stopMentionRouting: (() => void) | undefined;
	let rpc: SubagentsRpcWiring | undefined;
	// No message renderer is registered: the teammate-notification customType
	// plus its structured plain-text content IS the renderer contract exported
	// for pi-style companions (docs/INTEGRATION.md); hosts without a renderer
	// display the content verbatim.
	registerAgentsCommand(pi, { manager: app.manager, openHub: () => uiHandle?.openHub() });
	registerBackendCommand(pi, { backend });
	registerSubagentTools(pi, app.manager, app.registry, app.delivery);
	pi.on("turn_end", () => app.delivery?.finishSpawnBatch());
	registerLeadSendMessageTool(
		pi,
		() => app.mailbox,
		() => app.teams?.current?.members.map((member) => member.name) ?? [],
	);
	for (const tool of createTeamTaskTools(() => board)) pi.registerTool(tool);

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		board = undefined;
		rpc?.dispose();
		rpc = wireSubagentsRpc({ events: pi.events, manager: app.manager });
		uiHandle?.dispose();
		closeLeadMailbox?.();
		stopMentionRouting?.();
		closeLeadMailbox = undefined;
		stopMentionRouting = undefined;
		const settings = await loadSubagentsSettings(configCwd);
		app.updateSettings(settings);
		// Env override (four launchers) wins over the settings key (auto|headless).
		backend.setLauncherHint(resolveSessionLauncherHint(process.env, settings.backend));
		await app.sessionStart();
		const team = app.teams;
		board = team ? new TaskBoardService({ teamDir: team.teamDir, self: "lead" }) : undefined;
		if (app.mailbox)
			closeLeadMailbox = installLeadMailbox(
				pi,
				app.mailbox,
				(name) => app.teams?.current?.members.find((member) => member.name === name)?.color,
			);
		uiHandle = installSubagentsUi(ctx, {
			manager: app.manager,
			focus: createAgentFocusPort({ manager: app.manager, transcripts }),
			settings: () => app.manager.currentSettings,
			transcripts,
		});
		if (ctx.mode === "tui") {
			const routing = {
				names: () => app.manager.list().flatMap((run) => (run.teammateName && run.handle ? [run.teammateName] : [])),
				isMainEditorFocused: () => uiHandle?.isMainEditorFocused() ?? false,
				send: (target: string, text: string) =>
					app.mailbox?.send(target, text) ?? { delivered: false as const, error: "No active team" },
			};
			installAgentMentionAutocomplete(ctx, app.registry, routing);
			stopMentionRouting = installTeammateMentionRouting(ctx, routing);
		}
		rpc.announceReady();
	});
	pi.on("session_before_switch", async () => {
		board = undefined;
		closeLeadMailbox?.();
		stopMentionRouting?.();
		closeLeadMailbox = undefined;
		stopMentionRouting = undefined;
		app.delivery?.handleSessionSwitch();
		// Session-bound lifetime (ADR 0007 §1): switching sessions ends the
		// owning session's team — tear its children down before the next
		// session_start re-arms the manager.
		try {
			await app.sessionShutdown();
		} catch (error) {
			console.warn(`[pi-teams] session teardown failed: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
	});
	pi.on("session_shutdown", async () => {
		board = undefined;
		closeLeadMailbox?.();
		stopMentionRouting?.();
		closeLeadMailbox = undefined;
		stopMentionRouting = undefined;
		rpc?.dispose();
		rpc = undefined;
		uiHandle?.dispose();
		uiHandle = undefined;
		await app.sessionShutdown();
		latestCtx = undefined;
	});
}
