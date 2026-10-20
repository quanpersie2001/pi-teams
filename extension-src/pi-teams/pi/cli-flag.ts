export const DISABLE_PI_TEAMS_FLAG = "disable-pi-teams";

/** Pi resolves extension flag values after factories run, so inspect launch arguments here. */
export function isDisabledByCli(argv: readonly string[] = process.argv.slice(2)): boolean {
	for (const arg of argv) {
		if (arg === "--") break;
		// Pi boolean flags are enabled by presence, including --flag=value.
		if (arg === `--${DISABLE_PI_TEAMS_FLAG}` || arg.startsWith(`--${DISABLE_PI_TEAMS_FLAG}=`)) return true;
	}
	return false;
}
