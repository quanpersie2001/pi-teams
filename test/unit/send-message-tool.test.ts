// Execute-path coverage for the two send_message tool surfaces: the lead's
// roster-validated tool (pi/tools.ts) and the teammate's roster-file tool
// (pi/child-mailbox.ts). The tool is captured through a fake ExtensionAPI,
// mirroring how pi/index.ts and pi/child-bridge.ts register it.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MailboxService } from "../../extension-src/pi-teams/app/mailbox-service.js";
import { createChildMailboxTool } from "../../extension-src/pi-teams/pi/child-mailbox.js";
import { registerLeadSendMessageTool } from "../../extension-src/pi-teams/pi/tools.js";

const TEAM_KEY = "a".repeat(64);

let root = "";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "send-message-tool-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

interface SendTool {
	name: string;
	execute: (
		id: string,
		args: { target: string; message: string },
	) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;
}

/** Capture the tool handed to pi.registerTool, exactly as the hosts register it. */
function capturedTool(register: (pi: ExtensionAPI) => void): SendTool {
	let captured: unknown;
	const pi = {
		registerTool: (tool: unknown) => {
			captured = tool;
		},
		getAllTools: () => [],
	};
	register(pi as unknown as ExtensionAPI);
	if (captured === undefined) throw new Error("send_message tool was not registered");
	return captured as SendTool;
}

async function send(tool: SendTool, target: string, message: string): Promise<string> {
	const result = await tool.execute("call", { target, message });
	const first = result.content[0];
	if (first?.type !== "text") throw new Error("send_message returned no text");
	return first.text ?? "";
}

function leadTool(getMailbox: () => MailboxService | undefined, names: readonly string[]): SendTool {
	return capturedTool((pi) => {
		registerLeadSendMessageTool(pi, getMailbox, () => names);
	});
}

function teammateTool(self: string, members: readonly string[]): SendTool {
	const service = new MailboxService({ teamDir: root, teamKey: TEAM_KEY, self });
	writeFileSync(join(root, "config.json"), JSON.stringify({ members: members.map((name) => ({ name })) }), "utf8");
	return capturedTool((pi) => {
		pi.registerTool(createChildMailboxTool(service));
	});
}

describe("lead send_message", () => {
	it("reports no active mailbox before a team exists", async () => {
		const tool = leadTool(() => undefined, ["worker"]);
		expect(tool.name).toBe("send_message");
		expect(await send(tool, "worker", "hello")).toBe("No active team mailbox.");
	});

	it("refuses a target absent from the live roster", async () => {
		const lead = new MailboxService({ teamDir: root, teamKey: TEAM_KEY, self: "lead" });
		const tool = leadTool(() => lead, ["worker"]);
		expect(await send(tool, "stranger", "hello")).toBe("Unknown teammate: stranger");
	});

	it("refuses the lead address even when the roster carries it", async () => {
		const lead = new MailboxService({ teamDir: root, teamKey: TEAM_KEY, self: "lead" });
		const tool = leadTool(() => lead, ["worker", "lead"]);
		expect(await send(tool, "lead", "hello")).toBe("Unknown teammate: lead");
	});

	it("queues to a live teammate and lands the signed message in its inbox", async () => {
		const lead = new MailboxService({ teamDir: root, teamKey: TEAM_KEY, self: "lead" });
		const worker = new MailboxService({ teamDir: root, teamKey: TEAM_KEY, self: "worker" });
		const tool = leadTool(() => lead, ["worker"]);
		expect(await send(tool, "worker", "standup at 9")).toBe("Message queued for @worker.");
		expect(worker.receive().map((message) => ({ from: message.from, to: message.to, text: message.text }))).toEqual([
			{ from: "lead", to: "worker", text: "standup at 9" },
		]);
	});

	it("reports the underlying send failure verbatim", async () => {
		const failing = {
			send: () => ({ delivered: false, error: "mailbox is read-only" }),
		} as unknown as MailboxService;
		const tool = leadTool(() => failing, ["worker"]);
		expect(await send(tool, "worker", "hello")).toBe("Message not sent: mailbox is read-only");
	});
});

describe("teammate send_message", () => {
	it("queues to another teammate", async () => {
		const tool = teammateTool("worker", ["worker", "reviewer"]);
		expect(await send(tool, "reviewer", "please review")).toBe("Message queued for @reviewer.");
	});

	it("queues to the lead", async () => {
		const tool = teammateTool("worker", ["worker", "reviewer"]);
		expect(await send(tool, "lead", "done")).toBe("Message queued for @lead.");
	});

	it("refuses an address absent from the roster file", async () => {
		const tool = teammateTool("worker", ["worker", "reviewer"]);
		expect(await send(tool, "ghost", "hello")).toBe("Unknown teammate: ghost");
	});
});
