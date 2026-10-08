import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { MailboxService } from "../app/mailbox-service.js";
import { EMPTY_USAGE } from "../domain/agent-run.js";
import type { ChildBootstrap, ChildControlCommand, ChildState } from "../domain/child-protocol.js";
import { LEAD_ADDRESS, normalizeTeammateColor, type TeamRoster } from "../domain/team.js";
import type { AgentFocusSnapshot, AgentTranscriptView } from "../domain/ui-view.js";
import type { AgentViewData } from "../features/agent-view/index.js";
import {
	createAgentSteerEditor,
	createAgentTranscriptPane,
	createAgentViewOverlay,
} from "../features/agent-view/index.js";
import { ChildRpcClient } from "./child-rpc-client.js";

interface ViewerBootstrap {
	childId: string;
	token: string;
	socketPath: string;
	cwd: string;
	teammateName?: string;
	teammateColor?: string;
	teamDir?: string;
	teamKey?: string;
}

async function loadViewerBootstrap(): Promise<ViewerBootstrap> {
	const path = process.env.PI_TEAMS_VIEWER_BOOTSTRAP;
	if (!path || !isAbsolute(path)) throw new Error("PI_TEAMS_VIEWER_BOOTSTRAP must name an absolute owner-only file");
	const stat = await lstat(path);
	if (
		!stat.isFile() ||
		(typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
		(stat.mode & 0o077) !== 0
	)
		throw new Error("Refusing an unsafe teammate viewer bootstrap file");
	const value = JSON.parse(await readFile(path, "utf8")) as ViewerBootstrap;
	if (!value.childId || !value.token || !value.socketPath || !isAbsolute(value.socketPath))
		throw new Error("Teammate viewer bootstrap is invalid");
	return value;
}

function statusOf(state: ChildState): AgentTranscriptView["status"] {
	if (state.execution === "running") return "running";
	if (state.lastOutcome?.status === "completed") return "completed";
	if (state.lastOutcome?.status === "stopped") return "stopped";
	if (state.lastOutcome?.status === "failed") return "error";
	return "starting";
}

function viewOf(state: ChildState, name: string, startedAt: number): AgentViewData {
	const current = state.focus;
	const items = state.transcript.items;
	const view: AgentTranscriptView = {
		agentId: state.childId,
		type: `teammate ${name}`,
		description: state.execution === "running" ? `Run ${state.currentRunId ?? "active"}` : "Native teammate session",
		status: statusOf(state),
		backend: "process",
		resourceState: state.execution === "running" ? "open" : "idle",
		startedAt,
		toolUses: state.toolUses ?? 0,
		turns: state.turns ?? 0,
		usage: state.usage ?? { ...EMPTY_USAGE },
		items,
		truncatedHead: state.transcript.truncated,
		capabilities: {
			attachable: false,
			viewable: true,
			steerable: true,
			stoppable: state.execution === "running",
			resumable: false,
		},
		generatedAt: Date.now(),
	};
	const capabilities = [
		...(current?.capabilities.models.map((model) => `model:${model.provider}/${model.id}`) ?? []),
		...(current?.capabilities.thinking.map((level) => `thinking:${level}`) ?? []),
		...(current?.capabilities.commands ?? []),
	];
	const focus: AgentFocusSnapshot = {
		runId: state.currentRunId ?? state.lastOutcome?.runId ?? state.childId,
		currentRunId: state.currentRunId ?? null,
		model: current?.model ? `${current.model.provider}/${current.model.id}` : null,
		thinking: current?.thinking ?? null,
		cwd: current?.cwd ?? null,
		context: current?.context
			? { usedTokens: current.context.tokens, windowTokens: current.context.contextWindow }
			: null,
		capabilities,
		items,
		truncatedHead: state.transcript.truncated,
		closed: false,
	};
	return { view, focus };
}

async function installViewer(pi: ExtensionAPI): Promise<void> {
	if (process.env.PI_TEAMS_VIEWER !== "1") throw new Error("Teammate viewer entrypoint requires PI_TEAMS_VIEWER=1");
	const bootstrap = await loadViewerBootstrap();
	const client = new ChildRpcClient({
		socketPath: bootstrap.socketPath,
		childId: bootstrap.childId,
		token: bootstrap.token,
		role: "viewer",
	});
	const name = bootstrap.teammateName ?? `Teammate ${bootstrap.childId.slice(0, 8)}`;
	const identityColor = bootstrap.teammateColor ? normalizeTeammateColor(bootstrap.teammateColor) : undefined;
	const foreground = identityColor
		? `\u001b[38;2;${Number.parseInt(identityColor.slice(1, 3), 16)};${Number.parseInt(identityColor.slice(3, 5), 16)};${Number.parseInt(identityColor.slice(5, 7), 16)}m`
		: undefined;
	const paintIdentity = (text: string) => (foreground ? `${foreground}${text}\u001b[39m` : text);
	const displayName = paintIdentity(name);
	const mailbox =
		bootstrap.teamDir && bootstrap.teamKey && bootstrap.teammateName
			? new MailboxService({ teamDir: bootstrap.teamDir, teamKey: bootstrap.teamKey, self: bootstrap.teammateName })
			: undefined;
	let state: ChildState | undefined;
	let startedAt = Date.now();
	let closed = false;
	let unsubscribe: (() => void) | undefined;
	pi.on("session_start", async (_event, context: ExtensionContext) => {
		const initial = await client.connect();
		state = initial;
		startedAt = Date.now();
		const shutdown = async () => {
			if (closed) return;
			closed = true;
			unsubscribe?.();
			client.disconnect();
			context.shutdown();
		};
		let data: AgentViewData | null = viewOf(initial, displayName, startedAt);
		const open = context.ui.custom<void>(
			(tui: TUI, theme: Theme, keybindings: KeybindingsManager, done) => {
				const pane = createAgentTranscriptPane(tui, theme, {
					cwd: bootstrap.cwd,
					read: () => data?.view.items ?? [],
					signature: () => `${state?.seq ?? 0}:${state?.transcript.cursor ?? 0}`,
				});
				let editorTheme = theme;
				if (identityColor) {
					editorTheme = Object.create(theme) as Theme;
					editorTheme.fg = (token, text) =>
						token === "border" || token === "accent" ? paintIdentity(text) : theme.fg(token, text);
				}
				const editor = createAgentSteerEditor(tui, editorTheme, keybindings);
				const refreshState = async () => {
					if (closed) return;
					state = await client.state();
					data = viewOf(state, displayName, startedAt);
					tui.requestRender();
				};
				const route = async (text: string): Promise<boolean> => {
					const current = state;
					if (!current) return false;
					if (text.startsWith("/")) {
						const [command, ...parts] = text.trim().split(/\s+/);
						const value = parts.join(" ");
						let control: ChildControlCommand | undefined;
						if (command === "/model" && value && current.focus?.capabilities.commands.includes("model"))
							control = { type: "model", model: value };
						else if (command === "/thinking" && value && current.focus?.capabilities.commands.includes("thinking"))
							control = { type: "thinking", thinking: value as NonNullable<ChildBootstrap["thinking"]> };
						else if (
							command === "/compact" &&
							parts.length === 0 &&
							current.focus?.capabilities.commands.includes("compact")
						)
							control = { type: "compact" };
						if (!control) return false;
						state = await client.control(control);
						data = viewOf(state, displayName, startedAt);
						tui.requestRender();
						return true;
					}
					const routed = /^@([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+([\s\S]+)$/.exec(text);
					const target = routed?.[1];
					const message = routed?.[2];
					if (target && message && mailbox && bootstrap.teamDir) {
						const roster = JSON.parse(await readFile(join(bootstrap.teamDir, "config.json"), "utf8")) as TeamRoster;
						if (target === LEAD_ADDRESS || roster.members.some((member) => member.name === target)) {
							const result = mailbox.send(target, message);
							if (!result.delivered) throw new Error(result.error);
							return true;
						}
					}
					if (current.execution === "running" && current.currentRunId) {
						await client.steer(current.currentRunId, text);
					} else if (mailbox && bootstrap.teammateName) {
						const result = mailbox.send(bootstrap.teammateName, text);
						if (!result.delivered) throw new Error(result.error);
					} else {
						throw new Error("This child has no parent-admitted assignment route.");
					}
					return true;
				};
				const overlay = createAgentViewOverlay({
					tui,
					theme,
					keybindings,
					pane,
					editor,
					host: {
						getData: () => data,
						onSubmit: route,
						onAbort: async () => {
							if (state?.currentRunId) await client.abort(state.currentRunId);
							await refreshState();
						},
						onAttachPane: async () => {
							throw new Error("This pane is already the teammate presentation.");
						},
						onClose: () => {
							done(undefined);
							void shutdown();
						},
						requestRender: () => tui.requestRender(),
					},
				});
				unsubscribe = client.subscribe(() => {
					void refreshState();
				});
				return overlay;
			},
			{
				overlay: true,
				overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
				onHandle: () => {},
			},
		);
		void open.catch(async () => shutdown());
	});
	pi.on("session_shutdown", async () => {
		closed = true;
		unsubscribe?.();
		client.disconnect();
	});
}

export default async function childViewerExtension(pi: ExtensionAPI): Promise<void> {
	await installViewer(pi);
}
