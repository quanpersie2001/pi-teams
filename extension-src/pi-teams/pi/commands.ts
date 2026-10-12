// /agents command — alternative access path to the native Team Hub.
// /teams-backend — show or switch the multiplexer mode (auto | headless).
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../app/agent-manager.js";
import type { BackendSelector } from "../domain/config.js";

/** Register the /agents command; resolves the live UI handle per session. */
export function registerAgentsCommand(
	pi: ExtensionAPI,
	deps: {
		manager: AgentManager;
		openHub: () => void;
		setInlineAgentsVisible: (visible: boolean | "toggle") => void;
	},
): void {
	pi.registerCommand("agents", {
		description: "Open Team Hub; release runs or inspect/release/retire named teammates",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const words = args.trim().split(/\s+/);
			if (words[0] === "panel") {
				if (words.length > 2 || (words[1] !== undefined && !["show", "hide", "toggle"].includes(words[1]))) {
					ctx.ui.notify("Usage: /agents panel [show|hide|toggle]", "error");
					return;
				}
				const action = words[1] ?? "toggle";
				deps.setInlineAgentsVisible(action === "toggle" ? "toggle" : action === "show");
				ctx.ui.notify(
					`Inline Agents panel ${action === "toggle" ? "toggled" : action === "hide" ? "hidden" : "shown"} for this session.`,
					"info",
				);
				return;
			}
			if (words[0] === "teammate-status" || words[0] === "teammate-release" || words[0] === "teammate-retire") {
				const [action, name, extra] = words;
				if (!name || extra !== undefined) {
					ctx.ui.notify(`Usage: /agents ${action} <teammate-name>`, "error");
					return;
				}
				try {
					if (action === "teammate-status") {
						const status = deps.manager.teammateStatus(name);
						ctx.ui.notify(
							status
								? `@${status.name}: ${status.state}; ${status.availability}; context ${status.contextAvailable ? "available" : "unavailable"}${status.currentRunId ? ` (live run ${status.currentRunId})` : ""}${status.lastRunId ? ` (last run ${status.lastRunId})` : ""}${status.recoveryError ? ` — ${status.recoveryError}` : ""}`
								: `Unknown teammate: ${name}`,
							status ? "info" : "error",
						);
						return;
					}
					const retired = action === "teammate-retire";
					const changed = retired ? await deps.manager.retireTeammate(name) : await deps.manager.releaseTeammate(name);
					const status = changed ? deps.manager.teammateStatus(name) : undefined;
					ctx.ui.notify(
						!changed
							? `Unknown teammate: ${name}`
							: status
								? `Teammate @${name} is now ${status.state}. Task-board claims are unchanged.`
								: `Lifecycle operation completed for @${name}, but current status is unavailable.`,
						changed ? "info" : "error",
					);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
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
				ctx.ui.notify(
					"Usage: /agents [panel [show|hide|toggle] | release <id> [--worktree] | teammate-status <name> | teammate-release <name> | teammate-retire <name>]",
					"error",
				);
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
 * Register `/teams-backend`: without arguments it reports the current
 * multiplexer mode (and what auto detects); with `auto` or `headless` it
 * switches future launches for this session. Explicit herdr/tmux forcing
 * remains env-only — auto already detects both multiplexers.
 */
export function registerBackendCommand(pi: ExtensionAPI, deps: { backend: BackendModePort }): void {
	pi.registerCommand("teams-backend", {
		description: "Show or switch subagent launcher mode: auto (detect herdr/tmux) or headless",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const mode = args.trim().toLowerCase();
			if (mode === "") {
				const hint = deps.backend.getLauncherHint();
				const detected = hint === "auto" ? await deps.backend.detectLauncherKind().catch(() => "unavailable") : "";
				const env = process.env.PI_TEAMS_BACKEND?.trim();
				const detail = hint === "auto" ? ` (detects: ${detected})` : "";
				const envNote = env ? ` — env PI_TEAMS_BACKEND=${env} overrides settings` : "";
				ctx.ui.notify(
					`Team launcher: ${hint}${detail}${envNote}. Persist via the "backend" key in teams.json.`,
					"info",
				);
				return;
			}
			if (mode !== "auto" && mode !== "headless") {
				ctx.ui.notify("Usage: /teams-backend [auto|headless]. herdr/tmux are picked automatically by auto.", "error");
				return;
			}
			deps.backend.setLauncherHint(mode);
			ctx.ui.notify(
				mode === "headless"
					? "Team launcher set to headless for new runs (no multiplexer panes). Running children keep their launcher; resets at next session start."
					: "Team launcher set to auto (herdr → tmux → headless) for new runs. Running children keep their launcher; resets at next session start.",
				"info",
			);
		},
	});
}
