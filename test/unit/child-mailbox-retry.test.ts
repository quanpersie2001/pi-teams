import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailboxService } from "../../extension-src/pi-teams/app/mailbox-service.js";
import { watchChildMailbox } from "../../extension-src/pi-teams/pi/child-mailbox.js";

const watcher = vi.hoisted(() => ({ event: () => {}, close: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	watch: vi.fn((_path, callback) => {
		watcher.event = callback;
		return { close: watcher.close, on: vi.fn() };
	}),
}));

describe("child mailbox retry", () => {
	let teamDir: string;
	let handle: ReturnType<typeof watchChildMailbox> | undefined;
	const roster = (membershipId = "current") =>
		writeFileSync(join(teamDir, "config.json"), JSON.stringify({ members: [{ name: "worker", membershipId }] }));
	const start = (inject: (text: string) => Promise<void>, running = false) => {
		handle = watchChildMailbox({
			teamDir,
			teamKey: "key",
			self: "worker",
			membershipId: "current",
			isRunning: () => running,
			prompt: inject,
			steer: inject,
			warn: vi.fn(),
		});
		return handle;
	};
	const pending = () => readdirSync(join(teamDir, "inboxes", "worker")).filter((name) => name.endsWith(".json"));
	const send = (text: string) => {
		const sender = new MailboxService({ teamDir, teamKey: "key", self: "lead" });
		expect(sender.send("worker", text).delivered).toBe(true);
	};

	beforeEach(() => {
		vi.useFakeTimers();
		watcher.close.mockClear();
		teamDir = mkdtempSync(join(tmpdir(), "child-mailbox-retry-"));
		roster();
		send("first");
	});
	afterEach(() => {
		handle?.close();
		handle = undefined;
		expect(vi.getTimerCount()).toBe(0);
		expect(watcher.close).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
		rmSync(teamDir, { recursive: true, force: true });
	});

	it.each([false, true])(
		"retries a transient native rejection without inbox mutation (running=%s)",
		async (running) => {
			const inject = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(undefined);
			start(inject, running);
			await vi.advanceTimersByTimeAsync(0);
			expect(pending()).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(100);
			expect(inject).toHaveBeenCalledTimes(2);
			expect(pending()).toHaveLength(0);
		},
	);

	it("backs off repeated failures despite watch events and cancels retry on close", async () => {
		const inject = vi.fn().mockRejectedValue(new Error("busy"));
		const mailbox = start(inject);
		await vi.advanceTimersByTimeAsync(0);
		for (let i = 0; i < 10; i++) watcher.event();
		await vi.advanceTimersByTimeAsync(99);
		expect(inject).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(inject).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(199);
		expect(inject).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(inject).toHaveBeenCalledTimes(3);
		let attempts = 3;
		for (const delay of [400, 800, 1600, 2000, 2000]) {
			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(inject).toHaveBeenCalledTimes(attempts);
			await vi.advanceTimersByTimeAsync(1);
			expect(inject).toHaveBeenCalledTimes(++attempts);
		}
		mailbox.close();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(inject).toHaveBeenCalledTimes(attempts);
		expect(pending()).toHaveLength(1);
	});

	it("fences a scheduled retry when membership changes", async () => {
		const inject = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(undefined);
		start(inject);
		await vi.advanceTimersByTimeAsync(0);
		roster("replacement");
		await vi.advanceTimersByTimeAsync(100);
		expect(inject).toHaveBeenCalledTimes(1);
		expect(pending()).toHaveLength(1);
	});

	it("serializes watch events during rejection and delivers queued work exactly once", async () => {
		let reject!: (error: Error) => void;
		const inject = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<void>((_resolve, fail) => {
						reject = fail;
					}),
			)
			.mockResolvedValue(undefined);
		start(inject);
		send("second");
		for (let i = 0; i < 10; i++) watcher.event();
		expect(inject).toHaveBeenCalledTimes(1);
		reject(new Error("busy"));
		await vi.advanceTimersByTimeAsync(100);
		expect(inject).toHaveBeenCalledTimes(3);
		expect(pending()).toHaveLength(0);
		watcher.event();
		await vi.advanceTimersByTimeAsync(5000);
		expect(inject).toHaveBeenCalledTimes(3);
	});

	it("preserves a watch event arriving as an empty drain completes", async () => {
		const inject = vi.fn().mockResolvedValue(undefined);
		const mailbox = start(inject);
		await vi.advanceTimersByTimeAsync(0);
		vi.spyOn(mailbox.service, "receive").mockReturnValueOnce([]);
		watcher.event();
		send("late arrival");
		watcher.event();
		await vi.advanceTimersByTimeAsync(0);
		expect(inject).toHaveBeenCalledTimes(2);
		expect(pending()).toHaveLength(0);
	});

	it.each(["close", "membership"])("stops the rest of a received batch after %s during injection", async (stop) => {
		send("second");
		let resolve!: () => void;
		const inject = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<void>((done) => {
						resolve = done;
					}),
			)
			.mockResolvedValue(undefined);
		const mailbox = start(inject);
		if (stop === "close") mailbox.close();
		else roster("replacement");
		resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(inject).toHaveBeenCalledTimes(1);
		expect(pending()).toHaveLength(1);
	});
});
