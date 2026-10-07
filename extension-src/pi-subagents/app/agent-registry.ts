// Agent registry orchestration: precedence resolution across bundled/global/
// workspace/project agent sources, strictAgentFiles policy, type resolution
// with fallbackSubagent semantics, and immutable invocation snapshots.
//
// No filesystem access here: Markdown loading is injected as a `loader`
// function (the concrete adapter lives in pi/agent-files.ts).

import type {
	AgentDefinition,
	AgentDefinitionSnapshot,
	AgentFileInput,
	AgentInvocationOverrides,
	NormalizedAgentFile,
} from "../domain/agent-definition.js";
import {
	AgentFileError,
	DEFAULT_BUILTIN_TOOL_NAMES,
	normalizeAgentDefinition,
	resolveAgentSnapshot,
} from "../domain/agent-definition.js";
import type { SubagentsSettings } from "../domain/config.js";
import { createBundledDefaultAgents } from "./default-agents.js";

/** A raw file as produced by the host loader; `error` marks an unreadable/unparseable file. */
export type LoadedAgentFile = AgentFileInput & { error?: string };

export type RawAgentLoader = (dirs: string[]) => Promise<LoadedAgentFile[]>;

/** Outcome of resolving a caller-supplied agent type. */
export type TypeResolution = { ok: true; type: string; fellBackFrom?: string } | { ok: false; message: string };

export interface RegistryLoadError {
	sourcePath: string;
	message: string;
}

export interface RegistryLoadReport {
	/** All registered type names, including disabled ones. */
	types: string[];
	/** Non-fatal corrections collected during normalization (lenient mode). */
	warnings: string[];
	/** Files skipped because they could not be read/parsed (lenient mode). */
	errors: RegistryLoadError[];
}

export const NO_FALLBACK = "none";

export interface AgentRegistryOptions {
	/**
	 * Agent source directories in ASCENDING precedence (later overrides earlier
	 * on name clash): global < workspace < project per CONFIGURATION §3.
	 * Bundled defaults are seeded in-code below every directory source.
	 */
	sources: string[];
	loader: RawAgentLoader;
	/** Sanitized operational settings (fallbackSubagent, defaultMaxTurns, ...). */
	settings: SubagentsSettings;
	/** Built-in tool universe for `tools:` wildcard expansion. */
	builtinToolNames?: readonly string[];
}

/**
 * Case-insensitive unambiguous lookup: an exact key always wins; otherwise the
 * name must match exactly one registered key. Two agents differing only in
 * case are reachable (files keyed by declared name across directories), and
 * picking whichever came first would silently dispatch the wrong model/tool
 * policy — so ambiguity refuses to guess.
 */
function resolveUnambiguousKey(definitions: ReadonlyMap<string, AgentDefinition>, name: string): string | undefined {
	if (definitions.has(name)) return name;
	const lower = name.toLowerCase();
	const matches = [...definitions.keys()].filter((key) => key.toLowerCase() === lower);
	return matches.length === 1 ? matches[0] : undefined;
}

export class AgentRegistry {
	private definitions = new Map<string, AgentDefinition>();
	private loadWarnings: string[] = [];
	private loadErrors: RegistryLoadError[] = [];
	private settings: SubagentsSettings;
	/** Snapshots captured for active runs; reload never mutates these. */
	private readonly activeSnapshots = new Map<string, AgentDefinitionSnapshot>();

	private readonly sources: string[];
	private readonly loader: RawAgentLoader;
	private readonly builtinToolNames: readonly string[];

	constructor(options: AgentRegistryOptions) {
		this.sources = [...options.sources];
		this.loader = options.loader;
		this.settings = options.settings;
		this.builtinToolNames = options.builtinToolNames ?? DEFAULT_BUILTIN_TOOL_NAMES;
	}

	/** Replace operational settings; applies to subsequent loads and resolutions. */
	updateSettings(settings: SubagentsSettings): void {
		this.settings = settings;
	}

	get currentSettings(): Readonly<SubagentsSettings> {
		return this.settings;
	}

	get warnings(): readonly string[] {
		return this.loadWarnings;
	}

	get errors(): readonly RegistryLoadError[] {
		return this.loadErrors;
	}

	/**
	 * Load all agent sources into a fresh registry map. Bundled defaults are
	 * seeded first (lowest precedence), then each directory's files overlay by
	 * declared/filename type. Under strictAgentFiles the first malformed file
	 * THROWS (fail startup/reload); the previously loaded generation stays
	 * intact. Lenient mode warns and skips malformed files/fields.
	 */
	async load(): Promise<RegistryLoadReport> {
		const settings = this.settings;
		const strict = settings.strictAgentFiles;
		const next = new Map<string, AgentDefinition>();
		for (const bundled of createBundledDefaultAgents({ defaultBackground: settings.backgroundByDefault })) {
			next.set(bundled.type, bundled);
		}

		const warnings: string[] = [];
		const errors: RegistryLoadError[] = [];
		const rawFiles = await this.loader(this.sources);

		for (const raw of rawFiles) {
			if (raw.error !== undefined) {
				// FILE-level failure: strict fails startup naming the path; lenient
				// skips the whole file with a recorded error.
				if (strict) throw new AgentFileError(raw.sourcePath, raw.error);
				errors.push({ sourcePath: raw.sourcePath, message: raw.error });
				continue;
			}
			// normalizeAgentDefinition throws AgentFileError on field-level
			// invalid values under strict (fail startup/reload); in lenient mode
			// it always returns with collected warnings instead. EXCEPTION:
			// malformed time budgets are file-level in BOTH modes — strict
			// rethrows, lenient skips the whole file with a recorded error.
			let normalized: NormalizedAgentFile;
			try {
				normalized = normalizeAgentDefinition(raw, {
					strict,
					defaultBackground: settings.backgroundByDefault,
					builtinToolNames: this.builtinToolNames,
				});
			} catch (error) {
				if (strict) throw error;
				errors.push({
					sourcePath: raw.sourcePath,
					message: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			for (const warning of normalized.warnings) warnings.push(`${raw.sourcePath}: ${warning}`);
			// Same-name overlay: later sources (project) win by map overwrite.
			next.set(normalized.definition.type, normalized.definition);
		}

		this.definitions = next;
		this.loadWarnings = warnings;
		this.loadErrors = errors;
		return { types: [...next.keys()], warnings, errors };
	}

	/** Alias of load() for explicit mid-session refreshes. */
	async reload(): Promise<RegistryLoadReport> {
		return this.load();
	}

	/** All registered type names, including disabled agents. */
	get types(): string[] {
		return [...this.definitions.keys()];
	}

	/** Enabled type names only (spawnable + tool descriptions). */
	get availableTypes(): string[] {
		return [...this.definitions.entries()].filter(([, def]) => def.enabled).map(([type]) => type);
	}

	/** Definition lookup, case-insensitive; includes disabled agents. */
	get(type: string): AgentDefinition | undefined {
		const key = resolveUnambiguousKey(this.definitions, type.trim());
		return key !== undefined ? this.definitions.get(key) : undefined;
	}

	/**
	 * Resolve a caller-supplied type to exactly one ENABLED agent, applying the
	 * `fallbackSubagent` policy. Unknown, disabled and case-ambiguous names are
	 * treated identically: the caller did not identify one enabled agent.
	 *
	 * - `fallbackSubagent: "none"` → reject with the available list;
	 * - named fallback → resolve that specialist (it must itself be enabled,
	 *   else reject as a misconfiguration rather than guessing further);
	 * - the returned type is reported via `fellBackFrom` when substituted.
	 */
	resolveType(requested: unknown): TypeResolution {
		const raw = typeof requested === "string" ? requested.trim() : "";
		if (raw.length === 0) {
			return { ok: false, message: `No agent type given. Available: ${this.availableList()}.` };
		}

		const key = resolveUnambiguousKey(this.definitions, raw);
		if (key !== undefined && this.definitions.get(key)?.enabled === true) {
			return { ok: true, type: key };
		}

		const reason = `Unknown, disabled, or ambiguous agent type: "${raw}".`;
		const configured = this.settings.fallbackSubagent.trim();
		if (configured.length === 0 || configured.toLowerCase() === NO_FALLBACK) {
			return { ok: false, message: `${reason} Available: ${this.availableList()}.` };
		}

		const fallbackKey = resolveUnambiguousKey(this.definitions, configured);
		const fallbackDef = fallbackKey !== undefined ? this.definitions.get(fallbackKey) : undefined;
		if (fallbackKey === undefined || fallbackDef?.enabled !== true) {
			return {
				ok: false,
				message:
					`${reason} The configured fallbackSubagent "${configured}" is itself unknown or disabled. ` +
					`Available: ${this.availableList()}.`,
			};
		}
		return { ok: true, type: fallbackKey, fellBackFrom: raw };
	}

	/**
	 * Resolve an invocation into an immutable snapshot, merging per
	 * CONFIGURATION §4 precedence:
	 *
	 *   pinned agent frontmatter > spawn request > operational setting > built-in default
	 *
	 * Concretely: a frontmatter-pinned model/thinking/tools/max_turns cannot be
	 * overridden by the spawn request; an unpinned maxTurnLimit falls back to
	 * the spawn override, then `defaultMaxTurns` (>0), then unlimited; a
	 * worktree isolation policy is downgraded to "off" (silently) when the
	 * `worktreeIsolation` master switch is off.
	 *
	 * EXCEPTION for time budgets (`timeout` / `idleTimeout`): the precedence is
	 * deliberately spawn request > frontmatter > `defaultTimeout` /
	 * `defaultIdleTimeout` (>0) — the caller may tighten OR loosen a pinned
	 * budget for a specific run.
	 *
	 * Snapshots are fresh deep-copied objects: later reloads never mutate a
	 * previously returned/tracked snapshot. When `runId` is given the snapshot
	 * is tracked until releaseSnapshot for active-run bookkeeping.
	 *
	 * Throws when the requested type cannot be resolved (message from
	 * resolveType, including the fallback policy outcome).
	 */
	resolveInvocation(
		typeOrRequest: string,
		overrides?: AgentInvocationOverrides,
		runId?: string,
	): AgentDefinitionSnapshot {
		const resolution = this.resolveType(typeOrRequest);
		if (!resolution.ok) throw new Error(resolution.message);
		const definition = this.definitions.get(resolution.type);
		if (definition === undefined) throw new Error(`Registry lost type "${resolution.type}" after reload.`);

		// Precedence first: drop spawn-override fields the frontmatter pins.
		const effective: AgentInvocationOverrides = {};
		if (definition.model === undefined && overrides?.model !== undefined) effective.model = overrides.model;
		if (definition.thinking === undefined && overrides?.thinking !== undefined) {
			effective.thinking = overrides.thinking;
		}
		if (definition.tools === undefined && overrides?.tools !== undefined) effective.tools = overrides.tools;

		if (definition.maxTurnLimit === undefined) {
			const requested = overrides?.maxTurnLimit;
			if (requested !== undefined) {
				effective.maxTurnLimit = requested;
			} else if (this.settings.defaultMaxTurns > 0) {
				// Settings tier: defaultMaxTurns, where 0 means unlimited (absent).
				// A definition-pinned 0 never reaches here — it stays unlimited.
				effective.maxTurnLimit = this.settings.defaultMaxTurns;
			}
		}

		// Time budgets use a DIFFERENT precedence, deliberately (roadmap 1.1):
		// invocation > definition > settings — a caller-requested budget beats
		// a pinned frontmatter budget, and both beat the settings default.
		// resolveAgentSnapshot validates the override values (strict: malformed
		// budgets throw, never silently unlimited).
		if (overrides?.timeout !== undefined) {
			effective.timeout = overrides.timeout;
		} else if (definition.timeout === undefined && this.settings.defaultTimeout > 0) {
			effective.timeout = this.settings.defaultTimeout;
		}
		if (overrides?.idleTimeout !== undefined) {
			effective.idleTimeout = overrides.idleTimeout;
		} else if (definition.idleTimeout === undefined && this.settings.defaultIdleTimeout > 0) {
			effective.idleTimeout = this.settings.defaultIdleTimeout;
		}

		let snapshot = resolveAgentSnapshot(definition, effective);

		if (snapshot.resolved.isolationPolicy === "worktree" && !this.settings.worktreeIsolation) {
			// Master switch off: downgrade rather than fail — the user declined
			// the capability; the definition's veto semantics are unaffected.
			snapshot = { ...snapshot, resolved: { ...snapshot.resolved, isolationPolicy: "off" } };
		}

		if (runId !== undefined) this.activeSnapshots.set(runId, snapshot);
		return snapshot;
	}

	/** Track the immutable snapshot only after model/auth admission succeeds. */
	trackSnapshot(runId: string, snapshot: AgentDefinitionSnapshot): void {
		this.activeSnapshots.set(runId, snapshot);
	}

	/** Snapshot tracked for an active run id. */
	getActiveSnapshot(runId: string): AgentDefinitionSnapshot | undefined {
		return this.activeSnapshots.get(runId);
	}

	/** Release the snapshot tracked for a finished/stopped run. */
	releaseSnapshot(runId: string): boolean {
		return this.activeSnapshots.delete(runId);
	}

	private availableList(): string {
		return this.availableTypes.join(", ") || "(none)";
	}
}
