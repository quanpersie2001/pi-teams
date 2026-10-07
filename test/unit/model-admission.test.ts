import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelAdmission } from "../../extension-src/pi-subagents/pi/model-admission.js";

interface FixtureModel {
	id: string;
	name?: string;
	headers?: Record<string, string>;
}

interface FixtureProvider {
	baseUrl: string;
	api: string;
	apiKey?: string;
	headers?: Record<string, string>;
	models: FixtureModel[];
}

type FixtureCredentials = Record<
	string,
	{ type: "api_key"; key: string } | { type: "oauth"; access: string; refresh: string; expires: number }
>;

let root: string;
let agentDir: string;
let originalEnvironment: NodeJS.ProcessEnv;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "subagents-model-admission-"));
	agentDir = join(root, "agent");
	await mkdir(agentDir);
	originalEnvironment = process.env;
	// The actual native runtime still resolves auth, but cannot see the developer's credentials.
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
			throw new Error("Unexpected network request in isolated model admission fixture");
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

function provider(models: FixtureModel[], apiKey?: string): FixtureProvider {
	return {
		baseUrl: "https://model-admission.invalid/v1",
		api: "openai-completions",
		models,
		...(apiKey !== undefined ? { apiKey } : {}),
	};
}

async function fixture(
	providers: Record<string, FixtureProvider>,
	credentials: FixtureCredentials = {},
): Promise<void> {
	await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers }), "utf8");
	await writeFile(join(agentDir, "auth.json"), JSON.stringify(credentials), { mode: 0o600 });
}

async function savedSession(model?: string): Promise<string> {
	const sessionDir = join(root, "session");
	await mkdir(sessionDir);
	const sessionFile = join(sessionDir, "saved.jsonl");
	await writeFile(sessionFile, "", "utf8");
	await writeFile(
		join(sessionDir, "bootstrap.json"),
		JSON.stringify({
			childId: "saved-child",
			token: "isolated-bootstrap-token-not-a-real-credential",
			socketPath: "/tmp/admission-fixture.sock",
			sessionDir,
			cwd: root,
			configCwd: root,
			systemPrompt: "",
			promptMode: "append",
			...(model !== undefined ? { model } : {}),
		}),
		{ mode: 0o600 },
	);
	return sessionFile;
}

describe("native child model admission", () => {
	it("falls back from an unauthenticated pinned Anthropic-like provider to the captured parent", async () => {
		await fixture({
			"admission-anthropic": { ...provider([{ id: "claude-pinned" }]), api: "anthropic-messages" },
			"admission-parent": provider([{ id: "parent" }], "fixture-parent-key"),
			"admission-other": provider([{ id: "later-parent" }], "fixture-other-key"),
		});
		let parent = "admission-parent/parent";
		const getParentModel = vi.fn(() => parent);
		const prepare = createModelAdmission({ agentDir, getParentModel });
		const pending = prepare({ model: "admission-anthropic/claude-pinned" });
		parent = "admission-other/later-parent";

		expect(await pending).toEqual({
			model: "admission-parent/parent",
			fallback: expect.stringMatching(
				/admission-anthropic\/claude-pinned.*no usable native authentication.*admission-parent\/parent/,
			),
		});
		expect(getParentModel).toHaveBeenCalledTimes(1);
	});

	it("tries an ignored caller model before the parent when the primary is unavailable", async () => {
		await fixture({
			"admission-caller": provider([{ id: "caller" }], "fixture-caller-key"),
			"admission-parent": provider([{ id: "parent" }], "fixture-parent-key"),
		});
		const prepare = createModelAdmission({ agentDir, getParentModel: () => "admission-parent/parent" });
		expect(await prepare({ model: "missing-provider/missing", fallbackModel: "admission-caller/caller" })).toEqual({
			model: "admission-caller/caller",
			fallback: expect.stringMatching(/missing-provider\/missing.*not registered.*admission-caller\/caller/),
		});
		expect(await prepare({ model: "missing-provider/missing", fallbackModel: "missing-provider/caller" })).toEqual({
			model: "admission-parent/parent",
			fallback: expect.stringMatching(/missing-provider\/missing.*not registered.*admission-parent\/parent/),
		});
	});

	it("rejects explicitly when no native model has usable auth, without revealing credential details", async () => {
		await fixture({
			"admission-no-auth": provider([{ id: "pinned" }]),
			"admission-broken": {
				...provider([{ id: "broken" }], "fixture-secret-never-expose"),
				headers: { Authorization: "$ADMISSION_MISSING_HEADER" },
			},
		});
		const prepare = createModelAdmission({ agentDir });
		const failure = await prepare({ model: "admission-no-auth/pinned" }).catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		expect(failure).toMatchObject({
			message: expect.stringMatching(/No authenticated model is available.*admission-no-auth\/pinned/),
		});
		if (!(failure instanceof Error)) throw new Error("Expected failed admission");
		expect(failure.message).not.toContain("fixture-secret-never-expose");
		expect(failure.message).not.toContain("Authorization");
	});

	it("keeps an authenticated preferred canonical model unchanged", async () => {
		await fixture({
			"admission-preferred": provider([{ id: "preferred" }], "fixture-preferred-key"),
			"admission-parent": provider([{ id: "parent" }], "fixture-parent-key"),
		});
		const prepare = createModelAdmission({ agentDir, getParentModel: () => "admission-parent/parent" });
		expect(await prepare({ model: "admission-preferred/preferred", fallbackModel: "admission-parent/parent" })).toEqual(
			{
				model: "admission-preferred/preferred",
			},
		);
	});

	it("accepts native headers-only auth without requiring an API key", async () => {
		await fixture({
			anthropic: { ...provider([{ id: "admission-headers-only" }]), api: "anthropic-messages" },
		});
		process.env.ANTHROPIC_AUTH_TOKEN = "fixture-header-token";
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const model = runtime.getModel("anthropic", "admission-headers-only");
		if (!model) throw new Error("Native fixture model was not registered");
		expect(await runtime.getAuth(model)).toMatchObject({
			auth: { headers: { Authorization: "Bearer fixture-header-token" } },
		});
		expect((await runtime.getAuth(model))?.auth.apiKey).toBeUndefined();
		expect(await createModelAdmission({ agentDir })({ model: "anthropic/admission-headers-only" })).toEqual({
			model: "anthropic/admission-headers-only",
		});
	});

	it("accepts native unexpired OAuth credentials without making a model or refresh request", async () => {
		await fixture(
			{ anthropic: { ...provider([{ id: "admission-oauth" }]), api: "anthropic-messages" } },
			{
				anthropic: {
					type: "oauth",
					access: "isolated-oauth-access",
					refresh: "isolated-oauth-refresh",
					expires: Date.now() + 60 * 60 * 1000,
				},
			},
		);
		expect(await createModelAdmission({ agentDir })({ model: "anthropic/admission-oauth" })).toEqual({
			model: "anthropic/admission-oauth",
		});
	});

	it.each(["shared-exact-id", "shared fuzzy", "admission-ambiguous/shared"])(
		"reports ambiguity truthfully for %s instead of silently picking a match",
		async (model) => {
			await fixture({
				"admission-ambiguous": provider(
					[
						{ id: "shared-exact-id", name: "Shared fuzzy alpha" },
						{ id: "shared-beta", name: "Shared fuzzy beta" },
					],
					"fixture-ambiguous-key",
				),
				"admission-duplicate": provider([{ id: "shared-exact-id" }], "fixture-duplicate-key"),
				"admission-parent": provider([{ id: "parent" }], "fixture-parent-key"),
			});
			const prepare = createModelAdmission({ agentDir, getParentModel: () => "admission-parent/parent" });
			expect(await prepare({ model })).toEqual({
				model: "admission-parent/parent",
				fallback: expect.stringMatching(/ambiguous.*admission-parent\/parent/),
			});
		},
	);

	it.each([
		"UNIQUE-EXACT",
		"Exact display name with unique fragment",
		"unique fragment",
		"admission-primary/unique fragment",
	])("canonicalizes an unambiguous native model reference %s without calling it a fallback", async (model) => {
		await fixture({
			"admission-primary": provider(
				[{ id: "unique-exact", name: "Exact display name with unique fragment" }, { id: "other" }],
				"fixture-primary-key",
			),
		});
		expect(await createModelAdmission({ agentDir })({ model })).toEqual({ model: "admission-primary/unique-exact" });
	});

	it("does not let one provider's failed native auth resolution block another usable provider", async () => {
		await fixture({
			"admission-broken": {
				...provider([{ id: "broken" }], "fixture-secret-never-expose"),
				headers: { Authorization: "$ADMISSION_MISSING_HEADER" },
			},
			"admission-usable": provider([{ id: "usable" }], "fixture-usable-key"),
		});
		expect(await createModelAdmission({ agentDir })({ model: "admission-broken/broken" })).toEqual({
			model: "admission-usable/usable",
			fallback: expect.stringMatching(
				/admission-broken\/broken.*no usable native authentication.*admission-usable\/usable/,
			),
		});
	});

	it("keeps a usable sibling model eligible after model-specific native headers fail", async () => {
		await fixture({
			"admission-shared": provider(
				[{ id: "preferred", headers: { Authorization: "$ADMISSION_MISSING_MODEL_HEADER" } }, { id: "sibling" }],
				"fixture-shared-key",
			),
		});
		expect(
			await createModelAdmission({ agentDir })({
				model: "admission-shared/preferred",
				fallbackModel: "admission-shared/sibling",
			}),
		).toEqual({
			model: "admission-shared/sibling",
			fallback: expect.stringMatching(
				/admission-shared\/preferred.*no usable native authentication.*admission-shared\/sibling/,
			),
		});
	});

	it("observes native model configuration and stored credential changes on subsequent calls", async () => {
		const preferred = provider([{ id: "preferred" }]);
		const parent = provider([{ id: "parent" }], "fixture-parent-key");
		await fixture(
			{ "admission-preferred": preferred, "admission-parent": parent },
			{ "admission-preferred": { type: "api_key", key: "fixture-stored-key" } },
		);
		const prepare = createModelAdmission({ agentDir, getParentModel: () => "admission-parent/parent" });
		expect(await prepare({ model: "admission-preferred/preferred" })).toEqual({
			model: "admission-preferred/preferred",
		});
		await writeFile(join(agentDir, "auth.json"), "{}", "utf8");
		expect(await prepare({ model: "admission-preferred/preferred" })).toMatchObject({
			model: "admission-parent/parent",
			fallback: expect.stringMatching(/no usable native authentication/),
		});
		await fixture(
			{ "admission-preferred": { ...preferred, models: [{ id: "replacement" }] }, "admission-parent": parent },
			{ "admission-preferred": { type: "api_key", key: "fixture-replaced-key" } },
		);
		expect(await prepare({ model: "admission-preferred/replacement" })).toEqual({
			model: "admission-preferred/replacement",
		});
		expect(await prepare({ model: "admission-preferred/preferred" })).toMatchObject({
			model: "admission-parent/parent",
			fallback: expect.stringMatching(/not registered/),
		});
	});

	it("resolves configured environment auth afresh instead of treating a previous selection as permanent", async () => {
		await fixture({
			"admission-env": provider([{ id: "env" }], "$ADMISSION_FIXTURE_KEY"),
			"admission-parent": provider([{ id: "parent" }], "fixture-parent-key"),
		});
		const prepare = createModelAdmission({ agentDir, getParentModel: () => "admission-parent/parent" });
		process.env.ADMISSION_FIXTURE_KEY = "isolated-env-key";
		expect(await prepare({ model: "admission-env/env" })).toEqual({ model: "admission-env/env" });
		delete process.env.ADMISSION_FIXTURE_KEY;
		expect(await prepare({ model: "admission-env/env" })).toMatchObject({
			model: "admission-parent/parent",
			fallback: expect.stringMatching(/no usable native authentication/),
		});
	});

	it("selects native authenticated defaults in deterministic provider/model order", async () => {
		await fixture({
			"admission-z": provider([{ id: "first" }], "fixture-z-key"),
			"admission-a": provider([{ id: "z-model" }, { id: "a-model" }], "fixture-a-key"),
		});
		const prepare = createModelAdmission({ agentDir });
		expect(await prepare({})).toEqual({ model: "admission-a/a-model" });
		expect(await prepare({ model: "missing-provider/missing" })).toEqual({
			model: "admission-a/a-model",
			fallback: expect.stringMatching(/missing-provider\/missing.*not registered.*admission-a\/a-model/),
		});
	});

	it("loads the saved cold-resume model before falling back to the captured parent", async () => {
		await fixture({
			"admission-saved": provider([{ id: "saved" }]),
			"admission-parent": provider([{ id: "parent" }], "fixture-parent-key"),
		});
		const sessionFile = await savedSession("admission-saved/saved");
		let parent = "admission-parent/parent";
		const prepare = createModelAdmission({ agentDir, getParentModel: () => parent });
		const pending = prepare({ sessionFile });
		parent = "missing-provider/later-parent";
		expect(await pending).toEqual({
			model: "admission-parent/parent",
			fallback: expect.stringMatching(
				/admission-saved\/saved.*no usable native authentication.*admission-parent\/parent/,
			),
		});
	});

	it("prefers an explicit model over a valid saved resume model", async () => {
		await fixture({
			"admission-saved": provider([{ id: "saved" }], "fixture-saved-key"),
			"admission-explicit": provider([{ id: "explicit" }], "fixture-explicit-key"),
		});
		const sessionFile = await savedSession("admission-saved/saved");
		expect(await createModelAdmission({ agentDir })({ sessionFile, model: "admission-explicit/explicit" })).toEqual({
			model: "admission-explicit/explicit",
		});
	});

	it("keeps missing and malformed resume bootstraps as real errors, even with a usable explicit model", async () => {
		await fixture({ "admission-parent": provider([{ id: "parent" }], "fixture-parent-key") });
		const prepare = createModelAdmission({ agentDir, getParentModel: () => "admission-parent/parent" });
		await expect(prepare({ sessionFile: join(root, "missing", "session.jsonl") })).rejects.toMatchObject({
			code: "ENOENT",
		});
		const sessionFile = await savedSession("admission-parent/parent");
		await writeFile(join(root, "session", "bootstrap.json"), "not json", "utf8");
		await expect(prepare({ sessionFile, model: "admission-parent/parent" })).rejects.toMatchObject({
			code: "invalid_bootstrap",
		});
	});
});
