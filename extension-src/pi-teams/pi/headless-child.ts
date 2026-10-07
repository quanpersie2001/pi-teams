import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AgentSession,
	type CreateAgentSessionOptions,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type ChildBootstrap, ChildProtocolError } from "../domain/child-protocol.js";
import type { InboxRecipient } from "../domain/message.js";
import {
	type ChildBridgeHandle,
	type ChildBridgeHost,
	loadChildBootstrap,
	normalizeChildNativeEvent,
	normalizeMessage,
	parseChildBootstrap,
	startChildBridge,
} from "./child-bridge.js";
import { ChildRpcClient } from "./child-rpc-client.js";
import type { InboxToolPort } from "./tools.js";
import { createInboxTools } from "./tools.js";

const CHILD_ENV = "PI_TEAMS_CHILD";

export interface HeadlessChildOptions {
	/** Optional canonical native model/auth runtime, primarily for provider fixtures. */
	modelRuntime?: ModelRuntime;
	/** Direct bootstrap injection for in-process consumers; production reads the secured bootstrap file. */
	bootstrap?: ChildBootstrap;
}

export interface HeadlessChildHandle {
	readonly session: AgentSession;
	readonly bridge: ChildBridgeHandle;
	close(): Promise<void>;
}

function configuredModel(runtime: ModelRuntime, configured: string | undefined) {
	if (configured === undefined) return undefined;
	const separator = configured.indexOf("/");
	if (separator > 0) {
		const model = runtime.getModel(configured.slice(0, separator), configured.slice(separator + 1));
		if (model) return model;
		throw new ChildProtocolError(
			"model_unavailable",
			`Configured model ${configured} is not registered in the native Pi model runtime`,
		);
	}
	const target = configured.toLocaleLowerCase();
	const matches = runtime
		.getModels()
		.filter((model) => model.id.toLocaleLowerCase() === target || model.name.toLocaleLowerCase() === target);
	if (matches.length === 1) return matches[0];
	if (matches.length > 1)
		throw new ChildProtocolError(
			"model_ambiguous",
			`Configured model ${configured} matches multiple native Pi models; specify provider/modelId`,
		);
	throw new ChildProtocolError(
		"model_unavailable",
		`Configured model ${configured} is not registered in the native Pi model runtime`,
	);
}

function validateSessionDirectory(path: string): Promise<void> {
	return (async () => {
		await mkdir(path, { recursive: true, mode: 0o700 });
		const details = await lstat(path);
		if (
			!details.isDirectory() ||
			(typeof process.getuid === "function" && details.uid !== process.getuid()) ||
			(details.mode & 0o077) !== 0
		) {
			throw new ChildProtocolError("unsafe_session_dir", "Child session directory must be an owner-only directory");
		}
	})();
}

function validateSessionFile(path: string | undefined, sessionDir: string): string | undefined {
	if (path === undefined) return undefined;
	const absoluteFile = resolve(path);
	const fromDirectory = relative(sessionDir, absoluteFile);
	if (
		!isAbsolute(path) ||
		fromDirectory.length === 0 ||
		fromDirectory === ".." ||
		fromDirectory.startsWith(`..${sep}`) ||
		isAbsolute(fromDirectory)
	) {
		throw new ChildProtocolError(
			"invalid_bootstrap",
			"Child session file must be inside the configured session directory",
		);
	}
	return absoluteFile;
}

async function createRuntime(bootstrap: ChildBootstrap, options: HeadlessChildOptions): Promise<HeadlessChildHandle> {
	if (process.env[CHILD_ENV] !== "1")
		throw new ChildProtocolError("not_child", "The headless runtime can only run in a PI_TEAMS_CHILD process");
	const sessionDir = resolve(bootstrap.sessionDir);
	await validateSessionDirectory(sessionDir);
	const requestedSessionFile = validateSessionFile(bootstrap.sessionFile, sessionDir);
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(bootstrap.configCwd, agentDir);
	const modelRuntime =
		options.modelRuntime ??
		(await ModelRuntime.create({
			authPath: resolve(agentDir, "auth.json"),
			modelsPath: resolve(agentDir, "models.json"),
		}));
	const model = requestedSessionFile ? undefined : configuredModel(modelRuntime, bootstrap.model);
	const appendChildPrompts = [
		...(bootstrap.promptMode === "append" && bootstrap.systemPrompt.length > 0 ? [bootstrap.systemPrompt] : []),
		...(bootstrap.instructions ? [bootstrap.instructions] : []),
	];
	const resourceLoader = new DefaultResourceLoader({
		cwd: bootstrap.configCwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		...(bootstrap.promptMode === "replace" ? { systemPromptOverride: () => bootstrap.systemPrompt } : {}),
		appendSystemPromptOverride: (existing) => [...existing, ...appendChildPrompts],
	});
	await resourceLoader.reload();
	const sessionManager = requestedSessionFile
		? SessionManager.open(requestedSessionFile, sessionDir, bootstrap.cwd)
		: SessionManager.create(bootstrap.cwd, sessionDir);
	const messageClient = new ChildRpcClient({
		socketPath: bootstrap.socketPath,
		childId: bootstrap.childId,
		token: bootstrap.token,
	});
	const childRecipient: InboxRecipient = { kind: "agent", agentId: bootstrap.childId };
	const inboxPort: InboxToolPort = {
		sendFromParent: async () => {
			throw new ChildProtocolError(
				"unsupported_message_scope",
				"Child inbox tools cannot impersonate a parent session",
			);
		},
		sendFromAgent: async (agentId, target, text) => {
			if (agentId !== bootstrap.childId)
				throw new ChildProtocolError("unauthorized", "Child inbox identity does not match its authenticated process");
			await messageClient.connect();
			const reply = await messageClient.messageRequest({ action: "send", target, text });
			if (reply.action !== "sent")
				throw new ChildProtocolError("invalid_reply", "Parent did not return a sent inbox receipt");
			return {
				id: reply.message.id,
				...(reply.message.deliveredAt !== undefined ? { deliveredAt: reply.message.deliveredAt } : {}),
			};
		},
		listInbox: async (recipient) => {
			if (recipient.kind !== "agent" || recipient.agentId !== bootstrap.childId)
				throw new ChildProtocolError("unauthorized", "Inbox reads must target the authenticated child");
			await messageClient.connect();
			const reply = await messageClient.messageRequest({ action: "list" });
			if (reply.action !== "listed")
				throw new ChildProtocolError("invalid_reply", "Parent did not return an inbox listing");
			return reply.messages;
		},
		consumeInbox: async (recipient, messageId) => {
			if (recipient.kind !== "agent" || recipient.agentId !== bootstrap.childId)
				throw new ChildProtocolError("unauthorized", "Inbox consumption must target the authenticated child");
			await messageClient.connect();
			const reply = await messageClient.messageRequest({ action: "consume", messageId });
			if (reply.action !== "consumed" || reply.message.id !== messageId)
				throw new ChildProtocolError("invalid_reply", "Parent did not acknowledge the requested inbox message");
			return { id: reply.message.id };
		},
	};
	const inboxTools = createInboxTools(inboxPort, () => childRecipient);
	const sessionOptions: CreateAgentSessionOptions = {
		cwd: bootstrap.cwd,
		agentDir,
		modelRuntime,
		settingsManager,
		resourceLoader,
		sessionManager,
		...(model ? { model } : {}),
		...(!requestedSessionFile && bootstrap.thinking !== undefined ? { thinkingLevel: bootstrap.thinking } : {}),
		customTools: inboxTools,
		...(bootstrap.tools !== undefined ? { tools: [...bootstrap.tools] } : {}),
	};
	const { session } = await createAgentSession(sessionOptions);
	if (!session.model) {
		session.dispose();
		throw new ChildProtocolError(
			"model_unavailable",
			"No authenticated native Pi model is selected for the child session",
		);
	}
	if (bootstrap.tools !== undefined) {
		const availableTools = new Set(session.getAllTools().map((tool) => tool.name));
		const unsupported = bootstrap.tools.find((tool) => !availableTools.has(tool));
		if (unsupported !== undefined) {
			session.dispose();
			throw new ChildProtocolError(
				"unsupported_tool",
				`Configured tool ${unsupported} is not available in the native Pi child runtime`,
			);
		}
	}
	try {
		await session.bindExtensions({
			mode: "rpc",
			onError: (error) => console.error("Pi child extension runtime error:", error.error),
		});
	} catch (error) {
		session.dispose();
		throw error;
	}
	let bridge: ChildBridgeHandle | undefined;
	let unsubscribe = () => {};
	let closePromise: Promise<void> | undefined;
	const closeRuntime = (): Promise<void> =>
		(closePromise ??= (async () => {
			try {
				await session.abort();
			} finally {
				unsubscribe();
				messageClient.disconnect();
				try {
					await bridge?.close();
				} finally {
					session.dispose();
				}
			}
		})());
	const host: ChildBridgeHost = {
		getSessionFile: () => session.sessionFile,
		getTranscript: () =>
			session.sessionManager.buildContextEntries().flatMap((entry) => {
				if (entry.type === "message") return normalizeMessage(entry.message);
				const timestamp = Date.parse(entry.timestamp) || Date.now();
				if (entry.type === "compaction" || entry.type === "branch_summary") {
					return normalizeMessage({ role: "custom", timestamp, content: entry.summary });
				}
				if (entry.type === "custom_message") {
					return normalizeMessage({ role: "custom", timestamp, content: entry.content });
				}
				return [];
			}),
		getFocus: () => {
			const context = session.getContextUsage();
			const stats = session.getSessionStats();
			const selected = session.model;
			const models = modelRuntime.getAvailableSnapshot().map((entry) => ({
				provider: entry.provider,
				id: entry.id,
				name: entry.name,
			}));
			return {
				cwd: bootstrap.cwd,
				...(selected ? { model: { provider: selected.provider, id: selected.id, name: selected.name } } : {}),
				thinking: session.thinkingLevel,
				...(context && context.tokens !== null
					? {
							context: {
								tokens: context.tokens,
								contextWindow: context.contextWindow,
								percent: context.contextWindow > 0 ? (context.tokens / context.contextWindow) * 100 : 0,
							},
						}
					: {}),
				stats: {
					userMessages: stats.userMessages,
					assistantMessages: stats.assistantMessages,
					toolCalls: stats.toolCalls,
					toolResults: stats.toolResults,
					totalMessages: stats.totalMessages,
					tokens: { ...stats.tokens },
					cost: stats.cost,
				},
				capabilities: {
					models,
					thinking: session.getAvailableThinkingLevels(),
					commands: ["model", "thinking"],
				},
			};
		},
		controlFocus: async (command) => {
			if (command.type === "model") {
				const model = configuredModel(modelRuntime, command.model);
				if (!model) throw new ChildProtocolError("model_unavailable", `Selected model ${command.model} is unavailable`);
				if (
					!modelRuntime
						.getAvailableSnapshot()
						.some((entry) => entry.provider === model.provider && entry.id === model.id)
				)
					throw new ChildProtocolError("model_unavailable", "Selected model is not available in the child runtime");
				await session.setModel(model, { persist: false });
			} else if (command.type === "thinking") {
				const allowed: readonly string[] = session.getAvailableThinkingLevels();
				if (!allowed.includes(command.thinking))
					throw new ChildProtocolError("unsupported_thinking", "Selected thinking level is unavailable for this model");
				session.setThinkingLevel(command.thinking, { persist: false });
			} else if (command.type === "compact") {
				throw new ChildProtocolError(
					"unsupported_command",
					"Manual compaction is unavailable through the process child focus API",
				);
			} else {
				throw new ChildProtocolError("unsupported_command", "Unsupported child control command");
			}
		},
		sendInbox: async (message) => {
			await session.sendCustomMessage(
				{ customType: "pi-teams-inbox", content: JSON.stringify(message), display: true },
				{ triggerTurn: false },
			);
		},
		prompt: async (prompt) => {
			let accepted = false;
			let accept!: () => void;
			let reject!: (error: Error) => void;
			const admission = new Promise<void>((resolveAdmission, rejectAdmission) => {
				accept = resolveAdmission;
				reject = rejectAdmission;
			});
			const operation = session.prompt(prompt, {
				source: "rpc",
				expandPromptTemplates: false,
				preflightResult: (disposition) => {
					accepted = disposition === "started";
					if (accepted) accept();
					else
						reject(
							new ChildProtocolError("prompt_not_started", `Pi ${disposition} the child prompt without starting a run`),
						);
				},
			});
			void operation.catch((error: unknown) => {
				const failure = error instanceof Error ? error : new Error(String(error));
				if (!accepted) reject(failure);
				else bridge?.failActiveRun(failure);
			});
			return admission;
		},
		steer: async (message) => {
			await session.steer(message);
		},
		abort: () => session.abort(),
		shutdown: async () => {
			await closeRuntime();
		},
	};
	if (!session.sessionFile) {
		session.dispose();
		throw new ChildProtocolError("session_not_persisted", "Pi did not create a persistent child session file");
	}
	const expectedSessionFile = requestedSessionFile;
	if (expectedSessionFile && resolve(session.sessionFile) !== expectedSessionFile) {
		session.dispose();
		throw new ChildProtocolError(
			"session_mismatch",
			"Pi opened a different session file than the child bootstrap requested",
		);
	}
	unsubscribe = session.subscribe((event) => {
		const nativeEvent = normalizeChildNativeEvent(event);
		if (nativeEvent) bridge?.publishNativeEvent(nativeEvent);
	});
	try {
		bridge = await startChildBridge(bootstrap, host);
	} catch (error) {
		unsubscribe();
		session.dispose();
		throw error;
	}
	return {
		session,
		bridge,
		close: () => closeRuntime(),
	};
}

/** Start a real, persistent, headless Pi child after its owner-only bootstrap is available. */
export async function runHeadlessChild(options: HeadlessChildOptions = {}): Promise<HeadlessChildHandle> {
	if (process.env[CHILD_ENV] !== "1")
		throw new ChildProtocolError("not_child", "The headless runtime can only run in a PI_TEAMS_CHILD process");
	const bootstrap = parseChildBootstrap(options.bootstrap ?? (await loadChildBootstrap()));
	return createRuntime(bootstrap, options);
}

async function runAsProcess(): Promise<void> {
	const child = await runHeadlessChild();
	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		void child.close().catch((error: unknown) => {
			console.error("Failed to close Pi child runtime:", error);
			process.exitCode = 1;
		});
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
	void runAsProcess().catch((error: unknown) => {
		console.error("Failed to start Pi child runtime:", error);
		process.exitCode = 1;
	});
}
