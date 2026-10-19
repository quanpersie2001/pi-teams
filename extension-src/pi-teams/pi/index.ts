import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createAgentFocusPort } from "../app/focus-service.js";
import { createPiSubagentsApp } from "../app/index.js";
import { TaskAutomationService } from "../app/task-automation-service.js";
import { TaskBoardService } from "../app/task-board-service.js";
import { TaskExecutionService } from "../app/task-execution-service.js";
import { WorktreeService } from "../app/worktree-service.js";
import { DEFAULT_SUBAGENTS_SETTINGS } from "../domain/config.js";
import { loadAgentMarkdownFiles, resolveAgentSourceDirs } from "./agent-files.js";
import { installAgentMentionAutocomplete, installTeammateMentionRouting } from "./agent-mention-autocomplete.js";
import { shouldSkipExtensionInChildSession } from "./child-guard.js";
import { registerAgentsCommand, registerBackendCommand } from "./commands.js";
import { loadSubagentsSettings } from "./config-host.js";
import { createPiDeliveryHost, installLeadMailbox } from "./delivery-host.js";
import { registerModelTools } from "./model-tools.js";
import { type PeerRuntimeHandle, startPeerRuntime } from "./peer-runtime.js";
import { registerPeerTools, reviewHeldMessages } from "./peer-tools.js";
import { ProcessAgentExecutionBackend, resolveLauncherHint, resolveSessionLauncherHint } from "./process-backend.js";
import { createSubagentRunStore, teamsArtifactDir } from "./registry-host.js";
import { type SubagentsRpcWiring, wireSubagentsRpc } from "./rpc.js";
import { registerSettingsCommand } from "./settings-command.js";
import { summarizeRelevantTasks, TaskReminderCadence } from "./task-reminders.js";
import { createTasksTools } from "./tasks-tools.js";
import { eligibleTeammateNames, isTeammateMessageAvailable } from "./teammate-routing.js";
import { createPiTeamStore } from "./teams-host.js";
import { registerLeadSendMessageTool, registerSubagentTools } from "./tools.js";
import { createPiTranscriptSource } from "./transcript-host.js";
import { installSubagentsUi, type SubagentsUiHandle, type TasksUiPort } from "./ui-host.js";
import { createGitRunner, worktreeTmpRoot } from "./worktree-host.js";

/** Parent extension. Children load only specialist tools and allowlisted presentation extensions. */
export default function (pi: ExtensionAPI): void {
	if (shouldSkipExtensionInChildSession()) return;
	const configCwd = process.cwd();
	const agentDir = getAgentDir();
	let latestCtx: ExtensionContext | undefined;
	let peerRuntime: PeerRuntimeHandle | undefined;
	let currentTaskReminders = false;
	registerPeerTools(pi, () => peerRuntime);
	pi.registerCommand("peer-inbox", {
		description: "Review held independent-peer messages",
		handler: async (_args, ctx) => {
			if (!peerRuntime) {
				ctx.ui.notify("Peer capability is disabled or unavailable.", "error");
				return;
			}
			try {
				await reviewHeldMessages(ctx, peerRuntime.messaging);
			} catch (error) {
				ctx.ui.notify(`Peer inbox failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
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
	let taskExecution: TaskExecutionService | undefined;
	let taskAutomation: TaskAutomationService | undefined;
	let reminderCadence = new TaskReminderCadence();
	let closeLeadMailbox: (() => void) | undefined;
	let stopMentionRouting: (() => void) | undefined;
	let rpc: SubagentsRpcWiring | undefined;
	const getAvailableTeammateNames = () =>
		eligibleTeammateNames(app.teams?.current?.members ?? [], (name) => app.manager.teammateStatus(name));
	/** Roster identity colors, shared by the Task Hub UI and the default task
	 *  tool renderers so both name the same teammate in the same color. */
	const getTeammateColors = () =>
		app.teams?.current?.members.map((member) => ({
			name: member.name,
			...(member.color ? { color: member.color } : {}),
		})) ?? [];
	// No message renderer is registered: the teammate-notification customType
	// plus its structured plain-text content IS the renderer contract exported
	// for pi-style companions (docs/INTEGRATION.md); hosts without a renderer
	// display the content verbatim.
	registerAgentsCommand(pi, {
		manager: app.manager,
		openHub: () => uiHandle?.openAgents(),
		setInlineAgentsVisible: (visible) => uiHandle?.setInlineAgentsVisible(visible),
	});
	registerBackendCommand(pi, { backend });
	registerSettingsCommand(pi, {
		configCwd,
		agentDir,
		settings: () => app.manager.currentSettings,
		// Keys that bind at session start (peers, cascade, launcher) report that in
		// the UI; everything else is read from the manager on each use.
		apply: async () => {
			const next = await loadSubagentsSettings(configCwd, { agentDir });
			currentTaskReminders = next.tasks.reminders;
			app.updateSettings(next);
			uiHandle?.refresh();
			return app.manager.currentSettings;
		},
	});
	registerSubagentTools(pi, app.manager, app.registry, app.delivery);
	registerModelTools(pi);
	pi.on("turn_end", () => app.delivery?.finishSpawnBatch());
	pi.on("turn_start", () => {
		if (currentTaskReminders) reminderCadence.turnStart();
	});
	pi.on("tool_result", (event) => {
		if (event.toolName.startsWith("tasks_")) reminderCadence.taskToolUsed();
	});
	pi.on("context", (event) => {
		if (!currentTaskReminders || !reminderCadence.consume()) return;
		const summary = board ? summarizeRelevantTasks(board) : undefined;
		if (!summary) return;
		return {
			messages: [
				...event.messages,
				{
					role: "custom" as const,
					customType: "task-reminder",
					content: summary,
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});
	registerLeadSendMessageTool(
		pi,
		() => app.mailbox,
		getAvailableTeammateNames,
		(name) => app.manager.teammateStatus(name),
	);
	for (const tool of createTasksTools(
		() => board,
		() => taskExecution,
		getTeammateColors,
	))
		pi.registerTool(tool);
	pi.registerCommand("tasks", {
		description: "Open the Tasks view in Team Hub",
		handler: async () => uiHandle?.openTasks(),
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		taskAutomation?.dispose();
		taskAutomation = undefined;
		taskExecution?.dispose();
		taskExecution = undefined;
		board?.dispose();
		board = undefined;
		rpc?.dispose();
		rpc = wireSubagentsRpc({ events: pi.events, manager: app.manager });
		uiHandle?.dispose();
		closeLeadMailbox?.();
		stopMentionRouting?.();
		closeLeadMailbox = undefined;
		stopMentionRouting = undefined;
		await peerRuntime?.dispose();
		peerRuntime = undefined;
		const settings = await loadSubagentsSettings(configCwd);
		currentTaskReminders = settings.tasks.reminders;
		peerRuntime = await startPeerRuntime({
			pi,
			ctx,
			root: agentDir,
			enabled: settings.peers.enabled,
			scope: settings.peers.scope,
			policy: settings.peers.policy,
			onError: (error) =>
				console.warn(`[pi-teams] peer runtime unavailable: ${error instanceof Error ? error.message : String(error)}`),
		});
		reminderCadence = new TaskReminderCadence();
		app.updateSettings(settings);
		// Env override (four launchers) wins over the settings key (auto|headless).
		backend.setLauncherHint(resolveSessionLauncherHint(process.env, settings.backend));
		await app.sessionStart();
		const team = app.teams;
		board = team ? new TaskBoardService({ teamDir: team.teamDir, self: "lead" }) : undefined;
		taskExecution = board
			? new TaskExecutionService({ board, manager: app.manager, artifactRoot: teamsArtifactDir(configCwd) })
			: undefined;
		taskAutomation =
			board && taskExecution ? new TaskAutomationService(board, taskExecution, settings.tasks.autoCascade) : undefined;
		if (app.mailbox)
			closeLeadMailbox = installLeadMailbox(
				pi,
				app.mailbox,
				(name) => app.teams?.current?.members.find((member) => member.name === name)?.color,
			);
		const tasks: TasksUiPort = {
			snapshot: () => board?.list() ?? [],
			subscribe: (listener) => {
				const activeBoard = board;
				if (!activeBoard) return () => {};
				const unsubscribe = activeBoard.subscribe(() => listener());
				const unwatch = activeBoard.watch(listener);
				return () => {
					unsubscribe();
					unwatch();
				};
			},
			create: (input) => {
				if (!board) throw new Error("No active team");
				return board.create(input);
			},
			update: (input) => {
				if (!board) throw new Error("No active team");
				return board.update(input);
			},
			cancel: (id) => {
				if (!board) throw new Error("No active team");
				return board.cancel({ id });
			},
			execute: (id, type) => {
				if (!taskExecution) throw new Error("Task execution unavailable");
				return taskExecution.execute(id, { actor: { name: "lead", coordinator: true }, type });
			},
			output: (id, wait) => {
				if (!taskExecution) throw new Error("Task execution unavailable");
				return taskExecution.output(id, {
					actor: { name: "lead", coordinator: true },
					...(wait !== undefined ? { wait } : {}),
				});
			},
			stop: (id) => {
				if (!taskExecution) throw new Error("Task execution unavailable");
				return taskExecution.stop(id, { actor: { name: "lead", coordinator: true } });
			},
			executionTypes: () => app.registry.availableTypes,
			colors: getTeammateColors,
		};
		uiHandle = installSubagentsUi(ctx, {
			manager: app.manager,
			focus: createAgentFocusPort({ manager: app.manager, transcripts }),
			settings: () => app.manager.currentSettings,
			transcripts,
			tasks,
		});
		if (ctx.mode === "tui") {
			const routing = {
				names: getAvailableTeammateNames,
				isMainEditorFocused: () => uiHandle?.isMainEditorFocused() ?? false,
				send: (target: string, text: string) => {
					const status = app.manager.teammateStatus(target);
					if (!isTeammateMessageAvailable(status))
						return {
							delivered: false as const,
							error: status?.recoveryError ?? `Teammate @${target} is ${status?.state ?? "unavailable"}.`,
						};
					return (
						app.mailbox?.send(target, text, status?.membershipId) ?? {
							delivered: false as const,
							error: "No active team",
						}
					);
				},
			};
			installAgentMentionAutocomplete(ctx, app.registry, routing);
			stopMentionRouting = installTeammateMentionRouting(ctx, routing);
		}
		rpc.announceReady();
	});
	pi.on("session_before_switch", async () => {
		await peerRuntime?.dispose();
		peerRuntime = undefined;
		closeLeadMailbox?.();
		stopMentionRouting?.();
		closeLeadMailbox = undefined;
		stopMentionRouting = undefined;
		app.delivery?.handleSessionSwitch();
		currentTaskReminders = false;
		taskAutomation?.dispose();
		taskAutomation = undefined;
		// Session-bound lifetime (ADR 0007 §1): switching sessions ends the
		// owning session's team — tear its children down before the next
		// session_start re-arms the manager.
		try {
			taskExecution?.freezeAdmissions();
			await app.sessionShutdown();
			taskExecution?.dispose();
			taskExecution = undefined;
			board?.dispose();
			board = undefined;
		} catch (error) {
			console.warn(`[pi-teams] session teardown failed: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
	});
	pi.on("session_shutdown", async () => {
		await peerRuntime?.dispose();
		peerRuntime = undefined;
		closeLeadMailbox?.();
		stopMentionRouting?.();
		closeLeadMailbox = undefined;
		stopMentionRouting = undefined;
		rpc?.dispose();
		rpc = undefined;
		uiHandle?.dispose();
		uiHandle = undefined;
		currentTaskReminders = false;
		taskAutomation?.dispose();
		taskAutomation = undefined;
		try {
			taskExecution?.freezeAdmissions();
			await app.sessionShutdown();
		} finally {
			taskExecution?.dispose();
			taskExecution = undefined;
			board?.dispose();
			board = undefined;
			latestCtx = undefined;
		}
	});
}
