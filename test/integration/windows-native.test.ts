import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { LauncherHandle } from "../../extension-src/pi-teams/domain/process-launcher.js";
import { createControlEndpoints, isWindowsPipeEndpoint } from "../../extension-src/pi-teams/pi/child-endpoint.js";
import { ChildRpcClient } from "../../extension-src/pi-teams/pi/child-rpc-client.js";
import { ProcessAgentExecutionBackend } from "../../extension-src/pi-teams/pi/process-backend.js";
import { createProcessLaunchers } from "../../extension-src/pi-teams/pi/process-launchers.js";

// Real-launcher lifecycle against the BUILT headless child on native Windows.
// No model/API key exists in CI: a local OpenAI-compatible provider on
// 127.0.0.1 registers an authenticated model so the child can boot; no prompt
// is sent. Viewer presentation (HerdR/tmux panes, native TUI attach) cannot be
// proven on windows-latest CI — there is no TTY, no HerdR and no tmux — and
// this increment ships no Windows viewer; that coverage stays on the Unix
// suites, which is why only the headless lifecycle runs here.
describe.skipIf(process.platform !== "win32")("native windows headless runtime", () => {
	const tempRoots: string[] = [];
	const servers: Server[] = [];

	afterEach(async () => {
		while (servers.length > 0) {
			const server = servers.pop();
			if (server?.listening) {
				await new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
				});
			}
		}
		while (tempRoots.length > 0) {
			const root = tempRoots.pop();
			if (root) await rm(root, { recursive: true, force: true });
		}
	});

	it("selects headless automatically and drives the built child over named pipes with a verified exit", async () => {
		const root = await mkdtemp(join(tmpdir(), "teams-windows-native-"));
		tempRoots.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		await mkdir(agentDir, { recursive: true });
		await mkdir(cwd, { recursive: true });
		const server = createServer((request, response) => {
			// Drain the request body; no prompt is ever sent from this suite.
			request.resume();
			request.on("end", () => {
				response.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				});
				const prefix = {
					id: "chatcmpl-local",
					object: "chat.completion.chunk",
					created: 1,
					model: "local-model",
				};
				for (const chunk of [
					{
						...prefix,
						choices: [{ index: 0, delta: { role: "assistant", content: "windows-native-ok" }, finish_reason: null }],
					},
					{ ...prefix, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
					{ ...prefix, choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
				])
					response.write(`data: ${JSON.stringify(chunk)}\n\n`);
				response.end("data: [DONE]\n\n");
			});
		});
		servers.push(server);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("local provider did not bind a TCP port");
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"local-test": {
						baseUrl: `http://127.0.0.1:${address.port}/v1`,
						apiKey: "local-test-key",
						api: "openai-completions",
						models: [
							{
								id: "local-model",
								name: "Local deterministic model",
								reasoning: false,
								input: ["text"],
								contextWindow: 4096,
								maxTokens: 128,
							},
						],
					},
				},
			}),
			"utf8",
		);

		// Availability: headless reports true; HerdR/tmux report false on the
		// runner, so auto selection provably resolves to the Windows launcher.
		const launchers = createProcessLaunchers();
		const headless = launchers.find((candidate) => candidate.kind === "headless");
		if (!headless) throw new Error("headless launcher is missing");
		await expect(headless.available()).resolves.toBe(true);
		await expect(launchers.find((candidate) => candidate.kind === "herdr")?.available()).resolves.toBe(false);
		await expect(launchers.find((candidate) => candidate.kind === "tmux")?.available()).resolves.toBe(false);
		const backend = new ProcessAgentExecutionBackend({ launcherHint: "auto" });
		await expect(backend.detectLauncherKind()).resolves.toBe("headless");

		const runDir = join(root, "run");
		await mkdir(runDir, { recursive: true });
		const childId = randomUUID();
		const token = randomBytes(32).toString("hex");
		const control = createControlEndpoints(childId, { terminal: false });
		expect(isWindowsPipeEndpoint(control.socketPath)).toBe(true);
		const bootstrapFile = join(runDir, "bootstrap.json");
		await writeFile(
			bootstrapFile,
			JSON.stringify({
				childId,
				token,
				socketPath: control.socketPath,
				sessionDir: runDir,
				cwd,
				configCwd: cwd,
				systemPrompt: "",
				promptMode: "append",
				model: "local-test/local-model",
			}),
			"utf8",
		);
		const hostModuleEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const dist = join(process.cwd(), "dist/extensions");

		let handle: LauncherHandle | undefined;
		let client: ChildRpcClient | undefined;
		try {
			handle = await headless.launch({
				childId,
				runDir,
				cwd,
				env: {
					PI_TEAMS_BOOTSTRAP: bootstrapFile,
					PI_TEAMS_CHILD: "1",
					PI_TEAMS_HOST_MODULE: hostModuleEntry,
					PI_CODING_AGENT_DIR: agentDir,
					PI_OFFLINE: "1",
				},
				interactiveArgv: [],
				headlessCommand: process.execPath,
				headlessArgv: ["--import", join(dist, "child-module-loader.js"), join(dist, "headless-child.js")],
			});
			expect(handle.pid).toBeTruthy();
			expect(handle.pid).not.toBe(process.pid);
			expect(handle.identity?.creationDate).toBeTruthy();
			expect(handle.identity?.ownerToken).toBeTruthy();

			// Authenticated hello over the named pipe returns the child's state;
			// ChildRpcClient validates the childId/token identity itself.
			client = new ChildRpcClient({
				socketPath: control.socketPath,
				childId,
				token,
				connectTimeoutMs: 20_000,
			});
			const state = await client.connect();
			expect(state.execution).toBe("idle");
			expect(state.pid).toBe(handle.pid);

			// Cooperative stop first, then the taskkill /T lifecycle: a console
			// child may ignore the graceful close, so escalate to the forced kill
			// and require the launcher's verified-exit proof either way.
			await client.shutdown().catch(() => undefined);
			client.disconnect();
			await headless.terminate(handle).catch(() => headless.forceKill?.(handle));
			expect(await headless.cleanupExited(handle)).toBe(true);
		} finally {
			client?.disconnect();
			if (handle) await headless.terminate(handle).catch(() => headless.forceKill?.(handle));
			control.cleanup();
		}
	}, 120_000);
});
