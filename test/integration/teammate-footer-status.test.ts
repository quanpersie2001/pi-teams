import { existsSync } from "node:fs";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type {
	AgentFocusSnapshot,
	AgentGitSnapshot,
	AgentTranscriptView,
} from "../../extension-src/pi-teams/domain/ui-view.js";
import {
	agentStatusSnapshot,
	readAgentGit,
	renderAgentStatus,
} from "../../extension-src/pi-teams/features/agent-view/status.js";
import { renderTheme } from "../helpers/render-theme.js";

const providerFile = new URL("../../../pi-style/extension-src/pi-style/pi/detached-editor.ts", import.meta.url);
const configFile = new URL("../../../pi-style/extension-src/pi-style/domain/config-normalization.ts", import.meta.url);
const view = {
	agentId: "A",
	type: "explore",
	status: "running",
	resourceState: "open",
	usage: { inputTokens: 99999, outputTokens: 99999, cost: 99 },
} as AgentTranscriptView;
const focus: AgentFocusSnapshot = {
	runId: "A",
	currentRunId: "A",
	model: "canonical",
	modelName: "Child Alpha",
	provider: "child-provider",
	reasoning: true,
	thinking: "high",
	cwd: "/worktree/A",
	context: null,
	capabilities: [],
	items: [],
	truncatedHead: false,
	closed: false,
	sessionUsage: {
		scope: "session",
		inputTokens: 123,
		outputTokens: 45,
		cacheReadTokens: 6,
		cacheWriteTokens: 7,
		cost: 0.123,
	},
};

describe("child-only status projection", () => {
	it("does not ask even an old provider to resolve relative child cwd against Main", async () => {
		const key = Symbol.for("@quandev104/pi-style:detached-editor");
		const globals = globalThis as Record<symbol, unknown>;
		const previous = globals[key];
		const readGit = vi.fn();
		globals[key] = { readGit };
		try {
			for (const cwd of ["", ".", "child/worktree"]) expect(await readAgentGit(cwd)).toBeUndefined();
			expect(readGit).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) delete globals[key];
			else globals[key] = previous;
		}
	});
	it("uses native session totals and display model, never run billing", () => {
		expect(agentStatusSnapshot(view, focus)).toMatchObject({
			model: "Child Alpha",
			provider: "child-provider",
			reasoning: true,
			usage: { inputTokens: 123, cost: 0.123 },
		});
		for (const unavailable of [undefined, { ...focus, closed: true }, { ...focus, currentRunId: "B" }]) {
			expect(agentStatusSnapshot(view, unavailable).usage).toBeUndefined();
			expect(agentStatusSnapshot(view, unavailable).git).toBeUndefined();
		}
		expect(agentStatusSnapshot(view, { ...focus, sessionUsage: undefined }).usage).toBeUndefined();
		const sessionUsage = {
			scope: "session" as const,
			inputTokens: 1,
			outputTokens: 2,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		};
		expect(agentStatusSnapshot(view, { ...focus, sessionUsage }).usage?.cost).toBeUndefined();
		expect(agentStatusSnapshot(view, { ...focus, sessionUsage: { ...sessionUsage, cost: 0 } }).usage?.cost).toBe(0);
	});
});

describe.skipIf(!existsSync(providerFile))("actual optional pi-style footer", () => {
	it("uses configured model_effort, Git and native cost with cached separate worktrees and pure rendering", async () => {
		const { registerDetachedEditor, DETACHED_EDITOR_KEY } = await import(providerFile.href);
		const { DEFAULT_CONFIG } = await import(configFile.href);
		const runner = {
			run: vi.fn(async (_args: unknown, cwd: string) => ({
				code: 0,
				stderr: "",
				stdout: `## ${cwd.endsWith("A") ? "branch-A" : "branch-B"}\n M dirty\n?? new\n`,
			})),
		};
		const installation = registerDetachedEditor(
			() => ({
				...DEFAULT_CONFIG,
				statusLine: {
					...DEFAULT_CONFIG.statusLine,
					layout: { left: ["model_effort", "git", "token_in", "cost"], right: [], secondary: [] },
				},
			}),
			{ gitRunner: runner },
		);
		const registry = (globalThis as Record<symbol, { readGit(cwd: string): Promise<AgentGitSnapshot | undefined> }>)[
			DETACHED_EDITOR_KEY
		];
		if (!registry) throw new Error("Missing provider");
		try {
			for (const name of ["A", "B"]) {
				const git = await registry.readGit(`/worktree/${name}`);
				const selected = { ...focus, modelName: `Child ${name}`, cwd: `/worktree/${name}`, git };
				const line = stripTerminalSequences(renderAgentStatus(renderTheme(), 200, view, selected)?.join("\n") ?? "");
				expect(line).toContain(`(child-provider) Child ${name}`);
				expect(line).toContain("high");
				expect(line).toContain(`branch-${name} *1 ?1`);
				expect(line).toContain("in:123");
				expect(line).toContain("$0.123");
			}
			await registry.readGit("/worktree/A");
			expect(runner.run).toHaveBeenCalledTimes(2);
			for (let i = 0; i < 5; i++) renderAgentStatus(renderTheme(), 80, view, focus);
			expect(runner.run).toHaveBeenCalledTimes(2);
			const missing = stripTerminalSequences(
				renderAgentStatus(renderTheme(), 200, view, { ...focus, sessionUsage: undefined })?.join("\n") ?? "",
			);
			expect(missing).not.toContain("in:");
			expect(missing).not.toContain("$");
		} finally {
			installation.dispose();
		}
		expect(await registry.readGit("/worktree/A")).toBeUndefined();
	});
});
