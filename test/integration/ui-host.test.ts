// Integration: pi/ui-host.ts + pi/commands.ts driven by FakePiHost +
// FakeBackend. Verifies the below-editor panel, fullscreen overlay lifecycle,
// §5 keyboard table, composer routing, stop/dismiss, and settings/ownership.
// Child-process execution and model requests are outside this host test.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditorFactory } from "@earendil-works/pi-coding-agent";
import { type Component, Editor, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createAgentFocusPort } from "../../extension-src/pi-teams/app/focus-service.js";
import { createPiSubagentsApp, type PiSubagentsApp } from "../../extension-src/pi-teams/app/index.js";
import { sanitizeSettings } from "../../extension-src/pi-teams/domain/config.js";
import type { AgentViewOverlay } from "../../extension-src/pi-teams/features/agent-view/index.js";
import { registerAgentsCommand } from "../../extension-src/pi-teams/pi/commands.js";
import { createPiTeamStore } from "../../extension-src/pi-teams/pi/teams-host.js";
import { createPiTranscriptSource } from "../../extension-src/pi-teams/pi/transcript-host.js";
import { installSubagentsUi, type SubagentsUiHandle } from "../../extension-src/pi-teams/pi/ui-host.js";
import { FakeBackend } from "../helpers/fake-backend.js";
import { FakePiHost } from "../helpers/fake-pi-host.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const ENTER = "\r";
const ESC = "\x1b";

interface Fixture {
	host: FakePiHost;
	backend: FakeBackend;
	app: PiSubagentsApp;
	ui: SubagentsUiHandle;
	spawn(description?: string): Promise<string>;
}

async function makeFixture(
	options: { agentPanel?: boolean; initialEditor?: EditorFactory; now?: () => number; teamCwd?: string } = {},
): Promise<Fixture> {
	const host = new FakePiHost({
		mode: "tui",
		sessionView: { sessionId: "session-a" },
		...(options.initialEditor !== undefined ? { initialEditor: options.initialEditor } : {}),
	});
	const backend = new FakeBackend();
	let nextId = 0;
	const teamCwd = options.teamCwd;
	const app = createPiSubagentsApp({
		sources: [],
		loader: async () => [],
		settings: sanitizeSettings({
			backgroundByDefault: true,
			...(options.agentPanel === false ? { agentPanel: false } : {}),
		}),
		backends: [backend],
		cwd: "/tmp/project",
		configCwd: "/tmp/project",
		...(teamCwd ? { createTeamStore: (sessionId: string) => createPiTeamStore(teamCwd, sessionId) } : {}),
		managerOverrides: {
			idFactory: () => {
				nextId += 1;
				return `run-${nextId}`;
			},
			getSessionId: () => "session-a",
		},
	});
	await app.sessionStart();
	let ui: SubagentsUiHandle | undefined;
	const transcripts = createPiTranscriptSource({ backends: [backend] });
	registerAgentsCommand(host.extensionApi, {
		manager: app.manager,
		openHub: () => ui?.openHub(),
	});
	ui = installSubagentsUi(host.extensionContext, {
		manager: app.manager,
		focus: createAgentFocusPort({ manager: app.manager, transcripts }),
		settings: () => app.manager.currentSettings,
		transcripts,
		...(options.now ? { now: options.now } : {}),
	});

	async function spawnBackground(description?: string): Promise<string> {
		const record = await app.manager.spawn({
			type: "explore",
			prompt: "find auth files",
			run_in_background: true,
			...(description === undefined ? {} : { description }),
		});
		await vi.waitFor(() => expect(app.manager.get(record.id)?.status).toBe("running"));
		ui.refresh();
		if (options.agentPanel !== false) {
			await vi.waitFor(() => {
				const factory = host.componentFactories.get("teams-agents");
				const lines = factory?.({ requestRender() {} }, host.theme).render(100);
				expect(lines?.[0]).toContain(`team (${app.manager.list().length})`);
				if (description) expect(lines?.join("\n")).toContain(description);
			});
		}
		return record.id;
	}

	return { host, backend, app, ui, spawn: spawnBackground };
}

/** Editor theme stub shared by native and foreign-subclass mounts. */
const EDITOR_THEME = {
	borderColor: (text: string) => text,
	selectList: {
		selectedPrefix: (text: string) => text,
		selectedText: (text: string) => text,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
	},
} as const;

/** Mount the real native editor as the widget TUI's observed focus owner. */
function mountMainEditor(
	fx: Fixture,
	createEditor: (tui: TUI) => Editor | undefined = (tui) => new Editor(tui, EDITOR_THEME),
) {
	const tui: {
		requestRender(): void;
		terminal: { rows: number; columns: number };
		focusedComponent?: Component;
		hasOverlay(): boolean;
	} = {
		requestRender() {},
		terminal: { rows: 24, columns: 100 },
		hasOverlay: () => fx.host.overlays.some((overlay) => !overlay.handle.hidden),
	};
	const editor = createEditor(tui as unknown as TUI);
	if (editor !== undefined) tui.focusedComponent = editor;
	const factory = fx.host.componentFactories.get("teams-agents");
	if (!factory) throw new Error("Inline agent widget is not installed");
	const panel = factory(tui, fx.host.theme);
	return { tui, editor, panel };
}

describe("inline UI installation", () => {
	it("names the empty overlay Team Hub", async () => {
		const fx = await makeFixture();
		try {
			fx.ui.openHub();
			const hub = await fx.host.waitForOverlayOpen();
			expect(hub.component?.render(100)[0]).toContain("team (0) — Team Hub");
		} finally {
			fx.ui.dispose();
			await fx.app.sessionShutdown();
		}
	});

	it("keeps restored settled history in the Hub without an inline panel", async () => {
		const fx = await makeFixture();
		const launched = Promise.withResolvers<void>();
		const launch = fx.backend.launch.bind(fx.backend);
		fx.backend.launch = async (input) => {
			const handle = await launch(input);
			launched.resolve();
			return handle;
		};
		const record = await fx.app.manager.spawn({
			type: "explore",
			prompt: "inspect",
			description: "RESTORED_IDLE",
			run_in_background: true,
		});
		await launched.promise;
		fx.backend.complete(record.id, "finished");
		await fx.app.manager.waitForAll();
		fx.ui.dispose();
		const ctx = fx.host.extensionContext;
		const transcripts = createPiTranscriptSource({ backends: [fx.backend] });
		const ui = installSubagentsUi(ctx, {
			manager: fx.app.manager,
			focus: createAgentFocusPort({ manager: fx.app.manager, transcripts }),
			settings: () => fx.app.manager.currentSettings,
			transcripts,
		});
		try {
			ui.openHub();
			const hub = await fx.host.waitForOverlayOpen();
			await vi.waitFor(() => expect(hub.component?.render(100).join("\n")).toContain("RESTORED_IDLE"));
			expect(hub.component?.render(100)[0]).toContain("Team Hub");
			expect(fx.host.widgets.has("teams-agents")).toBe(false);
			expect(fx.app.manager.get(record.id)?.status).toBe("completed");
		} finally {
			ui.dispose();
			await fx.app.sessionShutdown();
		}
	});

	it("hides settled runs inline while retaining their Hub history and active siblings", async () => {
		const fx = await makeFixture();
		try {
			const first = await fx.spawn("FINISHED_FIRST");
			const second = await fx.spawn("ACTIVE_SECOND");
			fx.backend.complete(first, "FIRST_FINISHED");
			await vi.waitFor(() => {
				const factory = fx.host.componentFactories.get("teams-agents");
				const text = factory?.({ requestRender() {} }, fx.host.theme)
					.render(100)
					.join("\n");
				expect(text).toContain("ACTIVE_SECOND");
				expect(text).not.toContain("FINISHED_FIRST");
			});
			fx.backend.complete(second, "SECOND_FINISHED");
			await fx.app.manager.waitForAll();
			await vi.waitFor(() => expect(fx.host.widgets.has("teams-agents")).toBe(false));
		} finally {
			fx.ui.dispose();
			await fx.app.sessionShutdown();
		}
	});

	it("keeps an idle named teammate in the Hub but not inline beside active siblings", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-teams-idle-panel-"));
		const fx = await makeFixture({ teamCwd: root });
		try {
			const named = await fx.app.manager.spawn({
				type: "explore",
				name: "idle-peer",
				description: "RETAINED_PEER",
				prompt: "read only",
				run_in_background: true,
			});
			await vi.waitFor(() => expect(fx.app.manager.get(named.id)?.status).toBe("running"));
			const active = await fx.spawn("ACTIVE_SIBLING");
			fx.backend.complete(named.id, "PEER_FINISHED");
			await vi.waitFor(() => {
				const factory = fx.host.componentFactories.get("teams-agents");
				const text = factory?.({ requestRender() {} }, fx.host.theme)
					.render(120)
					.join("\n");
				expect(text).toContain("ACTIVE_SIBLING");
				expect(text).not.toContain("RETAINED_PEER");
			});
			expect(fx.app.manager.get(named.id)?.handle).toBeDefined();
			fx.backend.complete(active, "SIBLING_FINISHED");
			await fx.app.manager.waitForAll();
			await vi.waitFor(() => expect(fx.host.widgets.has("teams-agents")).toBe(false));
			fx.ui.openHub();
			const hub = await fx.host.waitForOverlayOpen();
			const text = hub.component?.render(120).join("\n");
			expect(text).toContain("RETAINED_PEER");
			expect(text).toContain("idle-peer");
			expect(fx.app.manager.get(named.id)?.handle).toBeDefined();
		} finally {
			fx.ui.dispose();
			await fx.app.sessionShutdown();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("agentPanel=false skips widget install while the lifecycle stays untouched", async () => {
		const fx = await makeFixture({ agentPanel: false });
		await fx.spawn();
		expect(fx.host.widgets.has("teams-agents")).toBe(false);
		// ↓ is NOT consumed (no UI active)
		expect(fx.host.emitTerminalInput(DOWN)).toBe(false);
		expect(fx.app.manager.get("run-1")?.status).toBe("running");
	});
});

describe("keyboard table via onTerminalInput", () => {
	it("↓ at empty editor focuses panel; ↑ back; Enter on main deactivates", async () => {
		const fx = await makeFixture();
		await fx.spawn();

		expect(fx.host.emitTerminalInput(DOWN)).toBe(true); // activation consumed
		expect(fx.host.overlays).toHaveLength(0);
		expect(fx.host.emitTerminalInput(UP)).toBe(true); // up at main clears navigation
		expect(fx.host.emitTerminalInput(DOWN)).toBe(true);
		expect(fx.host.emitTerminalInput(ENTER)).toBe(true); // enter on main → back to prompt
		expect(fx.host.overlays).toHaveLength(0);
		expect(fx.ui.isViewOpen()).toBe(false);
		expect(fx.host.emitTerminalInput(DOWN)).toBe(true);
		expect(fx.host.emitTerminalInput(ESC)).toBe(true);

		// typing still flows: unhandled keys are not consumed while inactive
		expect(fx.host.emitTerminalInput("q")).toBe(false);
	});

	it("keeps inline navigation out of the Hub and defers when a dialog takes focus", async () => {
		const fx = await makeFixture();
		await fx.spawn();
		const { tui } = mountMainEditor(fx);
		expect(fx.host.emitTerminalInput(DOWN)).toBe(true);
		expect(fx.host.overlays).toHaveLength(0);
		tui.focusedComponent = { render: () => [], invalidate() {} };
		expect(fx.host.emitTerminalInput(DOWN)).toBe(false);
		expect(fx.host.emitTerminalInput(ENTER)).toBe(false);
	});

	it("leaves slash/autocomplete, nonempty and multiline editor navigation to Pi", async () => {
		const fx = await makeFixture();
		await fx.spawn();
		const { editor } = mountMainEditor(fx);
		const autocomplete = vi.spyOn(editor, "isShowingAutocomplete").mockReturnValue(true);
		for (const text of ["/", "draft", "first\nsecond", ""]) {
			editor.setText(text);
			fx.host.currentEditorText = text;
			for (const key of [DOWN, LEFT, LEFT]) expect(fx.host.emitTerminalInput(key)).toBe(false);
		}
		autocomplete.mockReturnValue(false);
		for (const text of ["draft", "first\nsecond"]) {
			editor.setText(text);
			fx.host.currentEditorText = text;
			expect(fx.host.emitTerminalInput(DOWN)).toBe(false);
			expect(fx.host.emitTerminalInput(LEFT)).toBe(false);
			expect(fx.host.emitTerminalInput(LEFT)).toBe(false);
		}
		editor.handleInput("\x01"); // start of second line is not document start
		expect(fx.host.emitTerminalInput(LEFT)).toBe(false);
		expect(fx.host.emitTerminalInput(LEFT)).toBe(false);
		expect(fx.host.overlays).toHaveLength(0);
	});

	it("opens Hub only on two deliberate Left presses at the native document boundary", async () => {
		const fx = await makeFixture();
		await fx.spawn();
		const { editor } = mountMainEditor(fx);
		editor.setText("KEEP_MAIN_DRAFT");
		fx.host.currentEditorText = editor.getText();
		expect(fx.host.emitTerminalInput(LEFT)).toBe(false); // cursor inside draft
		editor.handleInput(LEFT);
		expect(fx.host.overlays).toHaveLength(0);
		editor.handleInput("\x01");
		expect(fx.host.emitTerminalInput(LEFT)).toBe(false); // first boundary press
		expect(fx.host.overlays).toHaveLength(0);
		expect(fx.host.emitTerminalInput(LEFT)).toBe(true);
		await fx.host.waitForOverlayOpen();
		expect(fx.host.currentEditorText).toBe("KEEP_MAIN_DRAFT");
		expect(fx.ui.isViewOpen()).toBe(false);
	});

	it("opens Hub with Left-left while inline bottom navigation is active", async () => {
		const fx = await makeFixture();
		await fx.spawn();
		mountMainEditor(fx);
		expect(fx.host.emitTerminalInput(DOWN)).toBe(true);
		expect(fx.host.emitTerminalInput(LEFT)).toBe(false);
		expect(fx.host.overlays).toHaveLength(0);
		expect(fx.host.emitTerminalInput(LEFT)).toBe(true);
		await fx.host.waitForOverlayOpen();
		expect(fx.ui.isViewOpen()).toBe(false);
	});

	it("resets double Left on other input, focus/session changes, delay and held repeats", async () => {
		let time = 1_000;
		const fx = await makeFixture({ now: () => time });
		await fx.spawn();
		const { tui, editor } = mountMainEditor(fx);
		expect(fx.host.emitTerminalInput(LEFT)).toBe(false);
		fx.host.emitTerminalInput("\x1b[C");
		expect(fx.host.emitTerminalInput(LEFT)).toBe(false);
		tui.focusedComponent = { render: () => [], invalidate() {} };
		expect(fx.host.emitTerminalInput(LEFT)).toBe(false);
		tui.focusedComponent = editor;
		expect(fx.host.emitTerminalInput(LEFT)).toBe(false);
		vi.spyOn(fx.host.extensionContext.sessionManager, "getSessionId").mockReturnValue("session-b");
		expect(fx.host.emitTerminalInput(LEFT)).toBe(false);
		time += 501;
		expect(fx.host.emitTerminalInput(LEFT)).toBe(false);
		expect(fx.host.emitTerminalInput("\x1b[1;1:2D")).toBe(false); // Kitty repeat disarms
		expect(fx.host.emitTerminalInput(LEFT)).toBe(false);
		expect(fx.host.overlays).toHaveLength(0);
		fx.host.emitTerminalInput("\x1b[1;1:3D"); // matching key release does not disarm
		expect(fx.host.emitTerminalInput(LEFT)).toBe(true);
		await fx.host.waitForOverlayOpen();
	});

	it("never selects a settled hidden child instead of the visible inline row", async () => {
		const fx = await makeFixture();
		const active = await fx.spawn("VISIBLE_ACTIVE");
		const finished = await fx.spawn("HIDDEN_HISTORY");
		fx.backend.complete(finished, "settled");
		await vi.waitFor(() => expect(fx.app.manager.get(finished)?.status).toBe("completed"));
		fx.ui.refresh();
		const { panel } = mountMainEditor(fx);
		await vi.waitFor(() => expect(panel.render(100).join("\n")).not.toContain("HIDDEN_HISTORY"));
		fx.host.emitTerminalInput(DOWN);
		fx.host.emitTerminalInput(DOWN);
		const opening = fx.host.waitForNextOverlayOpen();
		fx.host.emitTerminalInput(ENTER);
		const overlay = await opening;
		expect(overlay.component?.render(100).join("\n")).toContain("VISIBLE_ACTIVE");
		expect(fx.app.manager.get(active)?.status).toBe("running");
	});

	it("isolates batched input from the Main editor while the native Hub owns focus", async () => {
		const fx = await makeFixture();
		await fx.spawn();
		fx.host.currentEditorText = "PARENT_DRAFT_KEEP";
		const opening = fx.host.waitForOverlayOpen();
		expect(fx.host.emitTerminalInput("\x1bg")).toBe(true);
		const hub = await opening;
		const focused = vi.spyOn(hub.handle, "isFocused").mockReturnValue(false);
		expect(fx.host.emitTerminalInput(DOWN)).toBe(false);
		focused.mockReturnValue(true);

		expect(fx.host.emitTerminalInput(`${DOWN}${ENTER}`)).toBe(true);
		expect(fx.host.emitTerminalInput("typed while hub is open")).toBe(true);
		expect(fx.host.mainEditorSubmissions).toEqual([]);
		expect(fx.host.currentEditorText).toBe("PARENT_DRAFT_KEEP");
		expect(fx.backend.steers).toEqual([]);
		fx.host.emitTerminalInput(ESC);
	});

	it("↓ then ↓ then Enter opens the fullscreen transcript overlay; Esc closes WITHOUT stopping", async () => {
		const fx = await makeFixture();
		const runId = await fx.spawn();
		const opening = fx.host.waitForOverlayOpen();

		fx.host.emitTerminalInput(DOWN);
		fx.host.emitTerminalInput(DOWN);
		fx.host.emitTerminalInput(ENTER);
		const overlay = await opening;

		expect(overlay.options).toMatchObject({ anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 });
		expect(overlay.component).toBeDefined();
		fx.host.currentEditorText = "PARENT_DRAFT";
		fx.host.emitTerminalInput(ESC);
		expect(overlay.handle.hidden).toBe(true);
		expect(fx.host.currentEditorText).toBe("PARENT_DRAFT");
		expect(fx.backend.stops).toHaveLength(0);
		expect(fx.app.manager.get(runId)?.status).toBe("running");
	});

	it("x requires two presses to stop a running agent", async () => {
		const fx = await makeFixture();
		await fx.spawn();

		fx.host.emitTerminalInput(DOWN);
		fx.host.emitTerminalInput(DOWN);
		fx.host.emitTerminalInput("x"); // arm
		expect(fx.backend.stops).toHaveLength(0);
		fx.host.emitTerminalInput(LEFT); // an intervening navigation gesture disarms stop
		fx.host.emitTerminalInput("x"); // arm again, never confirm across Left
		expect(fx.backend.stops).toHaveLength(0);
		fx.host.emitTerminalInput("x"); // confirm
		expect(fx.backend.stops).toHaveLength(1);
	});

	it("x dismisses a finished row without touching backend resources", async () => {
		const fx = await makeFixture();
		const runId = await fx.spawn("DISMISS_SETTLED");
		fx.backend.complete(runId, "done");
		await vi.waitFor(() => expect(fx.app.manager.get(runId)?.status).toBe("completed"));

		fx.ui.openHub(); // Settled rows are only reachable through the Hub.
		const hub = await fx.host.waitForOverlayOpen();
		fx.host.emitTerminalInput(DOWN);
		fx.host.emitTerminalInput("x"); // dismiss — no confirm needed for finished rows
		await vi.waitFor(() => expect(hub.component?.render(100).join("\n")).not.toContain("DISMISS_SETTLED"));
		expect(fx.backend.stops).toHaveLength(0);
		expect(fx.app.manager.get(runId)?.status).toBe("completed");
	});
});

describe("composer routing in the transcript view", () => {
	async function openView(fx: Fixture): Promise<AgentViewOverlay> {
		await fx.spawn();
		const opening = fx.host.waitForOverlayOpen();
		fx.host.emitTerminalInput(DOWN);
		fx.host.emitTerminalInput(DOWN);
		fx.host.emitTerminalInput(ENTER);
		const overlay = await opening;
		if (!overlay.component) throw new Error("Agent overlay has no component");
		return overlay.component as AgentViewOverlay;
	}

	it("routes typed text + Enter to manager.steer and clears the view editor", async () => {
		const fx = await makeFixture();
		const overlay = await openView(fx);

		overlay.editor.setText("also check middleware");
		expect(fx.host.emitTerminalInput(ENTER)).toBe(true);
		expect(overlay.editor.getText()).toBe("");
		expect(fx.backend.steers.some((steer) => steer.message === "also check middleware")).toBe(true);
	});

	it("keeps printable x/o and navigation keys inside an in-progress steering message", async () => {
		const fx = await makeFixture();
		const overlay = await openView(fx);
		overlay.editor.setText("e");
		fx.host.emitTerminalInput("x");
		fx.host.emitTerminalInput("x");
		for (const key of [UP, DOWN, "\x1b[H", "\x1b[F", "\x1b[5~", "\x1b[6~", "o"]) fx.host.emitTerminalInput(key);
		expect(overlay.editor.getText()).toBe("exxo");
		expect(fx.backend.stops).toEqual([]);
		fx.host.emitTerminalInput(ENTER);
		expect(fx.backend.steers.some((steer) => steer.message === "exxo")).toBe(true);
	});

	it("rejects slash-prefixed child input without leaking it into the parent editor", async () => {
		const fx = await makeFixture();
		const overlay = await openView(fx);
		overlay.editor.setText("/tree");
		fx.host.emitTerminalInput(ENTER);
		expect(overlay.editor.getText()).toBe("/tree");
		expect(fx.backend.steers).toHaveLength(0);
		const rendered = overlay.render(80).join("\n");
		expect(rendered).toContain("Unsupported or unavailable child command: /tree.");
		expect(fx.host.notifications.some(({ message }) => message.includes("Unsupported"))).toBe(false);
	});

	it("finished agents route text + Enter to manager.resume instead of steer", async () => {
		const fx = await makeFixture();
		const runId = await fx.spawn();
		fx.backend.complete(runId, "finished work", "/tmp/teams-ui-test/session.jsonl");
		await fx.app.manager.waitForAll();

		fx.ui.openHub(); // Settled rows are not part of inline navigation.
		await fx.host.waitForOverlayOpen();
		fx.host.emitTerminalInput(DOWN);
		const opening = fx.host.waitForNextOverlayOpen();
		fx.host.emitTerminalInput(ENTER);
		const opened = await opening;
		if (!opened.component) throw new Error("Agent overlay has no component");
		const overlay = opened.component as AgentViewOverlay;
		const resumedOverlay = fx.host.waitForNextOverlayOpen();
		overlay.editor.setText("continue with tests");
		fx.host.emitTerminalInput(ENTER);
		await resumedOverlay;

		expect(fx.app.manager.list().some((record) => record.id !== runId && record.status !== "completed")).toBe(true);
		expect(fx.backend.resumes.length).toBeGreaterThan(0);
	}, 10_000);
});

describe("degraded mode (foreign custom editor)", () => {
	it("panel renders but key routing does not activate or intercept Enter", async () => {
		const foreignEditor: EditorFactory = () => ({ render: () => [] }) as never;
		const fx = await makeFixture({ initialEditor: foreignEditor });
		await fx.spawn();

		// Panel still installed below the editor.
		expect(fx.host.widgets.has("teams-agents")).toBe(true);
		expect(fx.host.widgets.get("teams-agents")?.placement).toBe("belowEditor");

		// ↓ not consumed (foreign editor owns the prompt).
		expect(fx.host.emitTerminalInput(DOWN)).toBe(false);

		// /agents remains as the alternative access path.
		const handle = fx.host.commands.get("agents");
		expect(handle).toBeDefined();
	});

	it("defers even when an opaque foreign component is the observed focus owner", async () => {
		const foreignEditor: EditorFactory = () => ({ render: () => [] }) as never;
		const fx = await makeFixture({ initialEditor: foreignEditor });
		await fx.spawn();
		// Focus is observable but the component is not Editor-shaped, so
		// cursor/autocomplete reads cannot be trusted; keys stay untouched.
		mountMainEditor(fx, (tui) => {
			(tui as unknown as { focusedComponent?: unknown }).focusedComponent = { render: () => [] };
			return undefined;
		});
		expect(fx.host.emitTerminalInput(DOWN)).toBe(false);
	});
});

describe("foreign editor that preserves Editor semantics (e.g. pi-style)", () => {
	// pi-style's StyledEditor extends CustomEditor which extends Editor: a
	// foreign prompt that still exposes public cursor/autocomplete APIs.
	class StyledForeignEditor extends Editor {}

	it("↓ at an empty foreign Editor-subclass prompt activates inline navigation", async () => {
		const foreignEditor: EditorFactory = () => ({ render: () => [] }) as never;
		const fx = await makeFixture({ initialEditor: foreignEditor });
		await fx.spawn();
		const { editor } = mountMainEditor(fx, (tui) => new StyledForeignEditor(tui, EDITOR_THEME));

		expect(editor.getText()).toBe("");
		expect(fx.host.emitTerminalInput(DOWN)).toBe(true); // activation consumed
		expect(fx.host.emitTerminalInput(ESC)).toBe(true); // leave navigation
		// Unhandled typing still flows to the foreign editor.
		expect(fx.host.emitTerminalInput("q")).toBe(false);
	});

	it("←← at document start under a foreign Editor subclass opens the Hub", async () => {
		const foreignEditor: EditorFactory = () => ({ render: () => [] }) as never;
		const fx = await makeFixture({ initialEditor: foreignEditor });
		await fx.spawn();
		mountMainEditor(fx, (tui) => new StyledForeignEditor(tui, EDITOR_THEME));

		expect(fx.host.emitTerminalInput(LEFT)).toBe(false); // first press belongs to the prompt
		const opening = fx.host.waitForNextOverlayOpen();
		expect(fx.host.emitTerminalInput(LEFT)).toBe(true); // second press opens the Hub
		await opening;
		fx.host.emitTerminalInput(ESC);
	});
});
