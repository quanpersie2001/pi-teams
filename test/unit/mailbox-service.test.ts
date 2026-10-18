// Mailbox filesystem behavior and HMAC authenticity (ADR 0007 §3).

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

	it("fences send against shutdown and binds queued delivery to the recipient incarnation", () => {
		const { sender, teamDir } = services();
		writeFileSync(join(teamDir, "config.json"), JSON.stringify({ members: [{ name: "worker", membershipId: "M1" }] }));
		const firstSend = sender.send("worker", "for M1", "M1");
		expect(firstSend.delivered).toBe(true);
		writeFileSync(
			join(teamDir, "config.json"),
			JSON.stringify({ members: [{ name: "worker", membershipId: "M1", operation: { kind: "shutdown" } }] }),
		);
		expect(sender.send("worker", "too late", "M1")).toMatchObject({ delivered: false });
		const next = new MailboxService({ teamDir, teamKey: "per-team-secret", self: "worker", selfMembershipId: "M2" });
		expect(next.receive()).toEqual([]);
	});

	it("quarantines legacy mailbox messages without an incarnation instead of delivering to a replacement", () => {
		const { teamDir } = services();
		const mailbox = join(teamDir, "inboxes", "worker");
		writeFileSync(join(teamDir, "config.json"), JSON.stringify({ members: [{ name: "worker", membershipId: "M2" }] }));
		const legacy = {
			id: "legacy-no-incarnation",
			from: "lead",
			to: "worker",
			text: "must not replay",
			sentAt: 1,
			hmac: "",
		};
		legacy.hmac = signMessage("per-team-secret", legacy);
		mkdirSync(mailbox, { recursive: true });
		writeFileSync(join(mailbox, "000-legacy.json"), JSON.stringify(legacy));
		const replacement = new MailboxService({
			teamDir,
			teamKey: "per-team-secret",
			self: "worker",
			selfMembershipId: "M2",
		});
		expect(replacement.receive()).toEqual([]);
		expect(readdirSync(join(mailbox, "quarantine"))).toContain("000-legacy.json");
	});

	it("rejects a late old-incarnation write after a same-name membership is created", () => {
		const { sender, teamDir } = services();
		const mailbox = join(teamDir, "inboxes", "worker");
		writeFileSync(join(teamDir, "config.json"), JSON.stringify({ members: [{ name: "worker", membershipId: "M2" }] }));
		const payload = {
			id: "late-M1",
			from: "lead",
			to: "worker",
			toMembershipId: "M1",
			text: "old",
			sentAt: 1,
			hmac: "",
		};
		payload.hmac = signMessage("per-team-secret", payload);
		mkdirSync(mailbox, { recursive: true });
		writeFileSync(join(mailbox, "000-late.json"), JSON.stringify(payload));
		const next = new MailboxService({ teamDir, teamKey: "per-team-secret", self: "worker", selfMembershipId: "M2" });
		expect(next.receive()).toEqual([]);
		expect(readdirSync(join(mailbox, "quarantine"))).toContain("000-late.json");
		const staleSender = new MailboxService({
			teamDir,
			teamKey: "per-team-secret",
			self: "worker",
			selfMembershipId: "M1",
		});
		expect(staleSender.send("lead", "late outbound")).toMatchObject({ delivered: false });
		expect(sender.send("worker", "current", "M2").delivered).toBe(true);
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
		const first = recipient.receive().find((message) => message.text === "first");
		if (!first) throw new Error("No signed message was available to consume");
		recipient.consume(first);
		expect(recipient.receive()).toMatchObject([{ text: "second" }]);
	});

	it("discards pending messages for only the named participant", async () => {
		const { sender, recipient, teamDir } = services();
		const other = new MailboxService({ teamDir, teamKey: "per-team-secret", self: "reviewer" });
		sender.send("worker", "pending one");
		sender.send("worker", "pending two");
		sender.send("reviewer", "keep me");
		await sender.discardPending("worker", "release");
		expect(recipient.receive()).toEqual([]);
		const archived = readdirSync(join(recipient.inboxDir, "archive"));
		expect(archived).toHaveLength(2);
		expect(archived.every((name) => name.includes("-release-"))).toBe(true);
		expect(statSync(join(recipient.inboxDir, "archive")).mode & 0o777).toBe(0o700);
		expect(other.receive().map((message) => message.text)).toEqual(["keep me"]);
		await sender.discardPending("worker", "release");
		expect(readdirSync(join(recipient.inboxDir, "archive"))).toHaveLength(2);
	});

	it("rejects invalid participant names when discarding", async () => {
		const { sender } = services();
		await expect(sender.discardPending("../outside")).rejects.toThrow("invalid mailbox participant address");
	});

	it("rejects invalid recipient addresses", () => {
		const { sender } = services();
		expect(sender.send("../outside", "hello")).toMatchObject({ delivered: false });
		expect(sender.send("", "hello")).toMatchObject({ delivered: false });
	});
});
