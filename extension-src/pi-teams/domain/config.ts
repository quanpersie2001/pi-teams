// Operational settings contract and pure sanitization.
//
// Exactly the thirteen accepted operational keys. Values are read from
// ~/.pi/agent/teams.json (global) and <project>/.pi/teams.json
// (overrides), then passed through sanitizeSettings before use.

import { MAX_BUDGET_SECONDS } from "./time-policy.js";

export type SubagentsSettings = {
	maxConcurrent: number;
	defaultMaxTurns: number;
	graceTurns: number;
	/** Default wall-clock budget in whole seconds; 0 = unlimited (opt-in). */
	defaultTimeout: number;
	/** Default idle budget in whole seconds; 0 = unlimited (opt-in). */
	defaultIdleTimeout: number;
	backgroundByDefault: boolean;
	worktreeIsolation: boolean;
	rememberAgents: boolean;
	strictAgentFiles: boolean;
	strictModelAdmission: boolean;
	fallbackSubagent: string;
	agentPanel: boolean;
	/** Multiplexer mode: auto-detect (herdr → tmux → headless) or forced headless. */
	backend: BackendMode;
};

export const MIN_MAX_CONCURRENT = 1;
export const MAX_MAX_CONCURRENT = 1024;

export const DEFAULT_SUBAGENTS_SETTINGS: Readonly<SubagentsSettings> = {
	maxConcurrent: 4,
	defaultMaxTurns: 30,
	graceTurns: 3,
	defaultTimeout: 0,
	defaultIdleTimeout: 0,
	backgroundByDefault: true,
	worktreeIsolation: false,
	rememberAgents: true,
	strictAgentFiles: false,
	strictModelAdmission: true,
	fallbackSubagent: "none",
	agentPanel: true,
	backend: "auto",
};

/**
 * Optional process-launcher hint supplied by the host environment; not one of
 * the user-facing settings.
 */
export type BackendSelector = "auto" | "herdr" | "tmux" | "headless";

/**
 * User-facing multiplexer mode. `auto` detects herdr → tmux and falls back to
 * an independent headless process; `headless` never attaches a multiplexer.
 * Explicit herdr/tmux forcing stays env-only (`PI_TEAMS_BACKEND`).
 */
export type BackendMode = "auto" | "headless";

const BACKEND_MODES: ReadonlySet<string> = new Set(["auto", "headless"]);

function backendModeOr(value: unknown): BackendMode {
	return typeof value === "string" && BACKEND_MODES.has(value) ? (value as BackendMode) : "auto";
}

function toRecord(raw: unknown): Record<string, unknown> {
	return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
}

function clampInt(value: unknown, fallback: number, min: number, max?: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	let n = Math.floor(value);
	if (n < min) n = min;
	if (max !== undefined && n > max) n = max;
	return n;
}

function boolOr(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/**
 * Sanitize one default budget setting. 0 = unlimited:
 * - non-number/non-finite → 0;
 * - negative → clamped to 0;
 * - positive fraction (e.g. 7.5s) is invalid and falls back to 0 rather than
 *   being silently truncated;
 * - whole seconds clamp to the timer range [0, MAX_BUDGET_SECONDS].
 */
function budgetOrZero(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	if (!Number.isInteger(value)) return 0;
	return Math.min(value, MAX_BUDGET_SECONDS);
}

/**
 * Normalize arbitrary parsed JSON into valid SubagentsSettings:
 * - unknown/missing/mistyped values fall back to defaults;
 * - maxConcurrent clamps to [1, 1024];
 * - defaultMaxTurns and graceTurns clamp to >= 0;
 * - defaultTimeout/defaultIdleTimeout: 0 = unlimited; negatives clamp to 0;
 *   positive fractions fall back to 0; whole seconds cap at MAX_BUDGET_SECONDS;
 * - fallbackSubagent must be a non-empty string, else "none";
 * - backend accepts only "auto" or "headless", else "auto";
 * - unknown keys are dropped (the result contains exactly the thirteen keys).
 */
export function sanitizeSettings(raw: unknown): SubagentsSettings {
	const source = toRecord(raw);
	return {
		maxConcurrent: clampInt(
			source.maxConcurrent,
			DEFAULT_SUBAGENTS_SETTINGS.maxConcurrent,
			MIN_MAX_CONCURRENT,
			MAX_MAX_CONCURRENT,
		),
		defaultMaxTurns: clampInt(source.defaultMaxTurns, DEFAULT_SUBAGENTS_SETTINGS.defaultMaxTurns, 0),
		graceTurns: clampInt(source.graceTurns, DEFAULT_SUBAGENTS_SETTINGS.graceTurns, 0),
		defaultTimeout: budgetOrZero(source.defaultTimeout),
		defaultIdleTimeout: budgetOrZero(source.defaultIdleTimeout),
		backgroundByDefault: boolOr(source.backgroundByDefault, DEFAULT_SUBAGENTS_SETTINGS.backgroundByDefault),
		worktreeIsolation: boolOr(source.worktreeIsolation, DEFAULT_SUBAGENTS_SETTINGS.worktreeIsolation),
		rememberAgents: boolOr(source.rememberAgents, DEFAULT_SUBAGENTS_SETTINGS.rememberAgents),
		strictAgentFiles: boolOr(source.strictAgentFiles, DEFAULT_SUBAGENTS_SETTINGS.strictAgentFiles),
		strictModelAdmission: boolOr(source.strictModelAdmission, DEFAULT_SUBAGENTS_SETTINGS.strictModelAdmission),
		fallbackSubagent:
			typeof source.fallbackSubagent === "string" && source.fallbackSubagent.trim().length > 0
				? source.fallbackSubagent
				: DEFAULT_SUBAGENTS_SETTINGS.fallbackSubagent,
		agentPanel: boolOr(source.agentPanel, DEFAULT_SUBAGENTS_SETTINGS.agentPanel),
		backend: backendModeOr(source.backend),
	};
}
