import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptItem } from "../../extension-src/pi-teams/domain/transcript.js";
import {
	type ChildBridgeHandle,
	type ChildBridgeHost,
	type ChildBridgeNativeEvent,
	installChildBridgeExtension,
	parseChildBootstrap,
	startChildBridge,
} from "../../extension-src/pi-teams/pi/child-bridge.js";
import { deriveViewerToken } from "../../extension-src/pi-teams/pi/child-rpc-auth.js";
import { ChildRpcClient } from "../../extension-src/pi-teams/pi/child-rpc-client.js";

const TOKEN = "bridge-test-secret-token";
let tempDir: string | undefined;
let bridge: ChildBridgeHandle | undefined;
const clients: ChildRpcClient[] = [];
let previousChildEnv: { child: string | undefined; bootstrap: string | undefined } | undefined;
let closeInstalledBridge: (() => Promise<void>) | undefined;

afterEach(async () => {
	for (const client of clients.splice(0)) client.disconnect();
	await closeInstalledBridge?.();
	closeInstalledBridge = undefined;
	await bridge?.close();
	bridge = undefined;
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	if (previousChildEnv) {
		if (previousChildEnv.child === undefined) delete process.env.PI_TEAMS_CHILD;
		else process.env.PI_TEAMS_CHILD = previousChildEnv.child;
		if (previousChildEnv.bootstrap === undefined) delete process.env.PI_TEAMS_BOOTSTRAP;
		else process.env.PI_TEAMS_BOOTSTRAP = previousChildEnv.bootstrap;
		previousChildEnv = undefined;
	}
	tempDir = undefined;
});

function createDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("child bridge over an owner-only Unix socket", () => {
	it("deduplicates reconnect retries and preserves run, transcript, and shutdown state", async () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-bridge-"));
		tempDir = dir;
		const sessionFile = join(dir, "sessions", "child.jsonl");
		const bootstrap = {
			childId: "child-a",
			token: TOKEN,
			socketPath: join(dir, "child.sock"),
			sessionDir: join(dir, "sessions"),
			sessionFile,
			cwd: dir,
			configCwd: dir,
			systemPrompt: "child prompt",
			promptMode: "append" as const,
		};
		expect(parseChildBootstrap({ ...bootstrap, thinking: "high" }).thinking).toBe("high");
		expect(() => parseChildBootstrap({ ...bootstrap, thinking: "instant" })).toThrow(
			"thinking must be a supported Pi thinking level",
		);
		const history: TranscriptItem[] = Array.from({ length: 300 }, (_, index) => ({
			kind: "assistant",
			timestamp: index,
			text: "h".repeat(8_192),
		}));
		const promptGate = createDeferred();
		const promptStarted = createDeferred();
		const shutdownCalled = createDeferred();
		let promptCalls = 0;
		let shouldFailPrompt = false;
		let steerCalls = 0;
		let abortCalls = 0;
		let shutdownCalls = 0;
		const host: ChildBridgeHost = {
			getSessionFile: () => sessionFile,
			getTranscript: () => history,
			getFocus: () => ({
				cwd: dir,
				thinking: "high",
				capabilities: { models: [], thinking: ["high"], commands: ["model", "thinking", "compact"] },
			}),
			async controlFocus() {},
			async prompt() {
				promptCalls++;
				promptStarted.resolve();
				if (shouldFailPrompt) throw new Error(`provider failed with ${TOKEN}`);
				await promptGate.promise;
			},
			async steer() {
				steerCalls++;
			},
			async abort() {
				abortCalls++;
			},
			async shutdown() {
				shutdownCalls++;
				shutdownCalled.resolve();
			},
		};

		const first = new ChildRpcClient({ socketPath: bootstrap.socketPath, childId: bootstrap.childId, token: TOKEN });
		const second = new ChildRpcClient({ socketPath: bootstrap.socketPath, childId: bootstrap.childId, token: TOKEN });
		const intruder = new ChildRpcClient({
			socketPath: bootstrap.socketPath,
			childId: bootstrap.childId,
			token: "wrong-secret-token",
		});
		const connectionTransitions: boolean[] = [];
		first.subscribeConnection((connected) => connectionTransitions.push(connected));
		clients.push(first, second, intruder);
		const viewer = new ChildRpcClient({
			socketPath: bootstrap.socketPath,
			childId: bootstrap.childId,
			token: deriveViewerToken(bootstrap.childId, TOKEN),
			role: "viewer",
		});
		clients.push(viewer);
		const initialConnection = first.connect();
		void initialConnection.catch(() => undefined); // Awaited below after the server starts.
		const childBridge = await startChildBridge(bootstrap, host);
		bridge = childBridge;
		expect(statSync(bootstrap.socketPath).mode & 0o777).toBe(0o600);
		await expect(intruder.connect()).rejects.toMatchObject({ code: "unauthorized" });
		const initial = await initialConnection;
		await second.connect();
		await viewer.connect();
		const elevatedViewer = new ChildRpcClient({
			socketPath: bootstrap.socketPath,
			childId: bootstrap.childId,
			token: deriveViewerToken(bootstrap.childId, TOKEN),
			role: "owner",
		});
		clients.push(elevatedViewer);
		await expect(elevatedViewer.connect()).rejects.toMatchObject({ code: "unauthorized" });
		await expect(viewer.shutdown()).rejects.toMatchObject({ code: "forbidden" });
		await expect(viewer.prompt("viewer-bypass", "Must not bypass parent admission")).rejects.toMatchObject({
			code: "forbidden",
		});
		viewer.disconnect();
		expect(shutdownCalls).toBe(0);
		expect(initial.transcript.cursor).toBe(history.length);
		expect(initial.transcript.offset).toBeGreaterThan(0);
		expect(initial.transcript.offset + initial.transcript.items.length).toBe(initial.transcript.cursor);
		expect(initial.transcript.truncated).toBe(true);
		childBridge.publishNativeEvent({ type: "message_start", message: { role: "assistant" } });
		childBridge.publishNativeEvent({
			type: "message_update",
			message: { role: "assistant", timestamp: 10, content: "partial" },
		});
		const partial = await first.state();
		const partialItem = partial.transcript.items.find((item) => item.partial);
		expect(partialItem).toMatchObject({ kind: "assistant", text: "partial", revision: 1 });
		childBridge.publishNativeEvent({
			type: "message_end",
			message: { role: "assistant", timestamp: 10, content: "complete" },
		});
		const completedMessage = await first.state();
		expect(
			completedMessage.transcript.items.some((item) => item.id === partialItem?.id && item.partial === false),
		).toBe(true);
		expect(completedMessage.focus?.cwd).toBe(dir);

		const firstPrompt = first.prompt("run-a", "start work");
		await promptStarted.promise;
		const retryPrompt = second.prompt("run-a", "start work");
		await second.state();
		promptGate.resolve();
		await expect(Promise.all([firstPrompt, retryPrompt])).resolves.toEqual([undefined, undefined]);
		expect(promptCalls).toBe(1);
		first.disconnect();
		const reconnected = await first.connect();
		expect(reconnected.execution).toBe("running");
		expect(reconnected.currentRunId).toBe("run-a");

		const active = await first.state();
		expect(active.execution).toBe("running");
		expect(active.currentRunId).toBe("run-a");
		await expect(first.abort("stale-run")).rejects.toMatchObject({ code: "stale_run" });
		await expect(first.steer("stale-run", "late steer")).rejects.toMatchObject({ code: "stale_run" });
		await first.steer("run-a", "focus on the edge cases");
		expect(steerCalls).toBe(1);

		const longAnswer = "a".repeat(9_000);
		childBridge.publishNativeEvent({
			type: "message_end",
			message: {
				role: "assistant",
				timestamp: Date.now(),
				content: [{ type: "text", text: longAnswer }],
				usage: { input: 11, output: 17, cacheRead: 3, cacheWrite: 5 },
				stopReason: "stop",
			},
		} satisfies ChildBridgeNativeEvent);
		childBridge.publishNativeEvent({ type: "agent_settled" });
		const completed = await first.state();
		expect(completed.execution).toBe("idle");
		expect(completed.lastOutcome).toMatchObject({
			runId: "run-a",
			status: "completed",
			resultTruncated: true,
			resultOriginalLength: longAnswer.length,
			resultFile: join(dir, "sessions", "result.md"),
		});
		// Full-result channel: the artifact carries the uncapped answer even
		// though the inline outcome copy is preview-bounded.
		expect(readFileSync(join(dir, "sessions", "result.md"), "utf8")).toBe(longAnswer);
		expect(statSync(join(dir, "sessions", "result.md")).mode & 0o777).toBe(0o600);
		expect(completed.transcript.items.at(-1)?.metadata).toMatchObject({
			truncated: true,
			originalLength: longAnswer.length,
		});
		expect(completed.usage).toMatchObject({
			inputTokens: 11,
			outputTokens: 17,
			cacheReadTokens: 3,
			cacheWriteTokens: 5,
			totalTokens: 33,
		});

		await expect(first.abort("run-a")).rejects.toMatchObject({ code: "stale_run" });
		const nextPrompt = first.prompt("run-b", "stop this run");
		await expect(nextPrompt).resolves.toBeUndefined();
		await first.abort("run-b");
		expect(abortCalls).toBe(1);
		childBridge.publishNativeEvent({
			type: "message_end",
			message: { role: "assistant", content: [], stopReason: "aborted" },
		});
		childBridge.publishNativeEvent({ type: "agent_settled" });
		expect((await first.state()).lastOutcome).toMatchObject({ runId: "run-b", status: "stopped" });

		await expect(first.prompt("run-c", "late native failure")).resolves.toBeUndefined();
		childBridge.failActiveRun(new Error(`native execution failed with ${TOKEN}`));
		const nativeFailed = await first.state();
		expect(nativeFailed.lastOutcome?.status).toBe("failed");
		expect(nativeFailed.lastOutcome?.error).not.toContain(TOKEN);
		shouldFailPrompt = true;
		await expect(first.prompt("run-d", "fail before acceptance")).rejects.toMatchObject({ code: "prompt_failed" });
		const requestFailed = await first.state();
		expect(requestFailed.lastOutcome?.status).toBe("failed");
		expect(requestFailed.lastOutcome?.error).not.toContain(TOKEN);

		await first.shutdown();
		await shutdownCalled.promise;
		expect(shutdownCalls).toBe(1);
		first.disconnect();
		expect(connectionTransitions).toEqual([true, false, true, false]);
	});

	it("settles native prompt preflight authentication failures for RPC consumers", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "teams-auth-preflight-"));
		const bootstrap = {
			childId: "child-auth",
			token: TOKEN,
			socketPath: join(tempDir, "child.sock"),
			sessionDir: join(tempDir, "sessions"),
			sessionFile: join(tempDir, "sessions", "child.jsonl"),
			cwd: tempDir,
			configCwd: tempDir,
			systemPrompt: "child prompt",
			promptMode: "append",
		};
		const bootstrapPath = join(tempDir, "bootstrap.json");
		writeFileSync(bootstrapPath, JSON.stringify(bootstrap), { mode: 0o600 });
		previousChildEnv = {
			child: process.env.PI_TEAMS_CHILD,
			bootstrap: process.env.PI_TEAMS_BOOTSTRAP,
		};
		process.env.PI_TEAMS_CHILD = "1";
		process.env.PI_TEAMS_BOOTSTRAP = bootstrapPath;

		let hasConfiguredAuth = false;
		let providerAuth: object | undefined;
		let dispatched = 0;
		const model = { provider: "anthropic", id: "claude-test", name: "claude-test" };
		const context = {
			model,
			cwd: tempDir,
			thinkingLevel: "off",
			getContextUsage: () => undefined,
			modelRegistry: {
				hasConfiguredAuth: () => hasConfiguredAuth,
				getProviderAuth: async () => providerAuth,
				isUsingOAuth: () => false,
				getAvailable: () => [model],
			},
			sessionManager: {
				getSessionFile: () => bootstrap.sessionFile,
				buildContextEntries: () => [],
			},
			abort: () => {},
			shutdown: () => {},
		};
		const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
		const pi = {
			on: (event: string, handler: (event: never, context: never) => unknown) => {
				handlers.set(event, handler as unknown as (event: unknown, context: unknown) => unknown);
			},
			sendUserMessage: () => {
				dispatched++;
			},
		};
		await installChildBridgeExtension(pi as never);
		closeInstalledBridge = async () => {
			await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context);
		};
		await handlers.get("session_start")?.({ type: "session_start" }, context);

		const client = new ChildRpcClient({
			socketPath: bootstrap.socketPath,
			childId: bootstrap.childId,
			token: TOKEN,
		});
		clients.push(client);
		await client.connect();
		await expect(client.prompt("missing-auth", "start work")).rejects.toMatchObject({ code: "prompt_failed" });
		const failed = await client.state();
		expect(failed.execution).toBe("idle");
		expect(failed.lastOutcome).toMatchObject({
			runId: "missing-auth",
			status: "failed",
		});
		expect(dispatched).toBe(0);

		providerAuth = { headers: { Authorization: "Bearer header-only" } };
		await client.prompt("header-auth", "start work");
		expect((await client.state()).currentRunId).toBe("header-auth");
		await handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		providerAuth = undefined;

		hasConfiguredAuth = true;
		await expect(client.prompt("configured-auth", "start work")).resolves.toBeUndefined();
		expect(dispatched).toBe(2);
		expect((await client.state()).execution).toBe("running");
		await handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
		expect((await client.state()).execution).toBe("idle");
	});

	it("fails at the readiness deadline when no child opens its socket", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "teams-deadline-"));
		const client = new ChildRpcClient({
			socketPath: join(tempDir, "missing.sock"),
			childId: "missing",
			token: TOKEN,
			connectTimeoutMs: 100,
		});
		clients.push(client);
		await expect(client.connect()).rejects.toMatchObject({ code: "connect_timeout" });
	});

	it("cancels an in-flight startup connection without waiting for its deadline", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "teams-cancel-"));
		const client = new ChildRpcClient({
			socketPath: join(tempDir, "missing.sock"),
			childId: "cancelled",
			token: TOKEN,
			connectTimeoutMs: 30_000,
		});
		clients.push(client);
		const pending = client.connect();
		client.disconnect();
		await expect(pending).rejects.toMatchObject({ code: "disconnected" });
	});
});

describe("mailbox assignment admission", () => {
	it("waits for capacity and preserves earlier full results across native assignments", async () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-mailbox-admission-"));
		tempDir = dir;
		const bootstrap = {
			childId: "mailbox-child",
			token: TOKEN,
			socketPath: join(dir, "child.sock"),
			sessionDir: join(dir, "sessions"),
			cwd: dir,
			configCwd: dir,
			systemPrompt: "",
			promptMode: "append" as const,
		};
		const injected: string[] = [];
		const runtime = await startChildBridge(bootstrap, {
			getSessionFile: () => join(dir, "sessions", "native.jsonl"),
			getTranscript: () => [],
			getFocus: () => ({ cwd: dir, thinking: "off", capabilities: { models: [], thinking: ["off"], commands: [] } }),
			controlFocus: async () => {},
			prompt: async (text) => {
				injected.push(text);
			},
			steer: async () => {},
			abort: async () => {},
			shutdown: async () => {},
		});
		bridge = runtime;
		const client = new ChildRpcClient({ socketPath: bootstrap.socketPath, childId: bootstrap.childId, token: TOKEN });
		clients.push(client);
		await client.connect();
		let earlierResult: string | undefined;
		for (const text of ["first findings", "second findings"]) {
			const ready = Promise.withResolvers<string>();
			const unsubscribe = client.subscribe((event) => {
				if (event.event === "mailbox_assignment" && typeof event.payload.runId === "string")
					ready.resolve(event.payload.runId);
			});
			const admission = runtime.startMailboxRun(text);
			const runId = await ready.promise;
			expect(runtime.state().execution).toBe("idle");
			expect(injected).not.toContain(text);
			await client.admitAssignment(runId);
			await admission;
			expect(runtime.state().currentRunId).toBe(runId);
			runtime.publishNativeEvent({
				type: "message_end",
				message: { role: "assistant", content: text, stopReason: "stop" },
			});
			runtime.publishNativeEvent({ type: "agent_settled" });
			const outcome = runtime.state().lastOutcome;
			if (!outcome?.resultFile) throw new Error("Native settlement did not persist a full result");
			expect(readFileSync(outcome.resultFile, "utf8")).toBe(text);
			if (earlierResult) {
				expect(outcome.resultFile).not.toBe(earlierResult);
				expect(readFileSync(earlierResult, "utf8")).toBe("first findings");
			} else earlierResult = outcome.resultFile;
			unsubscribe();
		}
	});
});

describe("control-loss self-termination (ADR 0007 §1)", () => {
	it("aborts, preserves an annotated partial result and stops after the control socket stays lost", async () => {
		vi.useFakeTimers();
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		try {
			const dir = mkdtempSync(join(tmpdir(), "teams-orphan-"));
			tempDir = dir;
			const sessionFile = join(dir, "sessions", "child.jsonl");
			const bootstrap = {
				childId: "child-orphan",
				token: TOKEN,
				socketPath: join(dir, "child.sock"),
				sessionDir: join(dir, "sessions"),
				sessionFile,
				cwd: dir,
				configCwd: dir,
				systemPrompt: "child prompt",
				promptMode: "append" as const,
			};
			const calls = { abort: 0, shutdown: 0 };
			const host: ChildBridgeHost = {
				getSessionFile: () => sessionFile,
				getTranscript: () => [],
				getFocus: () => ({
					cwd: dir,
					thinking: "off" as const,
					capabilities: { models: [], thinking: ["off"] as const, commands: [] },
				}),
				controlFocus: async () => {},
				prompt: async () => {},
				steer: async () => {},
				abort: async () => {
					calls.abort += 1;
				},
				shutdown: async () => {
					calls.shutdown += 1;
				},
			};
			bridge = await startChildBridge(bootstrap, host);
			const client = new ChildRpcClient({
				socketPath: bootstrap.socketPath,
				childId: bootstrap.childId,
				token: TOKEN,
			});
			clients.push(client);
			await client.connect();
			await client.prompt("run-orphan", "half-finished work");
			// Partial assistant text exists but the run never settles natively.
			bridge?.publishNativeEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "partial findings" }] },
			});

			client.disconnect();
			// Reconnect grace expires without a new authenticated connection.
			await vi.advanceTimersByTimeAsync(5_100);
			// Settle window expires and the shutdown path completes (the exit
			// failsafe is disarmed by the process.exit spy).
			await vi.runAllTimersAsync();

			expect(calls.abort).toBe(1);
			expect(calls.shutdown).toBe(1);
			const artifact = readFileSync(join(dir, "sessions", "result.md"), "utf8");
			expect(artifact.startsWith("stopped: parent control lost")).toBe(true);
			expect(artifact).toContain("partial findings");
		} finally {
			exitSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("does not stop while the parent reconnects inside the grace window", async () => {
		vi.useFakeTimers();
		try {
			const dir = mkdtempSync(join(tmpdir(), "teams-reconnect-"));
			tempDir = dir;
			const sessionFile = join(dir, "sessions", "child.jsonl");
			const bootstrap = {
				childId: "child-reconnect",
				token: TOKEN,
				socketPath: join(dir, "child.sock"),
				sessionDir: join(dir, "sessions"),
				sessionFile,
				cwd: dir,
				configCwd: dir,
				systemPrompt: "child prompt",
				promptMode: "append" as const,
			};
			const host: ChildBridgeHost = {
				getSessionFile: () => sessionFile,
				getTranscript: () => [],
				getFocus: () => ({
					cwd: dir,
					thinking: "off" as const,
					capabilities: { models: [], thinking: ["off"] as const, commands: [] },
				}),
				controlFocus: async () => {},
				steer: async () => {},
				abort: async () => {},
				shutdown: async () => {},
			};
			bridge = await startChildBridge(bootstrap, host);
			const client = new ChildRpcClient({
				socketPath: bootstrap.socketPath,
				childId: bootstrap.childId,
				token: TOKEN,
			});
			clients.push(client);
			await client.connect();
			client.disconnect();
			await vi.advanceTimersByTimeAsync(3_000);
			// The parent reconnects inside the grace window.
			await client.connect();
			await vi.advanceTimersByTimeAsync(6_000);
			const state = await client.state();
			expect(state.childId).toBe("child-reconnect");
		} finally {
			vi.useRealTimers();
		}
	});
});
