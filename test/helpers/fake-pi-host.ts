import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionEvent,
	type ExtensionUIContext,
	Theme,
	type ThemeColor,
	type WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey } from "@earendil-works/pi-tui";

export type FakePiMode = "tui" | "rpc" | "json" | "print";

export interface FakePiCapabilities {
	api: boolean;
	header: boolean;
	customEditor: boolean;
	customFooter: boolean;
	workingIndicator: boolean;
	widgets: boolean;
}

export interface FakePiHostOptions {
	mode?: FakePiMode;
	sessionReason?: "startup" | "reload" | "new" | "resume" | "fork";
	capabilities?: Partial<FakePiCapabilities>;
	initialEditor?: NonNullable<ExtensionUIContext["setEditorComponent"]> extends (factory: infer F) => void ? F : never;
	initialFooter?: Parameters<ExtensionUIContext["setFooter"]>[0];
	systemPrompt?: string;
	flags?: Record<string, boolean | string | undefined>;
	projectTrusted?: boolean;
	cwd?: string;
	/** Active theme name (default "fake"). */
	themeName?: string;
	/** Available themes for getTheme/setTheme; the active theme is registered automatically. */
	themes?: Record<string, Theme>;
	/** Session entries surfaced through the fake session manager (usage aggregation). */
	sessionEntries?: readonly unknown[];
	/**
	 * Session identity/tree view exposed through ctx.sessionManager
	 * (getSessionId/getLeafId/getBranch). Omitted methods stay missing so
	 * extensions see the same partial-manager shape real headless modes have.
	 */
	sessionView?: {
		sessionId?: string;
		leafId?: string | null;
		branch?: Array<{ id: string }>;
	};
	/**
	 * Terminal size handed to ctx.ui.custom overlay factories (default 24x80).
	 * Inline widgets receive their own TUI and are unaffected.
	 */
	overlayTerminal?: { rows: number; columns: number };
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
interface FakeOverlay {
	options?: unknown;
	handle: {
		hidden: boolean;
		disposed: boolean;
		hide(): void;
		setHidden(hidden: boolean): void;
		isHidden(): boolean;
		focus(): void;
		unfocus(): void;
		isFocused(): boolean;
	};
	component?: Component & { dispose?(): void };
	close(result?: unknown): void;
}

const defaultCapabilities: FakePiCapabilities = {
	api: true,
	header: true,
	customEditor: true,
	customFooter: true,
	workingIndicator: true,
	widgets: true,
};

function createFakeTheme(options: { name?: string } = {}): Theme {
	const foregroundTokens: ThemeColor[] = [
		"accent",
		"border",
		"borderAccent",
		"borderMuted",
		"success",
		"error",
		"warning",
		"muted",
		"dim",
		"text",
		"thinkingText",
		"userMessageText",
		"customMessageText",
		"customMessageLabel",
		"toolTitle",
		"toolOutput",
		"mdHeading",
		"mdLink",
		"mdLinkUrl",
		"mdCode",
		"mdCodeBlock",
		"mdCodeBlockBorder",
		"mdQuote",
		"mdQuoteBorder",
		"mdHr",
		"mdListBullet",
		"toolDiffAdded",
		"toolDiffRemoved",
		"toolDiffContext",
		"syntaxComment",
		"syntaxKeyword",
		"syntaxFunction",
		"syntaxVariable",
		"syntaxString",
		"syntaxNumber",
		"syntaxType",
		"syntaxOperator",
		"syntaxPunctuation",
		"thinkingOff",
		"thinkingMinimal",
		"thinkingLow",
		"thinkingMedium",
		"thinkingHigh",
		"thinkingXhigh",
		"thinkingMax",
		"bashMode",
	];
	const foregrounds = Object.fromEntries(foregroundTokens.map((token) => [token, ""])) as Record<ThemeColor, string>;
	const backgrounds = {
		selectedBg: "",
		userMessageBg: "",
		customMessageBg: "",
		toolPendingBg: "",
		toolSuccessBg: "",
		toolErrorBg: "",
	};
	return new Theme(foregrounds, backgrounds, "truecolor", { name: options.name ?? "fake" });
}

export class FakePiHost {
	readonly mode: FakePiMode;
	readonly capabilities: FakePiCapabilities;
	readonly handlers = new Map<string, Handler[]>();
	readonly commands = new Map<string, unknown>();
	readonly registeredTools: unknown[] = [];
	readonly registeredFlags = new Map<string, unknown>();
	readonly registeredMessageRenderers = new Map<string, unknown>();
	readonly registeredEntryRenderers = new Map<string, unknown>();
	readonly appendedEntries: Array<{ customType: string; data?: unknown }> = [];
	/** Messages passed to api.sendMessage (custom messages, e.g. delivery). */
	readonly sentMessages: Array<{
		message: { customType: string; content: unknown; display: boolean; details?: unknown };
		options?: { triggerTurn?: boolean; deliverAs?: string };
	}> = [];
	activeTools: string[] = [];
	allTools: unknown[] = [];
	readonly widgets = new Map<string, { content: unknown; placement: "aboveEditor" | "belowEditor" }>();
	readonly componentFactories = new Map<
		string,
		(
			tui: { requestRender: () => void },
			theme: Theme,
		) => { render(width: number): string[]; invalidate(): void; handleInput?(data: string): void; dispose?(): void }
	>();
	readonly notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
	/** Theme names passed to ui.setTheme by the extension under test. */
	readonly setThemeCalls: string[] = [];
	readonly renderRequests: Array<"tui" | "rpc"> = [];
	readonly overlays: FakeOverlay[] = [];
	readonly workingIndicatorChanges: Array<WorkingIndicatorOptions | undefined> = [];
	terminalInputSubscriptions = 0;
	readonly terminalInputHandlers = new Set<(data: string) => { consume?: boolean; data?: string } | undefined>();
	private overlayOpenWaiters: Array<(overlay: FakeOverlay) => void> = [];
	currentEditorText = "";
	readonly mainEditorSubmissions: string[] = [];

	/** Dispatch raw terminal input through extension handlers; returns true when consumed. */
	emitTerminalInput(data: string): boolean {
		let consumed = false;
		for (const handler of this.terminalInputHandlers) {
			const result = handler(data);
			if (result?.consume) {
				consumed = true;
				break;
			}
		}
		if (!consumed) {
			for (let index = this.overlays.length - 1; index >= 0; index--) {
				const overlay = this.overlays[index];
				if (!overlay?.component || overlay.handle.hidden || !overlay.handle.isFocused()) continue;
				overlay.component.handleInput?.(data);
				consumed = true;
				break;
			}
			if (!consumed && data === "\r") this.mainEditorSubmissions.push(this.currentEditorText);
		}
		return consumed;
	}
	waitForOverlayOpen(): Promise<FakeOverlay> {
		for (let index = this.overlays.length - 1; index >= 0; index--) {
			const overlay = this.overlays[index];
			if (overlay?.component && !overlay.handle.hidden) return Promise.resolve(overlay);
		}
		const deferred = Promise.withResolvers<FakeOverlay>();
		this.overlayOpenWaiters.push(deferred.resolve);
		return deferred.promise;
	}
	waitForNextOverlayOpen(): Promise<FakeOverlay> {
		const deferred = Promise.withResolvers<FakeOverlay>();
		this.overlayOpenWaiters.push(deferred.resolve);
		return deferred.promise;
	}

	emitOverlayInput(data: string): boolean {
		for (let index = this.overlays.length - 1; index >= 0; index--) {
			const overlay = this.overlays[index];
			if (!overlay?.component || overlay.handle.hidden || !overlay.handle.isFocused()) continue;
			if (!overlay.component.handleInput) return false;
			overlay.component.handleInput(data);
			return true;
		}
		return false;
	}
	private headerFactory: Parameters<NonNullable<ExtensionUIContext["setHeader"]>>[0] | undefined;
	readonly ownership = {
		header: { initial: false, current: false, restores: 0 },
		editor: { initial: false, current: false, restores: 0 },
		footer: { initial: false, current: false, restores: 0 },
	};
	private editorFactory: NonNullable<ExtensionUIContext["setEditorComponent"]> extends (factory: infer F) => void
		? F | undefined
		: undefined;
	/** Active theme; ui.setTheme may replace it. */
	theme: Theme;
	private readonly themeRegistry: Map<string, Theme>;
	model: unknown;
	thinkingLevel = "off";
	private sessionStarted = false;
	/** Last label passed to setHiddenThinkingLabel by the extension (undefined = untouched). */
	hiddenThinkingLabel: string | undefined = undefined;
	private readonly api: ExtensionAPI;
	private readonly context: ExtensionContext;
	private readonly sessionReason: NonNullable<FakePiHostOptions["sessionReason"]>;
	private readonly systemPrompt: string;
	private readonly flagValues: Record<string, boolean | string | undefined>;
	private readonly projectTrusted: boolean;
	private readonly cwd: string | undefined;
	readonly sessionEntries: readonly unknown[];
	/** Mutable session view; tests can move the leaf/branch to simulate switches. */
	sessionView: NonNullable<FakePiHostOptions["sessionView"]>;
	private readonly overlayTerminal: { rows: number; columns: number };

	constructor(options: FakePiHostOptions = {}) {
		this.mode = options.mode ?? "tui";
		this.sessionReason = options.sessionReason ?? "startup";
		this.systemPrompt = options.systemPrompt ?? "";
		this.flagValues = { ...options.flags };
		this.projectTrusted = options.projectTrusted ?? true;
		this.cwd = options.cwd ?? "/fake";
		this.sessionEntries = options.sessionEntries ?? [];
		this.sessionView = { ...(options.sessionView ?? {}) };
		this.overlayTerminal = options.overlayTerminal ?? { rows: 24, columns: 80 };
		this.capabilities = { ...defaultCapabilities, ...options.capabilities };
		this.theme = createFakeTheme({ name: options.themeName ?? "fake" });
		this.themeRegistry = new Map(Object.entries(options.themes ?? {}));
		if (!this.themeRegistry.has(this.theme.name ?? "fake"))
			this.themeRegistry.set(this.theme.name ?? "fake", this.theme);
		this.ownership.editor.initial = options.initialEditor !== undefined;
		this.ownership.editor.current = this.ownership.editor.initial;
		this.ownership.footer.initial = options.initialFooter !== undefined;
		this.ownership.footer.current = this.ownership.footer.initial;
		this.editorFactory = options.initialEditor;
		this.api = this.createApi();
		this.context = this.createContext();
	}

	get extensionApi(): ExtensionAPI {
		return this.api;
	}

	get extensionContext(): ExtensionContext {
		return this.context;
	}

	getSystemPrompt(): string {
		return this.systemPrompt;
	}

	get sessionIsStarted(): boolean {
		return this.sessionStarted;
	}

	get currentHeaderFactory(): typeof this.headerFactory {
		return this.headerFactory;
	}

	requestRender(): void {
		if (this.mode === "tui" || this.mode === "rpc") this.renderRequests.push(this.mode);
	}

	async emit<T extends ExtensionEvent["type"]>(type: T, event: Extract<ExtensionEvent, { type: T }>): Promise<void> {
		for (const handler of this.handlers.get(type) ?? []) await handler(event, this.context);
	}

	private createApi(): ExtensionAPI {
		const partial: Partial<ExtensionAPI> = {
			on: (event, handler) => {
				const list = this.handlers.get(event) ?? [];
				list.push(handler as unknown as Handler);
				this.handlers.set(event, list);
			},
			registerCommand: (name, options) => {
				this.commands.set(name, options);
			},
			registerShortcut: () => {},
			registerFlag: (name, options) => {
				this.registeredFlags.set(name, options);
				// Mirror Pi's extension loader: registerFlag seeds the runtime flag value
				// with its default when the session did not pass an explicit value.
				if (options.default !== undefined && this.flagValues[name] === undefined) {
					this.flagValues[name] = options.default;
				}
			},
			getFlag: (name) => this.flagValues[name],
			registerTool: (tool) => {
				this.registeredTools.push(tool);
			},
			registerMessageRenderer: (customType, renderer) => {
				this.registeredMessageRenderers.set(customType, renderer);
			},
			registerEntryRenderer: (customType, renderer) => {
				this.registeredEntryRenderers.set(customType, renderer);
			},
			sendMessage: (message, options) => {
				this.sentMessages.push({
					message: message as never,
					options: options as never,
				});
			},
			sendUserMessage: () => {},
			appendEntry: (customType, data) => {
				this.appendedEntries.push({ customType, data });
			},
			setSessionName: () => {},
			getSessionName: () => undefined,
			setLabel: () => {},
			exec: async () => ({
				stdout: "",
				stderr: "",
				output: "",
				code: 0,
				exitCode: 0,
				killed: false,
				cancelled: false,
				truncated: false,
			}),
			getActiveTools: () => [...this.activeTools],
			getAllTools: () => [...this.allTools] as never,
			setActiveTools: (toolNames) => {
				this.activeTools = [...toolNames];
			},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => this.thinkingLevel as never,
			setThinkingLevel: (level) => {
				this.thinkingLevel = level;
			},
			registerProvider: () => {},
			unregisterProvider: () => {},
			events: { on: () => () => {}, emit: async () => {}, subscribe: () => () => {} } as never,
		};
		return partial as ExtensionAPI;
	}

	private createContext(): ExtensionContext {
		const host = this;
		const sessionView = () => host.sessionView;
		const ui: ExtensionUIContext = {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: (message, type) => {
				this.notifications.push({ message, type });
			},
			onTerminalInput: (handler) => {
				this.terminalInputSubscriptions++;
				this.terminalInputHandlers.add(handler as never);
				return () => {
					this.terminalInputSubscriptions--;
					this.terminalInputHandlers.delete(handler as never);
				};
			},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: this.capabilities.workingIndicator
				? (options) => {
						this.workingIndicatorChanges.push(options);
					}
				: () => {},
			setHiddenThinkingLabel: (label) => {
				this.hiddenThinkingLabel = label;
			},
			setWidget: this.capabilities.widgets
				? (key, content, options) => {
						if (content === undefined) {
							this.widgets.delete(key);
							this.componentFactories.delete(key);
						} else {
							this.widgets.set(key, { content, placement: options?.placement ?? "aboveEditor" });
							if (typeof content === "function") this.componentFactories.set(key, content as never);
						}
					}
				: () => {},
			setFooter: this.capabilities.customFooter
				? (factory) => {
						this.ownership.footer.current = factory !== undefined;
						if (factory === undefined) this.ownership.footer.restores++;
					}
				: () => {},
			setHeader: this.capabilities.header
				? (factory) => {
						this.headerFactory = factory;
						this.ownership.header.current = factory !== undefined;
						if (factory === undefined) this.ownership.header.restores++;
					}
				: () => {},
			setTitle: () => {},
			custom: async (factory, options) => {
				this.requestRender();
				if (!options?.overlay) return undefined as never;
				const handle = {
					hidden: false,
					disposed: false,
					hide() {
						this.hidden = true;
						this.disposed = true;
					},
					setHidden(hidden: boolean) {
						this.hidden = hidden;
					},
					isHidden() {
						return this.hidden;
					},
					focus() {},
					unfocus() {},
					isFocused() {
						return !this.hidden;
					},
				};
				const closed = Promise.withResolvers<unknown>();
				const overlay: FakeOverlay = {
					options: options.overlayOptions,
					handle,
					close(result) {
						if (handle.disposed) return;
						handle.hidden = true;
						handle.disposed = true;
						overlay.component?.dispose?.();
						closed.resolve(result);
					},
				};
				this.overlays.push(overlay);
				const keybindings = {
					matches(data: string, action: string) {
						if (action === "app.tools.expand") return matchesKey(data, "ctrl+o");
						if (action === "tui.select.cancel") return matchesKey(data, "escape");
						return false;
					},
				};
				const component = await factory(
					{
						requestRender: () => this.requestRender(),
						terminal: { ...this.overlayTerminal },
						getShowHardwareCursor: () => true,
					} as never,
					this.theme,
					keybindings as never,
					(result) => overlay.close(result),
				);
				overlay.component = component as Component;
				if (handle.disposed) {
					overlay.component.dispose?.();
					return (await closed.promise) as never;
				}
				options.onHandle?.(handle as never);
				this.componentFactories.set("pi-teams.fake-overlay", (() => component) as never);
				for (const resolve of this.overlayOpenWaiters.splice(0)) resolve(overlay);
				this.requestRender();
				return (await closed.promise) as never;
			},
			pasteToEditor: () => {},
			setEditorText: (text) => {
				this.currentEditorText = text;
			},
			getEditorText: () => this.currentEditorText,
			editor: async () => undefined,
			addAutocompleteProvider: () => {},
			setEditorComponent: this.capabilities.customEditor
				? (factory) => {
						this.editorFactory = factory;
						this.ownership.editor.current = factory !== undefined;
						if (factory === undefined) this.ownership.editor.restores++;
					}
				: () => {},
			getEditorComponent: () => this.editorFactory,
			get theme() {
				return host.theme;
			},
			getAllThemes: () => [...host.themeRegistry.keys()].map((name) => ({ name, path: undefined })),
			getTheme: (name) => host.themeRegistry.get(name),
			setTheme: (themeOrName) => {
				const name = typeof themeOrName === "string" ? themeOrName : ((themeOrName as Theme).name ?? "");
				host.setThemeCalls.push(name);
				const candidate = typeof themeOrName === "string" ? host.themeRegistry.get(name) : (themeOrName as Theme);
				if (!candidate) return { success: false, error: `unknown theme "${name}"` };
				host.theme = candidate;
				return { success: true };
			},
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
		return {
			ui,
			mode: this.mode,
			hasUI: this.mode === "tui" || this.mode === "rpc",
			cwd: this.cwd ?? "/fake",
			sessionManager: {
				getEntries: () => this.sessionEntries,
				...(() => {
					const view = sessionView();
					if (view === undefined) return {};
					return {
						...(view.sessionId !== undefined ? { getSessionId: () => view.sessionId } : {}),
						...(view.leafId !== undefined || view.branch !== undefined ? { getLeafId: () => view.leafId ?? null } : {}),
						...(view.branch !== undefined ? { getBranch: () => view.branch ?? [] } : {}),
					};
				})(),
			} as never,
			modelRegistry: {} as never,
			model: undefined,
			scopedModels: [],
			thinkingLevel: "off" as never,
			isIdle: () => true,
			isProjectTrusted: () => this.projectTrusted,
			signal: undefined,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: () => {},
			getSystemPrompt: () => this.systemPrompt,
		};
	}

	async sessionStart(): Promise<void> {
		this.sessionStarted = true;
		await this.emit("session_start", { type: "session_start", reason: this.sessionReason });
	}
	async sessionShutdown(): Promise<void> {
		await this.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		this.sessionStarted = false;
	}
}
