// Render-test theme bootstrap.
//
// Native Pi components (UserMessageComponent / Markdown /
// ToolExecutionComponent) read the process-global theme during render, so
// headless render tests must install one before rendering (pi-style
// resolveTheme approach). We register a deterministic truecolor Theme whose
// color values are plain ANSI escapes, keeping width assertions honest.

import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";

let installed = false;

const FG_VALUES: Record<string, string> = {
	accent: "#00d7d7",
	border: "#5f5faf",
	borderAccent: "#5f87ff",
	borderMuted: "#666666",
	success: "#00af5f",
	error: "#ff5f5f",
	warning: "#ffaf00",
	muted: "#9e9e9e",
	dim: "#7f7f7f",
	text: "#ffffff",
	thinkingText: "#875faf",
	userMessageText: "#ffffff",
	customMessageText: "#5fd7d7",
	customMessageLabel: "#5f87d7",
	toolTitle: "#ffd787",
	toolOutput: "#c6c6c6",
	mdHeading: "#ffffff",
	mdLink: "#00d7d7",
	mdLinkUrl: "#5f87d7",
	mdCode: "#ffaf5f",
	mdCodeBlock: "#c6c6c6",
	mdCodeBlockBorder: "#666666",
	mdQuote: "#c6c6c6",
	mdQuoteBorder: "#666666",
	mdHr: "#666666",
	mdListBullet: "#00d7d7",
	toolDiffAdded: "#00d787",
	toolDiffRemoved: "#ff5f5f",
	toolDiffContext: "#808080",
	syntaxComment: "#7f7f7f",
	syntaxKeyword: "#d787ff",
	syntaxFunction: "#87afff",
	syntaxVariable: "#ffffff",
	syntaxString: "#87d787",
	syntaxNumber: "#ffaf5f",
	syntaxType: "#5fd7d7",
	syntaxOperator: "#ffffff",
	syntaxPunctuation: "#c6c6c6",
	thinkingOff: "#7f7f7f",
	thinkingMinimal: "#7f7f7f",
	thinkingLow: "#875faf",
	thinkingMedium: "#af5fff",
	thinkingHigh: "#d75fff",
	thinkingXhigh: "#ff5fff",
	bashMode: "#ffd787",
};

/** Install (once) and return the global Theme instance. */
export function renderTheme(): Theme {
	installRenderTheme();
	const key = Symbol.for("@earendil-works/pi-coding-agent:theme");
	return (globalThis as { [key: symbol]: Theme })[key] as Theme;
}

function installRenderTheme(): void {
	if (installed) return;
	const key = Symbol.for("@earendil-works/pi-coding-agent:theme");
	const globalWithTheme = globalThis as { [key: symbol]: unknown };
	if (globalWithTheme[key] !== undefined) {
		installed = true;
		return;
	}
	const foregrounds = Object.fromEntries(Object.entries(FG_VALUES)) as unknown as Record<
		Exclude<ThemeColor, "thinkingMax" | "searchMatchText">,
		string
	>;
	foregrounds.thinkingMax = "#ff5fff";
	foregrounds.searchMatchText = "#ffffff";
	const theme = new Theme(
		foregrounds,
		{
			selectedBg: "",
			userMessageBg: "",
			customMessageBg: "",
			toolPendingBg: "",
			toolSuccessBg: "",
			toolErrorBg: "",
		},
		"truecolor",
		{ name: "pi-teams-render-test" },
	);
	globalWithTheme[key] = theme;
	globalWithTheme[Symbol.for("@mariozechner/pi-coding-agent:theme")] = theme;
	installed = true;
}
