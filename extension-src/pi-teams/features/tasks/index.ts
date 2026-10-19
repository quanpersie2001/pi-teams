import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Markdown, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_INLINE_TASK_ROWS } from "../../domain/config.js";
import type { TaskProjection } from "../../domain/task-board.js";
import type { AgentListRow } from "../../domain/ui-view.js";
import { formatElapsedMs } from "../../shared/elapsed.js";
import { bindThemeFg, type ThemeFg, type UiColorToken } from "../../shared/theme.js";
import { plainMarkdownTheme, resolveMarkdownTheme } from "../agent-view/transcript-renderer.js";

export type TaskFilter = "all" | "open" | "blocked" | "in_progress" | "in_review" | "completed" | "cancelled";
export interface TasksHubData {
	tasks: readonly TaskProjection[];
	selection: string | null;
	filter: TaskFilter;
	query: string;
	detail: boolean;
	detailScroll?: number;
	rosterColors: ReadonlyMap<string, string>;
	error?: string | null;
	runs?: readonly AgentListRow[];
	now?: number;
}

/** Structural task view shared by the Hub, the inline widget and the default
 *  tool renderers. `TaskProjection` satisfies it, and tool results parsed from
 *  task JSON satisfy it without reconstructing the full board record. */
export interface TaskRowView {
	id: string;
	code?: string | undefined;
	title: string;
	status: string;
	assignee?: string | undefined;
	owner?: string | undefined;
	blockedBy?: readonly string[] | undefined;
	attempts?: readonly { status: string; teammateName?: string | undefined; runId?: string | undefined }[] | undefined;
	createdAt?: number | undefined;
}

function activeTaskRun(task: TaskRowView, runs: readonly AgentListRow[] = []): AgentListRow | undefined {
	const attempt = task.attempts?.at(-1);
	if (!attempt) return undefined;
	return runs.find((row) => row.id === attempt.runId && row.status === "running");
}

/** Task status glyph (`docs/ui/AGENT-PANEL-AND-VIEW.md`). Fill tracks
 *  progress — hollow `○`/`◌` not started, half `◐` claimed, `◉` live run,
 *  `◆` review, `✓`/`⊘`/`✗`/`■` terminal — and colors are theme tokens (no
 *  literal hex), so light and dark themes agree with `statusBadge`. */
export function taskGlyph(
	task: TaskRowView,
	runs: readonly AgentListRow[] = [],
): { icon: string; color: UiColorToken } {
	if (task.status === "completed") return { icon: "✓", color: "success" };
	if (task.status === "cancelled") return { icon: "⊘", color: "dim" };
	if (activeTaskRun(task, runs)) return { icon: "◉", color: "accent" };
	const latest = task.attempts?.at(-1);
	if (latest?.status === "failed") return { icon: "✗", color: "error" };
	if (latest?.status === "stopped") return { icon: "■", color: "dim" };
	if (task.status === "in_progress") return { icon: "◐", color: "accent" };
	if (task.status === "in_review") return { icon: "◆", color: "warning" };
	if ((task.blockedBy?.length ?? 0) > 0) return { icon: "◌", color: "warning" };
	return { icon: "○", color: "muted" };
}

function statusGlyph(task: TaskRowView, fg: ThemeFg, runs: readonly AgentListRow[] = []): string {
	const glyph = taskGlyph(task, runs);
	return fg(glyph.color, glyph.icon);
}

/** Status counts in display order, omitting zero categories. */
function countSegments(tasks: readonly TaskRowView[]): string {
	const counts = [
		[tasks.filter((task) => task.status === "completed").length, "done"],
		[tasks.filter((task) => task.status === "in_progress").length, "in progress"],
		[tasks.filter((task) => task.status === "pending").length, "open"],
		[tasks.filter((task) => task.status === "in_review").length, "in review"],
		[tasks.filter((task) => task.status === "cancelled").length, "cancelled"],
	] as const;
	return counts
		.filter(([count]) => count > 0)
		.map(([count, name]) => `${count} ${name}`)
		.join(", ");
}

export function taskHeader(tasks: readonly TaskRowView[]): string {
	return `● ${tasks.length} tasks (${countSegments(tasks)})`;
}

export function inlineTasks<T extends TaskRowView>(tasks: readonly T[]): T[] {
	return tasks.filter(
		(task) => task.status === "pending" || task.status === "in_progress" || task.status === "in_review",
	);
}

export function visibleTasks(data: TasksHubData): TaskProjection[] {
	const q = data.query.trim().toLowerCase();
	return data.tasks.filter((task) => {
		if (data.filter === "open" && task.status !== "pending") return false;
		if (data.filter === "blocked" && task.blockedBy.length === 0) return false;
		if (data.filter !== "all" && data.filter !== "open" && data.filter !== "blocked" && task.status !== data.filter)
			return false;
		return (
			!q || `${task.code ?? task.id} ${task.title} ${task.assignee ?? ""} ${task.owner ?? ""}`.toLowerCase().includes(q)
		);
	});
}

function oneLine(value: string): string {
	return value.replace(/[\r\n]+/g, " ");
}

export function taskIdentity(task: TaskRowView): string | undefined {
	const latestTeammate = task.attempts?.at(-1)?.teammateName;
	if (task.status === "completed" || task.status === "cancelled") return latestTeammate ?? task.assignee ?? task.owner;
	if (task.status === "pending") return task.assignee;
	return task.owner ?? task.assignee ?? latestTeammate;
}

function identity(name: string | undefined, colors: ReadonlyMap<string, string>, fg: ThemeFg): string {
	if (!name) return fg("muted", "unassigned");
	const color = colors.get(name);
	if (!color || !/^#[\da-f]{6}$/i.test(color)) return fg("muted", `@${name}`);
	return `\x1b[38;2;${Number.parseInt(color.slice(1, 3), 16)};${Number.parseInt(color.slice(3, 5), 16)};${Number.parseInt(color.slice(5, 7), 16)}m@${name}\x1b[39m`;
}

/** One-line task row: `<glyph> T3 @owner Title` plus blocked refs. Shared by the
 *  inline widget and the default `tasks_*` tool renderers so both agree. */
export function taskRow(
	task: TaskRowView,
	colors: ReadonlyMap<string, string>,
	fg: ThemeFg,
	runs: readonly AgentListRow[] = [],
): string {
	const blocked = (task.blockedBy?.length ?? 0) > 0 ? ` ${fg("warning", `← ${(task.blockedBy ?? []).join(",")}`)}` : "";
	return `${statusGlyph(task, fg, runs)} ${fg("dim", task.code ?? task.id)} ${identity(taskIdentity(task), colors, fg)} ${oneLine(task.title)}${blocked}`;
}

export function tasksHubListWindow(
	data: TasksHubData,
	height: number,
): { start: number; bodyEnd: number; taskIdsByLine: Array<string | null> } {
	const tasks = visibleTasks(data);
	const selected = tasks.find((task) => task.id === data.selection) ?? tasks[0];
	const bodyEnd = Math.max(0, Math.floor(height) - 3);
	const rowLines = bodyEnd;
	const selectedRow = tasks.findIndex((task) => task.id === selected?.id) + 1;
	const start = Math.max(0, Math.min(tasks.length + 1 - rowLines, selectedRow - rowLines + 1));
	const taskIdsByLine = Array.from({ length: bodyEnd }, (_, line) => {
		const listIndex = start + line;
		return listIndex > 0 ? (tasks[listIndex - 1]?.id ?? null) : null;
	});
	return { start, bodyEnd, taskIdsByLine };
}

export function renderTasksHub(
	data: TasksHubData,
	fg: ThemeFg,
	width: number,
	height: number,
	onDetailScrollLimit?: (taskId: string | null, max: number, normalizedOffset: number) => void,
): string[] {
	const w = Math.max(0, Math.floor(width));
	const h = Math.max(0, Math.floor(height));
	if (!w || !h) return [];
	const tasks = visibleTasks(data);
	const selected = tasks.find((task) => task.id === data.selection) ?? tasks[0];
	const split = w >= 76 && !data.detail;
	const inner = Math.max(0, w - 2);
	const leftWidth = split ? Math.floor(inner * 0.48) : inner;
	const rightWidth = split ? Math.max(0, inner - leftWidth - 1) : inner;
	const lines: string[] = [];
	const pad = (text: string, size: number) => {
		const clipped = truncateToWidth(text, size);
		return clipped + " ".repeat(Math.max(0, size - visibleWidth(clipped)));
	};
	const frame = (left: string, right = "") => {
		const body = split
			? `${pad(left, leftWidth)}${fg("accent", "│")}${pad(` ${right}`, rightWidth)}`
			: pad(left, inner);
		lines.push(truncateToWidth(`${fg("accent", "│")}${body}${fg("accent", "│")}`, w));
	};
	const border = (text = "") =>
		truncateToWidth(
			`${fg("accent", "╭")}${text}${fg("accent", `${"─".repeat(Math.max(0, inner - visibleWidth(text)))}╮`)}`,
			w,
		);
	lines.push(
		border(
			` Team Hub · ${fg("muted", "[Agents]")} ${fg("accent", "[Tasks]")}  ${fg("accent", taskHeader(data.tasks))} `,
		),
	);
	if (h === 1) return lines;
	const bodyEnd = Math.max(0, h - 3);
	const rowLines = Math.max(0, bodyEnd);
	const details: string[] = [];
	if (data.error) details.push(` ${fg("error", data.error)}`);
	if (selected) {
		const who = taskIdentity(selected);
		details.push(
			` ${fg("text", selected.code ?? selected.id)}  ${fg("muted", selected.status)}  ${identity(who, data.rosterColors, fg)}`,
		);
		details.push(` ${fg("text", selected.title)}`);
		if (selected.description) details.push(selected.description);
		if (selected.spec.acceptanceCriteria?.length)
			details.push("## Acceptance criteria", ...selected.spec.acceptanceCriteria.map((x) => `- ${x}`));
		if (selected.spec.scope?.paths?.length)
			details.push(`## Scope\n${selected.spec.scope.paths.map((x) => `- ${x}`).join("\n")}`);
		if (selected.spec.scope?.outOfScope?.length)
			details.push(`## Out of scope\n${selected.spec.scope.outOfScope.map((x) => `- ${x}`).join("\n")}`);
		if (selected.spec.expectedOutput) details.push(`## Expected output\n${selected.spec.expectedOutput}`);
		if (selected.spec.constraints?.length)
			details.push("## Constraints", ...selected.spec.constraints.map((x) => `- ${x}`));
		if (selected.context.background) details.push(`## Context\n${selected.context.background}`);
		if (selected.context.decisions?.length)
			details.push(`## Decisions\n${selected.context.decisions.map((x) => `- ${x}`).join("\n")}`);
		for (const reference of selected.context.references ?? [])
			details.push(`- **${reference.kind}:** ${reference.target}${reference.note ? ` — ${reference.note}` : ""}`);
		if (selected.dependencies.length)
			details.push(`## Dependencies\n${selected.dependencies.map((x) => `- ${x}`).join("\n")}`);
		const taskRefs = new Set([selected.id, ...(selected.code ? [selected.code] : [])]);
		const dependents = data.tasks.filter(
			(task) => task.id !== selected.id && task.dependencies.some((dependency) => taskRefs.has(dependency)),
		);
		if (dependents.length) details.push(`**Dependents:** ${dependents.map((task) => task.code ?? task.id).join(", ")}`);
		if (selected.blockedBy.length) details.push(`${fg("warning", "Blocked by:")} ${selected.blockedBy.join(", ")}`);
		const latestRunId = selected.attempts.at(-1)?.runId;
		const run = data.runs?.find((candidate) => candidate.id === latestRunId);
		if (run) {
			const elapsed = Math.max(0, (run.completedAt ?? data.now ?? Date.now()) - run.startedAt);
			details.push(`**Run metrics:** ${formatElapsedMs(elapsed)} · ↓ ${run.totalTokens} tokens`);
		}
		if (selected.outcome?.summary) details.push(`## Outcome\n${selected.outcome.summary}`);
		if (selected.outcome?.artifacts?.length)
			details.push(`## Artifacts\n${selected.outcome.artifacts.map((x) => `- Artifact: ${x}`).join("\n")}`);
		if (selected.outcome?.remainingIssues?.length)
			details.push(
				`## Remaining issues\n${selected.outcome.remainingIssues.map((x) => `- ${fg("warning", `Remaining issue: ${x}`)}`).join("\n")}`,
			);
		if (selected.outcome?.verification?.length)
			details.push(
				`## Verification\n${selected.outcome.verification.map((check) => `- ${check.outcome === "passed" ? fg("success", "✓") : check.outcome === "failed" ? fg("error", "!") : fg("muted", "○")} **${check.outcome}:** ${check.check}${check.evidence ? ` — ${check.evidence}` : ""}`).join("\n")}`,
			);
		if (selected.attempts.length)
			details.push(
				`## Attempts\n${selected.attempts.map((attempt) => `- ${attempt.status === "failed" ? fg("error", "!") : attempt.status === "completed" ? fg("success", "✓") : fg("muted", "·")} **${attempt.status}**${attempt.teammateName ? ` ${identity(attempt.teammateName, data.rosterColors, fg)}` : ""} · ${attempt.runId}${attempt.error ? `: ${fg("error", attempt.error)}` : ""}${attempt.resultFile ? ` · result ${attempt.resultFile}` : ""}${attempt.partialResult ? ` ${attempt.partialResult}` : ""}`).join("\n")}`,
			);
	} else details.push(` ${fg("muted", "No tasks match this filter.")}`);
	const detailMarkdown = new Markdown(details.join("\n\n"), 0, 0, resolveMarkdownTheme());
	let wrappedDetails: string[];
	try {
		wrappedDetails = detailMarkdown.render(Math.max(1, split ? rightWidth - 1 : inner));
	} catch {
		wrappedDetails = new Markdown(details.join("\n\n"), 0, 0, plainMarkdownTheme()).render(
			Math.max(1, split ? rightWidth - 1 : inner),
		);
	}
	const listRows: string[] = [` ${fg("muted", `Search: ${oneLine(data.query) || "(none)"} · ${data.filter}`)}`];
	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i];
		if (!task) continue;
		const chosen = task.id === selected?.id;
		const glyph = statusGlyph(task, fg, data.runs);
		const assignee = taskIdentity(task);
		listRows.push(
			`${chosen ? fg("accent", "›") : " "} ${glyph} ${fg("muted", task.code ?? task.id)} ${identity(assignee, data.rosterColors, fg)} ${oneLine(task.title)}${task.blockedBy.length ? ` ${fg("warning", `← ${task.blockedBy.join(",")}`)}` : ""}`,
		);
	}
	const { start } = tasksHubListWindow(data, h);
	const visibleList = listRows.slice(start, start + rowLines);
	const maxDetailScroll = bodyEnd > 0 ? Math.max(0, wrappedDetails.length - bodyEnd) : 0;
	const detailScroll = Math.max(0, Math.min(maxDetailScroll, Math.floor(data.detailScroll ?? 0)));
	onDetailScrollLimit?.(selected?.id ?? null, maxDetailScroll, detailScroll);
	const visibleDetails = wrappedDetails.slice(detailScroll, detailScroll + bodyEnd);
	for (let i = 0; i < bodyEnd; i++)
		frame(
			split || !data.detail ? (visibleList[i] ?? "") : (visibleDetails[i] ?? ""),
			split ? (visibleDetails[i] ?? "") : "",
		);
	const footer = fg(
		"dim",
		data.detail
			? "Esc back · ↑↓ scroll · Enter actions · r review · a accept · o output · Tab Agents"
			: "↑↓ select · Enter detail · n new · e edit · c claim/release · x execute · k stop · r review · a accept · o output · v agent · d cancel · / search · f filter · Tab Agents · Esc close",
	);
	lines.push(truncateToWidth(`${fg("accent", "│")}${pad(footer, inner)}${fg("accent", "│")}`, w));
	if (h >= 2) lines.push(truncateToWidth(fg("accent", `╰${"─".repeat(inner)}╯`), w));
	return lines.slice(0, h);
}

/** Inline widget head: `● Tasks (1 in progress, 5 open)`. The widget owns its
 *  own head (there is no tool call line above it), so the lane name replaces
 *  the board count and the counts tint dim. */
function inlineTaskHeader(tasks: readonly TaskRowView[], fg: ThemeFg): string {
	const counts = [
		[tasks.filter((task) => task.status === "in_progress").length, "in progress"],
		[tasks.filter((task) => task.status === "in_review").length, "in review"],
		[tasks.filter((task) => task.status === "pending").length, "open"],
	] as const;
	return `${fg("accent", "● Tasks")}${fg(
		"dim",
		` (${counts
			.filter(([count]) => count > 0)
			.map(([count, name]) => `${count} ${name}`)
			.join(", ")})`,
	)}`;
}

/** Rows the inline widget shows before the `… N more` tail; 0 hides it. */
export const INLINE_TASK_ROWS = DEFAULT_INLINE_TASK_ROWS;

/** Bounded task list card used by the default `tasks_list` renderer: header
 *  counts plus a hanging card of `<glyph> T3 @owner Title` rows. */
export function renderTaskList(
	tasks: readonly TaskRowView[],
	colors: ReadonlyMap<string, string>,
	fg: ThemeFg,
	width: number,
	limit: number,
	runs: readonly AgentListRow[] = [],
): string[] {
	if (!tasks.length || width < 8) return [];
	const shown = tasks.slice(0, Math.max(1, Math.floor(limit)));
	const lines = [truncateToWidth(`${fg("accent", "● Tasks")}${fg("dim", ` (${countSegments(tasks)})`)}`, width)];
	for (const [index, task] of shown.entries())
		lines.push(truncateToWidth(`${fg("dim", index === 0 ? "└─" : "  ")} ${taskRow(task, colors, fg, runs)}`, width));
	if (tasks.length > shown.length)
		lines.push(truncateToWidth(fg("dim", `   … ${tasks.length - shown.length} more`), width));
	return lines;
}

export function renderInlineTasks(
	tasks: readonly TaskRowView[],
	colors: ReadonlyMap<string, string>,
	fg: ThemeFg,
	width: number,
	runs: readonly AgentListRow[] = [],
	now = Date.now(),
	limit = INLINE_TASK_ROWS,
): string[] {
	const visible = inlineTasks(tasks);
	if (!visible.length || width < 8 || limit <= 0) return [];
	const ordered = [...visible].sort((a, b) => {
		const rank = (task: TaskRowView) =>
			activeTaskRun(task, runs)
				? 0
				: task.status === "in_progress"
					? 1
					: task.status === "pending"
						? 2
						: task.status === "in_review"
							? 3
							: task.status === "completed"
								? 4
								: 5;
		return rank(a) - rank(b) || (a.createdAt ?? 0) - (b.createdAt ?? 0);
	});
	const lines = [truncateToWidth(inlineTaskHeader(visible, fg), width)];
	const shown = ordered.slice(0, Math.max(1, Math.floor(limit)));
	for (let i = 0; i < shown.length; i++) {
		const task = shown[i];
		if (!task) continue;
		const running = activeTaskRun(task, runs);
		const elapsed = running
			? ` ${fg("muted", `${formatElapsedMs(Math.max(0, now - running.startedAt))} · ↓ ${running.totalTokens} tokens`)}`
			: "";
		// Hanging card: the first row carries the branch, the rest align under it.
		const branch = fg("dim", i === 0 ? "└─" : "  ");
		lines.push(truncateToWidth(`${branch} ${taskRow(task, colors, fg, runs)}${elapsed}`, width));
	}
	if (visible.length > shown.length)
		lines.push(truncateToWidth(fg("dim", `   … ${visible.length - shown.length} more`), width));
	return lines;
}

export function createTasksHubComponent(
	_tui: TUI,
	theme: Theme,
	getData: () => TasksHubData | null,
	onSelect?: (id: string) => void,
	onWheel?: (delta: number, region: "list" | "details", maxDetailScroll: number) => void,
	onDetailScrollLimit?: (taskId: string | null, max: number, normalizedOffset: number) => void,
): Component & Focusable {
	const fg = bindThemeFg(theme);
	let renderedWidth = _tui.terminal.columns;
	let renderedHeight = _tui.terminal.rows;
	let renderedMaxDetailScroll = 0;
	return {
		focused: true,
		handleInput() {},
		handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			const data = getData();
			if (!data) return undefined;
			if (event.type === "wheel" && event.wheelDelta !== undefined) {
				const split = renderedWidth >= 76 && !data.detail;
				const dividerX = 1 + Math.floor((renderedWidth - 2) * 0.48);
				if (event.y < 1 || event.y >= renderedHeight - 2) return undefined;
				const region = data.detail || (split && event.x > dividerX) ? "details" : "list";
				onWheel?.(event.wheelDelta < 0 ? -1 : 1, region, renderedMaxDetailScroll);
				return { handled: true, render: true };
			}
			if (event.type !== "click" || event.button !== "left" || !onSelect || data.detail) return undefined;
			const layout = tasksHubListWindow(data, renderedHeight);
			const target = layout.taskIdsByLine[event.y - 1];
			if (
				!target ||
				event.x < 1 ||
				event.x > (renderedWidth >= 76 ? Math.floor((renderedWidth - 2) * 0.48) : renderedWidth - 1)
			)
				return undefined;
			onSelect(target);
			return { handled: true, render: true };
		},
		render(width: number) {
			const data = getData();
			renderedWidth = width;
			renderedHeight = _tui.terminal.rows;
			return data
				? renderTasksHub(data, fg, width, renderedHeight, (id, max, offset) => {
						renderedMaxDetailScroll = max;
						onDetailScrollLimit?.(id, max, offset);
					})
				: [];
		},
		invalidate() {},
	};
}
