// Integration tests: pi/tools.ts registration + execute paths through the
// real composition root (createPiSubagentsApp), driven by FakePiHost and a
// deterministic FakeBackend. No real model calls.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiSubagentsApp } from "../../extension-src/pi-teams/app/index.js";
import { sanitizeSettings } from "../../extension-src/pi-teams/domain/config.js";
import { createPiDeliveryHost } from "../../extension-src/pi-teams/pi/delivery-host.js";
import { registerSubagentTools } from "../../extension-src/pi-teams/pi/tools.js";
import { FakeBackend } from "../helpers/fake-backend.js";
import { FakePiHost } from "../helpers/fake-pi-host.js";

interface ToolLike {
	name: string;
	parameters?: { properties?: Record<string, { description?: string }> };
	promptSnippet?: string;
	renderCall?: (args: Record<string, unknown>) => { render: (width: number) => string[] };
	prepareLoadout?: () => { descriptions?: Record<string, string> } | undefined;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{
		content: Array<{ type: string; text?: string }>;
		details: Record<string, unknown>;
		terminate?: boolean;
	}>;
}

interface Fixture {
	host: FakePiHost;
	backend: FakeBackend;
	tools: Map<string, ToolLike>;
	app: ReturnType<typeof createPiSubagentsApp>;
}

async function makeFixture(
	settingsOverrides: Record<string, unknown> = {},
	loader: (
		sources: string[],
	) => Promise<Array<{ sourcePath: string; frontmatter: Record<string, unknown>; body: string }>> = async () => [],
	now?: () => number,
	options: { mode?: "tui" | "rpc" | "json" | "print"; delivery?: boolean } = {},
): Promise<Fixture> {
	const host = new FakePiHost({ mode: options.mode ?? "tui" });
	const backend = new FakeBackend();
	let nextId = 0;
	const app = createPiSubagentsApp({
		sources: [],
		loader,
		settings: sanitizeSettings({ backgroundByDefault: false, ...settingsOverrides }),
		backends: [backend],
		cwd: "/tmp/project",
		configCwd: "/tmp/project",
		...(options.delivery
			? {
					deliveryHost: createPiDeliveryHost(host.extensionApi, () => host.extensionContext),
					deliveryOptions: { holdMs: 0 },
				}
			: {}),
		managerOverrides: {
			idFactory: () => {
				nextId += 1;
				return `run-${nextId}`;
			},
			...(now !== undefined ? { now } : {}),
		},
	});
	// Load agent definitions (bundled defaults) so spawns can resolve types.
	await app.sessionStart();
	const registrations = registerSubagentTools(host.extensionApi, app.manager, app.registry, app.delivery);
	expect(registrations.map((entry) => entry.skipped ?? false)).toEqual([false, false, false]);
	const tools = new Map<string, ToolLike>();
	for (const tool of host.registeredTools as ToolLike[]) tools.set(tool.name, tool);
	return { host, backend, tools, app };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}

const NO_SIGNAL = undefined;
const NAMED = { name: "worker", color: "#47a3e8" };

describe("tool registration", () => {
	it("declares the live enabled catalog with canonical names and effective descriptions", async () => {
		let files: Array<{ sourcePath: string; frontmatter: Record<string, unknown>; body: string }> = [];
		const fixture = await makeFixture({}, async () => files);
		const agent = fixture.tools.get("Agent");

		files = [
			{
				sourcePath: "/project/general-purpose.md",
				frontmatter: { name: "general-purpose", description: "Project-selected specialist" },
				body: "Project instructions",
			},
			{
				sourcePath: "/project/hidden-specialist.md",
				frontmatter: { name: "hidden-specialist", description: "Must not be exposed", enabled: false },
				body: "Hidden instructions",
			},
		];
		await fixture.app.registry.reload();
		const catalog = agent?.prepareLoadout?.()?.descriptions?.Agent ?? "";
		expect(catalog).toContain("general-purpose");
		expect(catalog).toContain("Project-selected specialist");
		expect(catalog).not.toContain("hidden-specialist");
		expect(catalog).toContain(
			"Every NEW spawn MUST include all four required fields — subagent_type, description, name, and color",
		);
		expect(catalog).toContain("When the user asks to spawn subagents/teammates");
		expect(agent?.promptSnippet).toContain("Spawn named, colored subagents");
	});

	it("skips registration when another party already claimed a name (collision gate)", async () => {
		const host = new FakePiHost({ mode: "rpc" });
		const backend = new FakeBackend();
		const app = createPiSubagentsApp({
			sources: [],
			loader: async () => [],
			settings: sanitizeSettings({}),
			backends: [backend],
			cwd: "/tmp/project",
			configCwd: "/tmp/project",
		});
		// Simulate a pre-existing "Agent" tool already visible in the runtime.
		(host.allTools as Array<{ name: string }>).push({ name: "Agent" });
		await app.sessionStart(); // registry load not needed here, but mirrors real wiring
		const registrations = registerSubagentTools(host.extensionApi, app.manager, app.registry);
		expect(registrations).toEqual([
			{ name: "Agent", skipped: true },
			{ name: "get_subagent_result" },
			{ name: "steer_subagent" },
		]);
		const registeredNames = (host.registeredTools as ToolLike[]).map((tool) => tool.name);
		expect(registeredNames).toEqual(["get_subagent_result", "steer_subagent"]);
	});
});

describe("Agent tool", () => {
	it("explains the fields required for a new spawn without allocating a run", async () => {
		const fixture = await makeFixture();
		const agent = fixture.tools.get("Agent");
		if (!agent) throw new Error("Agent tool not registered");
		const result = await agent.execute(
			"missing-role",
			{ prompt: "work", name: "worker", color: "#47a3e8" },
			NO_SIGNAL,
			undefined,
			fixture.host.extensionContext,
		);
		expect(textOf(result)).toContain("requires subagent_type and description");
		expect(result.terminate).toBeUndefined();
		expect(fixture.app.manager.list()).toHaveLength(0);
	});

	it("refuses anonymous or colorless new spawns before model admission", async () => {
		const fixture = await makeFixture();
		const agent = fixture.tools.get("Agent");
		if (!agent) throw new Error("Agent tool is not registered");
		for (const identity of [{}, { name: "worker" }, { color: "#47a3e8" }]) {
			const result = await agent.execute(
				"missing-identity",
				{ prompt: "work", description: "work", subagent_type: "general-purpose", ...identity },
				NO_SIGNAL,
				undefined,
				fixture.host.extensionContext,
			);
			expect(textOf(result)).toContain("requires both name and color");
		}
		expect(fixture.backend.admissions).toHaveLength(0);
		expect(fixture.app.manager.list()).toHaveLength(0);
	});

	it("renders the teammate's name and color in the launch call", async () => {
		const fixture = await makeFixture();
		const call = fixture.tools.get("Agent")?.renderCall?.({
			...NAMED,
			subagent_type: "explore",
			description: "Map modules",
		});
		expect(call?.render(100).join("\n")).toContain("@worker");
		expect(call?.render(100).join("\n")).toContain("38;2;71;163;232m");
	});

	it("withholds the started acknowledgement and run allocation until model admission resolves", async () => {
		const fixture = await makeFixture();
		const gate = Promise.withResolvers<void>();
		fixture.backend.admissionGate = gate.promise;
		fixture.backend.admissionResult = { model: "fake/fallback", fallback: "Pinned model has no credentials" };
		let acknowledged = false;
		const agentTool = fixture.tools.get("Agent");
		if (!agentTool) throw new Error("Agent tool is not registered");
		const pending = agentTool
			.execute(
				"pending-admission",
				{ prompt: "work", description: "work", subagent_type: "general-purpose", ...NAMED, run_in_background: true },
				NO_SIGNAL,
				undefined,
				fixture.host.extensionContext,
			)
			.then((result) => {
				acknowledged = true;
				return result;
			});
		for (let turn = 0; turn < 32; turn += 1) await Promise.resolve();
		expect(fixture.backend.admissions).toHaveLength(1);
		expect(acknowledged).toBe(false);
		expect(fixture.app.manager.list()).toEqual([]);
		expect(fixture.backend.launches).toEqual([]);
		gate.resolve();
		const result = await pending;
		expect(textOf(result)).toBe("{agent:run-1 started as @worker}");
		expect(result.details).toMatchObject({
			agentId: "run-1",
			model: "fake/fallback",
			modelFallback: "Pinned model has no credentials",
		});
	});

	it("pure interactive background launches terminate the coordinator batch, not the children", async () => {
		const fixture = await makeFixture({}, async () => [], undefined, { delivery: true });
		const agent = fixture.tools.get("Agent");
		if (!agent) throw new Error("Agent tool not registered");
		const launch = (name: string, color: string) =>
			agent.execute(
				`launch-${name}`,
				{
					prompt: "work",
					description: "review",
					subagent_type: "general-purpose",
					name,
					color,
					run_in_background: true,
				},
				NO_SIGNAL,
				undefined,
				fixture.host.extensionContext,
			);
		const results = await Promise.all([launch("one", "#47a3e8"), launch("two", "#e879f9")]);
		expect(results.map((result) => result.terminate)).toEqual([true, true]);
		expect(fixture.app.manager.hasRunning()).toBe(true);
		fixture.app.delivery?.finishSpawnBatch();
		await new Promise<void>((resolve) => {
			const poll = (): void => {
				if (fixture.backend.launches.length === 2) resolve();
				else setTimeout(poll, 5);
			};
			poll();
		});
		for (const launched of fixture.backend.launches)
			fixture.backend.complete(launched.runId, `answer ${launched.runId}`);
		await fixture.app.manager.waitForAll();
		expect(fixture.host.sentMessages).toHaveLength(1);
		expect(String(fixture.host.sentMessages[0]?.message.content)).toContain("@one");
		expect(String(fixture.host.sentMessages[0]?.message.content)).toContain("@two");
	});

	it("returns admission failure without an ID, row or child launch", async () => {
		const fixture = await makeFixture();
		fixture.backend.admissionError = new Error("No authenticated model is available");
		const agentTool = fixture.tools.get("Agent");
		if (!agentTool) throw new Error("Agent tool is not registered");
		const result = await agentTool.execute(
			"rejected-admission",
			{ prompt: "work", description: "work", subagent_type: "general-purpose", ...NAMED, run_in_background: true },
			NO_SIGNAL,
			undefined,
			fixture.host.extensionContext,
		);
		expect(textOf(result)).toBe("No authenticated model is available");
		expect(result.details).not.toHaveProperty("agentId");
		expect(fixture.app.manager.list()).toEqual([]);
		expect(fixture.backend.launches).toEqual([]);
		fixture.backend.admissionError = undefined;
		const admitted = await fixture.app.manager.spawn({
			type: "general-purpose",
			prompt: "valid",
			run_in_background: true,
		});
		expect(admitted.id).toBe("run-1");
	});

	it.each(["rpc", "json", "print"] as const)("forces a background request inline in %s mode", async (mode) => {
		const fixture = await makeFixture({}, async () => [], undefined, { mode, delivery: true });
		const agent = fixture.tools.get("Agent");
		if (!agent) throw new Error("Agent tool not registered");
		const launched = fixture.backend.nextLaunch();
		const pending = agent.execute(
			"headless-call",
			{ prompt: "work", description: "review", subagent_type: "general-purpose", ...NAMED, run_in_background: true },
			NO_SIGNAL,
			undefined,
			fixture.host.extensionContext,
		);
		const run = await launched;
		expect(run.background).toBe(false);
		fixture.backend.complete(run.runId, "inline result");
		const result = await pending;
		expect(textOf(result)).toBe("inline result");
		expect(result.terminate).toBeUndefined();
		expect(fixture.app.manager.get(run.runId)?.resultConsumed).toBe(true);
		expect(fixture.host.sentMessages).toHaveLength(0);
	});

	it("foreground call blocks and returns the agent's output inline", async () => {
		const fixture = await makeFixture();
		const agent = fixture.tools.get("Agent");
		fixture.backend.admissionResult = { model: "fake/fallback", fallback: "Primary unavailable" };
		expect(agent).toBeDefined();

		const pending = agent.execute(
			"call-1",
			{ prompt: "explore the code", description: "exploration", subagent_type: "general-purpose", ...NAMED },
			NO_SIGNAL,
			undefined,
			fixture.host.extensionContext,
		);

		await new Promise<void>((resolve) => {
			const poll = (): void => {
				if (fixture.backend.launches.length > 0) resolve();
				else setTimeout(poll, 5);
			};
			poll();
		});
		const launch = fixture.backend.launches[0];
		fixture.backend.complete(launch.runId, "foreground answer");

		const result = await pending;
		expect(textOf(result)).toBe("foreground answer");
		expect(result.details.agentId).toBe(launch.runId);
		expect(result.details).toMatchObject({ model: "fake/fallback", modelFallback: "Primary unavailable" });
		// Foreground results are consumed inline (suppressing the completion
		// notification); get_subagent_result still re-reads them on demand.
		const reread = textOf(
			await fixture.tools
				.get("get_subagent_result")
				?.execute("call-1b", { agent_id: launch.runId }, NO_SIGNAL, undefined, undefined),
		);
		expect(reread).toContain("foreground answer");
	});

	it("a foreground call cannot terminate the coordinator turn", async () => {
		const fixture = await makeFixture({}, async () => [], undefined, { delivery: true });
		const agent = fixture.tools.get("Agent");
		if (!agent) throw new Error("Agent tool not registered");
		const launched = fixture.backend.nextLaunch();
		const pending = agent.execute(
			"foreground-call",
			{ prompt: "work", description: "review", subagent_type: "general-purpose", ...NAMED, run_in_background: false },
			NO_SIGNAL,
			undefined,
			fixture.host.extensionContext,
		);
		const run = await launched;
		fixture.backend.complete(run.runId, "foreground result");
		const result = await pending;
		expect(textOf(result)).toBe("foreground result");
		expect(result.terminate).toBeUndefined();
	});

	it("background call returns a started handle immediately", async () => {
		const fixture = await makeFixture();
		const agent = fixture.tools.get("Agent");

		const result = await agent.execute(
			"call-2",
			{
				prompt: "long work",
				description: "detached",
				subagent_type: "general-purpose",
				...NAMED,
				run_in_background: true,
			},
			NO_SIGNAL,
			undefined,
			fixture.host.extensionContext,
		);

		expect(textOf(result)).toMatch(/^\{agent:run-\d+ started as @worker\}$/);
		expect(result.details.background).toBe(true);
	});

	it("names a background run as a teammate", async () => {
		const fixture = await makeFixture();
		const agent = fixture.tools.get("Agent");

		const result = await agent.execute(
			"call-2b",
			{
				prompt: "long work",
				description: "detached",
				subagent_type: "general-purpose",
				name: "scout",
				color: "#e879f9",
				run_in_background: true,
			},
			NO_SIGNAL,
			undefined,
			fixture.host.extensionContext,
		);

		expect(textOf(result)).toMatch(/^\{agent:run-\d+ started as @scout\}$/);
		expect(result.details.teammateName).toBe("scout");
		expect(result.details.color).toBe("#e879f9");
		expect(fixture.app.manager.get(String(result.details.agentId))?.teammateName).toBe("scout");
	});

	it("returns a readable error for an unresolvable subagent_type", async () => {
		const fixture = await makeFixture();
		const agent = fixture.tools.get("Agent");
		const result = await agent.execute(
			"call-3",
			{ prompt: "x", description: "x", subagent_type: "no-such-agent", ...NAMED },
			NO_SIGNAL,
			undefined,
			fixture.host.extensionContext,
		);
		expect(textOf(result)).toMatch(/Unknown, disabled, or ambiguous agent type/);
	});
});

describe("cold resume tool", () => {
	it("accepts resume and prompt without new-spawn-only schema fields", async () => {
		const fixture = await makeFixture({}, async () => [], undefined, { delivery: true });
		const firstLaunch = fixture.backend.nextLaunch();
		const original = await fixture.app.manager.spawn({
			type: "general-purpose",
			name: "worker",
			color: "#47a3e8",
			prompt: "first",
			run_in_background: true,
		});
		await firstLaunch;
		fixture.backend.complete(original.id, "first result", "/tmp/sessions/first.jsonl");
		await fixture.app.manager.whenSettled(original.id);
		const agent = fixture.tools.get("Agent");
		if (!agent) throw new Error("Agent tool not registered");
		expect(agent.parameters).toMatchObject({ required: ["prompt"] });
		const result = await agent.execute(
			"resume",
			{ resume: original.id, prompt: "continue", run_in_background: true },
			NO_SIGNAL,
			undefined,
			fixture.host.extensionContext,
		);
		expect(textOf(result)).toContain(`resumed from ${original.id}`);
		expect(result.terminate).toBe(true);
		expect(fixture.backend.resumes).toHaveLength(1);
	});

	it("waits for a cold resume inline when there is no interactive parent turn", async () => {
		const fixture = await makeFixture({}, async () => [], undefined, { mode: "rpc", delivery: true });
		const firstLaunch = fixture.backend.nextLaunch();
		const original = await fixture.app.manager.spawn({
			type: "general-purpose",
			prompt: "first",
			run_in_background: false,
		});
		await firstLaunch;
		fixture.backend.complete(original.id, "first result", "/tmp/sessions/first.jsonl");
		await fixture.app.manager.whenSettled(original.id);
		const previousNotifications = fixture.host.sentMessages.length;
		const agent = fixture.tools.get("Agent");
		if (!agent) throw new Error("Agent tool not registered");
		const nextLaunch = fixture.backend.nextLaunch();
		const pending = agent.execute(
			"resume",
			{ resume: original.id, prompt: "continue", run_in_background: true },
			NO_SIGNAL,
			undefined,
			fixture.host.extensionContext,
		);
		const resumed = await nextLaunch;
		expect(resumed.background).toBe(false);
		fixture.backend.complete(resumed.runId, "continued inline");
		const result = await pending;
		expect(textOf(result)).toBe("continued inline");
		expect(result.terminate).toBeUndefined();
		expect(fixture.host.sentMessages).toHaveLength(previousNotifications);
	});
});

describe("get_subagent_result tool", () => {
	it("waits for completion and re-reads the result on every call", async () => {
		const fixture = await makeFixture();
		const launched = fixture.backend.nextLaunch();
		const record = await fixture.app.manager.spawn({
			type: "general-purpose",
			prompt: "work",
			run_in_background: true,
		});

		const getResult = fixture.tools.get("get_subagent_result");
		const pending = getResult.execute("call-4", { agent_id: record.id, wait: true }, NO_SIGNAL, undefined, undefined);
		await launched;
		fixture.backend.complete(record.id, "the full result");
		const first = textOf(await pending);
		expect(first).toContain("the full result");

		const second = textOf(await getResult.execute("call-5", { agent_id: record.id }, NO_SIGNAL, undefined, undefined));
		expect(second).toContain("the full result");
		expect(fixture.app.manager.get(record.id)?.resultConsumed).toBe(true);
	});

	it("reports still-running state without consuming", async () => {
		const fixture = await makeFixture();
		const record = await fixture.app.manager.spawn({
			type: "general-purpose",
			prompt: "work",
			run_in_background: true,
		});
		const getResult = fixture.tools.get("get_subagent_result");
		const output = textOf(await getResult.execute("call-6", { agent_id: record.id }, NO_SIGNAL, undefined, undefined));
		expect(output).toMatch(/still (queued|running|starting)/);
		expect(fixture.app.manager.get(record.id)?.resultConsumed).toBeFalsy();
	});
});

describe("steer_subagent tool", () => {
	it("delivers a steering message to a live run and rejects dead ids", async () => {
		const fixture = await makeFixture();
		const record = await fixture.app.manager.spawn({
			type: "general-purpose",
			prompt: "work",
			run_in_background: true,
		});
		await new Promise<void>((resolve) => {
			const poll = (): void => {
				if (fixture.backend.launches.length > 0) resolve();
				else setTimeout(poll, 5);
			};
			poll();
		});

		const steer = fixture.tools.get("steer_subagent");
		await steer.execute("call-7", { agent_id: record.id, message: "focus on auth" }, NO_SIGNAL, undefined, undefined);
		expect(fixture.backend.steers.some((entry) => entry.message === "focus on auth")).toBe(true);

		const bad = textOf(
			await steer.execute("call-8", { agent_id: "ghost", message: "hi" }, NO_SIGNAL, undefined, undefined),
		);
		expect(bad).toMatch(/cannot be steered/);
	});
});

describe("Agent tool time budgets", () => {
	let clock: number;

	beforeEach(() => {
		vi.useFakeTimers();
		clock = 2_000_000;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function makeTimedFixture(settingsOverrides: Record<string, unknown> = {}) {
		return makeFixture(
			settingsOverrides,
			async () => [],
			() => clock,
		);
	}

	/** Moves the injected clock and the fake timer queue in lockstep, like a real clock. */
	async function advance(ms: number): Promise<void> {
		clock += ms;
		await vi.advanceTimersByTimeAsync(ms);
	}

	it("rejects malformed budget parameters without allocating a run", async () => {
		const fixture = await makeTimedFixture();
		const agent = fixture.tools.get("Agent");
		if (!agent) throw new Error("Agent tool is not registered");
		const result = await agent.execute(
			"bad-budget",
			{ prompt: "work", description: "work", subagent_type: "general-purpose", ...NAMED, timeout: 0 },
			NO_SIGNAL,
			undefined,
			fixture.host.extensionContext,
		);
		expect(textOf(result)).toMatch(/invalid timeout/);
		const idleResult = await agent.execute(
			"bad-idle",
			{ prompt: "work", description: "work", subagent_type: "general-purpose", ...NAMED, idle_timeout: 2.5 },
			NO_SIGNAL,
			undefined,
			fixture.host.extensionContext,
		);
		expect(textOf(idleResult)).toMatch(/invalid idleTimeout override/);
		expect(fixture.backend.launches).toEqual([]);
		expect(fixture.app.manager.list()).toEqual([]);
	});

	it("foreground call returns partial output plus the exact budget stop", async () => {
		const fixture = await makeTimedFixture();
		const agent = fixture.tools.get("Agent");
		if (!agent) throw new Error("Agent tool is not registered");

		const pending = agent.execute(
			"budgeted-foreground",
			{ prompt: "long work", description: "budgeted", subagent_type: "general-purpose", ...NAMED, timeout: 1 },
			NO_SIGNAL,
			undefined,
			fixture.host.extensionContext,
		);
		for (let turn = 0; turn < 32; turn += 1) await Promise.resolve();
		const runId = fixture.backend.launches[0]?.runId;
		expect(runId).toBe("run-1");

		await advance(1_100);
		// The stop settles with its persisted session: the resume below requires it.
		fixture.backend.setStatus(runId, { state: "stopped", sessionFile: "/tmp/sessions/foreground.jsonl" });
		const result = await pending;
		const text = textOf(result);
		expect(text).toMatch(/Stopped by timeout budget after 1s/);
		expect(text).toMatch(/partial work may be incomplete/);
		expect(text).toMatch(new RegExp(`Resume with Agent\\(resume: "${runId}"\\)`));
		expect(result.details).toMatchObject({ agentId: runId, budgetExhausted: "timeout", budgetSeconds: 1 });

		// Resume through the tool replays the frozen limit with fresh clocks.
		const resumed = await fixture.app.manager.resume(runId, "continue");
		for (let turn = 0; turn < 32; turn += 1) await Promise.resolve();
		expect(resumed.budgetTimeout).toBe(1);
		// Clocks live on the launched run, not on the pre-start clone.
		expect(fixture.app.manager.get(resumed.id)?.budgetStartedAt).toBe(clock);
	});

	it("background run emits the exhausted budget on the stop event", async () => {
		const fixture = await makeTimedFixture();
		const agent = fixture.tools.get("Agent");
		if (!agent) throw new Error("Agent tool is not registered");
		const events: Array<{ event: string; budgetExhausted?: string; budgetSeconds?: number }> = [];
		fixture.app.subscribe((event) => {
			events.push({ event: event.event, budgetExhausted: event.budgetExhausted, budgetSeconds: event.budgetSeconds });
		});

		const result = await agent.execute(
			"budgeted-background",
			{
				prompt: "long work",
				description: "detached",
				subagent_type: "general-purpose",
				...NAMED,
				run_in_background: true,
				idle_timeout: 1,
			},
			NO_SIGNAL,
			undefined,
			fixture.host.extensionContext,
		);
		expect(textOf(result)).toMatch(/^\{agent:run-\d+ started as @worker\}$/);

		await advance(1_100);
		fixture.backend.settleStopped("run-1");
		await fixture.app.manager.whenSettled("run-1");

		const stopped = events.find((event) => event.event === "stopped");
		expect(stopped).toMatchObject({ budgetExhausted: "idle_timeout", budgetSeconds: 1 });
		expect(await fixture.app.manager.getResult("run-1")).toMatch(/Stopped by idle_timeout budget after 1s/);
	});
});

describe("composition root lifecycle", () => {
	it("session_start loads definitions; lifecycle events stream to subscribers; shutdown disposes", async () => {
		const fixture = await makeFixture();
		const events: Array<{ event: string; agentId: string }> = [];
		fixture.app.subscribe((event) => events.push({ event: event.event, agentId: event.agentId }));

		expect(fixture.app.registry.availableTypes).toContain("general-purpose");

		const record = await fixture.app.manager.spawn({ type: "explore", prompt: "w", run_in_background: true });
		await new Promise<void>((resolve) => {
			const poll = (): void => {
				if (fixture.backend.launches.length > 0) resolve();
				else setTimeout(poll, 5);
			};
			poll();
		});
		fixture.backend.complete(record.id, "done");
		await fixture.app.manager.whenSettled(record.id);
		expect(events.map((event) => event.event)).toContain("started");
		expect(events.filter((event) => event.event === "completed")).toHaveLength(1);

		await fixture.host.sessionShutdown();
		expect(fixture.app.manager.hasRunning()).toBe(false);
	});
});
