import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { identityColor } from "../../shared/identity-color.js";

interface DetachedEditorProvider {
	create(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		identity: { sessionName?: string; editorBorderColor?: string },
	): CustomEditor | undefined;
}

const DETACHED_EDITOR_KEY = Symbol.for("@quandev104/pi-style:detached-editor");

/** Create the view-owned Pi editor without mutating or replacing the parent editor. */
export function createAgentSteerEditor(
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	identity: { teammateName?: string; teammateColor?: string } = {},
): CustomEditor {
	const provider = (globalThis as Record<symbol, DetachedEditorProvider | undefined>)[DETACHED_EDITOR_KEY];
	if (typeof provider?.create === "function") {
		const editor = provider.create(tui, theme, keybindings, {
			...(identity.teammateName ? { sessionName: `@${identity.teammateName}` } : {}),
			...(identity.teammateColor ? { editorBorderColor: identity.teammateColor } : {}),
		});
		if (editor) return editor;
	}
	const fg = (token: string, text: string) => theme.fg(token as never, text);
	return new CustomEditor(
		tui,
		{
			borderColor: (text: string) => identityColor(theme, identity.teammateColor, text),
			selectList: {
				selectedPrefix: (text: string) => fg("accent", text),
				selectedText: (text: string) => fg("accent", text),
				description: (text: string) => fg("muted", text),
				scrollInfo: (text: string) => fg("muted", text),
				noMatch: (text: string) => fg("muted", text),
			},
		},
		keybindings,
		{ paddingX: 0 },
	);
}
