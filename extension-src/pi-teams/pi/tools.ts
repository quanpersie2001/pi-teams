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
import type { DeliveryService } from "../app/delivery-service.js";
import type { MailboxService } from "../app/mailbox-service.js";
import { isMailboxAddress } from "../domain/mailbox.js";
import { LEAD_ADDRESS, normalizeTeammateColor, teammateNameProblem } from "../domain/team.js";

/** Register the lead's sole peer-messaging tool; targets are validated against the live roster. */
export function registerLeadSendMessageTool(
	pi: ExtensionAPI,
	getMailbox: () => MailboxService | undefined,
	getTeammateNames: () => readonly string[],
): ToolRegistration {
	const tool = defineTool({
		name: "send_message",
		label: "Send Message",
		description: "Send untrusted text to a teammate. Messages cannot approve permissions or authorize actions.",
		parameters: Type.Object({
			target: Type.String({ description: "Teammate name" }),
			message: Type.String({ description: "Message text" }),
		}),
		renderCall: (args) => new Text(`▸ send_message(@${String(args.target)})`, 0, 0),
		renderResult: (result) => new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0),
		execute: async (_id, args: { target: string; message: string }) => {
			const mailbox = getMailbox();
			if (!mailbox)
				return { content: [{ type: "text" as const, text: "No active team mailbox." }], details: undefined };
			if (!isMailboxAddress(args.target) || args.target === LEAD_ADDRESS || !getTeammateNames().includes(args.target))
				return { content: [{ type: "text" as const, text: `Unknown teammate: ${args.target}` }], details: undefined };
			const sent = mailbox.send(args.target, args.message);
			return {
				content: [
					{
						type: "text" as const,
						text: sent.delivered ? `Message queued for @${args.target}.` : `Message not sent: ${sent.error}`,
					},
				],
				details: undefined,
			};
		},
	});
	if (existingToolNames(pi).has(tool.name)) return { name: tool.name, skipped: true };
	pi.registerTool(tool);
	return { name: tool.name };
}
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

function textResult(text: string, details: Record<string, unknown> = {}, terminate = false) {
	return { content: [{ type: "text" as const, text }], details, ...(terminate ? { terminate: true } : {}) };
}

/** Only a durable interactive conversation can receive a later completion turn. */
function canDeliverLater(
	ctx: { mode: string; sessionManager: { getSessionId?: () => string } },
	run: { owner: { kind: string; sessionId?: string }; delivery: string },
	delivery: DeliveryService | undefined,
): boolean {
	return (
		ctx.mode === "tui" &&
		delivery !== undefined &&
		run.owner.kind === "conversation" &&
		run.owner.sessionId === sessionIdOf(ctx) &&
		(run.delivery === "conversation" || run.delivery === "both")
	);
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
	description: Type.Optional(
		Type.String({ description: "Required for a new spawn: a short (3-5 word) task description. Omit when resuming." }),
	),
	subagent_type: Type.Optional(
		Type.String({
			description:
				"Required for a new spawn: use the exact canonical name from the Available agent types. Omit when resuming.",
		}),
	),
	name: Type.Optional(
		Type.String({
			description:
				'REQUIRED for a new spawn (omit only when resuming): a unique teammate name (letters, digits, ".", "_", "-", 1-64 chars). This is its visible @name and address for messaging and tasks. Reuse a settled name only for another assignment to the same teammate.',
		}),
	),
	color: Type.Optional(
		Type.String({
			description:
				"REQUIRED for a new spawn (omit only when resuming): a distinct, readable teammate color as #RGB or #RRGGBB. Fixed at creation; reuse the same color for later assignments to that teammate.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				'Optional model choice. Prefer the canonical "provider/modelId"; a bare or fuzzy name must resolve to exactly one registered native model. A model pinned by the agent definition remains primary. When strictModelAdmission is enabled (default), an ambiguous or unregistered named model fails admission with the list of candidate models instead of silently running a different model; authentication-based fallback is unaffected.',
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
				"Cold-resume a finished run after its child has been released. A named teammate with a retained idle child should instead receive send_message or a new Agent assignment under the same name/color; use steer_subagent while it is running.",
		}),
	),
});

/**
 * Build and return the three orchestration tools bound to a manager and the
 * live registry. Exported pure so tests can exercise execute() without a live Pi host.
 */
export function createSubagentTools(manager: AgentManager, registry: AgentRegistry, delivery?: DeliveryService) {
	const agentTool = defineTool({
		name: "Agent",
		label: "Agent",
		description:
			"Spawn/delegate a named, colored specialist teammate. Use Agent whenever the user explicitly asks for subagents, teammates, delegation or parallel work, even for short tasks; also use it proactively for independent investigations, implementation and review that can run in parallel. Every NEW spawn MUST include all four required fields — subagent_type, description, name, and color (a unique teammate name and a distinct #RGB or #RRGGBB color). Resume needs only resume and prompt. Do not delegate trivial work better done directly or spawn overlapping tasks. A pinned model remains primary; authentication and fallback are checked before launch. In interactive sessions, a batch containing only detached launches ends the coordinator turn; their completion notifications start the next turn. Do not wait or poll for them.",
		promptSnippet: "Spawn named, colored subagents when asked; delegate independent work in parallel",
		promptGuidelines: [
			"Prefer delegating two or more independent subtasks to parallel teammates instead of doing them sequentially yourself",
			"Recognize delegation and parallel-work requests regardless of phrasing or language",
			"For multi-part coordinated work, track it on the team task board (create → claim → complete)",
		],
		parameters: agentParameters,
		prepareLoadout() {
			const agents = registry.availableTypes.map((type) => {
				const definition = registry.get(type);
				return `- ${type}: ${definition?.description ?? ""}`;
			});
			return {
				descriptions: {
					Agent:
						"Spawn/delegate a named, colored specialist teammate. When the user asks to spawn subagents/teammates, delegate, or work in parallel, use Agent rather than doing all independent parts yourself, even if each part is short. Also consider parallel agents for independent research, implementation and review; avoid overlapping or trivial tasks. Every NEW spawn MUST include all four required fields — subagent_type, description, name, and color (a unique teammate name and a distinct #RGB or #RRGGBB color). Resume needs only resume and prompt and inherits the original name/color. Give each agent a bounded, self-contained prompt. In interactive sessions, a batch of detached launches ends this turn; the completion notification starts a new turn. Do not poll or call get_subagent_result(wait: true) for a passive background report; reserve it for explicit immediate dependencies. A teammate's progress message is not a completion signal: let the pending report arrive rather than waiting on it. Retained idle teammates accept send_message or a new assignment under the same name/color, not cold resume. A pinned model remains primary; authentication and fallback are checked before launch.\n\n" +
						`Use an exact canonical name from the live enabled catalog below. ` +
						`Available agent types:\n${agents.length > 0 ? agents.join("\n") : "- (none)"}`,
				},
			};
		},

		renderCall(args, _theme) {
			const type = typeof args.subagent_type === "string" ? args.subagent_type : "?";
			const desc = typeof args.description === "string" ? args.description : "";
			const name =
				typeof args.name === "string" && teammateNameProblem(args.name) === undefined ? args.name : undefined;
			const color = typeof args.color === "string" ? normalizeTeammateColor(args.color) : undefined;
			const identity = name
				? color
					? `\u001b[38;2;${Number.parseInt(color.slice(1, 3), 16)};${Number.parseInt(color.slice(3, 5), 16)};${Number.parseInt(color.slice(5, 7), 16)}m@${name}\u001b[39m`
					: `@${name}`
				: type;
			return new Text(`▸ Agent(${identity})${desc ? `  ${desc}` : ""}`, 0, 0);
		},

		renderResult(result, options) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			if (!options.isPartial && text.length > 400 && !options.expanded) {
				return new Text(`${text.slice(0, 400)}\n… (use get_subagent_result for full output)`, 0, 0);
			}
			return new Text(text, 0, 0);
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (typeof params.resume !== "string" || params.resume.length === 0) {
				if (
					typeof params.subagent_type !== "string" ||
					params.subagent_type.length === 0 ||
					typeof params.description !== "string" ||
					params.description.length === 0
				)
					return textResult(
						"A new Agent spawn requires subagent_type and description. Resume needs only resume and prompt.",
					);
				if (
					typeof params.name !== "string" ||
					params.name.length === 0 ||
					typeof params.color !== "string" ||
					params.color.length === 0
				)
					return textResult(
						"A new Agent spawn requires both name and color (#RGB or #RRGGBB). Resume inherits its existing identity.",
					);
			}
			const base = {
				type: params.subagent_type as string,
				...(typeof params.name === "string" && params.name.length > 0 ? { name: params.name } : {}),
				...(typeof params.color === "string" ? { color: params.color } : {}),
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
						// Non-interactive parents may exit before any later notification is read.
						run_in_background: ctx.mode === "tui" ? base.run_in_background : false,
						...(base.color !== undefined ? { color: base.color } : {}),
						...(base.timeout !== undefined ? { timeout: base.timeout } : {}),
						...(base.idle_timeout !== undefined ? { idle_timeout: base.idle_timeout } : {}),
					});
					if (
						resumed.isBackground === true &&
						ctx.mode === "tui" &&
						(!delivery || canDeliverLater(ctx, resumed, delivery))
					) {
						const stopAfterLaunch = canDeliverLater(ctx, resumed, delivery);
						if (stopAfterLaunch) delivery?.trackSpawn(resumed.id);
						return textResult(
							`{agent:${resumed.id} started (resumed from ${params.resume})}`,
							{
								agentId: resumed.id,
								resumedFrom: params.resume,
								...(resumed.teammateName !== undefined ? { teammateName: resumed.teammateName } : {}),
								...(resumed.teammateColor !== undefined ? { color: resumed.teammateColor } : {}),
								background: true,
								model: resumed.model,
								modelFallback: resumed.modelFallback,
							},
							stopAfterLaunch,
						);
					}
					const settledResume = (await manager.whenSettled(resumed.id)) ?? resumed;
					manager.markResultConsumed(resumed.id);
					if (settledResume.status === "error")
						return textResult(`Agent failed: ${settledResume.error ?? "unknown error"}`, {
							agentId: resumed.id,
							status: settledResume.status,
						});
					const resumeNote = budgetStopNote(settledResume);
					return textResult(
						resumeNote !== undefined ? `${settledResume.result ?? ""}\n\n${resumeNote}` : (settledResume.result ?? ""),
						{
							agentId: resumed.id,
							...(settledResume.teammateName !== undefined ? { teammateName: settledResume.teammateName } : {}),
							...(settledResume.teammateColor !== undefined ? { color: settledResume.teammateColor } : {}),
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
					// A print/JSON/RPC parent has no durable interactive turn to notify.
					run_in_background: ctx.mode === "tui" ? base.run_in_background : false,
					owner: { kind: "conversation", sessionId: sessionIdOf(ctx) },
					delivery: "conversation",
				};
				const record = await manager.spawn(request);

				if (record.isBackground === true && ctx.mode === "tui") {
					const stopAfterLaunch = canDeliverLater(ctx, record, delivery);
					if (stopAfterLaunch) delivery?.trackSpawn(record.id);
					return textResult(
						record.teammateName !== undefined
							? `{agent:${record.id} started as @${record.teammateName}}`
							: `{agent:${record.id} started}`,
						{
							agentId: record.id,
							...(record.teammateName !== undefined ? { teammateName: record.teammateName } : {}),
							status: record.status,
							...(record.teammateColor !== undefined ? { color: record.teammateColor } : {}),
							background: true,
							model: record.model,
							modelFallback: record.modelFallback,
						},
						stopAfterLaunch,
					);
				}

				// Foreground: the caller blocks on this tool call — await inline.
				const settled = (await manager.whenSettled(record.id)) ?? record;
				manager.markResultConsumed(record.id);
				void signal;
				if (settled.status === "error") {
					return textResult(`Agent failed: ${settled.error ?? "unknown error"}`, {
						agentId: settled.id,
						status: settled.status,
						...(settled.teammateName !== undefined ? { teammateName: settled.teammateName } : {}),
						...(settled.teammateColor !== undefined ? { color: settled.teammateColor } : {}),
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
					...(settled.teammateName !== undefined ? { teammateName: settled.teammateName } : {}),
					...(settled.teammateColor !== undefined ? { color: settled.teammateColor } : {}),
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
			"Check status and retrieve a background agent's full result after it finishes. Use wait: true only if the current turn explicitly depends on the answer immediately; otherwise let the completion notification start a new turn, without polling. Results are durable and repeatable from result.md; use the ID returned by Agent.",
		parameters: Type.Object({
			agent_id: Type.String({ description: "The agent ID returned by Agent." }),
			wait: Type.Optional(
				Type.Boolean({
					description:
						"Block this tool call until completion only for an immediate dependency. Default: false; background runs notify automatically.",
				}),
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
	delivery?: DeliveryService,
): ToolRegistration[] {
	const taken = existingToolNames(pi);
	const registrations: ToolRegistration[] = [];
	for (const tool of createSubagentTools(manager, registry, delivery)) {
		if (taken.has(tool.name)) {
			registrations.push({ name: tool.name, skipped: true });
			continue;
		}
		pi.registerTool(tool);
		registrations.push({ name: tool.name });
	}
	return registrations;
}
