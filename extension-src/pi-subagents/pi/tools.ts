// Model-facing orchestration tools (ARCHITECTURE.md §11): Agent,
// get_subagent_result, steer_subagent.
//
// pi/-layer adapter only: parameter schemas, rendering and thin execute
// functions that delegate to the AgentManager. No run state lives here.

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentManager, budgetStopNote, type GetResultOptions, type SpawnRequest } from "../app/agent-manager.js";
import type { AgentRegistry } from "../app/agent-registry.js";
import type { InboxRecipient, MessageEndpoint } from "../domain/message.js";

/** Skip names already registered by Pi or another extension instead of double-registering. */
function existingToolNames(pi: ExtensionAPI): Set<string> {
	try {
		return new Set(pi.getAllTools().map((tool) => tool.name));
	} catch {
		return new Set();
	}
}

export interface ToolRegistration {
	name: string;
	skipped?: boolean;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

/** Session id for default conversation ownership; degrade when unavailable. */
function sessionIdOf(ctx: { sessionManager: { getSessionId?: () => string } }): string {
	try {
		const id = ctx.sessionManager.getSessionId?.();
		return typeof id === "string" && id.length > 0 ? id : "unknown-session";
	} catch {
		return "unknown-session";
	}
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const agentParameters = Type.Object({
	prompt: Type.String({ description: "The task for the agent to perform." }),
	description: Type.String({ description: "A short (3-5 word) description of the task (shown in UI)." }),
	subagent_type: Type.String({
		description:
			"Use the exact canonical spelling from the Available agent types listed in this tool's description. Do not invent aliases.",
	}),
	model: Type.Optional(
		Type.String({
			description:
				'Optional model choice. Accepts "provider/modelId" or a fuzzy name. A pinned agent model remains primary; this choice can be an automatic fallback if the primary is unavailable.',
		}),
	),
	thinking: Type.Optional(
		Type.String({
			description: `Thinking level: ${THINKING_LEVELS.join(", ")}. Overrides agent default.`,
		}),
	),
	max_turns: Type.Optional(
		Type.Number({
			description: "Maximum number of agentic turns before stopping. Omit for the configured default.",
			minimum: 1,
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Optional hard wall-clock budget in whole seconds for the entire run. The agent is stopped when the budget is exhausted; its partial output is returned and resuming re-applies the same limit. Omit for the configured default.",
			minimum: 1,
		}),
	),
	idle_timeout: Type.Optional(
		Type.Number({
			description:
				"Optional hard idle budget in whole seconds without new agent output (its messages and completed tool results; your steers and status checks do not count). The agent is stopped when quiet this long; resuming re-applies the same limit. Omit for the configured default.",
			minimum: 1,
		}),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Defaults per configuration — agents run detached by default, returning their ID immediately; you are notified on completion. Set false only when your very next action depends on the result; the call then blocks and returns the agent's output inline.",
		}),
	),
	resume: Type.Optional(
		Type.String({
			description:
				"Optional agent ID to resume from. Continues from previous context. An agent can only be resumed once its current run has finished — use steer_subagent mid-run.",
		}),
	),
});

/**
 * Build and return the three orchestration tools bound to a manager and the
 * live registry. Exported pure so tests can exercise execute() without a live Pi host.
 */
export function createSubagentTools(manager: AgentManager, registry: AgentRegistry) {
	const agentTool = defineTool({
		name: "Agent",
		label: "Agent",
		description:
			"Launch a specialist sub-agent for a task matching its description. A pinned agent model remains primary; model availability and authentication are checked before spawning, with automatic fallback to an available authenticated model. Subagents are valuable for parallelizing independent queries or protecting this conversation from excessive results. When the agent runs detached you will be notified on completion — do not poll or sleep waiting for it.",
		promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
		parameters: agentParameters,
		prepareLoadout() {
			const agents = registry.availableTypes.map((type) => {
				const definition = registry.get(type);
				return `- ${type}: ${definition?.description ?? ""}`;
			});
			return {
				descriptions: {
					Agent:
						"Launch a specialist sub-agent for a task matching its description. A pinned agent model remains primary; model availability and authentication are checked before spawning, with automatic fallback to an available authenticated model. Subagents are valuable for parallelizing independent queries or protecting this conversation from excessive results. When the agent runs detached you will be notified on completion — do not poll or sleep waiting for it.\n\n" +
						`Use an exact canonical name from the live enabled catalog below. ` +
						`Available agent types:\n${agents.length > 0 ? agents.join("\n") : "- (none)"}`,
				},
			};
		},

		renderCall(args, _theme) {
			const type = typeof args.subagent_type === "string" ? args.subagent_type : "?";
			const desc = typeof args.description === "string" ? args.description : "";
			return new Text(`▸ Agent(${type})${desc ? `  ${desc}` : ""}`, 0, 0);
		},

		renderResult(result, options) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			if (!options.isPartial && text.length > 400 && !options.expanded) {
				return new Text(`${text.slice(0, 400)}\n… (use get_subagent_result for full output)`, 0, 0);
			}
			return new Text(text, 0, 0);
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const base = {
				type: params.subagent_type as string,
				prompt: params.prompt as string,
				description: params.description as string,
				model: params.model as string | undefined,
				thinking: params.thinking as (typeof THINKING_LEVELS)[number] | undefined,
				max_turns: params.max_turns as number | undefined,
				timeout: params.timeout as number | undefined,
				idle_timeout: params.idle_timeout as number | undefined,
				run_in_background: params.run_in_background as boolean | undefined,
			};

			try {
				// Resume path: reopen a finished run's persisted session as a new
				// run; subagent_type is ignored there on purpose.
				if (typeof params.resume === "string" && params.resume.length > 0) {
					const resumed = await manager.resume(params.resume, base.prompt, {
						run_in_background: base.run_in_background,
						...(base.timeout !== undefined ? { timeout: base.timeout } : {}),
						...(base.idle_timeout !== undefined ? { idle_timeout: base.idle_timeout } : {}),
					});
					if (resumed.isBackground === true) {
						return textResult(`{agent:${resumed.id} started (resumed from ${params.resume})}`, {
							agentId: resumed.id,
							resumedFrom: params.resume,
							background: true,
							model: resumed.model,
							modelFallback: resumed.modelFallback,
						});
					}
					const settledResume = (await manager.whenSettled(resumed.id)) ?? resumed;
					manager.markResultConsumed(resumed.id);
					const resumeNote = budgetStopNote(settledResume);
					return textResult(
						resumeNote !== undefined ? `${settledResume.result ?? ""}\n\n${resumeNote}` : (settledResume.result ?? ""),
						{
							agentId: resumed.id,
							model: settledResume.model,
							modelFallback: settledResume.modelFallback,
							...(settledResume.budgetExhausted !== undefined
								? { budgetExhausted: settledResume.budgetExhausted }
								: {}),
							...(settledResume.budgetSeconds !== undefined ? { budgetSeconds: settledResume.budgetSeconds } : {}),
						},
					);
				}

				// Direct tools use conversation ownership and delivery.
				// Background mode defaults from the resolved definition when
				// the invocation does not explicitly select a mode.
				const request: SpawnRequest = {
					...base,
					owner: { kind: "conversation", sessionId: sessionIdOf(ctx) },
					delivery: "conversation",
				};
				const record = await manager.spawn(request);

				if (record.isBackground === true) {
					return textResult(`{agent:${record.id} started}`, {
						agentId: record.id,
						status: record.status,
						background: true,
						model: record.model,
						modelFallback: record.modelFallback,
					});
				}

				// Foreground: the caller blocks on this tool call — await inline.
				const settled = (await manager.whenSettled(record.id)) ?? record;
				manager.markResultConsumed(record.id);
				void signal;
				if (settled.status === "error") {
					return textResult(`Agent failed: ${settled.error ?? "unknown error"}`, {
						agentId: settled.id,
						status: settled.status,
						model: settled.model,
						modelFallback: settled.modelFallback,
					});
				}
				const budgetNote = budgetStopNote(settled);
				const resultText =
					budgetNote !== undefined ? `${settled.result ?? ""}\n\n${budgetNote}` : (settled.result ?? "");
				return textResult(resultText, {
					agentId: settled.id,
					status: settled.status,
					turns: settled.turns,
					toolUses: settled.toolUses,
					model: settled.model,
					modelFallback: settled.modelFallback,
					...(settled.budgetExhausted !== undefined ? { budgetExhausted: settled.budgetExhausted } : {}),
					...(settled.budgetSeconds !== undefined ? { budgetSeconds: settled.budgetSeconds } : {}),
				});
			} catch (error) {
				return textResult(error instanceof Error ? error.message : String(error));
			}
		},
	});

	const getResultTool = defineTool({
		name: "get_subagent_result",
		label: "Get Agent Result",
		description:
			"Check status and retrieve a background agent's full result — its completion notification carries only a preview. Use the agent ID returned by Agent.",
		promptSnippet: "Check status and retrieve results from a background agent",
		parameters: Type.Object({
			agent_id: Type.String({ description: "The agent ID returned by Agent." }),
			wait: Type.Optional(
				Type.Boolean({ description: "If true, wait for the agent to complete before returning. Default: false." }),
			),
		}),

		renderCall(args) {
			const id = typeof args.agent_id === "string" ? args.agent_id : "?";
			return new Text(`▸ get_subagent_result(${id})`, 0, 0);
		},

		renderResult(result) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(text, 0, 0);
		},

		async execute(_toolCallId, params, signal) {
			const getResultOptions: GetResultOptions = { wait: params.wait === true };
			if (signal !== undefined) getResultOptions.signal = signal;
			return textResult(await manager.getResult(params.agent_id as string, getResultOptions));
		},
	});

	const steerTool = defineTool({
		name: "steer_subagent",
		label: "Steer Agent",
		description:
			"Send a steering message to a running agent. The message interrupts the agent after its current tool execution and is injected into its conversation, redirecting its work mid-run. Only works on queued or running agents.",
		promptSnippet: "Send a steering message to redirect a running background agent",
		parameters: Type.Object({
			agent_id: Type.String({ description: "The agent ID to steer (must be currently running)." }),
			message: Type.String({ description: "The steering message to send." }),
		}),

		renderCall(args) {
			const id = typeof args.agent_id === "string" ? args.agent_id : "?";
			return new Text(`▸ steer_subagent(${id})`, 0, 0);
		},

		renderResult(result) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(text, 0, 0);
		},

		async execute(_toolCallId, params) {
			const agentId = params.agent_id as string;
			const status = manager.get(agentId)?.status;
			const queued = status === "queued" || status === "starting";
			const accepted = await manager.steer(agentId, params.message as string);
			if (!accepted) {
				return textResult(`Agent "${String(params.agent_id)}" cannot be steered (unknown id, or no longer running).`);
			}
			return textResult(
				queued
					? `Steering accepted and queued for agent ${String(params.agent_id)}.`
					: `Steering accepted by agent ${String(params.agent_id)}.`,
			);
		},
	});

	return [agentTool, getResultTool, steerTool];
}

/**
 * Register the three orchestration tools, skipping any name another party has
 * already claimed (see the collision note above). Returns what happened per
 * tool so the host can surface skips.
 */
export function registerSubagentTools(
	pi: ExtensionAPI,
	manager: AgentManager,
	registry: AgentRegistry,
): ToolRegistration[] {
	const taken = existingToolNames(pi);
	const registrations: ToolRegistration[] = [];
	for (const tool of createSubagentTools(manager, registry)) {
		if (taken.has(tool.name)) {
			registrations.push({ name: tool.name, skipped: true });
			continue;
		}
		pi.registerTool(tool);
		registrations.push({ name: tool.name });
	}
	return registrations;
}

/** Minimal messaging port so a child can bind authenticated RPC proxies without delegation tools. */
export interface InboxToolPort {
	sendFromParent?(
		sessionId: string,
		targetAgentId: string,
		text: string,
	): Promise<{ id: string; deliveredAt?: number }>;
	sendFromAgent(agentId: string, target: MessageEndpoint, text: string): Promise<{ id: string; deliveredAt?: number }>;
	listInbox(recipient: InboxRecipient): readonly unknown[] | Promise<readonly unknown[]>;
	consumeInbox(recipient: InboxRecipient, messageId: string): { id: string } | Promise<{ id: string }>;
}

export interface ParentInboxToolPort extends InboxToolPort {
	sendFromParent(sessionId: string, targetAgentId: string, text: string): Promise<{ id: string; deliveredAt?: number }>;
	listSessionMessages(sessionId: string): readonly unknown[] | Promise<readonly unknown[]>;
}

/** Scope comes from trusted runtime context/bootstrap, never from model parameters. */
export type InboxScopeResolver = (ctx: unknown) => InboxRecipient;

export function createInboxTools(port: InboxToolPort, resolveRecipient: InboxScopeResolver) {
	const sendTool = defineTool({
		name: "send_inbox_message",
		label: "Send Inbox Message",
		description:
			"Send a separate inbox message to the parent or a sibling agent in this parent session, without submitting its composer or reviving a closed child.",
		promptSnippet: "Send a scoped inbox message to the parent or sibling agent",
		parameters: Type.Object({
			target: Type.Union([
				Type.Literal("parent"),
				Type.Object({ agent_id: Type.String({ description: "Target sibling agent ID." }) }),
			]),
			text: Type.String({ description: "Message content." }),
		}),
		renderCall(args) {
			const target = args.target === "parent" ? "parent" : "agent";
			return new Text(`▸ send_inbox_message(${target})`, 0, 0);
		},
		renderResult(result) {
			return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const recipient = resolveRecipient(ctx);
				let target: MessageEndpoint;
				if (typeof params.target === "string") {
					target = { kind: "parent" };
				} else {
					target = { kind: "agent", agentId: params.target.agent_id };
				}
				let message: { id: string; deliveredAt?: number };
				if (recipient.kind === "parent") {
					if (target.kind !== "agent") {
						throw new Error("A parent may send inbox messages only to a child agent.");
					}
					if (!port.sendFromParent) throw new Error("Parent inbox sending is unavailable in this runtime.");
					message = await port.sendFromParent(recipient.sessionId, target.agentId, params.text);
				} else {
					message = await port.sendFromAgent(recipient.agentId, target, params.text);
				}
				const delivery =
					message.deliveredAt === undefined ? "queued for inbox reading" : "delivered to recipient session";
				return textResult(`Inbox message ${delivery} (${message.id}).`);
			} catch (error) {
				return textResult(error instanceof Error ? error.message : String(error));
			}
		},
	});

	const readTool = defineTool({
		name: "read_inbox",
		label: "Read Inbox",
		description: "Inspect unread inbox messages addressed to this parent session or child agent.",
		promptSnippet: "Read pending scoped inbox messages",
		parameters: Type.Object({}),
		renderCall() {
			return new Text("▸ read_inbox()", 0, 0);
		},
		renderResult(result) {
			return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
		},
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				const inbox = await port.listInbox(resolveRecipient(ctx));
				return textResult(inbox.length === 0 ? "Inbox is empty." : JSON.stringify(inbox));
			} catch (error) {
				return textResult(error instanceof Error ? error.message : String(error));
			}
		},
	});

	const consumeTool = defineTool({
		name: "consume_inbox_message",
		label: "Consume Inbox Message",
		description: "Mark one of this recipient's inbox messages read after inspecting it.",
		promptSnippet: "Consume a pending inbox message",
		parameters: Type.Object({ message_id: Type.String({ description: "ID from read_inbox." }) }),
		renderCall(args) {
			return new Text(`▸ consume_inbox_message(${String(args.message_id)})`, 0, 0);
		},
		renderResult(result) {
			return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const message = await port.consumeInbox(resolveRecipient(ctx), params.message_id);
				return textResult(`Consumed inbox message ${message.id}.`);
			} catch (error) {
				return textResult(error instanceof Error ? error.message : String(error));
			}
		},
	});
	return [sendTool, readTool, consumeTool];
}

/** Parent-only inspector for the complete session thread; child runtimes do not register this tool. */
export function createParentMessageInspectionTool(port: ParentInboxToolPort, resolveRecipient: InboxScopeResolver) {
	return defineTool({
		name: "inspect_subagent_messages",
		label: "Inspect Agent Messages",
		description:
			"Inspect retained inbox messages in this parent session, including messages sent to children and sibling-agent traffic.",
		promptSnippet: "Inspect parent-session agent messages",
		parameters: Type.Object({}),
		renderCall() {
			return new Text("▸ inspect_subagent_messages()", 0, 0);
		},
		renderResult(result) {
			return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
		},
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				const recipient = resolveRecipient(ctx);
				if (recipient.kind !== "parent") {
					throw new Error("Only the parent session may inspect the complete agent-message thread.");
				}
				const messages = await port.listSessionMessages(recipient.sessionId);
				return textResult(messages.length === 0 ? "No retained agent messages." : JSON.stringify(messages));
			} catch (error) {
				return textResult(error instanceof Error ? error.message : String(error));
			}
		},
	});
}

/** Register the parent-only thread inspector separately from child messaging tools. */
export function registerParentMessageInspectionTool(
	pi: ExtensionAPI,
	port: ParentInboxToolPort,
	resolveRecipient: InboxScopeResolver,
): ToolRegistration {
	const tool = createParentMessageInspectionTool(port, resolveRecipient);
	if (existingToolNames(pi).has(tool.name)) return { name: tool.name, skipped: true };
	pi.registerTool(tool);
	return { name: tool.name };
}

/** Register messaging-only tools separately from orchestration to preserve no-recursive-delegation boundaries. */
export function registerInboxTools(
	pi: ExtensionAPI,
	port: InboxToolPort,
	resolveRecipient: InboxScopeResolver,
): ToolRegistration[] {
	const taken = existingToolNames(pi);
	const registrations: ToolRegistration[] = [];
	for (const tool of createInboxTools(port, resolveRecipient)) {
		if (taken.has(tool.name)) {
			registrations.push({ name: tool.name, skipped: true });
			continue;
		}
		pi.registerTool(tool);
		registrations.push({ name: tool.name });
	}
	return registrations;
}
