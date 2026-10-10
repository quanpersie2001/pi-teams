// Tool surface and rendering for the read-only list_models preflight tool.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelTools } from "../../extension-src/pi-teams/pi/model-tools.js";

interface FixtureModel {
	id: string;
	name?: string;
}

interface FixtureProvider {
	baseUrl: string;
	api: string;
	models: FixtureModel[];
}

let root: string;
let agentDir: string;
let originalEnvironment: NodeJS.ProcessEnv;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "teams-model-tools-"));
	agentDir = join(root, "agent");
	await mkdir(agentDir);
	originalEnvironment = process.env;
	// The native runtime still resolves auth, but cannot see the developer's credentials.
	process.env = {
		PATH: originalEnvironment.PATH ?? "",
		HOME: root,
		USERPROFILE: root,
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected network request in isolated model tools fixture");
		}),
	);
});

afterEach(async () => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		process.env = originalEnvironment;
		await rm(root, { recursive: true, force: true });
	}
});

function provider(models: FixtureModel[]): FixtureProvider {
	return {
		baseUrl: "https://model-tools.invalid/v1",
		api: "openai-completions",
		models,
	};
}

async function fixture(providers: Record<string, FixtureProvider>): Promise<void> {
	await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers }), "utf8");
	await writeFile(join(agentDir, "auth.json"), "{}", { mode: 0o600 });
}

type ToolResult = { content: Array<{ type: string; text?: string }>; details: unknown };
type ModelTool = {
	name: string;
	description: string;
	renderCall?: (args: unknown, theme: unknown, context: unknown) => { render(width: number): string[] };
	renderResult?: (
		result: ToolResult,
		options: unknown,
		theme: unknown,
		context: unknown,
	) => { render(width: number): string[] };
	execute: (id: string, args: unknown, signal: undefined, onUpdate: undefined, ctx: never) => Promise<ToolResult>;
};

function tool(): ModelTool {
	const found = createModelTools()[0];
	if (!found) throw new Error("list_models tool is unavailable");
	return found as ModelTool;
}

async function runText(args: Record<string, unknown> = {}): Promise<string> {
	const raw = await tool().execute("call", args, undefined, undefined, undefined as never);
	const first = raw.content[0];
	if (first?.type !== "text") throw new Error("Tool returned no text");
	return first.text ?? "";
}

function rendered(component: { render(width: number): string[] }): string {
	return component.render(200).join("\n");
}

/** Three fixture models with unique display-name tokens so queries cannot match the built-in catalog. */
async function baseFixture(): Promise<void> {
	await fixture({
		"toolfixture-a": provider([{ id: "alpha", name: "Zephyr Quokka" }]),
		"toolfixture-b": provider([
			{ id: "second", name: "Zephyr Ocelot" },
			{ id: "first", name: "Zephyr Narwhal" },
		]),
	});
}

describe("list_models tool", () => {
	it("lists matches as canonical provider/id rows with display names, sorted", async () => {
		await baseFixture();
		const text = await runText({ query: "toolfixture-" });
		expect(text.split("\n")).toEqual([
			"toolfixture-a/alpha — Zephyr Quokka",
			"toolfixture-b/first — Zephyr Narwhal",
			"toolfixture-b/second — Zephyr Ocelot",
		]);
	});

	it("filters case-insensitively on the canonical ref", async () => {
		await baseFixture();
		expect((await runText({ query: "TOOLFIXTURE-B" })).split("\n")).toEqual([
			"toolfixture-b/first — Zephyr Narwhal",
			"toolfixture-b/second — Zephyr Ocelot",
		]);
	});

	it("filters case-insensitively on the display name", async () => {
		await baseFixture();
		expect(await runText({ query: "NARWHAL" })).toBe("toolfixture-b/first — Zephyr Narwhal");
		expect((await runText({ query: "zephyr" })).split("\n")).toHaveLength(3);
	});

	it("reports an explicit empty result with the query", async () => {
		await baseFixture();
		expect(await runText({ query: "toolfixture-no-such-model" })).toBe(
			'No registered model matches "toolfixture-no-such-model".',
		);
	});

	it("adds the truncation footer only when the total exceeds the limit", async () => {
		await baseFixture();
		expect((await runText({ query: "toolfixture-", limit: 2 })).split("\n")).toEqual([
			"toolfixture-a/alpha — Zephyr Quokka",
			"toolfixture-b/first — Zephyr Narwhal",
			"2 of 3 matching models shown",
		]);
		const exact = await runText({ query: "toolfixture-", limit: 3 });
		expect(exact.split("\n")).toHaveLength(3);
		expect(exact).not.toContain("matching models shown");
	});

	it("defaults to a limit of 50", async () => {
		await fixture({
			"toolfixture-bulk": provider(
				Array.from({ length: 60 }, (_value, index) => ({
					id: `bulk-${String(index).padStart(2, "0")}`,
					name: `Bulk Fixture ${index}`,
				})),
			),
		});
		const lines = (await runText({ query: "toolfixture-bulk" })).split("\n");
		expect(lines).toHaveLength(51);
		expect(lines[0]).toBe("toolfixture-bulk/bulk-00 — Bulk Fixture 0");
		expect(lines[49]).toBe("toolfixture-bulk/bulk-49 — Bulk Fixture 49");
		expect(lines[50]).toBe("50 of 60 matching models shown");
	});

	it("renders a compact call and the raw result text", async () => {
		await baseFixture();
		const list = tool();
		if (!list.renderCall || !list.renderResult) throw new Error("renderers are unavailable");
		expect(rendered(list.renderCall({ query: "toolfixture" }, undefined, undefined))).toContain(
			'▸ list_models("toolfixture")',
		);
		expect(rendered(list.renderCall({}, undefined, undefined))).toContain("▸ list_models()");
		const raw = await list.execute("call", { query: "toolfixture-" }, undefined, undefined, undefined as never);
		expect(rendered(list.renderResult(raw, { expanded: false, isPartial: false }, undefined, undefined))).toContain(
			"toolfixture-a/alpha — Zephyr Quokka",
		);
	});
});
