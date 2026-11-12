import type { ChildState } from "../domain/child-protocol.js";

type NativeEntry = {
	type: string;
	usage?: unknown;
	message?: { role: string; content?: unknown; usage?: unknown };
};

/** Mirrors native session-wide accounting, including off-branch and summary usage. Never prices tokens. */
export function childSessionStats(
	entries: readonly NativeEntry[] | undefined,
): (Omit<NonNullable<NonNullable<ChildState["focus"]>["stats"]>, "cost"> & { cost?: number }) | undefined {
	if (!entries) return undefined;
	let userMessages = 0;
	let assistantMessages = 0;
	let toolCalls = 0;
	let toolResults = 0;
	let totalMessages = 0;
	const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	let cost = 0;
	let validCost = true;
	let recordedCost = false;
	const addUsage = (value: unknown) => {
		if (!value || typeof value !== "object") return;
		const usage = value as Record<string, unknown>;
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const amount = usage[key];
			if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) tokens[key] += amount;
		}
		const recorded = (usage.cost as { total?: unknown } | undefined)?.total;
		if (typeof recorded === "number" && Number.isFinite(recorded) && recorded >= 0) {
			cost += recorded;
			recordedCost = true;
		} else validCost = false;
	};
	for (const entry of entries) {
		if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") addUsage(entry.usage);
		if (entry.type !== "message" || !entry.message) continue;
		totalMessages++;
		const message = entry.message;
		if (message.role === "user") userMessages++;
		else if (message.role === "toolResult") {
			toolResults++;
			addUsage(message.usage);
		} else if (message.role === "assistant") {
			assistantMessages++;
			if (Array.isArray(message.content))
				toolCalls += message.content.filter((part) => part?.type === "toolCall").length;
			addUsage(message.usage);
		}
	}
	tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
	return {
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages,
		tokens,
		...(recordedCost && validCost && Number.isFinite(cost) ? { cost } : {}),
	};
}

/** Preserve protocol-v2 legacy stats: missing billing travels only in the additive usage field. */
export function childSessionMetadata(
	entries: readonly NativeEntry[] | undefined,
): Pick<NonNullable<ChildState["focus"]>, "sessionUsage" | "stats"> | undefined {
	const stats = childSessionStats(entries);
	if (!stats) return undefined;
	return {
		sessionUsage: {
			scope: "session",
			inputTokens: stats.tokens.input,
			outputTokens: stats.tokens.output,
			cacheReadTokens: stats.tokens.cacheRead,
			cacheWriteTokens: stats.tokens.cacheWrite,
			...(stats.cost !== undefined ? { cost: stats.cost } : {}),
		},
		...(stats.cost !== undefined ? { stats: { ...stats, cost: stats.cost } } : {}),
	};
}
