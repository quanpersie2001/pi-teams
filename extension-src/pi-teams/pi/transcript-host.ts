// Live progress comes from the authenticated child RPC projection.
// Session JSONL is read only for settled history with no live transcript.
import { basename, dirname } from "node:path";
import type { AgentRun } from "../domain/agent-run.js";
import { isTerminalStatus } from "../domain/agent-run.js";
import type { AgentExecutionBackend } from "../domain/backend.js";
import type { TranscriptItem } from "../domain/transcript.js";
import { readTranscriptItems, transcriptDirSignature } from "./session-jsonl.js";

export interface TranscriptSource {
	getTranscript(run: AgentRun): Promise<readonly TranscriptItem[]>;
}

export interface CreatePiTranscriptSourceOptions {
	backends: readonly AgentExecutionBackend[];
}

interface JsonlCacheEntry {
	signature: string;
	items: readonly TranscriptItem[];
}

export function createPiTranscriptSource(options: CreatePiTranscriptSourceOptions): TranscriptSource {
	const historyCache = new Map<string, JsonlCacheEntry>();
	return {
		async getTranscript(run) {
			let items: readonly TranscriptItem[] = [];
			const handle = run.handle;
			const backend = handle && options.backends.find((candidate) => candidate.kind === handle.kind);
			if (handle && backend) {
				try {
					items = (await backend.readTranscript(handle)).items;
				} catch {
					/* Missing child projections can recover settled history below. */
				}
			}
			if (items.length === 0 && isTerminalStatus(run.status) && run.sessionFile) {
				const dir = dirname(run.sessionFile);
				const name = basename(run.sessionFile).replace(/\.jsonl$/, "");
				const key = `${dir}\u0000${name}`;
				try {
					const signature = transcriptDirSignature(dir);
					const cached = historyCache.get(key);
					items = cached?.signature === signature ? cached.items : readTranscriptItems(dir, name);
					historyCache.set(key, { signature, items });
				} catch {
					/* Unreadable history does not break the live UI. */
				}
			}
			return items.length > TAIL_WINDOW_ITEMS ? items.slice(-TAIL_WINDOW_ITEMS) : [...items];
		},
	};
}

export const TAIL_WINDOW_ITEMS = 400;
