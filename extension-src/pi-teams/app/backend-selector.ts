import type { AgentExecutionBackend } from "../domain/backend.js";

export interface ResolveBackendOptions {
	backends: readonly AgentExecutionBackend[];
}

/** Runtime availability only. Launcher selection belongs to the concrete process backend. */
export async function resolveBackend(options: ResolveBackendOptions): Promise<AgentExecutionBackend | undefined> {
	for (const backend of options.backends) {
		if (await backend.available()) return backend;
	}
	return undefined;
}

/**
 * Best-effort explanation for resolveBackend finding nothing: available() is a
 * boolean probe, so the concrete process backend's launcher detection is asked
 * for the per-launcher reason whenever it exposes one.
 */
export async function backendUnavailableReason(options: ResolveBackendOptions): Promise<string | undefined> {
	for (const backend of options.backends) {
		const detect = (backend as { detectLauncherKind?: () => Promise<string> }).detectLauncherKind;
		if (typeof detect !== "function") continue;
		try {
			await detect.call(backend);
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}
	return undefined;
}
