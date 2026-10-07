// Integration test: settings files are read at session_start and the merged
// result reaches the registry + manager (and the worktree service when present).
// Mirrors the session_start wiring in pi/index.ts but with a temp project dir
// and temp agent dir so it never touches the real ~/.pi/agent.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiSubagentsApp } from "../../extension-src/pi-subagents/app/index.js";
import { loadSubagentsSettings } from "../../extension-src/pi-subagents/pi/config-host.js";
import { FakeBackend } from "../helpers/fake-backend.js";
import { FakePiHost } from "../helpers/fake-pi-host.js";

let root: string | undefined;

afterEach(async () => {
	if (root) {
		await rm(root, { recursive: true, force: true });
		root = undefined;
	}
});

describe("session_start settings load", () => {
	it("reads a temp project .pi/subagents.json and propagates it to registry + manager", async () => {
		root = await mkdtemp(join(tmpdir(), "pi-subagents-settings-int-"));
		const project = join(root, "project");
		const agentDir = join(root, "agent");
		await mkdir(join(project, ".pi"), { recursive: true });
		// Manager directly reflects maxConcurrent; fallbackSubagent exercises
		// the sanitized merge end-to-end as well.
		await writeFile(
			join(project, ".pi", "subagents.json"),
			JSON.stringify({ maxConcurrent: 7, fallbackSubagent: "general-purpose" }),
		);

		const host = new FakePiHost({ mode: "rpc", cwd: project });
		const backend = new FakeBackend();
		const app = createPiSubagentsApp({
			sources: [],
			loader: async () => [],
			settings: { ...(await loadSubagentsSettings(project, { agentDir })) },
			backends: [backend],
			cwd: project,
			configCwd: project,
		});

		// Same wiring as pi/index.ts session_start: re-read files, propagate to
		// registry/manager/worktree, then run sessionStart.
		host.extensionApi.on("session_start", async () => {
			app.updateSettings(await loadSubagentsSettings(project, { agentDir }));
			await app.sessionStart();
		});
		await host.sessionStart();

		expect(app.manager.currentSettings.maxConcurrent).toBe(7);
		expect(app.manager.currentSettings.fallbackSubagent).toBe("general-purpose");
		expect(app.registry.currentSettings.maxConcurrent).toBe(7);
		expect(app.manager.getMaxConcurrent()).toBe(7);
	});

	it("falls back to defaults when no settings file exists anywhere", async () => {
		root = await mkdtemp(join(tmpdir(), "pi-subagents-settings-int-"));
		const project = join(root, "project");
		const agentDir = join(root, "agent");
		await mkdir(project, { recursive: true });

		const host = new FakePiHost({ mode: "rpc", cwd: project });
		const backend = new FakeBackend();
		const app = createPiSubagentsApp({
			sources: [],
			loader: async () => [],
			settings: { ...(await loadSubagentsSettings(project, { agentDir })) },
			backends: [backend],
			cwd: project,
			configCwd: project,
		});
		host.extensionApi.on("session_start", async () => {
			app.updateSettings(await loadSubagentsSettings(project, { agentDir }));
			await app.sessionStart();
		});
		await host.sessionStart();

		expect(app.manager.currentSettings.maxConcurrent).toBe(4);
		expect(app.manager.currentSettings.backgroundByDefault).toBe(true);
	});
});
