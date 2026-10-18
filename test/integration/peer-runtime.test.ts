import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { LocalPeerHost } from "../../extension-src/pi-teams/pi/peer-host.js";
import {
	createSafePeerSdkAdapter,
	resolveSessionProjectId,
	startPeerRuntime,
} from "../../extension-src/pi-teams/pi/peer-runtime.js";
import * as peerTransport from "../../extension-src/pi-teams/pi/peer-transport.js";

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

	it.skipIf(process.platform === "win32")(
		"publishes for the active runtime and unregisters on disposal (Unix host)",
		async () => {
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
		},
	);

	it("withdraws its advertisement and closes ingress after a listener failure", async () => {
		const previous = process.env.PI_TEAMS_CHILD;
		delete process.env.PI_TEAMS_CHILD;
		const root = join("/tmp", `pt-failure-${randomUUID()}`);
		await mkdir(root, { mode: 0o700 });
		let fail!: (error: Error) => void;
		const failure = new Promise<Error>((resolve) => {
			fail = resolve;
		});
		const close = vi.fn(async () => {});
		const ingressSpy = vi.spyOn(peerTransport, "startPeerIngress").mockResolvedValue({ failure, close });
		const ctx = {
			sessionManager: { getSessionId: () => "failure-session", getCwd: () => process.cwd() },
			ui: { notify: vi.fn() },
		} as never;
		const pi = { on: () => () => {}, sendUserMessage: vi.fn() } as unknown as ExtensionAPI;
		const runtime = await startPeerRuntime({ pi, ctx, root, enabled: true, policy: "hold" });
		try {
			if (!runtime) throw new Error("runtime should start with mocked ingress");
			expect(await new LocalPeerHost(join(root, "peer")).list(runtime.projectId)).toHaveLength(1);
			fail(new Error("pipe helper exited"));
			await vi.waitFor(async () =>
				expect(await new LocalPeerHost(join(root, "peer")).list(runtime.projectId)).toHaveLength(0),
			);
			expect(close).toHaveBeenCalledOnce();
		} finally {
			ingressSpy.mockRestore();
			await runtime?.dispose();
			await rm(root, { recursive: true, force: true });
			if (previous !== undefined) process.env.PI_TEAMS_CHILD = previous;
		}
	});

	it.skipIf(process.platform !== "win32")(
		"starts and cleanly disposes a healthy Windows peer runtime",
		async () => {
			const previous = process.env.PI_TEAMS_CHILD;
			delete process.env.PI_TEAMS_CHILD;
			const root = join(process.env.TEMP ?? "C:\\temp", `pt-win-healthy-${randomUUID()}`);
			const ctx = {
				sessionManager: { getSessionId: () => "windows-healthy-session", getCwd: () => process.cwd() },
				ui: { notify: vi.fn() },
			} as never;
			const pi = { on: () => () => {}, sendUserMessage: vi.fn() } as unknown as ExtensionAPI;
			const errors: unknown[] = [];
			const runtime = await startPeerRuntime({
				pi,
				ctx,
				root,
				enabled: true,
				policy: "hold",
				onError: (error) => errors.push(error),
			});
			try {
				if (!runtime) throw new Error(`Windows peer runtime failed to start: ${String(errors[0])}`);
				const ads = await new LocalPeerHost(join(root, "peer")).list(runtime.projectId);
				expect(ads).toHaveLength(1);
				expect(ads[0]?.endpoint.kind).toBe("named_pipe");
				await runtime.dispose();
				expect(await new LocalPeerHost(join(root, "peer")).list(runtime.projectId)).toHaveLength(0);
				expect(errors).toEqual([]);
			} finally {
				await runtime?.dispose();
				await rm(root, { recursive: true, force: true });
				if (previous !== undefined) process.env.PI_TEAMS_CHILD = previous;
			}
		},
		30_000,
	);

	it.skipIf(process.platform !== "win32")(
		"withdraws a Windows runtime advertisement after helper failure",
		async () => {
			const previous = process.env.PI_TEAMS_CHILD;
			delete process.env.PI_TEAMS_CHILD;
			const root = join(process.env.TEMP ?? "C:\\temp", `pt-win-${randomUUID()}`);
			const handlers: Record<string, () => void> = {};
			const ctx = {
				sessionManager: { getSessionId: () => "windows-session", getCwd: () => process.cwd() },
				ui: { notify: vi.fn() },
			} as never;
			const pi = {
				on: (event: string, handler: () => void) => {
					handlers[event] = handler;
					return () => {};
				},
				sendUserMessage: vi.fn(),
			} as unknown as ExtensionAPI;
			const errors: unknown[] = [];
			const runtime = await startPeerRuntime({
				pi,
				ctx,
				root,
				enabled: true,
				policy: "hold",
				onError: (error) => errors.push(error),
			});
			try {
				if (!runtime) throw new Error(`Windows peer runtime failed to start: ${String(errors[0])}`);
				const ads = await new LocalPeerHost(join(root, "peer")).list(runtime.projectId);
				expect(ads).toHaveLength(1);
				const ad = ads[0];
				if (!ad) throw new Error("Windows runtime did not publish its advertisement");
				expect(ad.endpoint.kind).toBe("named_pipe");
				expect(handlers.turn_start).toBeDefined();
				const idleClient = connect(ad.endpoint.path);
				await new Promise<void>((resolve, reject) => {
					idleClient.once("connect", resolve);
					idleClient.once("error", reject);
				});
				await new Promise<void>((resolve, reject) =>
					idleClient.write(Buffer.alloc(24 * 1024 + 1, 65), (error) => (error ? reject(error) : resolve())),
				);
				idleClient.destroy();
				await vi.waitFor(
					async () => expect(await new LocalPeerHost(join(root, "peer")).list(runtime.projectId)).toHaveLength(0),
					{ timeout: 20_000 },
				);
				expect(errors.some((error) => String(error).includes("helper exited"))).toBe(true);
				await runtime.dispose();
				expect(await new LocalPeerHost(join(root, "peer")).list(runtime.projectId)).toHaveLength(0);
			} finally {
				await runtime?.dispose();
				await rm(root, { recursive: true, force: true });
				if (previous !== undefined) process.env.PI_TEAMS_CHILD = previous;
			}
		},
		30_000,
	);

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
