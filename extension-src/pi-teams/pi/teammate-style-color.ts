import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

// Pi-style's /pi-style color command and --color flag both feed this editor
// border setting. A child runs the SDK, not the Pi CLI, so it has no CLI flags.
const EDITOR_COLOR_ENTRY = "pi-style.editor-color";
const OWNER = "pi-teams";

type ColorSession = Pick<SessionManager, "getBranch" | "appendCustomEntry">;

/** Older pi-style builds pass #hex to Pi 1.1's token-only theme.style(),
 * crashing the native child on render. Never apply color to those builds. */
export function supportsTeammateStyleColor(stylePaths: readonly string[]): boolean {
	return (
		stylePaths.length > 0 &&
		stylePaths.every((path) => {
			try {
				const editor = readFileSync(resolve(dirname(path), "../features/editor/index.ts"), "utf8");
				return editor.includes("rgbBorder(color") && !editor.includes("style(line, { fg: color })");
			} catch {
				// Unknown/bundled version: prefer a working child to an unverified border color.
				return false;
			}
		})
	);
}

function normalizedColor(color: string): string | undefined {
	if (/^#[\da-f]{6}$/i.test(color)) return color.toLowerCase();
	if (/^#[\da-f]{3}$/i.test(color))
		return `#${[...color.slice(1)].map((digit) => digit.repeat(2)).join("")}`.toLowerCase();
	return undefined;
}

/** Apply the teammate's color before pi-style handles session_start. */
export function syncTeammateStyleColor(
	session: ColorSession,
	options: { color?: string; styleEnabled: boolean; resumingWithoutTeammate: boolean },
): void {
	const last = session
		.getBranch()
		.findLast((entry) => entry.type === "custom" && entry.customType === EDITOR_COLOR_ENTRY);
	const previous =
		last?.type === "custom" ? (last.data as { color?: unknown; owner?: unknown } | undefined) : undefined;
	if (options.resumingWithoutTeammate) {
		// Do not carry team-owned presentation into an anonymous cold continuation.
		// Leave a user's own /pi-style color choice untouched.
		if (previous?.owner === OWNER && previous.color !== null)
			session.appendCustomEntry(EDITOR_COLOR_ENTRY, { color: null, owner: OWNER });
		return;
	}
	if (!options.styleEnabled || !options.color) return;
	const color = normalizedColor(options.color);
	if (color && previous?.color !== color) session.appendCustomEntry(EDITOR_COLOR_ENTRY, { color, owner: OWNER });
}
