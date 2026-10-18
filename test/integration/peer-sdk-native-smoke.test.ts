import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
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
	observed: Array<{ role: string; text: string }> = [],
	promptErrors: unknown[] = [],
): ExtensionAPI {
	const handlers = new Map<string, Set<(event: never) => void>>();
	session.subscribe((event) => {
		if (event.type === "message_start" && "message" in event && event.message.role === "user") {
			const content = event.message.content;
			observed.push({
				role: event.message.role,
				text:
					typeof content === "string"
						? content
						: content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join(""),
			});
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
			// Dispatch into the real AgentSession; SDK message_start is observed below, not synthesized.
			void session
				.prompt(typeof content === "string" ? content : content.map((part) => part.text ?? "").join(""), options)
				.catch((error) => promptErrors.push(error));
		},
	} as ExtensionAPI;
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() >= deadline) throw new Error("condition did not become true before timeout");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("native Pi SDK peer sessions", () => {
	it("creates independent real sessions and registers isolated signed peer runtimes", async () => {
		previousChildEnv = process.env.PI_TEAMS_CHILD;
		delete process.env.PI_TEAMS_CHILD;
		root = await mkdtemp(join("/tmp", "ps-"));
		provider = createServer((request, response) => {
			request.resume();
			request.on("end", () => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				for (const chunk of [
					{ choices: [{ index: 0, delta: { role: "assistant", content: "local-ok" }, finish_reason: null }] },
					{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
					{ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
				])
					response.write(
						`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "local", ...chunk })}\n\n`,
					);
				response.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolve) => provider?.listen(0, "127.0.0.1", resolve));
		const providerAddress = provider.address();
		if (!providerAddress || typeof providerAddress === "string") throw new Error("local provider did not bind");
		const project = join(root, "project");
		const agentDir = join(root, "agent");
		await mkdir(project, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"local-test": {
						baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
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
		const makeSession = async (id: string) => {
			const { session } = await createAgentSession({
				cwd: project,
				agentDir,
				noTools: "all",
				sessionManager: SessionManager.inMemory(project, { id }),
			});
			sessions.push(session);
			return session;
		};
		const senderSession = await makeSession("peer-sender");
		const receiverSession = await makeSession("peer-receiver");
		expect(senderSession).not.toBe(receiverSession);
		expect(senderSession.sessionManager).not.toBe(receiverSession.sessionManager);

		const makeContext = (session: typeof senderSession): ExtensionContext =>
			({
				sessionManager: session.sessionManager,
				ui: { notify() {} },
			}) as unknown as ExtensionContext;
		const observedReceiverMessages: Array<{ role: string; text: string }> = [];
		const receiverPromptErrors: unknown[] = [];
		for (const [session, name] of [
			[senderSession, "sender"],
			[receiverSession, "receiver"],
		] as const) {
			let startupError: unknown;
			const runtime = await startPeerRuntime({
				pi: extensionAdapter(
					session,
					name === "receiver" ? observedReceiverMessages : [],
					name === "receiver" ? receiverPromptErrors : [],
				),
				ctx: makeContext(session),
				root: agentDir,
				enabled: true,
				policy: "hold",
				onError(error) {
					startupError = error;
				},
			});
			expect(runtime, `peer runtime for ${name}: ${String(startupError)}`).toBeDefined();
			runtimes.push(runtime);
		}
		expect(runtimes).toHaveLength(2);
		const sender = runtimes[0];
		const receiver = runtimes[1];
		if (!sender || !receiver) throw new Error("both peer runtimes must be live");
		expect(sender.projectId).toBe(receiver.projectId);
		const receiverAd = (await sender.discovery.discover(sender.projectId)).find(
			(peer) => peer.peerSessionId === "peer-receiver",
		);
		expect(receiverAd).toBeDefined();
		if (!receiverAd) throw new Error("receiver advertisement missing");
		const sent = await sender.messaging.send(receiverAd, "private peer payload");
		expect(sent.receipt).toBe("queued");
		await waitUntil(
			async () =>
				(await receiver.messaging.heldMessages()).some((message) => message.messageId === sent.messageId) &&
				(await receiver.messaging.receipt(sent.messageId)).receipt === "held",
		);
		expect(observedReceiverMessages).toHaveLength(0);
		await receiver.messaging.approveHeld(sent.messageId);
		await waitUntil(async () =>
			observedReceiverMessages.some(
				(message) => message.text.includes("[peer-delivery:") && message.text.includes("private peer payload"),
			),
		);
		expect(observedReceiverMessages).toHaveLength(1);
		expect((await receiver.messaging.receipt(sent.messageId)).receipt).toBe("delivered");
		await waitUntil(async () => receiverSession.isIdle);
		expect(receiverPromptErrors).toEqual([]);
		expect(
			receiverSession.state.messages.some(
				(message) => message.role === "assistant" && JSON.stringify(message.content).includes("local-ok"),
			),
			JSON.stringify(receiverSession.state.messages),
		).toBe(true);
	}, 30_000);
});
