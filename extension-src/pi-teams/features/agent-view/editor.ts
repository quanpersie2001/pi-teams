import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

/** Create the view-owned Pi editor without mutating or replacing the parent editor. */
export function createAgentSteerEditor(
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	paddingX = 0,
): CustomEditor {
	const fg = (token: string, text: string) => theme.fg(token as never, text);
	return new CustomEditor(
		tui,
		{
			borderColor: (text: string) => fg("border", text),
			selectList: {
				selectedPrefix: (text: string) => fg("accent", text),
				selectedText: (text: string) => fg("accent", text),
				description: (text: string) => fg("muted", text),
				scrollInfo: (text: string) => fg("muted", text),
				noMatch: (text: string) => fg("muted", text),
			},
		},
		keybindings,
		{ paddingX },
	);
}
