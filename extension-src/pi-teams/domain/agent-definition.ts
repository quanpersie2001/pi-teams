// Specialist agent definition contracts.
//
// A definition describes the worker (type, prompt, model policy, tool
// allowlist), never the work — task priority/dependencies belong to pi-tasks.
// A snapshot is the immutable resolved invocation captured at spawn time so
// active runs survive agent-file reloads unchanged.

import { MAX_BUDGET_SECONDS } from "./time-policy.js";

/** Thinking level mirror of Pi's model thinking levels (kept dependency-free). */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type PromptMode = "replace" | "append";

/** Worktree policy: `off` is a genuine veto from the agent file. */
export type IsolationPolicy = "worktree" | "off";

export interface AgentDefinition {
	type: string;
	description: string;
	/** System prompt used according to promptMode. */
	systemPrompt: string;
	/** Extra specialist instructions appended after systemPrompt handling. */
	instructions?: string;
	/** Model pin/fuzzy name; absent = inherit caller's model. */
	model?: string;
	thinking?: ThinkingLevel;
	/** Built-in tool allowlist; absent = default toolset. Empty array = none. */
	tools?: readonly string[];
	/** Turn limit; 0 = pinned unlimited; absent = unspecified (settings/overrides decide). */
	maxTurnLimit?: number;
	/** Wall-clock budget in whole seconds for the whole run. Absent = unspecified. */
	timeout?: number;
	/** Idle budget in whole seconds without child output. Absent = unspecified. */
	idleTimeout?: number;
	promptMode: PromptMode;
	defaultBackground: boolean;
	isolationPolicy: IsolationPolicy;
	enabled: boolean;
	/** Path of the .md this was loaded from; absent for bundled defaults. */
	loadedFrom?: string;
	resolvedAt: number;
}

/** Spawn-time overrides requested by the caller (spawn request / tool call). */
export interface AgentInvocationOverrides {
	model?: string;
	thinking?: ThinkingLevel;
	tools?: readonly string[];
	maxTurnLimit?: number;
	/** Wall-clock budget in whole seconds; beats the definition, then settings. */
	timeout?: number;
	/** Idle budget in whole seconds; beats the definition, then settings. */
	idleTimeout?: number;
}

/**
 * Immutable resolved invocation: definition + requested overrides merged.
 * Captured once at spawn; later file reloads never mutate active runs.
 */
export interface AgentDefinitionSnapshot {
	readonly definition: AgentDefinition;
	readonly overrides: AgentInvocationOverrides;
	/** Effective merged values actually handed to the backend. */
	readonly resolved: ResolvedAgentInvocation;
}

export interface ResolvedAgentInvocation {
	type: string;
	description: string;
	systemPrompt: string;
	instructions?: string;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: readonly string[];
	maxTurnLimit?: number;
	/** Effective wall-clock budget in whole seconds; absent = unlimited. */
	timeout?: number;
	/** Effective idle budget in whole seconds; absent = unlimited. */
	idleTimeout?: number;
	promptMode: PromptMode;
	defaultBackground: boolean;
	isolationPolicy: IsolationPolicy;
	resolvedAt: number;
}

// ---- Agent file normalization (pure: no filesystem access) ----

/**
 * A raw agent Markdown file reduced to data by a host adapter (pi/agent-files.ts).
 * Pure shape so domain normalization never touches the filesystem itself.
 */
export interface AgentFileInput {
	/** Absolute or display path of the source .md (used in errors/warnings). */
	sourcePath: string;
	/** Parsed YAML frontmatter attributes. */
	frontmatter: Record<string, unknown>;
	/** Markdown body after the frontmatter block = system instructions. */
	body: string;
	/** Filename without extension; stands in as the type when `name:` is absent/invalid. */
	filenameStem?: string;
}

/**
 * Canonical built-in tool names mirrored from pi's coding + read-only tool
 * factories (read, bash, edit, write, grep, find, ls). Overridable via
 * NormalizeOptions so hosts can keep the set in sync with pi.
 */
export const DEFAULT_BUILTIN_TOOL_NAMES: readonly string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Error for a malformed agent file. Carries the file path for actionable messages. */
export class AgentFileError extends Error {
	constructor(
		readonly sourcePath: string,
		message: string,
	) {
		super(`${sourcePath}: ${message}`);
		this.name = "AgentFileError";
	}
}

export interface NormalizeAgentDefinitionOptions {
	/**
	 * strictAgentFiles behavior:
	 * - File-level failure (unreadable/unparseable frontmatter) and field-level
	 *   invalid values THROW AgentFileError naming the file.
	 * - When false (default): field-level problems collect a warning and fall
	 *   back to a sensible default, keeping the agent; file-level failures are
	 *   reported by the caller (registry) and the FILE is skipped.
	 */
	strict?: boolean;
	/**
	 * Value of the operational `backgroundByDefault` setting: used when the
	 * frontmatter omits `run_in_background` (settings rank above built-in
	 * defaults per CONFIGURATION §4).
	 */
	defaultBackground?: boolean;
	/** Built-in tool universe for wildcard expansion; defaults to DEFAULT_BUILTIN_TOOL_NAMES. */
	builtinToolNames?: readonly string[];
}

export interface NormalizedAgentFile {
	definition: AgentDefinition;
	/** Non-fatal field-level corrections applied while normalizing (lenient mode). */
	warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Extract a trimmed non-empty string, else undefined. */
function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** The one reserved character in a declared type (plugin-scoped identifier syntax). */
const RESERVED_IN_TYPE = ":";

const VALID_THINKING_LEVELS: ReadonlySet<string> = new Set<string>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

/**
 * Validate one budget value (frontmatter `timeout` / `idle_timeout` /
 * `idle-timeout`, or a spawn-request override). Budgets are strict, unlike
 * sanitized settings:
 * - absent (`undefined`) → undefined ("unspecified"; settings tier decides);
 * - any PROVIDED value must be a positive safe whole number of seconds within
 *   the timer range [1, MAX_BUDGET_SECONDS];
 * - null, 0, negatives, fractions, non-finite or non-number values throw —
 *   a malformed budget never silently becomes "unlimited".
 */
export function parseBudgetSeconds(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_BUDGET_SECONDS) {
		throw new TypeError(
			`invalid ${field}: must be a positive whole number of seconds (1–${MAX_BUDGET_SECONDS}); got ${String(value)}`,
		);
	}
	return value;
}

/**
 * Parse the `tools:` CSV into an allowlist.
 * - omitted/null → undefined (meaning: default toolset = all built-ins);
 * - "none"/empty → [] (explicitly zero tools);
 * - "*" or "all" (case-insensitive) expands to all built-ins plus any plain
 *   extra entries named alongside it;
 * - otherwise the comma-separated entries themselves.
 */
export function parseToolsField(value: unknown, builtinToolNames: readonly string[]): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	const rawEntries: unknown[] = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [value];
	const entries = rawEntries.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
	if (entries.length === 0) return [];
	const isWildcard = (entry: string) => entry === "*" || entry.toLowerCase() === "all";
	if (entries.some(isWildcard)) {
		const plain = entries.filter((entry) => !isWildcard(entry));
		return [...new Set([...builtinToolNames, ...plain])];
	}
	if (entries.length === 1 && entries[0]?.toLowerCase() === "none") return [];
	return entries;
}

/**
 * Normalize one raw agent file into an AgentDefinition.
 *
 * strictAgentFiles semantics (documented decision):
 * - FIELD-level invalid values (bad thinking level, negative max_turns, a
 *   declared name containing ":", non-boolean enabled/isolation, ...):
 *   strict=true throws AgentFileError naming the file; strict=false collects
 *   a warning and applies a sensible default, keeping the agent.
 * - FILE-level failure (the host adapter could not read/parse the file) is
 *   surfaced via RawAgentFile.error by the caller: strict must fail startup,
 *   lenient skips the whole file with a warning. normalizeAgentDefinition
 *   also treats a missing/invalid derived name as file-level.
 */
export function normalizeAgentDefinition(
	input: AgentFileInput,
	options: NormalizeAgentDefinitionOptions = {},
): NormalizedAgentFile {
	const strict = options.strict === true;
	const warnings: string[] = [];
	const fail = (message: string): never => {
		throw new AgentFileError(input.sourcePath, message);
	};
	const warnOrThrow = (field: string, message: string, fallback: string): void => {
		if (strict) fail(`invalid ${field}: ${message}`);
		warnings.push(`invalid ${field} (${message}); using ${fallback}`);
	};

	const fm = isRecord(input.frontmatter) ? input.frontmatter : {};

	// Type: declared `name:` wins; empty/whitespace falls back to the filename
	// stem (a quoted-empty name would otherwise register under ""). A declared
	// name containing ":" is rejected rather than silently substituted.
	const fallbackName = str(input.filenameStem) ?? "unnamed-agent";
	const declared = str(fm.name);
	let name: string;
	if (declared === undefined) {
		name = fallbackName;
	} else if (declared.includes(RESERVED_IN_TYPE)) {
		warnOrThrow("name", `"${declared}" uses reserved character "${RESERVED_IN_TYPE}"`, fallbackName);
		name = fallbackName;
	} else {
		name = declared;
	}

	const description = str(fm.description) ?? name;

	const builtinToolNames = options.builtinToolNames ?? DEFAULT_BUILTIN_TOOL_NAMES;
	const tools = parseToolsField(fm.tools, builtinToolNames);

	let model: string | undefined;
	if (typeof fm.model === "string") {
		model = str(fm.model);
	} else if (fm.model !== undefined && fm.model !== null) {
		warnOrThrow("model", "not a string", "inherited");
	}

	let thinking: ThinkingLevel | undefined;
	const rawThinking = str(fm.thinking)?.toLowerCase();
	if (rawThinking !== undefined) {
		if (VALID_THINKING_LEVELS.has(rawThinking)) {
			thinking = rawThinking as ThinkingLevel;
		} else if (fm.thinking === null) {
			// omitted
		} else {
			warnOrThrow("thinking", `"${String(fm.thinking)}" is not a valid thinking level`, "inherited");
		}
	}

	let maxTurnLimit: number | undefined;
	if (typeof fm.max_turns === "number" && Number.isFinite(fm.max_turns)) {
		const turns = Math.floor(fm.max_turns);
		if (turns >= 0 && turns === fm.max_turns) {
			// Explicit 0 is PINNED unlimited: it outranks the defaultMaxTurns
			// setting at invocation time. Absent means unspecified instead.
			maxTurnLimit = turns;
		} else {
			warnOrThrow("max_turns", String(fm.max_turns), "unlimited");
		}
	} else if (fm.max_turns !== undefined && fm.max_turns !== null) {
		warnOrThrow("max_turns", "not a number", "unlimited");
	}

	// Time budgets (roadmap 1.1): `timeout`, `idle_timeout` (canonical) and the
	// original port alias `idle-timeout`. Unlike turn-limit fields these are
	// FILE-level strict in BOTH modes: a malformed budget rejects the whole
	// file (never silently "unlimited"), and specifying both idle spellings is
	// an ambiguous conflict.
	let timeout: number | undefined;
	try {
		timeout = parseBudgetSeconds(fm.timeout, "timeout");
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
	const hasIdleSnake = "idle_timeout" in fm;
	const hasIdleKebab = "idle-timeout" in fm;
	if (hasIdleSnake && hasIdleKebab) {
		fail("invalid idle_timeout: specify either idle_timeout or idle-timeout, not both");
	}
	let idleTimeout: number | undefined;
	try {
		idleTimeout = parseBudgetSeconds(hasIdleSnake ? fm.idle_timeout : fm["idle-timeout"], "idle_timeout");
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}

	// prompt_mode: anything other than "append" (including invalid/omitted)
	// normalizes to "replace", mirroring the reference implementation.
	const promptMode: PromptMode = str(fm.prompt_mode)?.toLowerCase() === "append" ? "append" : "replace";

	let defaultBackground = options.defaultBackground === true;
	if (typeof fm.run_in_background === "boolean") {
		defaultBackground = fm.run_in_background;
	} else if (fm.run_in_background !== undefined && fm.run_in_background !== null) {
		warnOrThrow("run_in_background", "not a boolean", String(defaultBackground));
	}

	let isolationPolicy: IsolationPolicy = "off";
	const rawIsolation = str(fm.isolation)?.toLowerCase();
	if (rawIsolation === "worktree") {
		isolationPolicy = "worktree";
	} else if (rawIsolation === "off" || rawIsolation === "none" || rawIsolation === "no") {
		isolationPolicy = "off";
	} else if (rawIsolation !== undefined) {
		warnOrThrow("isolation", `"${String(fm.isolation)}" is not worktree|off`, "off");
	}

	let enabled = true;
	if (typeof fm.enabled === "boolean") {
		enabled = fm.enabled;
	} else if (fm.enabled !== undefined && fm.enabled !== null) {
		warnOrThrow("enabled", "not a boolean", "true");
	}

	const definition: AgentDefinition = {
		type: name,
		description,
		systemPrompt: input.body.trim(),
		promptMode,
		defaultBackground,
		isolationPolicy,
		enabled,
		loadedFrom: input.sourcePath,
		resolvedAt: Date.now(),
	};
	if (model !== undefined) definition.model = model;
	if (thinking !== undefined) definition.thinking = thinking;
	if (tools !== undefined) definition.tools = tools;
	if (maxTurnLimit !== undefined) definition.maxTurnLimit = maxTurnLimit;
	if (timeout !== undefined) definition.timeout = timeout;
	if (idleTimeout !== undefined) definition.idleTimeout = idleTimeout;

	return { definition, warnings };
}

/** Merge a definition with requested overrides into an immutable snapshot. */
export function resolveAgentSnapshot(
	definition: AgentDefinition,
	overrides: AgentInvocationOverrides = {},
): AgentDefinitionSnapshot {
	// Budget overrides are strict: a malformed provided value fails the whole
	// resolution instead of degrading to the definition/settings tier.
	const overrideTimeout = parseBudgetSeconds(overrides.timeout, "timeout override");
	const overrideIdleTimeout = parseBudgetSeconds(overrides.idleTimeout, "idleTimeout override");
	const resolved: ResolvedAgentInvocation = {
		type: definition.type,
		description: definition.description,
		systemPrompt: definition.systemPrompt,
		promptMode: definition.promptMode,
		defaultBackground: definition.defaultBackground,
		isolationPolicy: definition.isolationPolicy,
		resolvedAt: definition.resolvedAt,
	};
	if (definition.instructions !== undefined) resolved.instructions = definition.instructions;
	if (definition.model !== undefined) resolved.model = definition.model;
	if (definition.thinking !== undefined) resolved.thinking = definition.thinking;
	if (definition.tools !== undefined) resolved.tools = [...definition.tools];
	if (definition.maxTurnLimit !== undefined) resolved.maxTurnLimit = definition.maxTurnLimit;
	if (definition.timeout !== undefined) resolved.timeout = definition.timeout;
	if (definition.idleTimeout !== undefined) resolved.idleTimeout = definition.idleTimeout;

	if (overrides.model !== undefined) resolved.model = overrides.model;
	if (overrides.thinking !== undefined) resolved.thinking = overrides.thinking;
	if (overrides.tools !== undefined) resolved.tools = [...overrides.tools];
	if (overrides.maxTurnLimit !== undefined) resolved.maxTurnLimit = overrides.maxTurnLimit;
	// Budgets deliberately take the override even when the definition pins one
	// (invocation > definition > settings for these new fields).
	if (overrideTimeout !== undefined) resolved.timeout = overrideTimeout;
	if (overrideIdleTimeout !== undefined) resolved.idleTimeout = overrideIdleTimeout;

	return { definition, overrides, resolved };
}
