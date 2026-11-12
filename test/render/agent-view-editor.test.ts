import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { EMPTY_USAGE } from "../../extension-src/pi-teams/domain/agent-run.js";
import type { AgentFocusSnapshot, AgentTranscriptView } from "../../extension-src/pi-teams/domain/ui-view.js";
import {
	createAgentSteerEditor,
	updateAgentSteerEditor,
} from "../../extension-src/pi-teams/features/agent-view/editor.js";
import { createAgentViewOverlay } from "../../extension-src/pi-teams/features/agent-view/overlay.js";
import { renderTheme } from "../helpers/render-theme.js";

const key = Symbol.for("@quandev104/pi-style:detached-editor");
const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} } as never;
const keybindings = { matches: () => false } as never;

/** The composer remains independent of Main, with or without pi-style. */
describe("agent view editor", () => {
	it("colors the native fallback frame with the teammate identity", () => {
		const editor = createAgentSteerEditor(tui, renderTheme(), keybindings, {
			teammateName: "scout",
			teammateColor: "#12ab34",
		});
		expect(editor.render(40)[0]).toContain("\x1b[38;2;18;171;52m");
	});

	it("renders identity color on 256-color terminals", () => {
		const theme = Object.create(renderTheme()) as ReturnType<typeof renderTheme>;
		theme.getColorMode = () => "256color";
		const editor = createAgentSteerEditor(tui, theme, keybindings, { teammateColor: "#12ab34" });
		expect(editor.render(40)[0]).toContain("\x1b[38;5;35m");
	});

	it("feeds the selected child's live metadata through its creating provider only", () => {
		const globals = globalThis as Record<symbol, unknown>;
		const previous = globals[key];
		const fallback = createAgentSteerEditor(tui, renderTheme(), keybindings);
		const snapshots: unknown[] = [];
		globals[key] = {
			create: () => fallback,
			update: (_editor: unknown, snapshot: unknown) => snapshots.push(snapshot),
		};
		const view: AgentTranscriptView = {
			agentId: "child",
			type: "explore",
			teammateName: "scout",
			description: "task",
			status: "running",
			backend: "process",
			resourceState: "open",
			startedAt: 0,
			toolUses: 0,
			turns: 0,
			usage: EMPTY_USAGE,
			items: [],
			truncatedHead: false,
			generatedAt: 1,
			capabilities: { attachable: false, viewable: true, steerable: true, stoppable: true, resumable: false },
		};
		let focus: AgentFocusSnapshot | undefined = {
			runId: "child",
			currentRunId: "child",
			model: "child-model",
			thinking: "high",
			cwd: "/child",
			context: { usedTokens: 12000, windowTokens: 100000 },
			capabilities: [],
			items: [],
			truncatedHead: false,
			closed: false,
		};
		try {
			const editor = createAgentSteerEditor(tui, renderTheme(), keybindings, { teammateName: "scout" });
			editor.setText("child draft");
			// Replacing the global registry must not route an existing editor to a new owner.
			globals[key] = {
				update: () => {
					throw new Error("wrong provider");
				},
			};
			const overlay = createAgentViewOverlay({
				tui,
				theme: renderTheme(),
				keybindings,
				editor,
				pane: { render: () => [], invalidate() {}, dispose() {} } as never,
				host: {
					getData: () => ({ view, ...(focus ? { focus } : {}) }),
					onSubmit: () => true,
					onAbort() {},
					onAttachPane() {},
					onClose() {},
					requestRender() {},
				},
			});
			overlay.render(100);
			expect(snapshots.at(-1)).toMatchObject({ model: "child-model", context: { currentTokens: 12000, percent: 12 } });
			focus = { ...focus, context: { usedTokens: 45000, windowTokens: 100000 } };
			overlay.render(100);
			expect(snapshots.at(-1)).toMatchObject({ context: { percent: 45 } });
			focus = { ...focus, currentRunId: "next-assignment" };
			expect(overlay.render(100).join("\n")).not.toContain("child-model");
			expect(snapshots.at(-1)).toMatchObject({ model: undefined, context: { currentTokens: undefined } });
			focus = { ...focus, currentRunId: "child", closed: true };
			expect(overlay.render(100).join("\n")).not.toContain("child-model");
			expect(snapshots.at(-1)).toMatchObject({ model: undefined, context: { currentTokens: undefined } });
			focus = { ...focus, closed: false, runId: "another-child" };
			overlay.render(100);
			expect(snapshots.at(-1)).toMatchObject({ model: undefined, context: { percent: undefined } });
			focus = undefined;
			overlay.render(100);
			expect(snapshots.at(-1)).toMatchObject({ model: undefined, cwd: undefined });
			expect(editor.getText()).toBe("child draft");
		} finally {
			if (previous === undefined) delete globals[key];
			else globals[key] = previous;
		}
	});

	it("keeps actual native remapped submit drafts before acceptance and while pending", async () => {
		const previous = getKeybindings();
		const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": ["ctrl+s"] });
		setKeybindings(keys);
		const editor = createAgentSteerEditor(tui, renderTheme(), keys as never);
		const response = Promise.withResolvers<boolean>();
		let submissions = 0;
		const view = { capabilities: { steerable: true, resumable: false } } as AgentTranscriptView;
		const overlay = createAgentViewOverlay({
			tui,
			theme: renderTheme(),
			keybindings: keys,
			editor,
			pane: { render: () => [], invalidate() {}, dispose() {} } as never,
			host: {
				getData: () => ({ view }),
				onSubmit: () => {
					submissions++;
					return response.promise;
				},
				onAbort() {},
				onAttachPane() {},
				onClose() {},
				requestRender() {},
			},
		});
		try {
			editor.setText("native retry draft");
			overlay.handleInput("\x13");
			expect(editor.getText()).toBe("native retry draft");
			editor.setText("newer native draft");
			overlay.handleInput("\x13");
			expect(submissions).toBe(1);
			expect(editor.getText()).toBe("newer native draft");
			response.resolve(false);
			await new Promise((resolve) => setImmediate(resolve));
			expect(editor.getText()).toBe("newer native draft");
			editor.setText("continued\\");
			overlay.handleInput("\x13");
			expect(editor.getText()).toBe("continued\n");
			expect(submissions).toBe(1);
		} finally {
			overlay.dispose();
			setKeybindings(previous);
		}
	});

	it("does not assume legacy editors expose a metadata update method", () => {
		const globals = globalThis as Record<symbol, unknown>;
		const previous = globals[key];
		const fallback = createAgentSteerEditor(tui, renderTheme(), keybindings);
		Object.assign(fallback, {
			update() {
				throw new Error("not a provider port");
			},
		});
		try {
			globals[key] = { create: () => fallback };
			const legacy = createAgentSteerEditor(tui, renderTheme(), keybindings);
			legacy.setText("draft");
			expect(() => updateAgentSteerEditor(legacy, undefined, undefined)).not.toThrow();
			expect(legacy.getText()).toBe("draft");
			globals[key] = { create: () => undefined };
			const disabled = createAgentSteerEditor(tui, renderTheme(), keybindings);
			expect(() => updateAgentSteerEditor(disabled, undefined, undefined)).not.toThrow();
		} finally {
			if (previous === undefined) delete globals[key];
			else globals[key] = previous;
		}
	});

	it("passes child identity to an optional detached style provider", () => {
		const globals = globalThis as Record<symbol, unknown>;
		const previous = globals[key];
		const editor = createAgentSteerEditor(tui, renderTheme(), keybindings);
		let identity: unknown;
		globals[key] = {
			create: (_tui: unknown, _theme: unknown, _keybindings: unknown, next: unknown) => {
				identity = next;
				return editor;
			},
		};
		try {
			expect(
				createAgentSteerEditor(tui, renderTheme(), keybindings, {
					teammateName: "scout",
					teammateColor: "#12ab34",
				}),
			).toBe(editor);
			expect(identity).toEqual({ sessionName: "@scout", editorBorderColor: "#12ab34" });
		} finally {
			if (previous === undefined) delete globals[key];
			else globals[key] = previous;
		}
	});
});
