import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { AgentFocusSnapshot, AgentTranscriptView } from "../../domain/ui-view.js";
import { identityColor } from "../../shared/identity-color.js";
import { agentStatusSnapshot } from "./status.js";

type EditorSnapshot = Partial<ReturnType<typeof agentStatusSnapshot>>;

interface DetachedEditorProvider {
	update?(editor: CustomEditor, snapshot: EditorSnapshot): void;
	create(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		identity: { sessionName?: string; editorBorderColor?: string },
	): CustomEditor | undefined;
}

const updates = new WeakMap<object, (snapshot: EditorSnapshot) => void>();

/** Update only editors created by a provider with the optional metadata port. */
export function updateAgentSteerEditor(
	editor: object,
	view: AgentTranscriptView | undefined,
	focus: AgentFocusSnapshot | undefined,
): void {
	updates.get(editor)?.(view ? agentStatusSnapshot(view, focus) : {});
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
		if (editor) {
			if (typeof provider.update === "function") updates.set(editor, (snapshot) => provider.update?.(editor, snapshot));
			return editor;
		}
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
