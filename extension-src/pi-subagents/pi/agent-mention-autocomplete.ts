import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import type { AgentRegistry } from "../app/agent-registry.js";

const MENTION_PREFIX = "\u0000pi-subagents-agent-mention\u0000";
const installedContexts = new WeakSet<object>();

type CompletionOrigin =
	| { kind: "agent"; type: string }
	| { kind: "native"; provider: AutocompleteProvider; prefix: string };
type AgentMention = { query: string; start: number };

/** Match only a standalone @ token on the cursor line, never an email or path component. */
function findMention(line: string, cursorCol: number): AgentMention | undefined {
	const beforeCursor = line.slice(0, cursorCol);
	const match = /(?:^|[ \t])@([^\s/@:]*)$/.exec(beforeCursor);
	if (!match) return undefined;
	const query = match[1] ?? "";
	return { query, start: beforeCursor.length - query.length - 1 };
}

function createAgentMentionProvider(current: AutocompleteProvider, registry: AgentRegistry): AutocompleteProvider {
	const origins = new WeakMap<AutocompleteItem, CompletionOrigin>();

	return {
		triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "@"])],
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const line = lines[cursorLine] ?? "";
			const mention = findMention(line, cursorCol);
			if (!mention) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const native = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			if (options.signal.aborted) return native;

			const agentItems = registry.availableTypes.flatMap((type): AutocompleteItem[] => {
				const definition = registry.get(type);
				if (
					!definition?.enabled ||
					(mention.query.length > 0 && !type.toLocaleLowerCase().includes(mention.query.toLocaleLowerCase()))
				) {
					return [];
				}
				const item: AutocompleteItem = {
					value: type,
					label: `@${type}`,
					description: definition.description,
				};
				origins.set(item, { kind: "agent", type });
				return [item];
			});
			if (agentItems.length === 0) return native;

			if (native) {
				for (const item of native.items)
					origins.set(item, { kind: "native", provider: current, prefix: native.prefix });
			}
			return {
				items: [...agentItems, ...(native?.items ?? [])],
				prefix: MENTION_PREFIX,
			};
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const origin = origins.get(item);
			if (origin?.kind === "native") {
				return origin.provider.applyCompletion(lines, cursorLine, cursorCol, item, origin.prefix);
			}
			if (origin?.kind === "agent" && prefix === MENTION_PREFIX) {
				const nextLines = [...lines];
				const line = nextLines[cursorLine] ?? "";
				const mention = findMention(line, cursorCol);
				if (!mention) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
				let end = cursorCol;
				while (end < line.length && !/[\s/@:]/.test(line[end] ?? "")) end++;
				const replacement = `@${origin.type}`;
				nextLines[cursorLine] = `${line.slice(0, mention.start)}${replacement}${line.slice(end)}`;
				return { lines: nextLines, cursorLine, cursorCol: mention.start + replacement.length };
			}
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

/**
 * Adds registry-backed @agent suggestions over Pi's current provider. Install once
 * from session_start; Pi 1.0.4 resets autocomplete wrappers between sessions and
 * extension reloads, so retain no wrapper/disposer across those boundaries.
 */
export function installAgentMentionAutocomplete(ctx: Pick<ExtensionContext, "ui">, registry: AgentRegistry): void {
	if (installedContexts.has(ctx)) return;
	installedContexts.add(ctx);
	ctx.ui.addAutocompleteProvider((current) => createAgentMentionProvider(current, registry));
}
