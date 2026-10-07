import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTranscriptItems } from "../../extension-src/pi-subagents/pi/session-jsonl.js";

const tempDirs: string[] = [];
afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

async function makeSession(content: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "subagents-session-"));
	tempDirs.push(dir);
	await writeFile(join(dir, "session.jsonl"), content, "utf8");
	return dir;
}

const row = (role: string, content: unknown, extra: Record<string, unknown> = {}) =>
	JSON.stringify({ type: "message", timestamp: "2025-02-03T04:05:06.000Z", message: { role, content, ...extra } });

describe("settled process JSONL transcript reader", () => {
	it("normalizes historical user, assistant and tool content", async () => {
		const dir = await makeSession(
			[
				JSON.stringify({ type: "session_info", name: "run-a" }),
				row("user", "inspect this"),
				row(
					"assistant",
					[
						{ type: "text", text: "Checking files" },
						{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "x" } },
					],
					{ stopReason: "toolUse" },
				),
				row("toolResult", "contents", { toolCallId: "call-1", toolName: "read" }),
				row("assistant", [{ type: "text", text: "Finished" }], { stopReason: "endTurn" }),
			].join("\n"),
		);

		expect(readTranscriptItems(dir, "run-a").map((item) => item.kind)).toEqual([
			"user",
			"assistant",
			"toolCall",
			"toolResult",
			"assistant",
		]);
	});

	it("excludes differently named sibling sessions without discarding tool-use history", async () => {
		const dir = await makeSession(
			[
				JSON.stringify({ type: "session_info", name: "sibling" }),
				row("assistant", [{ type: "text", text: "not ours" }], { stopReason: "endTurn" }),
			].join("\n"),
		);
		expect(readTranscriptItems(dir, "run-a")).toEqual([]);

		const toolUseDir = await makeSession(
			row("assistant", [{ type: "text", text: "still working" }], { stopReason: "toolUse" }),
		);
		expect(readTranscriptItems(toolUseDir)).toEqual([
			{
				kind: "assistant",
				timestamp: Date.parse("2025-02-03T04:05:06.000Z"),
				text: "still working",
				metadata: { stopReason: "toolUse" },
			},
		]);
	});
});
