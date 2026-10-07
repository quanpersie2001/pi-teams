// Unit: pi/transcript-host.ts — process transcript snapshots normalize onto the
// shared TranscriptItem model; settled-session JSONL remains a fallback only.
// Signature caching skips unchanged files and the adapter applies a bounded tail.

import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRun } from "../../extension-src/pi-subagents/domain/agent-run.js";
import { EMPTY_USAGE } from "../../extension-src/pi-subagents/domain/agent-run.js";
import type { AgentBackendHandle, AgentExecutionBackend } from "../../extension-src/pi-subagents/domain/backend.js";
import type { TranscriptItem } from "../../extension-src/pi-subagents/domain/transcript.js";
import { createPiTranscriptSource, TAIL_WINDOW_ITEMS } from "../../extension-src/pi-subagents/pi/transcript-host.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "subagents-transcript-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function run(overrides: Partial<AgentRun> = {}): AgentRun {
	return {
		id: "run-1",
		type: "explore",
		description: "d",
		status: "running",
		backend: "process",
		startedAt: 1,
		toolUses: 0,
		turns: 0,
		usage: { ...EMPTY_USAGE },
		owner: { kind: "conversation", sessionId: "s" },
		delivery: "conversation",
		isBackground: true,
		...overrides,
	};
}

function jsonlRow(type: string, message?: Record<string, unknown>, timestamp?: string): string {
	return JSON.stringify({
		...(timestamp !== undefined ? { timestamp } : {}),
		type,
		...(message !== undefined ? { message } : {}),
	});
}

describe("JSONL origin", () => {
	it("normalizes a fixture session onto user/assistant/toolCall/toolResult items", async () => {
		const sessionFile = join(dir, "session-abc.jsonl");
		writeFileSync(
			sessionFile,
			[
				jsonlRow("session_info", undefined),
				jsonlRow("message", { role: "user", content: "find auth files" }, "2024-01-01T00:00:00Z"),
				jsonlRow("message", { role: "assistant", content: [{ type: "text", text: "On it." }] }, "2024-01-01T00:00:01Z"),
				jsonlRow(
					"message",
					{
						role: "assistant",
						content: [
							{ type: "text", text: "Reading." },
							{ type: "toolCall", id: "call-1", name: "read", arguments: { file_path: "/src/login.ts" } },
						],
					},
					"2024-01-01T00:00:02Z",
				),
				jsonlRow(
					"message",
					{
						role: "toolResult",
						content: [{ type: "text", text: "file body" }],
						toolCallId: "call-1",
						toolName: "read",
					},
					"2024-01-01T00:00:03Z",
				),
			].join("\n"),
		);
		const source = createPiTranscriptSource({ backends: [] });
		const items = await source.getTranscript(run({ sessionFile, status: "completed" }));

		expect(items.map((entry) => entry.kind)).toEqual(["user", "assistant", "assistant", "toolCall", "toolResult"]);
		expect(items[0]?.text).toBe("find auth files");
		expect(items[2]?.text).toBe("Reading.");
		const call = items[3];
		expect(call?.toolName).toBe("read");
		expect(call?.args).toEqual({ file_path: "/src/login.ts" });
		const result = items[4];
		expect(result?.toolCallId).toBe("call-1");
		expect(result?.isError).toBe(false);
	});

	it("re-parses settled content when the session file grows", async () => {
		const sessionFile = join(dir, "session-sig.jsonl");
		writeFileSync(sessionFile, `${jsonlRow("message", { role: "user", content: "v1" })}\n`);
		// Keep the initial file signature stable for the repeated read.
		const before = statSync(sessionFile);
		utimesSync(sessionFile, before.atime, new Date(1_000));

		const source = createPiTranscriptSource({ backends: [] });
		const first = await source.getTranscript(run({ sessionFile, status: "completed" }));
		const second = await source.getTranscript(run({ sessionFile, status: "completed" }));
		expect(second).toEqual(first);

		// Grow the file → size changes → re-parse picks up the new row.
		writeFileSync(
			sessionFile,
			`${jsonlRow("message", { role: "user", content: "v1" })}\n${jsonlRow("message", { role: "assistant", content: "v2" })}\n`,
		);
		const third = await source.getTranscript(run({ sessionFile, status: "completed" }));
		expect(third).toHaveLength(2);
		expect(third[1]?.kind).toBe("assistant");
	});

	it("yields an empty list for missing/unreadable sources instead of throwing", async () => {
		const source = createPiTranscriptSource({ backends: [] });
		const items = await source.getTranscript(run({ sessionFile: join(dir, "nope.jsonl"), status: "completed" }));
		expect(items).toEqual([]);
	});
});

describe("process RPC transcript projection", () => {
	it("reads normalized items through the process backend that owns the handle", async () => {
		const items: TranscriptItem[] = [
			{ kind: "user", timestamp: 1, text: "hello" },
			{ kind: "assistant", timestamp: 2, text: "hi there" },
		];
		const handle: AgentBackendHandle = { kind: "process", handle: "run-1" };
		const backend: AgentExecutionBackend = {
			kind: "process",
			async available() {
				return true;
			},
			async prepareModel(input) {
				return { model: input.model ?? "fake/deterministic" };
			},
			async launch() {
				return handle;
			},
			async status() {
				return { state: "running" };
			},
			async steer() {
				return true;
			},
			async stop() {
				return true;
			},
			async resume() {
				return handle;
			},
			async readTranscript() {
				return { items, cursor: items.length };
			},
			subscribe() {
				return () => {};
			},
			async dispose() {},
			detach() {},
		};
		const source = createPiTranscriptSource({ backends: [backend] });
		const read = await source.getTranscript(run({ handle }));
		expect(read).toEqual(items);
		expect(read).not.toBe(items);
	});

	it("does not treat session JSONL as live progress for an active disconnected run", async () => {
		const sessionFile = join(dir, "session-live.jsonl");
		writeFileSync(sessionFile, `${jsonlRow("message", { role: "user", content: "stale disk copy" })}\n`);
		const source = createPiTranscriptSource({ backends: [] });

		expect(await source.getTranscript(run({ sessionFile, status: "running" }))).toEqual([]);
	});

	it("restores settled history from session JSONL when live process transcript is unavailable", async () => {
		const sessionFile = join(dir, "session-old.jsonl");
		writeFileSync(sessionFile, `${jsonlRow("message", { role: "user", content: "from disk" })}\n`);
		const source = createPiTranscriptSource({ backends: [] });
		const items = await source.getTranscript(run({ sessionFile, status: "completed" }));

		expect(items.map((entry) => entry.kind)).toEqual(["user"]);
		expect(items[0]?.text).toBe("from disk");
	});
});

it("applies the bounded tail window to long transcripts", async () => {
	const rows: string[] = [];
	for (let i = 0; i < TAIL_WINDOW_ITEMS + 25; i++) {
		rows.push(jsonlRow("message", { role: "user", content: `m${i}` }));
	}
	const sessionFile = join(dir, "session-long.jsonl");
	writeFileSync(sessionFile, `${rows.join("\n")}\n`);
	const source = createPiTranscriptSource({ backends: [] });
	const items = await source.getTranscript(run({ sessionFile, status: "completed" }));
	expect(items).toHaveLength(TAIL_WINDOW_ITEMS);
	expect(items[0]?.text).toBe("m25");
	expect(items[items.length - 1]?.text).toBe(`m${TAIL_WINDOW_ITEMS + 24}`);
});
