import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { MailboxService } from "../../extension-src/pi-teams/app/mailbox-service.js";
import { installLeadMailbox } from "../../extension-src/pi-teams/pi/delivery-host.js";

let root: string | undefined;
let close: (() => void) | undefined;
afterEach(() => {
	close?.();
	close = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

it("retains a queued lead message until its own native acknowledgement and replays an unacknowledged message", () => {
	root = mkdtempSync(join(tmpdir(), "teams-lead-ack-"));
	const key = "a".repeat(64);
	const lead = new MailboxService({ teamDir: root, teamKey: key, self: "lead" });
	const sender = new MailboxService({ teamDir: root, teamKey: key, self: "worker" });
	const sent = sender.send("lead", "findings that must survive native delivery failure");
	if (!sent.delivered) throw new Error(sent.error);
	let acknowledge:
		| ((event: { message: { role: string; customType: string; details: { messageId: string } } }) => void)
		| undefined;
	const deliveries: string[] = [];
	const pi = {
		on: (_event: string, handler: typeof acknowledge) => {
			acknowledge = handler;
			return () => {
				acknowledge = undefined;
			};
		},
		sendMessage: (message: { content: string }) => {
			deliveries.push(message.content);
		},
	} as unknown as ExtensionAPI;
	close = installLeadMailbox(pi, lead);
	expect(lead.receive().map((message) => message.id)).toEqual([sent.id]);
	acknowledge?.({ message: { role: "custom", customType: "teammate-message", details: { messageId: "unrelated" } } });
	expect(lead.receive().map((message) => message.id)).toEqual([sent.id]);
	close();
	close = installLeadMailbox(pi, lead);
	expect(deliveries).toEqual([
		"Message from @worker:\n\nfindings that must survive native delivery failure",
		"Message from @worker:\n\nfindings that must survive native delivery failure",
	]);
	expect(lead.receive().map((message) => message.id)).toEqual([sent.id]);
	acknowledge?.({ message: { role: "custom", customType: "teammate-message", details: { messageId: sent.id } } });
	expect(lead.receive()).toEqual([]);
});
