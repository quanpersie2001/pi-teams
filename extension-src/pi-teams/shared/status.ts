// Shared status-badge rendering (icon + color token) for every UI surface:
// the agent panel and the transcript view header. Features must not import
// sibling features, so this lives in shared/.
//
// shared/ is the lowest layer (ARCH-001) and cannot import domain/, so the
// status is accepted as a string over the AgentRunStatus union below.

import type { UiColorToken } from "./theme.js";

export interface StatusBadge {
	icon: string;
	color: UiColorToken;
}

/** AgentRunStatus names the badge renderer understands (mirrors domain). */
export type StatusToken = "queued" | "starting" | "running" | "completed" | "error" | "stopped" | "aborted";

/** Icon/color per run status, shared by all UI surfaces. */
export function statusBadge(status: StatusToken | string): StatusBadge {
	switch (status) {
		case "queued":
			return { icon: "◌", color: "muted" };
		case "starting":
			return { icon: "◐", color: "accent" };
		case "running":
			return { icon: "●", color: "accent" };
		case "completed":
			return { icon: "✓", color: "success" };
		case "error":
			return { icon: "✗", color: "error" };
		default:
			// stopped / aborted / unknown
			return { icon: "■", color: "dim" };
	}
}
