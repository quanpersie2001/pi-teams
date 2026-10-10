// Read-only model preflight tool (ARCHITECTURE.md §11): resolve a model
// reference before spawning an Agent, instead of discovering the mistake after
// teammates are already running.
//
// pi/-layer adapter only: parameter schema, rendering and a thin execute that
// delegates to the native catalog helper in model-admission.ts. No run state
// and no extra ModelRuntime live here.

import { defineTool, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { listNativeModels } from "./model-admission.js";

export const LIST_MODELS_TOOL_NAME = "list_models";

export const LIST_MODELS_DESCRIPTION =
	"Read-only: lists registered native Pi models as canonical provider/modelId with display names so a model can be resolved before spawning an Agent. Use the exact returned provider/modelId as Agent's `model`; an ambiguous bare name is a resolution error.";

function result(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

type TextResult = { content: ReadonlyArray<{ type: string; text?: string }> };

function resultText(result: TextResult): string {
	const first = result.content[0];
	return first !== undefined && first.type === "text" && typeof first.text === "string" ? first.text : "";
}

/** Build the read-only model preflight tool; exported pure so tests can drive execute() without a host. */
export function createModelTools(): ToolDefinition[] {
	return [
		defineTool({
			name: LIST_MODELS_TOOL_NAME,
			label: "List Models",
			description: LIST_MODELS_DESCRIPTION,
			parameters: Type.Object({
				query: Type.Optional(
					Type.String({
						description: "Case-insensitive substring matched against provider/modelId or display name.",
					}),
				),
				limit: Type.Optional(
					Type.Number({
						description: "Maximum rows to return (default 50).",
						minimum: 1,
						maximum: 200,
					}),
				),
			}),
			renderCall: (args) => {
				const query = typeof args.query === "string" && args.query.length > 0 ? `"${args.query}"` : "";
				return new Text(`▸ list_models(${query})`, 0, 0);
			},
			renderResult: (result) => new Text(resultText(result), 0, 0),
			execute: async (_id: string, args: { query?: string; limit?: number }) => {
				const { total, rows } = await listNativeModels({
					...(args.query ? { query: args.query } : {}),
					...(args.limit ? { limit: args.limit } : {}),
				});
				if (rows.length === 0) {
					return result(
						args.query ? `No registered model matches "${args.query}".` : "No registered models are available.",
					);
				}
				const lines = rows.map((row) => `${row.ref} — ${row.name}`);
				if (rows.length < total) lines.push(`${rows.length} of ${total} matching models shown`);
				return result(lines.join("\n"));
			},
		}),
	];
}

/** Skip names already claimed by Pi or another extension instead of double-registering. */
function existingToolNames(pi: ExtensionAPI): Set<string> {
	try {
		return new Set(pi.getAllTools().map((tool) => tool.name));
	} catch {
		return new Set();
	}
}

export interface ModelToolRegistration {
	name: string;
	skipped?: boolean;
}

/** Register the model preflight tool unless its name is already taken. */
export function registerModelTools(pi: ExtensionAPI): ModelToolRegistration[] {
	const taken = existingToolNames(pi);
	const registrations: ModelToolRegistration[] = [];
	for (const tool of createModelTools()) {
		if (taken.has(tool.name)) {
			registrations.push({ name: tool.name, skipped: true });
			continue;
		}
		pi.registerTool(tool);
		registrations.push({ name: tool.name });
	}
	return registrations;
}
