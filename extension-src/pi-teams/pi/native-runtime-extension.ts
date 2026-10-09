import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { NativeTerminal } from "./native-terminal.js";

export interface NativeRuntimeExtensionOptions {
	childId: string;
	name?: string;
	color?: string;
	terminal: NativeTerminal;
	/** Styled editors render the teammate session name in their frame instead. */
	showIdentityWidget?: () => boolean;
	routeNativeInput?: (text: string, idle: boolean) => boolean;
}

/** Adds identity and child-session policies without replacing any native Pi UI. */
export function createNativeRuntimeExtension(options: NativeRuntimeExtensionOptions): ExtensionFactory {
	const identity = (options.name ?? `child ${options.childId}`).replace(/\p{Cc}/gu, "");
	const label =
		options.color && /^#[0-9a-f]{6}$/i.test(options.color)
			? `\u001b[38;2;${Number.parseInt(options.color.slice(1, 3), 16)};${Number.parseInt(options.color.slice(3, 5), 16)};${Number.parseInt(options.color.slice(5, 7), 16)}m@${identity}\u001b[39m`
			: `@${identity}`;
	return (pi) => {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.setWidget(
				"pi-teams-native-identity",
				(tui) => {
					options.terminal.setRepaint(() => tui.requestRender(true));
					return options.showIdentityWidget?.() === false
						? { render: () => [], invalidate() {} }
						: new Text(label, 0, 0);
				},
				{ placement: "aboveEditor" },
			);
		});
		pi.on("session_before_switch", (_event, ctx) => {
			ctx.ui.notify(
				"This child is bound to its parent-owned execution session; start a new teammate instead.",
				"warning",
			);
			return { cancel: true };
		});
		pi.on("session_before_fork", (_event, ctx) => {
			ctx.ui.notify(
				"This child is bound to its parent-owned execution session; forking is unavailable here.",
				"warning",
			);
			return { cancel: true };
		});
		pi.on("input", (event, ctx) => {
			if (event.source !== "interactive" || !options.routeNativeInput) return { action: "continue" };
			const targeted = /^@([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+([\s\S]+)$/.test(event.text);
			const idle = event.streamingBehavior === undefined;
			if (!idle && !targeted) return { action: "continue" };
			if (idle && event.text.trim().length === 0) return { action: "continue" };
			try {
				if (options.routeNativeInput(event.text, idle)) return { action: "handled" };
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				ctx.ui.setEditorText(event.text);
				return { action: "handled" };
			}
			return { action: "continue" };
		});
	};
}
