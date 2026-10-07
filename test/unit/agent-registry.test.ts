import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LoadedAgentFile } from "../../extension-src/pi-subagents/app/agent-registry.js";
import { AgentRegistry } from "../../extension-src/pi-subagents/app/agent-registry.js";
import {
	AgentFileError,
	DEFAULT_BUILTIN_TOOL_NAMES,
	normalizeAgentDefinition,
	parseToolsField,
	resolveAgentSnapshot,
} from "../../extension-src/pi-subagents/domain/agent-definition.js";
import { DEFAULT_SUBAGENTS_SETTINGS, sanitizeSettings } from "../../extension-src/pi-subagents/domain/config.js";
import { loadAgentMarkdownFiles } from "../../extension-src/pi-subagents/pi/agent-files.js";

const FIXTURES = join(import.meta.dirname, "../fixtures/agents");
const GLOBAL_DIR = join(FIXTURES, "global");
const WORKSPACE_DIR = join(FIXTURES, "workspace");
const PROJECT_DIR = join(FIXTURES, "project");
const BROKEN_DIR = join(FIXTURES, "broken");

function settings(overrides: Partial<typeof DEFAULT_SUBAGENTS_SETTINGS> = {}) {
	return sanitizeSettings({ ...DEFAULT_SUBAGENTS_SETTINGS, ...overrides });
}

function makeRegistry(
	dirs: string[],
	settingsOverrides: Partial<typeof DEFAULT_SUBAGENTS_SETTINGS> = {},
): AgentRegistry {
	return new AgentRegistry({
		sources: dirs,
		loader: loadAgentMarkdownFiles,
		settings: settings(settingsOverrides),
	});
}

// The injected loader in tests below; keeps the registry fs-free while the
// real adapter is exercised separately in agent-files.test.ts.
function fakeLoader(files: LoadedAgentFile[]) {
	return async (_dirs: string[]) => files;
}

describe("AgentRegistry source precedence", () => {
	it("later sources override earlier ones on name clash (global < workspace < project)", async () => {
		const registry = makeRegistry([GLOBAL_DIR]);
		await registry.load();
		expect(registry.get("base-agent")?.description).toBe("global base agent");

		const two = makeRegistry([GLOBAL_DIR, WORKSPACE_DIR]);
		await two.load();
		expect(two.get("base-agent")?.description).toBe("workspace base agent");

		const three = makeRegistry([GLOBAL_DIR, WORKSPACE_DIR, PROJECT_DIR]);
		await three.load();
		expect(three.get("base-agent")?.description).toBe("project base agent");
	});

	it("reload() replaces the generation without duplicating types", async () => {
		const registry = makeRegistry([GLOBAL_DIR, WORKSPACE_DIR, PROJECT_DIR]);
		await registry.load();
		const report = await registry.reload();
		expect(report.types).toEqual(registry.types);
		expect(registry.types.filter((type) => type === "base-agent")).toHaveLength(1);
	});
});

describe("AgentRegistry resolveType", () => {
	it("resolves case-insensitively with exact-match preference", async () => {
		const registry = makeRegistry([GLOBAL_DIR, WORKSPACE_DIR, PROJECT_DIR]);
		await registry.load();
		expect(registry.resolveType("BASE-AGENT")).toEqual({ ok: true, type: "base-agent" });
		expect(registry.resolveType("  base-agent  ")).toEqual({ ok: true, type: "base-agent" });
		expect(registry.resolveType("EXPLORE")).toEqual({
			ok: true,
			type: "explore",
		});
	});

	it("excludes disabled agents from resolution but keeps them registered", async () => {
		const registry = makeRegistry([PROJECT_DIR]);
		await registry.load();
		expect(registry.availableTypes).not.toContain("disabled-agent");
		expect(registry.types).toContain("disabled-agent");
		expect(registry.get("disabled-agent")?.enabled).toBe(false);
		const strictNone = registry.resolveType("disabled-agent");
		expect(strictNone.ok).toBe(false);
	});

	it("treats case-ambiguous names as unresolvable (exact match still wins)", async () => {
		const registry = makeRegistry([PROJECT_DIR]);
		await registry.load();
		// "gamma" exactly registers one agent, so it resolves directly...
		expect(registry.resolveType("gamma")).toEqual({ ok: true, type: "gamma" });
		// ...but "GAMMA" has no exact key and matches two case-variants → refuse.
		const resolution = registry.resolveType("GAMMA");
		expect(resolution.ok).toBe(false);
		if (!resolution.ok) expect(resolution.message).toContain("GAMMA");
	});

	it('rejects with fallbackSubagent "none" (default policy)', async () => {
		const registry = makeRegistry([PROJECT_DIR], { fallbackSubagent: "none" });
		await registry.load();
		const resolution = registry.resolveType("no-such-agent");
		expect(resolution.ok).toBe(false);
		if (!resolution.ok) expect(resolution.message).toContain("Available:");
	});

	it("falls back to a named fallbackSubagent for unknown/ambiguous/disabled requests", async () => {
		const registry = makeRegistry([PROJECT_DIR], { fallbackSubagent: "base-agent" });
		await registry.load();
		for (const requested of ["no-such-agent", "GAMMA", "disabled-agent"]) {
			const resolution = registry.resolveType(requested);
			expect(resolution).toEqual({ ok: true, type: "base-agent", fellBackFrom: requested });
		}
		// Requesting the fallback itself resolves directly (no fellBackFrom).
		expect(registry.resolveType("base-agent")).toEqual({ ok: true, type: "base-agent" });
	});

	it("rejects when the configured fallback is itself unknown or disabled", async () => {
		const unknownFallback = makeRegistry([PROJECT_DIR], { fallbackSubagent: "ghost" });
		await unknownFallback.load();
		expect(unknownFallback.resolveType("nope").ok).toBe(false);

		const disabledFallback = makeRegistry([PROJECT_DIR], { fallbackSubagent: "disabled-agent" });
		await disabledFallback.load();
		expect(disabledFallback.resolveType("nope").ok).toBe(false);
	});
});

describe("AgentRegistry strictAgentFiles", () => {
	it("strict=true throws on an unparseable file, naming it", async () => {
		const registry = makeRegistry([BROKEN_DIR], { strictAgentFiles: true });
		// Files load in sorted order, so bad-fields.md's invalid field throws first.
		await expect(registry.load()).rejects.toThrow(/bad-fields\.md/);
		await expect(registry.load()).rejects.toThrow(AgentFileError);
	});

	it("strict=false skips malformed files with recorded errors and loads the rest", async () => {
		const registry = makeRegistry([BROKEN_DIR], { strictAgentFiles: false });
		const report = await registry.load();
		expect(registry.get("broken-fields")).toBeDefined();
		expect(report.errors.map((error) => error.sourcePath)).toEqual([join(BROKEN_DIR, "bad-yaml.md")]);
		expect(report.warnings.some((warning) => warning.includes("bad-fields.md"))).toBe(true);
	});

	it("strict=true also fails on invalid FIELD values", async () => {
		const loader = fakeLoader([
			{
				sourcePath: "/agents/fields.md",
				frontmatter: { name: "fields", thinking: "banana", max_turns: -3 },
				body: "Body.",
				filenameStem: "fields",
			},
		]);
		const registry = new AgentRegistry({
			sources: ["/agents"],
			loader,
			settings: settings({ strictAgentFiles: true }),
		});
		await expect(registry.load()).rejects.toThrow(AgentFileError);
	});

	it("strict=false normalizes invalid fields to defaults and keeps the agent", async () => {
		const registry = makeRegistry([BROKEN_DIR], { strictAgentFiles: false });
		await registry.load();
		const def = registry.get("broken-fields");
		expect(def?.thinking).toBeUndefined();
		expect(def?.maxTurnLimit).toBeUndefined(); // -3 warned → unlimited
		expect(def?.enabled).toBe(true); // "sometimes" warned → true
		expect(def?.tools).toEqual(["read"]);
	});
});

describe("AgentRegistry invocation precedence (CONFIGURATION §4)", () => {
	it("pinned frontmatter beats spawn overrides for model/thinking/tools/max_turns", async () => {
		const registry = makeRegistry([PROJECT_DIR], { defaultMaxTurns: 30 });
		await registry.load();
		const explore = registry.resolveInvocation("explore", {
			model: "override-model",
			thinking: "high",
			tools: ["bash"],
			maxTurnLimit: 99,
		});
		expect(explore.resolved.model).toBe("anthropic/claude-haiku-4-5");
		expect(explore.resolved.thinking).toBe("minimal");
		expect(explore.resolved.tools).toEqual(["read"]);
		// explore.md pins no max_turns → the spawn override wins over the setting.
		expect(explore.resolved.maxTurnLimit).toBe(99);
	});

	it("unpinned fields take spawn override, then defaultMaxTurns setting, then unlimited", async () => {
		const pinned = makeRegistry([PROJECT_DIR], { defaultMaxTurns: 30 });
		await pinned.load();
		// base-agent frontmatter pins max_turns: 15 — beats override and setting.
		expect(pinned.resolveInvocation("base-agent", { maxTurnLimit: 99 }).resolved.maxTurnLimit).toBe(15);
		// worktree-pinned has max_turns: 0 → PINNED unlimited (0) regardless of setting/override.
		expect(pinned.resolveInvocation("worktree-pinned", { maxTurnLimit: 5 }).resolved.maxTurnLimit).toBe(0);

		const unpinned = new AgentRegistry({
			sources: ["/x"],
			loader: fakeLoader([
				{
					sourcePath: "/x/free.md",
					frontmatter: { name: "free", description: "no pins" },
					body: "Body.",
					filenameStem: "free",
				},
			]),
			settings: settings({ defaultMaxTurns: 7 }),
		});
		await unpinned.load();
		expect(unpinned.resolveInvocation("free").resolved.maxTurnLimit).toBe(7);
		expect(unpinned.resolveInvocation("free", { maxTurnLimit: 3 }).resolved.maxTurnLimit).toBe(3);

		unpinned.updateSettings(settings({ defaultMaxTurns: 0 }));
		await unpinned.reload();
		// Setting 0 = unlimited (absent); an explicit spawn override still applies.
		expect(unpinned.resolveInvocation("free").resolved.maxTurnLimit).toBeUndefined();
		expect(unpinned.resolveInvocation("free", { maxTurnLimit: 3 }).resolved.maxTurnLimit).toBe(3);
	});

	it("worktreeIsolation master switch downgrades a pinned worktree to off", async () => {
		const allowed = makeRegistry([PROJECT_DIR], { worktreeIsolation: true });
		await allowed.load();
		expect(allowed.resolveInvocation("worktree-pinned").resolved.isolationPolicy).toBe("worktree");

		const denied = makeRegistry([PROJECT_DIR], { worktreeIsolation: false });
		await denied.load();
		const snapshot = denied.resolveInvocation("worktree-pinned");
		expect(snapshot.resolved.isolationPolicy).toBe("off");
		// The definition itself keeps its veto value; only the snapshot is downgraded.
		expect(snapshot.definition.isolationPolicy).toBe("worktree");
	});

	it("throws with the fallback-policy message when the type cannot be resolved", () => {
		const empty = new AgentRegistry({ sources: [], loader: fakeLoader([]), settings: settings() });
		expect(() => empty.resolveInvocation("anything")).toThrow(/Unknown, disabled, or ambiguous/);
	});
});

describe("snapshot immutability across reload", () => {
	it("already-resolved invocation snapshots survive reload unchanged", async () => {
		const registry = makeRegistry([PROJECT_DIR]);
		await registry.load();

		const before = registry.resolveInvocation("base-agent");
		const trackedRunId = "run-1";
		registry.resolveInvocation("base-agent", {}, trackedRunId);

		await registry.reload();

		// Tracked active-run snapshot untouched by reload.
		const afterReloadTracked = registry.getActiveSnapshot(trackedRunId);
		expect(afterReloadTracked).toBe(registry.getActiveSnapshot(trackedRunId));
		expect(afterReloadTracked?.resolved.maxTurnLimit).toBe(before.resolved.maxTurnLimit);

		// Mutating a returned snapshot's arrays never leaks into later snapshots.
		before.resolved.tools?.push("injected-tool");
		const fresh = registry.resolveInvocation("base-agent");
		expect(fresh.resolved.tools).not.toContain("injected-tool");
		expect(fresh).not.toBe(before);
		expect(fresh.resolved.tools).toEqual([...DEFAULT_BUILTIN_TOOL_NAMES]);

		registry.releaseSnapshot(trackedRunId);
		expect(registry.getActiveSnapshot(trackedRunId)).toBeUndefined();
	});
});

describe("normalizeAgentDefinition field parsing", () => {
	const baseFile = {
		sourcePath: "/agents/x.md",
		frontmatter: {} as Record<string, unknown>,
		body: "Instructions.",
		filenameStem: "file-fallback",
	};

	it("falls back to the filename stem when name is absent or whitespace", () => {
		const absent = normalizeAgentDefinition(baseFile);
		expect(absent.definition.type).toBe("file-fallback");
		expect(absent.warnings).toHaveLength(0);

		const blank = normalizeAgentDefinition({ ...baseFile, frontmatter: { name: "   " } });
		expect(blank.definition.type).toBe("file-fallback");
	});

	it("lenient mode warns and falls back on reserved ':' in declared name; strict throws", () => {
		const lenient = normalizeAgentDefinition({ ...baseFile, frontmatter: { name: "plugin:reviewer" } });
		expect(lenient.definition.type).toBe("file-fallback");
		expect(lenient.warnings[0]).toContain("name");

		expect(() =>
			normalizeAgentDefinition({ ...baseFile, frontmatter: { name: "plugin:reviewer" } }, { strict: true }),
		).toThrow(AgentFileError);
	});

	it("parses tools CSV, wildcard expansion, none, and omission", () => {
		const csv = normalizeAgentDefinition({ ...baseFile, frontmatter: { tools: "read , grep" } });
		expect(csv.definition.tools).toEqual(["read", "grep"]);

		const wildcard = parseToolsField("*, custom-ext", ["read", "bash"]);
		expect(wildcard).toEqual(["read", "bash", "custom-ext"]);

		const allAlias = parseToolsField("all", ["read", "bash"]);
		expect(allAlias).toEqual(["read", "bash"]);

		const none = normalizeAgentDefinition({ ...baseFile, frontmatter: { tools: "none" } });
		expect(none.definition.tools).toEqual([]);

		const omitted = normalizeAgentDefinition(baseFile);
		expect(omitted.definition.tools).toBeUndefined(); // default toolset
	});

	it("prompt_mode defaults to replace; append is honored", () => {
		expect(normalizeAgentDefinition(baseFile).definition.promptMode).toBe("replace");
		expect(
			normalizeAgentDefinition({ ...baseFile, frontmatter: { prompt_mode: "append" } }).definition.promptMode,
		).toBe("append");
	});

	it("run_in_background uses the settings tier when omitted", () => {
		expect(normalizeAgentDefinition(baseFile).definition.defaultBackground).toBe(false);
		expect(normalizeAgentDefinition(baseFile, { defaultBackground: true }).definition.defaultBackground).toBe(true);
		expect(
			normalizeAgentDefinition(
				{ ...baseFile, frontmatter: { run_in_background: false } },
				{
					defaultBackground: true,
				},
			).definition.defaultBackground,
		).toBe(false);
	});

	it("max_turns: absent → unspecified, 0 → pinned unlimited, positive kept", () => {
		expect(normalizeAgentDefinition(baseFile).definition.maxTurnLimit).toBeUndefined();
		expect(normalizeAgentDefinition({ ...baseFile, frontmatter: { max_turns: 0 } }).definition.maxTurnLimit).toBe(0);
		expect(normalizeAgentDefinition({ ...baseFile, frontmatter: { max_turns: 20 } }).definition.maxTurnLimit).toBe(20);
	});

	it("body becomes trimmed system instructions and description defaults to the type", () => {
		const result = normalizeAgentDefinition({ ...baseFile, body: "  Do things.  " });
		expect(result.definition.systemPrompt).toBe("Do things.");
		expect(result.definition.description).toBe("file-fallback");
		expect(result.definition.loadedFrom).toBe("/agents/x.md");
	});
});

describe("time budgets (roadmap 1.1)", () => {
	const baseFile = {
		sourcePath: "/agents/budget.md",
		frontmatter: {} as Record<string, unknown>,
		body: "Instructions.",
		filenameStem: "budget",
	};

	it("parses timeout / idle_timeout frontmatter; idle-timeout is an accepted alias", () => {
		expect(normalizeAgentDefinition(baseFile).definition.timeout).toBeUndefined();
		expect(
			normalizeAgentDefinition({ ...baseFile, frontmatter: { timeout: 600, idle_timeout: 30 } }).definition,
		).toMatchObject({ timeout: 600, idleTimeout: 30 });
		expect(
			normalizeAgentDefinition({ ...baseFile, frontmatter: { timeout: 600, "idle-timeout": 30 } }).definition,
		).toMatchObject({ timeout: 600, idleTimeout: 30 });
	});

	it("rejects malformed budgets as FILE-level failures even in lenient mode", () => {
		for (const frontmatter of [
			{ timeout: 0 },
			{ timeout: -5 },
			{ timeout: 1.5 },
			{ timeout: null },
			{ timeout: "600" },
			{ timeout: Number.POSITIVE_INFINITY },
			{ idle_timeout: 0 },
			{ "idle-timeout": 2.5 },
		]) {
			expect(() => normalizeAgentDefinition({ ...baseFile, frontmatter })).toThrow(AgentFileError);
			expect(() => normalizeAgentDefinition({ ...baseFile, frontmatter }, { strict: true })).toThrow(AgentFileError);
		}
	});

	it("rejects specifying both idle_timeout and idle-timeout (ambiguous conflict)", () => {
		expect(() =>
			normalizeAgentDefinition({ ...baseFile, frontmatter: { idle_timeout: 30, "idle-timeout": 30 } }),
		).toThrow(AgentFileError);
	});

	it("rejects budgets beyond the signed-32-bit millisecond timer range", () => {
		expect(() => normalizeAgentDefinition({ ...baseFile, frontmatter: { timeout: 2147484 } })).toThrow(
			/positive whole number of seconds/,
		);
		expect(normalizeAgentDefinition({ ...baseFile, frontmatter: { timeout: 2147483 } }).definition.timeout).toBe(
			2147483,
		);
	});

	function fakeRegistry(files: LoadedAgentFile[], settingsOverrides = {}) {
		return new AgentRegistry({
			sources: ["/x"],
			loader: fakeLoader(files),
			settings: settings(settingsOverrides),
		});
	}

	it("resolves invocation > definition > settings for budgets", async () => {
		const registry = fakeRegistry(
			[{ ...baseFile, frontmatter: { name: "budgeted", timeout: 600, idle_timeout: 30 } }],
			{ defaultTimeout: 120, defaultIdleTimeout: 10 },
		);
		await registry.load();

		// Settings tier applies only when neither definition nor override sets one.
		const plain = fakeRegistry([{ ...baseFile, frontmatter: { name: "free" } }], {
			defaultTimeout: 120,
			defaultIdleTimeout: 10,
		});
		await plain.load();
		expect(plain.resolveInvocation("free").resolved).toMatchObject({ timeout: 120, idleTimeout: 10 });

		// Definition pins beat settings.
		expect(registry.resolveInvocation("budgeted").resolved).toMatchObject({ timeout: 600, idleTimeout: 30 });

		// Invocation beats the pinned definition — tighten or loosen.
		expect(registry.resolveInvocation("budgeted", { timeout: 5, idleTimeout: 1 }).resolved).toMatchObject({
			timeout: 5,
			idleTimeout: 1,
		});
		expect(registry.resolveInvocation("budgeted", { timeout: 900 }).resolved).toMatchObject({
			timeout: 900,
			idleTimeout: 30,
		});

		// Settings 0 = unlimited when nothing else specifies a budget.
		const off = fakeRegistry([{ ...baseFile, frontmatter: { name: "free" } }], {
			defaultTimeout: 0,
			defaultIdleTimeout: 0,
		});
		await off.load();
		expect(off.resolveInvocation("free").resolved.timeout).toBeUndefined();
		expect(off.resolveInvocation("free").resolved.idleTimeout).toBeUndefined();
	});

	it("throws on malformed invocation budget overrides instead of silently disabling", async () => {
		const registry = fakeRegistry([{ ...baseFile, frontmatter: { name: "free" } }], { defaultTimeout: 120 });
		await registry.load();
		for (const overrides of [
			{ timeout: 0 },
			{ timeout: -1 },
			{ timeout: 1.5 },
			{ idleTimeout: null as unknown as number },
		]) {
			expect(() => registry.resolveInvocation("free", overrides)).toThrow();
		}
	});

	it("lenient registry skips a file with a malformed budget; strict throws", async () => {
		const bad = { ...baseFile, sourcePath: "/agents/bad-budget.md", frontmatter: { name: "bad-budget", timeout: 1.5 } };
		const lenient = fakeRegistry([bad], { strictAgentFiles: false });
		const report = await lenient.load();
		expect(lenient.types).not.toContain("bad-budget");
		expect(report.errors).toEqual([
			{ sourcePath: "/agents/bad-budget.md", message: expect.stringContaining("timeout") },
		]);

		const strict = fakeRegistry([bad], { strictAgentFiles: true });
		await expect(strict.load()).rejects.toThrow(AgentFileError);
	});

	it("snapshot budget fields are copied, not aliased", () => {
		const definition = normalizeAgentDefinition({
			...baseFile,
			frontmatter: { timeout: 600, idle_timeout: 30 },
		}).definition;
		const snapshot = resolveAgentSnapshot(definition);
		expect(snapshot.resolved).toMatchObject({ timeout: 600, idleTimeout: 30 });
		expect(snapshot.resolved).not.toBe(definition);
	});
});
