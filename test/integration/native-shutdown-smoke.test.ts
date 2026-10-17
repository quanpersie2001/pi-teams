import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProcessLaunchers } from "../../extension-src/pi-teams/pi/process-launchers.js";

describe("native shutdown smoke (macOS/Unix process evidence)", () => {
	let root: string | undefined;
	afterEach(async () => {
		if (root) await rm(root, { recursive: true, force: true });
		root = undefined;
	});

	it("force-terminates a real owned process group and verifies the PID is gone", async () => {
		root = await mkdtemp(join(tmpdir(), "pi-teams-native-shutdown-"));
		const launcher = createProcessLaunchers().find((candidate) => candidate.kind === "headless");
		if (!launcher) throw new Error("headless launcher unavailable");
		const handle = await launcher.launch({
			childId: "native-shutdown-smoke",
			runDir: join(root, "run"),
			cwd: root,
			env: process.env as Record<string, string>,
			interactiveArgv: [],
			headlessCommand: process.execPath,
			headlessArgv: ["-e", "setInterval(() => {}, 1000)"],
		});
		try {
			expect(handle.pid).toBeDefined();
			expect(handle.pid).not.toBe(process.pid);
			await launcher.forceKill?.(handle);
			await new Promise<void>((resolve) => {
				const poll = () => launcher.alive(handle).then((alive) => (alive ? setTimeout(poll, 25) : resolve()));
				void poll();
			});
			expect(await launcher.alive(handle)).toBe(false);
			const pid = handle.pid;
			if (pid) expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
		} finally {
			if (await launcher.alive(handle)) await launcher.terminate(handle);
		}
	});
});
