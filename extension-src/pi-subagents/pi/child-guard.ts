// Every independent child process carries PI_SUBAGENTS_CHILD=1. The parent
// extension must not install recursive orchestration, UI or lifecycle hooks
// if loaded there. Interactive children load only the bridge extension;
// headless children load no extensions and expose only specialist tools.

/** Environment variable marking a child specialist session. */
export const CHILD_SESSION_ENV_VAR = "PI_SUBAGENTS_CHILD";

const TRUTHY_MARKER_VALUES: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);

type EnvLike = Record<string, string | undefined>;

/**
 * True when the current process/session is a child specialist session.
 * Accepts an env record for deterministic testing; defaults to process.env.
 */
export function isChildSessionContext(env: EnvLike = process.env): boolean {
	const raw = env[CHILD_SESSION_ENV_VAR];
	if (raw === undefined || raw.length === 0) return false;
	return TRUTHY_MARKER_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Guard consulted by the extension factory: true means "this module is being
 * loaded inside a child specialist session" and the factory must return
 * without registering tools, UI, RPC or lifecycle handlers.
 *
 * Mirrors the reference implementation's `if (inChildSessionContext()) return;`
 * using the environment marker above.
 */
export function shouldSkipExtensionInChildSession(env: EnvLike = process.env): boolean {
	return isChildSessionContext(env);
}
