// Mailbox filesystem behavior and HMAC authenticity (ADR 0007 §3).

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MailboxService } from "../../extension-src/pi-teams/app/mailbox-service.js";
import { signMessage } from "../../extension-src/pi-teams/shared/hmac.js";

let root: string | undefined;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});
function services() {
	root = mkdtempSync(join(tmpdir(), "mailbox-"));
	const opts = { teamDir: root, teamKey: "per-team-secret", self: "lead", now: () => 42 };
	return {
		teamDir: root,
		sender: new MailboxService(opts),
		recipient: new MailboxService({ ...opts, self: "worker" }),
	};
}

describe("MailboxService", () => {
	it("atomically writes owner-only messages and verifies them on receive", () => {
		const { sender, recipient } = services();
		const sent = sender.send("worker", "hello");
		expect(sent.delivered).toBe(true);
		const files = readdirSync(recipient.inboxDir);
		expect(files).toHaveLength(1);
		const filename = files[0];
		if (!filename) throw new Error("Atomic send did not create a mailbox file");
		expect(statSync(join(recipient.inboxDir, filename)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(join(recipient.inboxDir, filename), "utf8"))).toMatchObject({
			from: "lead",
			to: "worker",
			text: "hello",
		});
		expect(recipient.receive()).toMatchObject([{ from: "lead", to: "worker", text: "hello" }]);
	});

	it("quarantines tampered and malformed entries without blocking valid delivery", () => {
		const warnings: string[] = [];
		const { sender, teamDir } = services();
		const target = new MailboxService({
			teamDir,
			teamKey: "per-team-secret",
			self: "worker",
			warn: (warning) => warnings.push(warning),
		});
		sender.send("worker", "valid");
		const payload = { id: "tampered", from: "lead", to: "worker", text: "altered", sentAt: 1 };
		const tampered = { ...payload, hmac: signMessage("per-team-secret", { ...payload, text: "original" }) };
		writeFileSync(join(target.inboxDir, "000-tampered.json"), JSON.stringify(tampered));
		writeFileSync(join(target.inboxDir, "001-malformed.json"), "{");
		expect(target.receive()).toMatchObject([{ text: "valid" }]);
		expect(readdirSync(join(target.inboxDir, "quarantine")).sort()).toEqual([
			"000-tampered.json",
			"001-malformed.json",
		]);
		expect(warnings).toHaveLength(2);
	});

	it("consumes only the delivered message", () => {
		const { sender, recipient } = services();
		sender.send("worker", "first");
		sender.send("worker", "second");
		const [first] = recipient.receive();
		if (!first) throw new Error("No signed message was available to consume");
		recipient.consume(first);
		expect(recipient.receive()).toMatchObject([{ text: "second" }]);
	});

	it("rejects invalid recipient addresses", () => {
		const { sender } = services();
		expect(sender.send("../outside", "hello")).toMatchObject({ delivered: false });
		expect(sender.send("", "hello")).toMatchObject({ delivered: false });
	});
});
