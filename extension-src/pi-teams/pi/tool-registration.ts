// Shared pi-layer guard for tool registration: skip names another extension or
// Pi itself already claimed instead of double-registering. Kept in one place so
// every registrar's collision behavior cannot drift.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Skip names already registered by Pi or another extension instead of double-registering. */
export function existingToolNames(pi: ExtensionAPI): Set<string> {
	try {
		return new Set(pi.getAllTools().map((tool) => tool.name));
	} catch {
		return new Set();
	}
}

export interface ToolRegistration {
	name: string;
	skipped?: boolean;
}
