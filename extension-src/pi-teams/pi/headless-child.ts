import { readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AgentSession,
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionOptions,
	type CreateAgentSessionRuntimeFactory,
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionServices,
	DefaultResourceLoader,
	getAgentDir,
	InteractiveMode,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { MailboxService } from "../app/mailbox-service.js";
import { TaskBoardService } from "../app/task-board-service.js";
import { type ChildBootstrap, ChildProtocolError } from "../domain/child-protocol.js";
import {
	type ChildBridgeHandle,
	type ChildBridgeHost,
	loadChildBootstrap,
	normalizeChildNativeEvent,
	normalizeMessage,
	parseChildBootstrap,
	startChildBridge,
} from "./child-bridge.js";
import { type ChildMailboxHandle, createChildMailboxTool, watchChildMailbox } from "./child-mailbox.js";
import { deriveViewerToken } from "./child-rpc-auth.js";
import { createTeamTaskTools } from "./team-task-tools.js";
import { supportsTeammateStyleColor, syncTeammateStyleColor } from "./teammate-style-color.js";

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
		// Windows permission bits only mirror the read-only attribute (directories
		// always read 0o777) and stats carry no owner, so owner-only proof there is
		// the parent-created directory inheriting the user's NTFS ACLs; the mode
		// and uid assertions are POSIX-only.
		if (
			!details.isDirectory() ||
			(process.platform !== "win32" &&
				((typeof process.getuid === "function" && details.uid !== process.getuid()) || (details.mode & 0o077) !== 0))
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
function rosterContainsParticipant(value: unknown, target: string): boolean {
	if (typeof value !== "object" || value === null || !("members" in value) || !Array.isArray(value.members))
		return false;
	return value.members.some(
		(member: unknown) => typeof member === "object" && member !== null && "name" in member && member.name === target,
	);
}

async function createRuntime(bootstrap: ChildBootstrap, options: HeadlessChildOptions): Promise<HeadlessChildHandle> {
	if (process.env[CHILD_ENV] !== "1")
		throw new ChildProtocolError("not_child", "The headless runtime can only run in a PI_TEAMS_CHILD process");
	const sessionDir = resolve(bootstrap.sessionDir);
	await validateSessionDirectory(sessionDir);
	const requestedSessionFile = validateSessionFile(bootstrap.sessionFile, sessionDir);
	// Keep SDK-only workers free of the native TUI transport and extension graph.
	const nativeTerminalModule = bootstrap.terminalSocketPath ? await import("./native-terminal.js") : undefined;
	const nativeExtensionModule = bootstrap.terminalSocketPath
		? await import("./native-runtime-extension.js")
		: undefined;
	const terminal =
		nativeTerminalModule && bootstrap.terminalSocketPath
			? await nativeTerminalModule.createNativeTerminal({
					socketPath: bootstrap.terminalSocketPath,
					childId: bootstrap.childId,
					token: deriveViewerToken(bootstrap.childId, bootstrap.token),
				})
			: undefined;
	let mailboxService: MailboxService | undefined;
	let styleExtensionPaths: string[] = [];
	const nativeExtension =
		terminal &&
		nativeExtensionModule?.createNativeRuntimeExtension({
			childId: bootstrap.childId,
			...(bootstrap.teammateName !== undefined ? { name: bootstrap.teammateName } : {}),
			...(bootstrap.teammateColor !== undefined ? { color: bootstrap.teammateColor } : {}),
			terminal,
			showIdentityWidget: () => styleExtensionPaths.length === 0,
			routeNativeInput: (text, idle) => {
				if (!mailboxService || !bootstrap.teammateName) {
					if (idle) throw new Error("This child has no parent-owned mailbox for a new assignment.");
					return false;
				}
				const addressed = /^@([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+([\s\S]+)$/.exec(text);
				const target = addressed?.[1];
				const message = addressed?.[2];
				if (target && message && bootstrap.teamDir) {
					let authorized = false;
					try {
						const roster: unknown = JSON.parse(readFileSync(join(bootstrap.teamDir, "config.json"), "utf8"));
						authorized = target === "lead" || rosterContainsParticipant(roster, target);
					} catch {
						// An unavailable roster cannot authorize a target.
					}
					if (authorized) {
						const result = mailboxService.send(target, message);
						if (!result.delivered) throw new Error(`Could not route native assignment: ${result.error}`);
						return true;
					}
				}
				// Unresolved mentions stay intact as ordinary input to this child.
				if (!idle) return false;
				const result = mailboxService.send(bootstrap.teammateName, text);
				if (!result.delivered) throw new Error(`Could not admit native assignment: ${result.error}`);
				return true;
			},
		});
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
	if (terminal) {
		try {
			const { resolveChildStyleExtensions } = await import("./child-style-extensions.js");
			styleExtensionPaths = await resolveChildStyleExtensions({
				cwd: bootstrap.configCwd,
				agentDir,
				settingsManager,
				...(bootstrap.presentationExtensionPaths !== undefined
					? { parentExtensionPaths: bootstrap.presentationExtensionPaths }
					: {}),
			});
		} catch (error) {
			await terminal.close();
			throw error;
		}
	}
	const childExtensionOptions = {
		noExtensions: true,
		...(nativeExtension ? { extensionFactories: [nativeExtension] } : {}),
		...(styleExtensionPaths.length > 0 ? { additionalExtensionPaths: styleExtensionPaths } : {}),
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd: bootstrap.configCwd,
		agentDir,
		settingsManager,
		...childExtensionOptions,
		...(bootstrap.promptMode === "replace" ? { systemPromptOverride: () => bootstrap.systemPrompt } : {}),
		appendSystemPromptOverride: (existing) => [...existing, ...appendChildPrompts],
	});
	try {
		await resourceLoader.reload();
	} catch (error) {
		await terminal?.close();
		throw error;
	}
	const sessionManager = requestedSessionFile
		? SessionManager.open(requestedSessionFile, sessionDir, bootstrap.cwd)
		: SessionManager.create(bootstrap.cwd, sessionDir);

	mailboxService =
		bootstrap.teamDir && bootstrap.teamKey && bootstrap.teammateName
			? new MailboxService({ teamDir: bootstrap.teamDir, teamKey: bootstrap.teamKey, self: bootstrap.teammateName })
			: undefined;
	const taskBoard =
		bootstrap.teamDir && bootstrap.teammateName
			? new TaskBoardService({ teamDir: bootstrap.teamDir, self: bootstrap.teammateName })
			: undefined;
	const customTools =
		mailboxService && taskBoard
			? [createChildMailboxTool(mailboxService), ...createTeamTaskTools(() => taskBoard)]
			: undefined;
	const tools = bootstrap.tools === undefined ? undefined : [...bootstrap.tools];
	if (tools && customTools) {
		for (const tool of customTools) {
			if (!tools.includes(tool.name)) tools.push(tool.name);
		}
	}
	const sessionOptions: CreateAgentSessionOptions = {
		cwd: bootstrap.cwd,
		agentDir,
		modelRuntime,
		settingsManager,
		resourceLoader,
		sessionManager,
		...(customTools ? { customTools } : {}),
		...(model ? { model } : {}),
		...(!requestedSessionFile && bootstrap.thinking !== undefined ? { thinkingLevel: bootstrap.thinking } : {}),
		...(tools !== undefined ? { tools } : {}),
	};
	let session: AgentSession;
	try {
		session = (await createAgentSession(sessionOptions)).session;
	} catch (error) {
		await terminal?.close();
		throw error;
	}
	// Pi-style reads the native session name for its right-hand editor-frame label.
	// Set it before binding extensions, without touching specialist definitions.
	// A cold continuation without current-team identity must not show an old
	// teammate's @name from the persisted child session.
	if (bootstrap.teammateName && styleExtensionPaths.length > 0) {
		if (session.sessionName !== `@${bootstrap.teammateName}`) session.setSessionName(`@${bootstrap.teammateName}`);
	} else if (requestedSessionFile && !bootstrap.teammateName && session.sessionName?.startsWith("@")) {
		session.setSessionName("");
	}
	syncTeammateStyleColor(session.sessionManager, {
		...(bootstrap.teammateColor ? { color: bootstrap.teammateColor } : {}),
		styleEnabled: supportsTeammateStyleColor(styleExtensionPaths),
		resumingWithoutTeammate: Boolean(requestedSessionFile && !bootstrap.teammateName),
	});
	if (!session.model) {
		session.dispose();
		await terminal?.close();
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
			await terminal?.close();
			throw new ChildProtocolError(
				"unsupported_tool",
				`Configured tool ${unsupported} is not available in the native Pi child runtime`,
			);
		}
	}
	let runtime: AgentSessionRuntime | undefined;
	if (terminal) {
		const currentServices: AgentSessionServices = {
			cwd: bootstrap.cwd,
			agentDir,
			modelRuntime,
			settingsManager,
			resourceLoader,
			diagnostics: [],
		};
		const createRuntimeFactory: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			agentDir: runtimeAgentDir,
			sessionManager: runtimeSessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: runtimeAgentDir,
				settingsManager,
				modelRuntime,
				resourceLoaderOptions: {
					...childExtensionOptions,
					...(bootstrap.promptMode === "replace" ? { systemPromptOverride: () => bootstrap.systemPrompt } : {}),
					appendSystemPromptOverride: (existing) => [...existing, ...appendChildPrompts],
				},
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager: runtimeSessionManager,
				...(sessionStartEvent !== undefined ? { sessionStartEvent } : {}),
				...(model ? { model } : {}),
				...(customTools ? { customTools } : {}),
				...(tools !== undefined ? { tools } : {}),
			});
			return { ...created, services, diagnostics: services.diagnostics };
		};
		runtime = new AgentSessionRuntime(session, currentServices, createRuntimeFactory);
	}
	try {
		if (!terminal) {
			await session.bindExtensions({
				mode: "rpc",
				onError: (error) => console.error("Pi child extension runtime error:", error.error),
			});
		}
	} catch (error) {
		session.dispose();
		await terminal?.close();
		throw error;
	}
	let interactiveMode: InteractiveMode | undefined;
	let bridge: ChildBridgeHandle | undefined;
	let mailbox: ChildMailboxHandle | undefined;
	let unsubscribe = () => {};
	let closePromise: Promise<void> | undefined;
	const closeRuntime = (): Promise<void> =>
		(closePromise ??= (async () => {
			interactiveMode?.stop();
			try {
				await session.abort();
			} finally {
				unsubscribe();
				mailbox?.close();
				try {
					await bridge?.close();
				} finally {
					try {
						await terminal?.close();
					} finally {
						session.dispose();
					}
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
		await terminal?.close();
		throw new ChildProtocolError("session_not_persisted", "Pi did not create a persistent child session file");
	}
	const expectedSessionFile = requestedSessionFile;
	if (expectedSessionFile && resolve(session.sessionFile) !== expectedSessionFile) {
		session.dispose();
		await terminal?.close();
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
		if (terminal) {
			if (!runtime) throw new Error("Native terminal was created without its AgentSessionRuntime");
			interactiveMode = new InteractiveMode(runtime, { terminal });
			await interactiveMode.init();
		}
		bridge = await startChildBridge(bootstrap, host);
		if (bootstrap.teamDir && bootstrap.teamKey && bootstrap.teammateName) {
			const activeBridge = bridge;
			mailbox = watchChildMailbox({
				teamDir: bootstrap.teamDir,
				teamKey: bootstrap.teamKey,
				self: bootstrap.teammateName,
				isRunning: () => activeBridge.state().execution === "running",
				prompt: (text) => activeBridge.startMailboxRun(text),
				steer: (text) => host.steer(text),
			});
		}
		if (interactiveMode) {
			void interactiveMode.run().catch((error: unknown) => {
				console.error("Pi child native interactive mode failed:", error);
				void closeRuntime();
			});
		}
	} catch (error) {
		await closeRuntime();
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
if (entryPath && import.meta.url === pathToFileURL(realpathSync(resolve(entryPath))).href) {
	void runAsProcess().catch((error: unknown) => {
		console.error("Failed to start Pi child runtime:", error);
		process.exitCode = 1;
	});
}
