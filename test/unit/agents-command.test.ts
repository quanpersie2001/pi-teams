import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { AgentManager } from "../../extension-src/pi-teams/app/agent-manager.js";
import { registerAgentsCommand } from "../../extension-src/pi-teams/pi/commands.js";

interface CapturedNotification {
	message: string;
	type: "info" | "warning" | "error" | undefined;
}

/** Minimal command-context stub: captures notifications. */
function commandContext(): { ctx: ExtensionCommandContext; notifications: CapturedNotification[] } {
	const notifications: CapturedNotification[] = [];
	const ctx = {
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => {
				notifications.push({ message, type });
			},
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifications };
}

interface ReleaseCall {
	agentId: string;
	cleanupWorktree: boolean | undefined;
}
interface TeammateCall {
	action: "release" | "retire";
	name: string;
}

/** Stub manager: records release calls and reports a fixed resolution. */
function stubManager(released = true): AgentManager & { calls: ReleaseCall[]; teammateCalls: TeammateCall[] } {
	const calls: ReleaseCall[] = [];
	const teammateCalls: TeammateCall[] = [];
	const manager = {
		calls,
		teammateCalls,
		async release(agentId: string, options: { cleanupWorktree?: boolean } = {}): Promise<boolean> {
			calls.push({ agentId, cleanupWorktree: options.cleanupWorktree });
			return released;
		},
		teammateStatus(name: string) {
			if (name !== "worker") return undefined;
			const action = [...teammateCalls].reverse().find((call) => call.name === name)?.action;
			return {
				name,
				type: "explore",
				state:
					action === "retire" ? ("retired" as const) : action === "release" ? ("released" as const) : ("idle" as const),
				availability: "available" as const,
				contextAvailable: false,
				lastRunId: "run-1",
			};
		},
		async releaseTeammate(name: string) {
			teammateCalls.push({ action: "release", name });
			return released;
		},
		async retireTeammate(name: string) {
			teammateCalls.push({ action: "retire", name });
			return released;
		},
	};
	return manager as unknown as AgentManager & { calls: ReleaseCall[]; teammateCalls: TeammateCall[] };
}

/** Capture the registered command handler from a fake ExtensionAPI. */
function captureCommand(): {
	pi: Pick<ExtensionAPI, "registerCommand">;
	registeredName: () => string | undefined;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
} {
	let registeredName: string | undefined;
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const pi = {
		registerCommand: (name: string, options: { handler: typeof handler }) => {
			registeredName = name;
			handler = options.handler;
		},
	} as unknown as Pick<ExtensionAPI, "registerCommand">;
	return {
		pi,
		registeredName: () => registeredName,
		handler: (args: string, ctx: ExtensionCommandContext) => {
			if (!handler) throw new Error("command was not registered");
			return handler(args, ctx);
		},
	};
}

function setup(released = true): {
	manager: AgentManager & { calls: ReleaseCall[]; teammateCalls: TeammateCall[] };
	openHub: () => number;
	hubCalls: () => number;
	panelCalls: Array<boolean | "toggle">;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	registeredName: () => string | undefined;
} {
	const { pi, handler, registeredName } = captureCommand();
	const manager = stubManager(released);
	let hubCalls = 0;
	const panelCalls: Array<boolean | "toggle"> = [];
	const openHub = () => {
		hubCalls += 1;
		return hubCalls;
	};
	registerAgentsCommand(pi as ExtensionAPI, {
		manager,
		openHub,
		setInlineAgentsVisible: (visible) => panelCalls.push(visible),
	});
	return { manager, openHub, hubCalls: () => hubCalls, panelCalls, handler, registeredName };
}

describe("/agents command", () => {
	it("registers under its own name", () => {
		const { registeredName } = setup();
		expect(registeredName()).toBe("agents");
	});

	it("delegates panel show, hide, and toggle as their intended values", async () => {
		const { handler, panelCalls, hubCalls } = setup();
		const { ctx, notifications } = commandContext();
		for (const [args, expected] of [
			["panel show", true],
			["panel hide", false],
			["panel toggle", "toggle"],
			["panel", "toggle"],
		] as const) {
			await handler(args, ctx);
			expect(panelCalls.at(-1)).toBe(expected);
		}
		expect(panelCalls).toEqual([true, false, "toggle", "toggle"]);
		expect(hubCalls()).toBe(0);
		expect(notifications).toHaveLength(4);
	});

	it("opens the hub without notifying when called without arguments", async () => {
		const { handler, hubCalls } = setup();
		const { ctx, notifications } = commandContext();
		await handler("", ctx);
		expect(hubCalls()).toBe(1);
		expect(notifications).toHaveLength(0);
	});

	it("opens the hub for whitespace-only arguments too", async () => {
		const { handler, hubCalls } = setup();
		const { ctx, notifications } = commandContext();
		await handler("   ", ctx);
		expect(hubCalls()).toBe(1);
		expect(notifications).toHaveLength(0);
	});

	it("releases a child while retaining its worktree checkout", async () => {
		const { handler, manager } = setup(true);
		const { ctx, notifications } = commandContext();
		await handler("release child-1", ctx);
		expect(manager.calls).toEqual([{ agentId: "child-1", cleanupWorktree: false }]);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.type).toBe("info");
		expect(notifications[0]?.message).toBe("Released child. Worktree checkout retained for review.");
	});

	it("releases a child and its worktree checkout with --worktree", async () => {
		const { handler, manager } = setup(true);
		const { ctx, notifications } = commandContext();
		await handler("release child-1 --worktree", ctx);
		expect(manager.calls).toEqual([{ agentId: "child-1", cleanupWorktree: true }]);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.type).toBe("info");
		expect(notifications[0]?.message).toBe("Released child and worktree checkout. Preserved commit branch retained.");
	});

	it("reports an unknown child as an error instead of pretending success", async () => {
		const { handler, manager } = setup(false);
		const { ctx, notifications } = commandContext();
		await handler("release ghost", ctx);
		expect(manager.calls).toEqual([{ agentId: "ghost", cleanupWorktree: false }]);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.type).toBe("error");
		expect(notifications[0]?.message).toBe("Unknown subagent: ghost");
	});

	it("rejects malformed release arguments with usage guidance and no release attempt", async () => {
		for (const bad of ["release", "release a b c", "release child-1 --bad"]) {
			const { handler, manager } = setup();
			const { ctx, notifications } = commandContext();
			await handler(bad, ctx);
			expect(manager.calls, bad).toHaveLength(0);
			expect(notifications, bad).toHaveLength(1);
			expect(notifications[0]?.type, bad).toBe("error");
			expect(notifications[0]?.message, bad).toContain("Usage: /agents release <id> [--worktree]");
		}
	});

	it("supports teammate status, settled release and retirement without changing run cleanup semantics", async () => {
		const { handler, manager } = setup();
		const { ctx, notifications } = commandContext();
		await handler("teammate-status worker", ctx);
		expect(notifications.at(-1)?.message).toContain("@worker: idle; available");
		await handler("teammate-release worker", ctx);
		expect(notifications.at(-1)?.message).toContain("is now released");
		expect(notifications.at(-1)?.message).toContain("Task-board claims are unchanged");
		await handler("teammate-retire worker", ctx);
		expect(notifications.at(-1)?.message).toContain("is now retired");
		expect(manager.teammateCalls).toEqual([
			{ action: "release", name: "worker" },
			{ action: "retire", name: "worker" },
		]);
	});

	it("rejects malformed teammate lifecycle command arguments", async () => {
		const { handler, manager } = setup();
		const { ctx, notifications } = commandContext();
		await handler("teammate-release worker extra", ctx);
		expect(manager.teammateCalls).toEqual([]);
		expect(notifications[0]?.message).toBe("Usage: /agents teammate-release <teammate-name>");
	});

	it("rejects unknown non-empty arguments without opening the hub", async () => {
		const { handler, hubCalls, panelCalls } = setup();
		for (const bad of ["resume", "list all", "--help", "panel nope", "panel show extra"]) {
			const { ctx, notifications } = commandContext();
			await handler(bad, ctx);
			expect(hubCalls(), bad).toBe(0);
			expect(notifications, bad).toHaveLength(1);
			expect(notifications[0]?.type, bad).toBe("error");
			expect(notifications[0]?.message, bad).toContain(
				bad.startsWith("panel")
					? "Usage: /agents panel [show|hide|toggle]"
					: "Usage: /agents [panel [show|hide|toggle]",
			);
		}
		expect(panelCalls).toEqual([]);
	});
});
