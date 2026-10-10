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

/** Stub manager: records release calls and reports a fixed resolution. */
function stubManager(released = true): AgentManager & { calls: ReleaseCall[] } {
	const calls: ReleaseCall[] = [];
	const manager = {
		calls,
		async release(agentId: string, options: { cleanupWorktree?: boolean } = {}): Promise<boolean> {
			calls.push({ agentId, cleanupWorktree: options.cleanupWorktree });
			return released;
		},
	};
	return manager as unknown as AgentManager & { calls: ReleaseCall[] };
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
	manager: AgentManager & { calls: ReleaseCall[] };
	openHub: () => number;
	hubCalls: () => number;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	registeredName: () => string | undefined;
} {
	const { pi, handler, registeredName } = captureCommand();
	const manager = stubManager(released);
	let hubCalls = 0;
	const openHub = () => {
		hubCalls += 1;
		return hubCalls;
	};
	registerAgentsCommand(pi as ExtensionAPI, { manager, openHub });
	return { manager, openHub, hubCalls: () => hubCalls, handler, registeredName };
}

describe("/agents command", () => {
	it("registers under its own name", () => {
		const { registeredName } = setup();
		expect(registeredName()).toBe("agents");
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

	it("rejects unknown non-empty arguments without opening the hub", async () => {
		const { handler, hubCalls } = setup();
		for (const bad of ["resume", "list all", "--help"]) {
			const { ctx, notifications } = commandContext();
			await handler(bad, ctx);
			expect(hubCalls(), bad).toBe(0);
			expect(notifications, bad).toHaveLength(1);
			expect(notifications[0]?.type, bad).toBe("error");
			expect(notifications[0]?.message, bad).toBe("Usage: /agents [release <id> [--worktree]]");
		}
	});
});
