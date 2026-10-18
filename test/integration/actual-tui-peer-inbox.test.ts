import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { LocalPeerHost } from "../../extension-src/pi-teams/pi/peer-host.js";
import { startPeerRuntime } from "../../extension-src/pi-teams/pi/peer-runtime.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = process.env.PI_TEAMS_TUI_EVIDENCE_DIR ?? join(tmpdir(), "pi-teams-actual-tui-evidence");
const hasTmux = (() => {
	try {
		execFileSync("tmux", ["-V"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();
function resolvePiExecutable(): string {
	if (process.env.PI_BIN) return resolve(process.env.PI_BIN);
	const candidates = (process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, "pi"));
	const existing = candidates.filter((candidate) => {
		try {
			accessSync(candidate, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
	const installedHost = existing.find((candidate) => !candidate.includes(`${join("node_modules", ".bin")}/`));
	const executable = installedHost ?? existing[0];
	if (!executable) throw new Error("Pi executable not found; set PI_BIN to the installed Pi CLI");
	return executable;
}
const owned: Array<{ socket: string; session: string; child?: ChildProcess }> = [];
let root: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let senderRuntime: Awaited<ReturnType<typeof startPeerRuntime>>;

afterEach(async () => {
	await senderRuntime?.dispose();
	senderRuntime = undefined;
	for (const item of owned.splice(0)) {
		await tmux(item.socket, ["kill-session", "-t", item.session]).catch(() => {});
		await tmux(item.socket, ["kill-server"]).catch(() => {});
	}
	if (server?.listening) await new Promise<void>((resolve) => server?.close(() => resolve()));
	server = undefined;
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

function tmux(socket: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("tmux", ["-L", socket, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "",
			err = "";
		child.stdout.on("data", (chunk) => (out += chunk));
		child.stderr.on("data", (chunk) => (err += chunk));
		child.once("error", reject);
		child.once("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(err || `tmux exited ${code}`))));
	});
}
async function waitFor(check: () => Promise<string>, predicate: (screen: string) => boolean, label: string) {
	const until = Date.now() + 20_000;
	while (Date.now() < until) {
		const screen = await check();
		if (predicate(screen)) return screen;
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error(`Timed out waiting for ${label}; last screen follows:\n${await check()}`);
}
async function keys(socket: string, text: string) {
	await tmux(socket, ["send-keys", "-t", "tui", "C-u"]);
	await tmux(socket, ["send-keys", "-t", "tui", "-l", text]);
	await tmux(socket, ["send-keys", "-t", "tui", "Enter"]);
}

describe("actual Pi TUI peer inbox smoke", () => {
	it.skipIf(process.platform === "win32" || !hasTmux)(
		"renders production peer controls and confirms busy teammate shutdown/removal in Pi TUI",
		async () => {
			const piExecutable = resolvePiExecutable();
			root = await mkdtemp("/tmp/pt-");
			const agentDir = join(root, "agent"),
				cwd = join(root, "project");
			await mkdir(agentDir, { recursive: true });
			await mkdir(cwd, { recursive: true });
			let requests = 0;
			let heldChildBody = "";
			let releaseChildRequest!: () => void;
			const childRequest = new Promise<void>((resolve) => {
				releaseChildRequest = resolve;
			});
			server = createServer((req, res) => {
				let body = "";
				req.setEncoding("utf8");
				req.on("data", (chunk) => {
					body += chunk;
				});
				req.on("end", () => {
					requests++;
					if (requests === 3) {
						heldChildBody = body;
						// The third model request is the actual child run. Keep its HTTP stream open
						// until production shutdown aborts the child; never synthesize a busy state.
						releaseChildRequest();
						res.on("close", releaseChildRequest);
						return;
					}
					res.writeHead(200, { "content-type": "text/event-stream" });
					const chunks =
						requests === 2
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
															id: "call-agent",
															type: "function",
															function: {
																name: "Agent",
																arguments: JSON.stringify({
																	prompt: "T19 child hold prompt",
																	description: "TUI shutdown smoke",
																	subagent_type: "general-purpose",
																	name: "tui-worker",
																	color: "#48A0D0",
																	run_in_background: true,
																}),
															},
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
										choices: [
											{
												index: 0,
												delta: {
													role: "assistant",
													content: requests === 1 ? "local-fixture-ok" : "local-followup-ok",
												},
												finish_reason: null,
											},
										],
									},
									{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
								];
					for (const chunk of chunks)
						res.write(
							`data: ${JSON.stringify({ id: "offline", object: "chat.completion.chunk", created: 1, model: "local-model", ...chunk })}\n\n`,
						);
					res.end("data: [DONE]\n\n");
				});
			});
			await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
			const address = server?.address();
			if (!address || typeof address === "string") throw new Error("local provider did not bind");
			await writeFile(
				join(agentDir, "models.json"),
				JSON.stringify({
					providers: {
						"local-test": {
							baseUrl: `http://127.0.0.1:${address.port}/v1`,
							apiKey: "local-test",
							api: "openai-completions",
							models: [
								{
									id: "local-model",
									name: "local fixture",
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
			await writeFile(join(agentDir, "auth.json"), JSON.stringify({}));
			await writeFile(
				join(agentDir, "settings.json"),
				JSON.stringify({ defaultProvider: "local-test", defaultModel: "local-model" }),
			);
			await writeFile(
				join(agentDir, "teams.json"),
				JSON.stringify({ peers: { enabled: true, scope: "project", policy: "hold" }, backend: "headless" }),
			);
			await mkdir(evidence, { recursive: true });

			const socket = `pitui-${process.pid}-${Date.now()}`;
			owned.push({ socket, session: "tui" });
			const extension = join(repo, "dist/extensions/pi-teams.js");
			const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
			const command = `cd ${quote(cwd)} && env -u PI_TEAMS_CHILD PI_CODING_AGENT_DIR=${quote(agentDir)} PI_OFFLINE=1 ${quote(piExecutable)} --no-extensions --extension ${quote(extension)} --provider local-test --model local-model --no-session --tui-mode regular`;
			await tmux(socket, ["new-session", "-d", "-s", "tui", "-x", "120", "-y", "38", command]);
			const capture = () => tmux(socket, ["capture-pane", "-p", "-t", "tui"]);
			const initial = await waitFor(
				capture,
				(s) => s.includes("local-model") || s.includes("local fixture"),
				"configured local model",
			);
			await writeFile(join(evidence, "initial.txt"), initial);
			await keys(socket, "/agents");
			const agents = await waitFor(
				capture,
				(s) => s.includes("Team Hub") || s.includes("[Agents]"),
				"/agents Team Hub controls",
			);
			expect(requests).toBe(0); // /agents must be handled as a command, not sent to the model.
			await writeFile(join(evidence, "agents.txt"), agents);
			await tmux(socket, ["send-keys", "-t", "tui", "Escape"]);

			const fakePi = { on: () => () => {}, sendUserMessage: () => {} } as unknown as ExtensionAPI;
			const sid = `sender-${Date.now()}`;
			const context = {
				sessionManager: { getSessionId: () => sid, getCwd: () => cwd },
				ui: { notify() {} },
			} as unknown as ExtensionContext;
			const oldChildEnv = process.env.PI_TEAMS_CHILD;
			delete process.env.PI_TEAMS_CHILD;
			let senderError: unknown;
			senderRuntime = await startPeerRuntime({
				pi: fakePi,
				ctx: context,
				root: agentDir,
				enabled: true,
				policy: "hold",
				onError: (error) => {
					senderError = error;
				},
			});
			if (oldChildEnv !== undefined) process.env.PI_TEAMS_CHILD = oldChildEnv;
			if (!senderRuntime) throw new Error(`could not start authenticated local sender runtime: ${String(senderError)}`);
			const sender = senderRuntime;
			const receiver = async () =>
				(await sender.discovery.discover(sender.projectId)).find((a) => a.peerSessionId !== sid);
			await waitFor(
				async () => JSON.stringify(await receiver()),
				(s) => s !== "undefined",
				"TUI peer advertisement",
			);
			const target = await receiver();
			if (!target)
				throw new Error(
					`TUI peer advertisement not discoverable; TUI screen:\n${await capture()}\nregistry: ${JSON.stringify(await new LocalPeerHost(join(agentDir, "peer")).list(sender.projectId))}`,
				);
			const sendHeld = async (body: string) => {
				const result = await sender.messaging.send(target, body);
				expect(result.receipt).toBe("queued");
				await waitFor(
					async () => JSON.stringify(await new LocalPeerHost(join(agentDir, "peer")).listHeld()),
					(s) => s.includes(body),
					"signed message held by production runtime",
				);
			};
			await sendHeld("T19 refuse visible payload");
			await keys(socket, "/peer-inbox");
			const held = await waitFor(capture, (s) => s.includes("T19 refuse visible payload"), "held-message selector");
			await writeFile(join(evidence, "held-message.txt"), held);
			await tmux(socket, ["send-keys", "-t", "tui", "Enter"]);
			const actions = await waitFor(
				capture,
				(s) => s.includes("Approve and deliver to model") && s.includes("Refuse"),
				"approve/refuse controls",
			);
			await writeFile(join(evidence, "controls.txt"), actions);
			await tmux(socket, ["send-keys", "-t", "tui", "Down", "Enter"]);
			const refused = await waitFor(capture, (s) => s.includes("Peer message refused"), "refusal outcome");
			await writeFile(join(evidence, "refused.txt"), refused);
			await sendHeld("T19 approve visible payload");
			await keys(socket, "/peer-inbox");
			await waitFor(capture, (s) => s.includes("T19 approve visible payload"), "second held message");
			await tmux(socket, ["send-keys", "-t", "tui", "Enter"]);
			await waitFor(capture, (s) => s.includes("Approve and deliver to model"), "approval controls");
			await tmux(socket, ["send-keys", "-t", "tui", "Enter"]);
			const approved = await waitFor(capture, (s) => s.includes("Peer message delivered"), "approval outcome");
			await writeFile(join(evidence, "approved.txt"), approved);
			await waitFor(
				async () => String(requests),
				(s) => Number(s) > 0,
				"local model request after approved delivery",
			);
			const modelOutcome = await waitFor(
				capture,
				(s) => s.includes("local-fixture-ok"),
				"local model response after approval",
			);
			await writeFile(join(evidence, "model-outcome.txt"), modelOutcome);
			expect(initial).not.toContain("No models available");
			expect(initial).not.toContain("No API key found");
			expect(agents).not.toContain("No API key found");
			expect(held).toContain("T19 refuse visible payload");
			expect(actions).toContain("Approve and deliver to model");
			expect(actions).toContain("Refuse");
			expect(refused).toContain("Peer message refused");
			expect(approved).toContain("Peer message delivered");
			expect(modelOutcome).toContain("local-fixture-ok");
			expect(requests).toBe(1);

			await keys(socket, "Create the named tui-worker child now and keep working on T19 child hold prompt.");
			await waitFor(
				async () => String(requests),
				(count) => Number(count) >= 3,
				"real child model request held by local provider",
			);
			await childRequest;
			expect(heldChildBody).toContain("T19 child hold prompt");
			await writeFile(join(evidence, "child-request-held.txt"), heldChildBody);
			await keys(socket, "/agents teammate-status tui-worker");
			const busy = await waitFor(
				capture,
				(s) => s.includes("@tui-worker:") && s.includes("busy"),
				"actual busy teammate status",
			);
			await writeFile(join(evidence, "busy-status.txt"), busy);
			expect(requests).toBe(3);
			await keys(socket, "/agents teammate-shutdown tui-worker");
			const shutdown = await waitFor(
				capture,
				(s) => s.includes("Teammate @tui-worker was shut down and removed."),
				"shutdown command outcome",
			);
			await writeFile(join(evidence, "shutdown-outcome.txt"), shutdown);
			await waitFor(capture, (s) => s.includes("local-followup-ok"), "parent turn completes after child shutdown");
			await keys(socket, "/agents teammate-status tui-worker");
			const shutdownStatus = await waitFor(
				capture,
				(s) => s.includes("@tui-worker: released"),
				"released teammate status after shutdown",
			);
			await writeFile(join(evidence, "membership-removed.txt"), shutdownStatus);
			await keys(socket, "/agents");
			await waitFor(capture, (s) => s.includes("Team Hub (1)") && s.includes("released"), "released run in Team Hub");
			await tmux(socket, ["send-keys", "-t", "tui", "x"]);
			const removed = await waitFor(
				capture,
				(s) => s.includes("Team Hub (0)"),
				"dismissed run disappears from Team Hub",
			);
			await writeFile(join(evidence, "shutdown-removed.txt"), removed);
			expect(shutdownStatus).toContain("@tui-worker: released");
			expect(removed).toContain("Team Hub (0)");
			expect(requests).toBeGreaterThanOrEqual(4);
		},
		60_000,
	);
});
