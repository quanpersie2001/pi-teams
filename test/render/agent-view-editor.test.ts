import { describe, expect, it } from "vitest";
import { createAgentSteerEditor } from "../../extension-src/pi-teams/features/agent-view/editor.js";
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
