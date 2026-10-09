import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

// The child is a plain Node process: Pi's extension-loader aliases do not apply.
// Resolve only host-provided packages from the *parent Pi CLI's* module tree.
const hostEntry = process.env.PI_TEAMS_HOST_MODULE;
if (!hostEntry) throw new Error("Missing PI_TEAMS_HOST_MODULE for Pi child module resolution");
const hostURL = pathToFileURL(hostEntry).href;
const hostPackages = new Set([
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
]);

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (hostPackages.has(specifier) || [...hostPackages].some((name) => specifier.startsWith(`${name}/`))) {
			return nextResolve(specifier, { ...context, parentURL: hostURL });
		}
		return nextResolve(specifier, context);
	},
});
