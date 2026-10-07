import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { BackendSelector } from "../../extension-src/pi-subagents/domain/config.js";
import type { ProcessLauncher } from "../../extension-src/pi-subagents/domain/process-launcher.js";
import { type BackendModePort, registerBackendCommand } from "../../extension-src/pi-subagents/pi/commands.js";
import {
	ProcessAgentExecutionBackend,
	resolveSessionLauncherHint,
} from "../../extension-src/pi-subagents/pi/process-backend.js";

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

/** Stub backend port: records hint changes and reports a fixed detected kind. */
function stubBackend(initial: BackendSelector, detectedKind = "tmux"): BackendModePort & { hint: BackendSelector } {
	const port = {
		hint: initial,
		getLauncherHint(): BackendSelector {
			return port.hint;
		},
		setLauncherHint(hint: BackendSelector): void {
			port.hint = hint;
		},
		async detectLauncherKind(): Promise<string> {
			if (detectedKind === "throw") throw new Error("no launcher");
			return detectedKind;
		},
	};
	return port;
}

/** Capture the registered command handler from a fake ExtensionAPI. */
function captureCommand(): {
	pi: Pick<ExtensionAPI, "registerCommand">;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
} {
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const pi = {
		registerCommand: (name: string, options: { handler: typeof handler }) => {
			if (name === "sub-agents-backend") handler = options.handler;
		},
	} as unknown as Pick<ExtensionAPI, "registerCommand">;
	return {
		pi,
		handler: (args: string, ctx: ExtensionCommandContext) => {
			if (!handler) throw new Error("command was not registered");
			return handler(args, ctx);
		},
	};
}

describe("/sub-agents-backend command", () => {
	it("registers under its own name", () => {
		const { pi } = captureCommand();
		registerBackendCommand(pi as ExtensionAPI, { backend: stubBackend("auto") });
	});

	it("reports the current mode and auto-detection without arguments", async () => {
		const { pi, handler } = captureCommand();
		const backend = stubBackend("auto", "tmux");
		registerBackendCommand(pi as ExtensionAPI, { backend });
		const { ctx, notifications } = commandContext();
		await handler("", ctx);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.type).toBe("info");
		expect(notifications[0]?.message).toContain("auto");
		expect(notifications[0]?.message).toContain("tmux");
	});

	it("reports forced mode without a detection claim", async () => {
		const { pi, handler } = captureCommand();
		const backend = stubBackend("headless", "tmux");
		registerBackendCommand(pi as ExtensionAPI, { backend });
		const { ctx, notifications } = commandContext();
		await handler("", ctx);
		expect(notifications[0]?.message).toContain("headless");
		expect(notifications[0]?.message).not.toContain("detects:");
	});

	it("switches to headless and auto for new runs", async () => {
		const { pi, handler } = captureCommand();
		const backend = stubBackend("auto");
		registerBackendCommand(pi as ExtensionAPI, { backend });

		await handler("headless", commandContext().ctx);
		expect(backend.hint).toBe("headless");

		await handler("AUTO", commandContext().ctx);
		expect(backend.hint).toBe("auto");
	});

	it("rejects herdr/tmux and unknown arguments with usage guidance", async () => {
		const { pi, handler } = captureCommand();
		const backend = stubBackend("auto");
		registerBackendCommand(pi as ExtensionAPI, { backend });
		for (const bad of ["herdr", "tmux", "multiplexer"]) {
			const { ctx, notifications } = commandContext();
			await handler(bad, ctx);
			expect(backend.hint).toBe("auto");
			expect(notifications[0]?.type).toBe("error");
			expect(notifications[0]?.message).toContain("Usage: /sub-agents-backend [auto|headless]");
		}
	});

	it("surfaces detection failure as unavailable instead of throwing", async () => {
		const { pi, handler } = captureCommand();
		registerBackendCommand(pi as ExtensionAPI, { backend: stubBackend("auto", "throw") });
		const { ctx, notifications } = commandContext();
		await handler("", ctx);
		expect(notifications[0]?.message).toContain("unavailable");
	});

	it("notes an active env override in status output", async () => {
		const previous = process.env.PI_SUBAGENTS_BACKEND;
		process.env.PI_SUBAGENTS_BACKEND = "headless";
		try {
			const { pi, handler } = captureCommand();
			registerBackendCommand(pi as ExtensionAPI, { backend: stubBackend("headless") });
			const { ctx, notifications } = commandContext();
			await handler("", ctx);
			expect(notifications[0]?.message).toContain("PI_SUBAGENTS_BACKEND=headless");
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENTS_BACKEND;
			else process.env.PI_SUBAGENTS_BACKEND = previous;
		}
	});
});

describe("resolveSessionLauncherHint", () => {
	it("uses the settings mode when the env var is unset", () => {
		expect(resolveSessionLauncherHint({}, "auto")).toBe("auto");
		expect(resolveSessionLauncherHint({}, "headless")).toBe("headless");
		expect(resolveSessionLauncherHint({ PI_SUBAGENTS_BACKEND: "  " }, "headless")).toBe("headless");
	});

	it("lets the env var override settings, including forced launchers", () => {
		expect(resolveSessionLauncherHint({ PI_SUBAGENTS_BACKEND: "headless" }, "auto")).toBe("headless");
		expect(resolveSessionLauncherHint({ PI_SUBAGENTS_BACKEND: "tmux" }, "headless")).toBe("tmux");
		expect(resolveSessionLauncherHint({ PI_SUBAGENTS_BACKEND: " herdr " }, "auto")).toBe("herdr");
	});

	it("rejects invalid env values instead of guessing", () => {
		expect(() => resolveSessionLauncherHint({ PI_SUBAGENTS_BACKEND: "vscode" }, "auto")).toThrow(
			/Unsupported PI_SUBAGENTS_BACKEND/,
		);
	});
});

/** Launcher stub satisfying the port; only `available` matters for detection. */
function fakeLauncher(kind: string, available: boolean): ProcessLauncher {
	return {
		kind: kind as ProcessLauncher["kind"],
		async available() {
			return available;
		},
		async launch() {
			throw new Error("not used");
		},
		async alive() {
			return false;
		},
		async cleanupExited() {
			return true;
		},
		async terminate() {},
	};
}

describe("ProcessAgentExecutionBackend launcher hint", () => {
	it("defaults to auto, accepts runtime switching and affects detection", async () => {
		const backend = new ProcessAgentExecutionBackend({
			launchers: [fakeLauncher("herdr", false), fakeLauncher("tmux", true), fakeLauncher("headless", true)],
		});
		expect(backend.getLauncherHint()).toBe("auto");
		await expect(backend.detectLauncherKind()).resolves.toBe("tmux");

		backend.setLauncherHint("headless");
		expect(backend.getLauncherHint()).toBe("headless");
		await expect(backend.detectLauncherKind()).resolves.toBe("headless");

		backend.setLauncherHint("auto");
		await expect(backend.detectLauncherKind()).resolves.toBe("tmux");
	});

	it("respects a constructor hint and reports unavailable launchers", async () => {
		const backend = new ProcessAgentExecutionBackend({
			launcherHint: "herdr",
			launchers: [fakeLauncher("herdr", false), fakeLauncher("headless", true)],
		});
		expect(backend.getLauncherHint()).toBe("herdr");
		await expect(backend.detectLauncherKind()).rejects.toThrow(/No available process launcher/);
	});
});
