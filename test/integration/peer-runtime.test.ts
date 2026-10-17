import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { LocalPeerHost } from "../../extension-src/pi-teams/pi/peer-host.js";
import {
	createSafePeerSdkAdapter,
	resolveSessionProjectId,
	startPeerRuntime,
} from "../../extension-src/pi-teams/pi/peer-runtime.js";

describe("peer runtime host integration", () => {
	it("suppresses independent peer runtimes in child sessions", async () => {
		const previous = process.env.PI_TEAMS_CHILD;
		process.env.PI_TEAMS_CHILD = "1";
		try {
			await expect(
				startPeerRuntime({ pi: {} as ExtensionAPI, ctx: {} as never, root: "/tmp", enabled: true, policy: "hold" }),
			).resolves.toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.PI_TEAMS_CHILD;
			else process.env.PI_TEAMS_CHILD = previous;
		}
	});

	it("resolves the active Git or non-Git session cwd rather than process cwd", async () => {
		const gitProject = await resolveSessionProjectId(process.cwd());
		const nonGit = join("/tmp", `session-${randomUUID()}`);
		await mkdir(nonGit, { mode: 0o700 });
		try {
			expect(await resolveSessionProjectId(nonGit)).toBe(
				`dir:${await import("node:fs/promises").then(({ realpath }) => realpath(nonGit))}`,
			);
			expect(await resolveSessionProjectId(nonGit)).not.toBe(gitProject);
		} finally {
			await rm(nonGit, { recursive: true, force: true });
		}
	});

	it("publishes for the active runtime and unregisters on disposal", async () => {
		if (process.platform === "win32") {
			let diagnostic: unknown;
			const result = await startPeerRuntime({
				pi: {} as ExtensionAPI,
				ctx: {} as never,
				root: "C:\\\\temp",
				enabled: true,
				policy: "hold",
				onError: (error) => {
					diagnostic = error;
				},
			});
			expect(result).toBeUndefined();
			expect(String(diagnostic)).toContain("disabled on Windows");
			return;
		}
		const previous = process.env.PI_TEAMS_CHILD;
		delete process.env.PI_TEAMS_CHILD;
		const root = join("/tmp", `pt-${randomUUID()}`);
		await mkdir(root, { mode: 0o700 });
		const handlers: Record<string, () => void> = {};
		const ctx = {
			sessionManager: { getSessionId: () => "test-session", getCwd: () => process.cwd() },
			ui: { notify: vi.fn() },
		} as never;
		const pi = {
			on: (event: string, handler: () => void) => {
				handlers[event] = handler;
				return () => {};
			},
			sendUserMessage: vi.fn(),
		} as unknown as ExtensionAPI;
		let startupError: unknown;
		const runtime = await startPeerRuntime({
			pi,
			ctx,
			root,
			enabled: true,
			policy: "hold",
			onError: (error) => {
				startupError = error;
			},
		});
		try {
			if (!runtime)
				throw new Error(
					`Peer runtime did not start: ${startupError instanceof Error ? startupError.message : startupError}`,
				);
			expect(handlers.turn_start).toBeDefined();
			expect(await new LocalPeerHost(join(root, "peer")).list(runtime.projectId)).toHaveLength(1);
			await runtime.dispose();
			expect(await new LocalPeerHost(join(root, "peer")).list(runtime.projectId)).toHaveLength(0);
		} finally {
			await runtime?.dispose();
			await rm(root, { recursive: true, force: true });
			if (previous !== undefined) process.env.PI_TEAMS_CHILD = previous;
		}
	});

	it("acknowledges only an SDK user-message acceptance event", async () => {
		let onMessageStart: ((event: never) => void) | undefined;
		const sendUserMessage = vi.fn();
		const unsubscribe = vi.fn();
		const pi = {
			sendUserMessage,
			on: (_name: string, handler: (event: never) => void) => {
				onMessageStart = handler;
				return unsubscribe;
			},
		};
		const adapter = createSafePeerSdkAdapter(pi as unknown as ExtensionAPI);
		let settled = false;
		const pending = adapter.inject("hello", "idle").then(() => {
			settled = true;
		});
		expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("hello"), {
			deliverAs: "followUp",
			expandPromptTemplates: false,
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		const content = sendUserMessage.mock.calls[0]?.[0];
		onMessageStart?.({ message: { role: "assistant", content: [{ type: "text", text: content }] } } as never);
		expect(settled).toBe(false);
		onMessageStart?.({ message: { role: "user", content: [{ type: "text", text: content }] } } as never);
		await pending;
		expect(settled).toBe(true);
		adapter.dispose();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("rejects synchronous SDK errors without reporting acceptance", async () => {
		const error = new Error("dispatch rejected");
		const pi = {
			on: vi.fn(),
			sendUserMessage: vi.fn(() => {
				throw error;
			}),
		};
		const adapter = createSafePeerSdkAdapter(pi as unknown as ExtensionAPI);
		await expect(adapter.inject("failure", "busy")).rejects.toBe(error);
		expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("failure"), {
			deliverAs: "steer",
			expandPromptTemplates: false,
		});
	});

	it("times out without acknowledgement and can safely retry; disposal rejects pending sends", async () => {
		vi.useFakeTimers();
		let onMessageStart: ((event: never) => void) | undefined;
		const sendUserMessage = vi.fn();
		const pi = {
			sendUserMessage,
			on: (_name: string, handler: (event: never) => void) => {
				onMessageStart = handler;
				return vi.fn();
			},
		};
		const adapter = createSafePeerSdkAdapter(pi as unknown as ExtensionAPI);
		try {
			const failedAttempt = adapter.inject("retry me", "idle").then(
				() => undefined,
				(error: unknown) => error,
			);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(await failedAttempt).toBeInstanceOf(Error);
			expect(await failedAttempt).toMatchObject({ message: expect.stringContaining("ambiguous") });
			const retry = adapter.inject("retry me", "idle");
			const retryContent = sendUserMessage.mock.calls[1]?.[0];
			onMessageStart?.({ message: { role: "user", content: [{ type: "text", text: retryContent }] } } as never);
			await expect(retry).resolves.toBeUndefined();
			const stopped = adapter.inject("stop me", "busy");
			adapter.dispose();
			await expect(stopped).rejects.toThrow("stopped before acceptance");
		} finally {
			vi.useRealTimers();
		}
	});

	it("correlates concurrent acceptance events by unique delivery marker", async () => {
		let onMessageStart: ((event: never) => void) | undefined;
		const sendUserMessage = vi.fn();
		const pi = {
			sendUserMessage,
			on: (_name: string, handler: (event: never) => void) => {
				onMessageStart = handler;
				return vi.fn();
			},
		};
		const adapter = createSafePeerSdkAdapter(pi as unknown as ExtensionAPI);
		const first = adapter.inject("same text", "idle");
		const second = adapter.inject("same text", "busy");
		for (const index of [1, 0]) {
			const text = sendUserMessage.mock.calls[index]?.[0];
			onMessageStart?.({ message: { role: "user", content: [{ type: "text", text }] } } as never);
		}
		await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
		adapter.dispose();
	});
});
