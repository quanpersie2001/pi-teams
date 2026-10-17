// Unified task contracts and validation.

import { isMailboxAddress } from "./mailbox.js";

export const TASK_SCHEMA_VERSION = 2 as const;
export type TaskStatus = "pending" | "in_progress" | "in_review" | "completed" | "cancelled";
export type VerificationOutcome = "passed" | "failed" | "not_run";
export interface TaskReference {
	kind: "file" | "url" | "artifact";
	target: string;
	note?: string;
}
export interface TaskVerification {
	check: string;
	outcome: VerificationOutcome;
	evidence?: string;
}
export interface TaskExecutionPlan {
	type: string;
	name?: string;
	color?: string;
	model?: string;
	maxTurns?: number;
}
export interface TaskSpec {
	acceptanceCriteria?: string[];
	scope?: { paths?: string[]; outOfScope?: string[] };
	constraints?: string[];
	expectedOutput?: string;
}
export interface TaskContext {
	background?: string;
	decisions?: string[];
	references?: TaskReference[];
}
export interface TaskOutcome {
	summary?: string;
	artifacts?: string[];
	verification?: TaskVerification[];
	remainingIssues?: string[];
}
export interface TaskRequirementSnapshot {
	title: string;
	description?: string;
	dependencies: string[];
	executionPlan?: TaskExecutionPlan;
	spec: TaskSpec;
	context: TaskContext;
}
export interface TaskAttempt {
	runId: string;
	teammateName?: string;
	membershipId?: string;
	reservationId?: string;
	startedAt: number;
	settledAt?: number;
	status: "running" | "completed" | "stopped" | "failed";
	resultFile?: string;
	error?: string;
	partialResult?: string;
	requirementRevision: number;
	requirementSnapshot: TaskRequirementSnapshot;
	result?: TaskOutcome;
}
export interface BoardTask {
	id: string;
	code?: string;
	title: string;
	description?: string;
	status: TaskStatus;
	dependencies: string[];
	owner?: string;
	ownerMembershipId?: string;
	assignee?: string;
	reviewRequested?: boolean;
	executionPlan?: TaskExecutionPlan;
	requirementRevision: number;
	spec: TaskSpec;
	context: TaskContext;
	outcome?: TaskOutcome;
	attempts: TaskAttempt[];
	createdAt: number;
	updatedAt: number;
}
export interface TaskProjection extends BoardTask {
	blockedBy: string[];
}
export function isTaskId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}
export function isTaskCode(value: unknown): value is string {
	return typeof value === "string" && /^T[1-9][0-9]*$/.test(value);
}
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
function parseExecutionPlan(value: unknown): TaskExecutionPlan | undefined {
	if (
		!record(value) ||
		typeof value.type !== "string" ||
		!value.type.trim() ||
		(value.name !== undefined &&
			(typeof value.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.name))) ||
		(value.color !== undefined &&
			(typeof value.color !== "string" || !/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value.color))) ||
		(value.model !== undefined && (typeof value.model !== "string" || !value.model.trim())) ||
		(value.maxTurns !== undefined && (!Number.isSafeInteger(value.maxTurns) || (value.maxTurns as number) < 1))
	)
		return undefined;
	return {
		type: value.type,
		...(typeof value.name === "string" ? { name: value.name } : {}),
		...(typeof value.color === "string" ? { color: value.color } : {}),
		...(typeof value.model === "string" ? { model: value.model } : {}),
		...(typeof value.maxTurns === "number" ? { maxTurns: value.maxTurns } : {}),
	};
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function parseSpec(v: unknown): TaskSpec | undefined {
	if (v === undefined) return {};
	if (
		!record(v) ||
		(v.acceptanceCriteria !== undefined && !strings(v.acceptanceCriteria)) ||
		(v.constraints !== undefined && !strings(v.constraints)) ||
		(v.expectedOutput !== undefined && typeof v.expectedOutput !== "string")
	)
		return undefined;
	let scope: TaskSpec["scope"];
	if (v.scope !== undefined) {
		if (
			!record(v.scope) ||
			(v.scope.paths !== undefined && !strings(v.scope.paths)) ||
			(v.scope.outOfScope !== undefined && !strings(v.scope.outOfScope))
		)
			return undefined;
		scope = {
			...(strings(v.scope.paths) ? { paths: [...v.scope.paths] } : {}),
			...(strings(v.scope.outOfScope) ? { outOfScope: [...v.scope.outOfScope] } : {}),
		};
	}
	return {
		...(strings(v.acceptanceCriteria) ? { acceptanceCriteria: [...v.acceptanceCriteria] } : {}),
		...(scope ? { scope } : {}),
		...(strings(v.constraints) ? { constraints: [...v.constraints] } : {}),
		...(typeof v.expectedOutput === "string" ? { expectedOutput: v.expectedOutput } : {}),
	};
}
function parseContext(v: unknown): TaskContext | undefined {
	if (v === undefined) return {};
	if (
		!record(v) ||
		(v.background !== undefined && typeof v.background !== "string") ||
		(v.decisions !== undefined && !strings(v.decisions)) ||
		(v.references !== undefined && !Array.isArray(v.references))
	)
		return undefined;
	const references: TaskReference[] = [];
	for (const r of (v.references ?? []) as unknown[]) {
		if (
			!record(r) ||
			!["file", "url", "artifact"].includes(String(r.kind)) ||
			typeof r.target !== "string" ||
			(r.note !== undefined && typeof r.note !== "string")
		)
			return undefined;
		references.push({
			kind: r.kind as TaskReference["kind"],
			target: r.target,
			...(typeof r.note === "string" ? { note: r.note } : {}),
		});
	}
	return {
		...(typeof v.background === "string" ? { background: v.background } : {}),
		...(strings(v.decisions) ? { decisions: [...v.decisions] } : {}),
		...(v.references !== undefined ? { references } : {}),
	};
}
function parseOutcome(v: unknown): TaskOutcome | undefined {
	if (v === undefined) return undefined;
	if (
		!record(v) ||
		(v.summary !== undefined && typeof v.summary !== "string") ||
		(v.artifacts !== undefined && !strings(v.artifacts)) ||
		(v.remainingIssues !== undefined && !strings(v.remainingIssues)) ||
		(v.verification !== undefined && !Array.isArray(v.verification))
	)
		return undefined;
	const verification: TaskVerification[] = [];
	for (const x of (v.verification ?? []) as unknown[]) {
		if (
			!record(x) ||
			typeof x.check !== "string" ||
			!["passed", "failed", "not_run"].includes(String(x.outcome)) ||
			(x.evidence !== undefined && typeof x.evidence !== "string")
		)
			return undefined;
		verification.push({
			check: x.check,
			outcome: x.outcome as VerificationOutcome,
			...(typeof x.evidence === "string" ? { evidence: x.evidence } : {}),
		});
	}
	return {
		...(typeof v.summary === "string" ? { summary: v.summary } : {}),
		...(strings(v.artifacts) ? { artifacts: [...v.artifacts] } : {}),
		...(v.verification !== undefined ? { verification } : {}),
		...(strings(v.remainingIssues) ? { remainingIssues: [...v.remainingIssues] } : {}),
	};
}
function parseRequirementSnapshot(value: unknown): TaskRequirementSnapshot | undefined {
	if (
		!record(value) ||
		typeof value.title !== "string" ||
		!value.title.trim() ||
		(value.description !== undefined && typeof value.description !== "string") ||
		!strings(value.dependencies) ||
		!value.dependencies.every(isTaskId)
	)
		return undefined;
	const spec = parseSpec(value.spec);
	const context = parseContext(value.context);
	const executionPlan = value.executionPlan === undefined ? undefined : parseExecutionPlan(value.executionPlan);
	if (!spec || !context || (value.executionPlan !== undefined && !executionPlan)) return undefined;
	return {
		title: value.title,
		...(typeof value.description === "string" ? { description: value.description } : {}),
		dependencies: [...value.dependencies],
		...(executionPlan ? { executionPlan } : {}),
		spec,
		context,
	};
}
function parseAttempt(value: unknown): TaskAttempt | undefined {
	if (
		!record(value) ||
		typeof value.runId !== "string" ||
		value.runId.length === 0 ||
		(value.teammateName !== undefined && !isMailboxAddress(value.teammateName)) ||
		(value.membershipId !== undefined && (typeof value.membershipId !== "string" || value.membershipId.length === 0)) ||
		(value.reservationId !== undefined &&
			(typeof value.reservationId !== "string" || value.reservationId.length === 0)) ||
		!Number.isSafeInteger(value.startedAt) ||
		!["running", "completed", "stopped", "failed"].includes(String(value.status)) ||
		(value.settledAt !== undefined && !Number.isSafeInteger(value.settledAt)) ||
		(value.resultFile !== undefined && typeof value.resultFile !== "string") ||
		(value.error !== undefined && typeof value.error !== "string") ||
		(value.partialResult !== undefined && typeof value.partialResult !== "string") ||
		!Number.isSafeInteger(value.requirementRevision) ||
		(value.requirementRevision as number) < 1
	)
		return undefined;
	const snapshot = parseRequirementSnapshot(value.requirementSnapshot);
	const result = parseOutcome(value.result);
	if (!snapshot || (value.result !== undefined && !result)) return undefined;
	const status = value.status as TaskAttempt["status"];
	if ((status === "running") === (value.settledAt !== undefined)) return undefined;
	return {
		runId: value.runId,
		...(typeof value.teammateName === "string" ? { teammateName: value.teammateName } : {}),
		...(typeof value.membershipId === "string" ? { membershipId: value.membershipId } : {}),
		...(typeof value.reservationId === "string" ? { reservationId: value.reservationId } : {}),
		startedAt: value.startedAt as number,
		...(typeof value.settledAt === "number" ? { settledAt: value.settledAt } : {}),
		status,
		...(typeof value.resultFile === "string" ? { resultFile: value.resultFile } : {}),
		...(typeof value.error === "string" ? { error: value.error } : {}),
		...(typeof value.partialResult === "string" ? { partialResult: value.partialResult } : {}),
		requirementRevision: value.requirementRevision as number,
		requirementSnapshot: snapshot,
		...(result ? { result } : {}),
	};
}
export function parseBoardTask(value: unknown): BoardTask | undefined {
	if (!record(value)) return undefined;
	const r = value;
	if (
		r.schemaVersion !== undefined &&
		(!Number.isSafeInteger(r.schemaVersion) || (r.schemaVersion !== 1 && r.schemaVersion !== TASK_SCHEMA_VERSION))
	)
		return undefined;
	if (
		!isTaskId(r.id) ||
		(r.code !== undefined && !isTaskCode(r.code)) ||
		typeof r.title !== "string" ||
		!r.title.trim() ||
		(r.description !== undefined && typeof r.description !== "string") ||
		!["pending", "in_progress", "in_review", "completed", "cancelled"].includes(String(r.status)) ||
		!strings(r.dependencies) ||
		!r.dependencies.every(isTaskId) ||
		(r.owner !== undefined && (typeof r.owner !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.owner))) ||
		(r.assignee !== undefined &&
			(typeof r.assignee !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.assignee))) ||
		(r.ownerMembershipId !== undefined &&
			(typeof r.ownerMembershipId !== "string" || r.ownerMembershipId.length === 0)) ||
		(r.reviewRequested !== undefined && typeof r.reviewRequested !== "boolean") ||
		(r.executionPlan !== undefined && !parseExecutionPlan(r.executionPlan)) ||
		!Number.isSafeInteger(r.createdAt) ||
		!Number.isSafeInteger(r.updatedAt)
	)
		return undefined;
	const spec = parseSpec(r.spec);
	const context = parseContext(r.context);
	const outcome = parseOutcome(r.outcome);
	if (!spec || !context || (r.outcome !== undefined && !outcome)) return undefined;
	const requirementRevision = r.requirementRevision === undefined ? 1 : r.requirementRevision;
	if (!Number.isSafeInteger(requirementRevision) || (requirementRevision as number) < 1) return undefined;
	if (
		r.schemaVersion === TASK_SCHEMA_VERSION &&
		(r.requirementRevision === undefined || r.spec === undefined || r.context === undefined || r.attempts === undefined)
	)
		return undefined;
	let attempts: TaskAttempt[] = [];
	if (r.attempts !== undefined) {
		if (!Array.isArray(r.attempts)) return undefined;
		const parsed = r.attempts.map(parseAttempt);
		if (parsed.some((attempt) => attempt === undefined)) return undefined;
		attempts = parsed as TaskAttempt[];
	}
	if ((r.status === "in_progress" || r.status === "in_review") !== (r.owner !== undefined)) return undefined;
	const executionPlan = r.executionPlan === undefined ? undefined : parseExecutionPlan(r.executionPlan);
	return {
		id: r.id,
		...(r.code === undefined ? {} : { code: r.code as string }),
		title: r.title,
		...(typeof r.description === "string" ? { description: r.description } : {}),
		status: r.status as TaskStatus,
		dependencies: [...r.dependencies],
		...(typeof r.owner === "string" ? { owner: r.owner } : {}),
		...(typeof r.ownerMembershipId === "string" ? { ownerMembershipId: r.ownerMembershipId } : {}),
		...(typeof r.assignee === "string" ? { assignee: r.assignee } : {}),
		...(typeof r.reviewRequested === "boolean" ? { reviewRequested: r.reviewRequested } : {}),
		...(executionPlan ? { executionPlan } : {}),
		requirementRevision: requirementRevision as number,
		spec,
		context,
		...(outcome ? { outcome } : {}),
		attempts,
		createdAt: r.createdAt as number,
		updatedAt: r.updatedAt as number,
	};
}
