// /agents command — alternative access path to the native Agents Hub.
// /sub-agents-backend — show or switch the multiplexer mode (auto | headless).
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../app/agent-manager.js";
import type { BackendSelector } from "../domain/config.js";

/** Register the /agents command; resolves the live UI handle per session. */
export function registerAgentsCommand(
	pi: ExtensionAPI,
	deps: {
		manager: AgentManager;
		openHub: () => void;
	},
): void {
	pi.registerCommand("agents", {
		description: "Open the Agents Hub; release <id> [--worktree] cleans settled resources",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const words = args.trim().split(/\s+/);
			if (words[0] === "release") {
				if (!words[1] || words.length > 3 || (words[2] !== undefined && words[2] !== "--worktree")) {
					ctx.ui.notify(
						"Usage: /agents release <id> [--worktree]. Use --worktree only after reviewing and integrating the preserved commits.",
						"error",
					);
					return;
				}
				const cleanupWorktree = words[2] === "--worktree";
				const released = await deps.manager.release(words[1], { cleanupWorktree });
				ctx.ui.notify(
					released
						? cleanupWorktree
							? "Released child and worktree checkout. Preserved commit branch retained."
							: "Released child. Worktree checkout retained for review."
						: `Unknown subagent: ${words[1]}`,
					released ? "info" : "error",
				);
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("Usage: /agents [release <id> [--worktree]]", "error");
				return;
			}
			deps.openHub();
		},
	});
}

/** Runtime surface the backend-mode command needs; structural so tests can stub it. */
export interface BackendModePort {
	getLauncherHint(): BackendSelector;
	setLauncherHint(hint: BackendSelector): void;
	detectLauncherKind(): Promise<string>;
}

/**
 * Register `/sub-agents-backend`: without arguments it reports the current
 * multiplexer mode (and what auto detects); with `auto` or `headless` it
 * switches future launches for this session. Explicit herdr/tmux forcing
 * remains env-only — auto already detects both multiplexers.
 */
export function registerBackendCommand(pi: ExtensionAPI, deps: { backend: BackendModePort }): void {
	pi.registerCommand("sub-agents-backend", {
		description: "Show or switch subagent launcher mode: auto (detect herdr/tmux) or headless",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const mode = args.trim().toLowerCase();
			if (mode === "") {
				const hint = deps.backend.getLauncherHint();
				const detected = hint === "auto" ? await deps.backend.detectLauncherKind().catch(() => "unavailable") : "";
				const env = process.env.PI_SUBAGENTS_BACKEND?.trim();
				const detail = hint === "auto" ? ` (detects: ${detected})` : "";
				const envNote = env ? ` — env PI_SUBAGENTS_BACKEND=${env} overrides settings` : "";
				ctx.ui.notify(
					`Subagent launcher: ${hint}${detail}${envNote}. Persist via the "backend" key in subagents.json.`,
					"info",
				);
				return;
			}
			if (mode !== "auto" && mode !== "headless") {
				ctx.ui.notify(
					"Usage: /sub-agents-backend [auto|headless]. herdr/tmux are picked automatically by auto.",
					"error",
				);
				return;
			}
			deps.backend.setLauncherHint(mode);
			ctx.ui.notify(
				mode === "headless"
					? "Subagent launcher set to headless for new runs (no multiplexer panes). Running children keep their launcher; resets at next session start."
					: "Subagent launcher set to auto (herdr → tmux → headless) for new runs. Running children keep their launcher; resets at next session start.",
				"info",
			);
		},
	});
}
