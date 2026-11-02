import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskBoardService } from "../../extension-src/pi-teams/app/task-board-service.js";
import extension from "../../extension-src/pi-teams/pi/index.js";
import { teamDirFor } from "../../extension-src/pi-teams/pi/teams-host.js";
import { FakePiHost } from "../helpers/fake-pi-host.js";

let root: string | undefined;
let host: FakePiHost | undefined;
let nativeSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
afterEach(async () => {
	await host?.sessionShutdown();
	nativeSession?.dispose();
	nativeSession = undefined;
	host = undefined;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

async function setup(reminders: boolean) {
	root = mkdtempSync(join(tmpdir(), "task-reminder-history-"));
	vi.spyOn(process, "cwd").mockReturnValue(root);
	vi.stubEnv("PI_CODING_AGENT_DIR", root);
	vi.stubEnv("PI_TEAMS_CHILD", "");
	writeFileSync(join(root, "teams.json"), JSON.stringify({ tasks: { reminders } }));
	host = new FakePiHost({ mode: "print", cwd: root, sessionView: { sessionId: "reminder-test" } });
	extension(host.extensionApi);
	await host.sessionStart();
	const board = new TaskBoardService({ teamDir: teamDirFor(root, "reminder-test"), self: "lead" });
	board.create({ title: "Investigate signed thinking" });
	return host;
}

async function turn(host: FakePiHost, index: number) {
	await host.emit("turn_start", { type: "turn_start", turnIndex: index, timestamp: index });
	await host.emit("turn_end", {
		type: "turn_end",
		turnIndex: index,
		message: { role: "assistant", content: [] } as never,
		toolResults: [],
	});
}

describe("task reminder history", () => {
	it("sends a durable hidden message at the turn boundary, never a request-only transform", async () => {
		const host = await setup(true);
		const sessions = SessionManager.create(root as string, root);
		const { session } = await createAgentSession({
			cwd: root as string,
			agentDir: root as string,
			sessionManager: sessions,
			noTools: "all",
		});
		nativeSession = session;
		const pending: Promise<void>[] = [];
		const sendMessage = host.extensionApi.sendMessage.bind(host.extensionApi);
		vi.spyOn(host.extensionApi, "sendMessage").mockImplementation((message, options) => {
			sendMessage(message, options);
			pending.push(session.sendCustomMessage(message, options));
		});
		expect(host.handlers.has("context")).toBe(false);
		for (let i = 0; i < 3; i += 1) await turn(host, i);
		expect(host.sentMessages).toEqual([]);
		await turn(host, 3);
		expect(host.sentMessages).toEqual([
			{
				message: {
					customType: "task-reminder",
					content: expect.stringContaining("Investigate signed thinking"),
					display: false,
				},
				options: { triggerTurn: false },
			},
		]);

		// The custom-message session entry must remain before any later signed
		// assistant message when native Pi rebuilds history (including resume).
		await Promise.all(pending);
		const reminder = host.sentMessages[0]?.message;
		if (!reminder) throw new Error("Missing task reminder");
		sessions.appendMessage({
			role: "assistant",
			content: [{ type: "thinking", thinking: "Checking tasks", thinkingSignature: "signed-thinking" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 1,
		});
		const before = sessions.buildSessionContext().messages;
		await turn(host, 4);
		expect(host.sentMessages).toHaveLength(1);
		const sessionFile = sessions.getSessionFile();
		if (!sessionFile) throw new Error("Missing persisted session");
		expect(SessionManager.open(sessionFile).buildSessionContext().messages).toEqual(before);
		expect(before[0]).toMatchObject({ role: "custom", customType: "task-reminder", content: reminder.content });
		expect(before[1]).toMatchObject({ role: "assistant", content: [{ thinkingSignature: "signed-thinking" }] });
	});

	it("resets the cadence when a task tool is used before the turn boundary", async () => {
		const host = await setup(true);
		for (let i = 0; i < 3; i += 1) await turn(host, i);
		await host.emit("turn_start", { type: "turn_start", turnIndex: 3, timestamp: 3 });
		await host.emit("tool_result", {
			type: "tool_result",
			toolName: "tasks_list",
			toolCallId: "tasks",
			input: {},
			content: [],
			details: {},
			isError: false,
		});
		await host.emit("turn_end", {
			type: "turn_end",
			turnIndex: 3,
			message: { role: "assistant", content: [] } as never,
			toolResults: [],
		});
		expect(host.sentMessages).toEqual([]);
		for (let i = 4; i < 8; i += 1) await turn(host, i);
		expect(host.sentMessages).toHaveLength(1);
	});

	it("does not emit reminders when disabled", async () => {
		const host = await setup(false);
		for (let i = 0; i < 5; i += 1) await turn(host, i);
		expect(host.sentMessages).toEqual([]);
	});
});
