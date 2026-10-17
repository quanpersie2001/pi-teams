import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withMailboxMutationLock } from "../../extension-src/pi-teams/app/mailbox-lock.js";

let root: string | undefined;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("mailbox mutation lock recovery", () => {
	it("recovers a stale owner after process death", () => {
		root = mkdtempSync(join(tmpdir(), "mailbox-lock-"));
		const lock = join(root, ".mailbox-mutation.lock");
		mkdirSync(lock);
		writeFileSync(
			join(lock, "owner.json"),
			JSON.stringify({ pid: 2_147_483_647, identity: "dead-process", token: "abandoned" }),
		);

		const result = withMailboxMutationLock(root, () => "acquired after recovery");
		expect(result).toEqual({ acquired: true, value: "acquired after recovery" });
		expect(() => readFileSync(join(lock, "owner.json"), "utf8")).toThrow();
	});

	it("does not steal a lock held by the current live process", () => {
		root = mkdtempSync(join(tmpdir(), "mailbox-lock-live-"));
		const outer = withMailboxMutationLock(root, () => withMailboxMutationLock(root, () => "must not enter"));
		expect(outer).toEqual({ acquired: true, value: { acquired: false } });
	});
});
