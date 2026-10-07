import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutocompleteProvider, AutocompleteProviderFactory } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "../../extension-src/pi-teams/app/agent-registry.js";
import { DEFAULT_SUBAGENTS_SETTINGS } from "../../extension-src/pi-teams/domain/config.js";
import { installAgentMentionAutocomplete } from "../../extension-src/pi-teams/pi/agent-mention-autocomplete.js";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "agent-mention-autocomplete-"));
	await writeFile(join(root, "native-file.txt"), "file completion fixture", "utf8");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function registryFixture(): Promise<AgentRegistry> {
	const registry = new AgentRegistry({
		sources: [],
		settings: { ...DEFAULT_SUBAGENTS_SETTINGS },
		loader: async () => [
			{
				sourcePath: "/agents/Review.md",
				filenameStem: "Review",
				frontmatter: { name: "Review", description: "Review the change" },
				body: "",
			},
			{
				sourcePath: "/agents/Disabled.md",
				filenameStem: "Disabled",
				frontmatter: { name: "Disabled", enabled: false },
				body: "",
			},
		],
	});
	await registry.load();
	return registry;
}

function installedProvider(registry: AgentRegistry): AutocompleteProvider {
	let factory: AutocompleteProviderFactory | undefined;
	installAgentMentionAutocomplete(
		{
			ui: {
				addAutocompleteProvider(providerFactory) {
					factory = providerFactory;
				},
			},
		},
		registry,
	);
	if (!factory) throw new Error("Autocomplete provider was not installed");
	return factory(new CombinedAutocompleteProvider([], root));
}

const options = { signal: new AbortController().signal };

describe("agent mention autocomplete", () => {
	it("offers built-ins and enabled definitions alongside native file completion and acceptance", async () => {
		const registry = await registryFixture();
		const provider = installedProvider(registry);
		const result = await provider.getSuggestions(["Please ask @"], 0, 12, options);

		expect(result?.items.find((item) => item.label === "@Review")).toMatchObject({
			value: "Review",
			description: "Review the change",
		});
		expect(result?.items.some((item) => item.label === "@Disabled")).toBe(false);

		const filePrompt = "Please ask ./native-";
		const files = await provider.getSuggestions([filePrompt], 0, filePrompt.length, options);
		const fileItem = files?.items.find((item) => item.label === "native-file.txt");
		if (!fileItem || !files) throw new Error("Expected native file suggestion");
		expect(provider.applyCompletion([filePrompt], 0, filePrompt.length, fileItem, files.prefix)).toEqual({
			lines: ["Please ask ./native-file.txt"],
			cursorLine: 0,
			cursorCol: "Please ask ./native-file.txt".length,
		});

		const pickedAgent = result.items.find((item) => item.label === "@Review");
		if (!pickedAgent) throw new Error("Expected Review suggestion");
		expect(provider.applyCompletion(["Please ask @rev now"], 0, 15, pickedAgent, result.prefix)).toEqual({
			lines: ["Please ask @Review now"],
			cursorLine: 0,
			cursorCol: 18,
		});
	});

	it("handles empty, partial, mid-token, multiline and end-of-line mentions without matching emails or paths", async () => {
		const registry = await registryFixture();
		const provider = installedProvider(registry);

		const empty = await provider.getSuggestions(["@"], 0, 1, options);
		expect(empty?.items.some((item) => item.label === "@Review")).toBe(true);
		const partial = await provider.getSuggestions(["line one", "Use @rev here"], 1, 8, options);
		expect(partial?.items.map((item) => item.label)).toContain("@Review");
		expect(partial?.items.some((item) => item.label === "@Disabled")).toBe(false);

		const midToken = await provider.getSuggestions(["first line", "Use @ReView later"], 1, 7, options);
		const review = midToken?.items.find((item) => item.label === "@Review");
		if (!review || !midToken) throw new Error("Expected mid-token Review suggestion");
		expect(provider.applyCompletion(["first line", "Use @ReView later"], 1, 7, review, midToken.prefix)).toEqual({
			lines: ["first line", "Use @Review later"],
			cursorLine: 1,
			cursorCol: 11,
		});

		const end = await provider.getSuggestions(["Use @Review"], 0, 11, options);
		expect(end?.items.some((item) => item.label === "@Review")).toBe(true);
		const email = await provider.getSuggestions(["name@example"], 0, 12, options);
		expect((email?.items ?? []).some((item) => item.label === "@Review")).toBe(false);
		const path = await provider.getSuggestions(["src/@Review"], 0, 11, options);
		expect((path?.items ?? []).some((item) => item.label === "@Review")).toBe(false);
	});
});
