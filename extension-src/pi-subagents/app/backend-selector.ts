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
