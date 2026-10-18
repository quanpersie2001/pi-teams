import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { startPeerRuntime } from "../../extension-src/pi-teams/pi/peer-runtime.js";

let root: string | undefined;
let provider: ReturnType<typeof createServer> | undefined;
let previousChildEnv: string | undefined;
const runtimes: Array<Awaited<ReturnType<typeof startPeerRuntime>>> = [];
const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime?.dispose();
	if (provider?.listening) await new Promise<void>((resolve) => provider?.close(() => resolve()));
	provider = undefined;
	for (const session of sessions.splice(0)) await session.abort();
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
	if (previousChildEnv === undefined) delete process.env.PI_TEAMS_CHILD;
	else process.env.PI_TEAMS_CHILD = previousChildEnv;
	previousChildEnv = undefined;
});

function extensionAdapter(
	session: Awaited<ReturnType<typeof createAgentSession>>["session"],
	observed: string[],
	errors: unknown[],
): ExtensionAPI {
	const handlers = new Map<string, Set<(event: never) => void>>();
	session.subscribe((event) => {
		if (event.type === "message_start" && "message" in event && event.message.role === "user") {
			const content = event.message.content;
			const text =
				typeof content === "string"
					? content
					: content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("");
			if (text.includes("[peer-delivery:")) observed.push(text);
		}
		for (const handler of handlers.get(event.type) ?? []) handler(event as never);
	});
	return {
		on(event, handler) {
			const listeners = handlers.get(event) ?? new Set();
			listeners.add(handler as (event: never) => void);
			handlers.set(event, listeners);
			return () => listeners.delete(handler as (event: never) => void);
		},
		sendUserMessage(content, options) {
			void session
				.prompt(typeof content === "string" ? content : content.map((part) => part.text ?? "").join(""), {
					...options,
					streamingBehavior: options?.deliverAs === "steer" ? "steer" : "followUp",
					expandPromptTemplates: false,
				})
				.catch((error) => errors.push(error));
		},
	} as ExtensionAPI;
}
async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() >= deadline) throw new Error("condition did not become true before timeout");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("native Pi SDK peer delivery while busy", () => {
	it("accepts signed peer steering without aborting or overlapping a pending tool", async () => {
		previousChildEnv = process.env.PI_TEAMS_CHILD;
		delete process.env.PI_TEAMS_CHILD;
		root = await mkdtemp(join("/tmp", "ps-busy-"));
		let providerCalls = 0;
		provider = createServer((request, response) => {
			request.resume();
			request.on("end", () => {
				providerCalls++;
				response.writeHead(200, { "content-type": "text/event-stream" });
				const chunks =
					providerCalls === 1
						? [
								{
									choices: [
										{
											index: 0,
											delta: {
												role: "assistant",
												tool_calls: [
													{
														index: 0,
														id: "call-block",
														type: "function",
														function: { name: "blocking_tool", arguments: "{}" },
													},
												],
											},
											finish_reason: null,
										},
									],
								},
								{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
							]
						: [
								{
									choices: [{ index: 0, delta: { role: "assistant", content: "tool-finished" }, finish_reason: null }],
								},
								{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
							];
				for (const chunk of chunks)
					response.write(
						`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "local-model", ...chunk })}\n\n`,
					);
				response.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolve) => provider?.listen(0, "127.0.0.1", resolve));
		const address = provider.address();
		if (!address || typeof address === "string") throw new Error("local provider did not bind");
		const project = join(root, "project"),
			agentDir = join(root, "agent");
		await mkdir(project, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"local-test": {
						baseUrl: `http://127.0.0.1:${address.port}/v1`,
						apiKey: "offline",
						api: "openai-completions",
						models: [
							{
								id: "local-model",
								name: "local",
								reasoning: false,
								input: ["text"],
								contextWindow: 4096,
								maxTokens: 128,
							},
						],
					},
				},
			}),
		);
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "local-test", defaultModel: "local-model" }),
		);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = false,
			exited = false,
			concurrent = false,
			active = 0;
		const { session: receiverSession } = await createAgentSession({
			cwd: project,
			agentDir,
			noTools: "builtin",
			sessionManager: SessionManager.inMemory(project, { id: "peer-receiver-busy" }),
			customTools: [
				{
					name: "blocking_tool",
					label: "Blocking tool",
					description: "Waits for release",
					parameters: Type.Object({}),
					execute: async () => {
						active++;
						if (active > 1) concurrent = true;
						entered = true;
						await gate;
						exited = true;
						active--;
						return { content: [{ type: "text", text: "blocking-tool-done" }] };
					},
				},
			],
		});
		sessions.push(receiverSession);
		const senderSession = (
			await createAgentSession({
				cwd: project,
				agentDir,
				noTools: "builtin",
				sessionManager: SessionManager.inMemory(project, { id: "peer-sender-busy" }),
			})
		).session;
		sessions.push(senderSession);
		const context = (session: typeof receiverSession): ExtensionContext =>
			({ sessionManager: session.sessionManager, ui: { notify() {} } }) as unknown as ExtensionContext;
		const observed: string[] = [],
			errors: unknown[] = [];
		for (const [session, id] of [
			[senderSession, "peer-sender-busy"],
			[receiverSession, "peer-receiver-busy"],
		] as const) {
			let startupError: unknown;
			const runtime = await startPeerRuntime({
				pi: extensionAdapter(
					session,
					id === "peer-receiver-busy" ? observed : [],
					id === "peer-receiver-busy" ? errors : [],
				),
				ctx: context(session),
				root: agentDir,
				enabled: true,
				policy: "accept",
				onError(error) {
					startupError = error;
				},
			});
			expect(runtime, String(startupError)).toBeDefined();
			runtimes.push(runtime);
		}
		const [sender, receiver] = runtimes;
		if (!sender || !receiver) throw new Error("peer runtimes did not start");
		const ad = (await sender.discovery.discover(sender.projectId)).find(
			(peer) => peer.peerSessionId === "peer-receiver-busy",
		);
		if (!ad) throw new Error("receiver advertisement missing");
		const run = receiverSession.prompt("start blocked tool", { expandPromptTemplates: false });
		await waitUntil(() => entered).catch((error) => {
			throw new Error(
				`${String(error)}; providerCalls=${providerCalls}; messages=${JSON.stringify(receiverSession.state.messages)}`,
			);
		});
		const sent = await sender.messaging.send(ad, "busy peer payload");
		expect(sent.receipt).toBe("queued");
		await new Promise((resolve) => setTimeout(resolve, 150));
		const deliveredBeforeRelease = await receiver.messaging.receipt(sent.messageId);
		expect(deliveredBeforeRelease.receipt).not.toBe("delivered");
		expect(observed).toEqual([]);
		expect(exited).toBe(false);
		expect(active).toBe(1);
		release();
		await run;
		await waitUntil(() => receiverSession.isIdle);
		await waitUntil(async () => (await receiver.messaging.receipt(sent.messageId)).receipt === "delivered");
		expect(observed.some((text) => text.includes("busy peer payload"))).toBe(true);
		expect(exited).toBe(true);
		expect(concurrent).toBe(false);
		expect(errors).toEqual([]);
		expect(
			receiverSession.state.messages.some(
				(message) => message.role === "assistant" && JSON.stringify(message.content).includes("tool-finished"),
			),
		).toBe(true);
	}, 30_000);
});
