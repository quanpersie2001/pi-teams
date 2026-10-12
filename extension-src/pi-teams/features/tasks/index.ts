import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TaskProjection } from "../../domain/task-board.js";
import type { AgentListRow } from "../../domain/ui-view.js";
import { formatElapsedMs } from "../../shared/elapsed.js";
import { bindThemeFg, type ThemeFg } from "../../shared/theme.js";

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

function rgb(hex: string, text: string): string {
	if (!/^#[\da-f]{6}$/i.test(hex)) return text;
	return `\x1b[38;2;${Number.parseInt(hex.slice(1, 3), 16)};${Number.parseInt(hex.slice(3, 5), 16)};${Number.parseInt(hex.slice(5, 7), 16)}m${text}\x1b[39m`;
}
function activeTaskRun(task: TaskProjection, runs: readonly AgentListRow[] = []): AgentListRow | undefined {
	const attempt = task.attempts.at(-1);
	if (!attempt) return undefined;
	return runs.find((row) => row.id === attempt.runId && row.status === "running");
}
const statusGlyph = (task: TaskProjection, fg: ThemeFg, runs: readonly AgentListRow[] = []): string => {
	if (task.status === "completed") return fg("success", "✓");
	if (task.status === "cancelled") return fg("dim", "⊘");
	if (activeTaskRun(task, runs)) return rgb("#00d7ff", "◉");
	const latest = task.attempts.at(-1);
	if (latest && (latest.status === "failed" || latest.status === "stopped")) return fg("error", "!");
	if (task.status === "in_progress") return rgb("#3b82f6", "◼");
	if (task.status === "in_review") return rgb("#a855f7", "◇");
	return task.blockedBy.length ? rgb("#f59e0b", "◌") : fg("text", "○");
};

function wrapAnsi(text: string, width: number): string[] {
	if (width < 1) return [""];
	const tokens: string[] = [];
	for (let i = 0; i < text.length; ) {
		if (text[i] === "\x1b" && text[i + 1] === "[") {
			const end = text.indexOf("m", i + 2);
			if (end >= 0) {
				tokens.push(text.slice(i, end + 1));
				i = end + 1;
				continue;
			}
		}
		const codePoint = text.codePointAt(i);
		if (codePoint === undefined) break;
		const char = String.fromCodePoint(codePoint);
		tokens.push(char);
		i += char.length;
	}
	const lines: string[] = [];
	let line = "";
	let used = 0;
	let color = "";
	for (const token of tokens) {
		if (token === "\n") {
			lines.push(`${line}${color ? "\x1b[39m" : ""}`);
			line = color;
			used = 0;
			continue;
		}
		if (token.startsWith("\x1b[")) {
			line += token;
			color = token === "\x1b[39m" ? "" : token;
			continue;
		}
		const tokenWidth = visibleWidth(token);
		if (used > 0 && used + tokenWidth > width) {
			lines.push(`${line}${color ? "\x1b[39m" : ""}`);
			line = color;
			used = 0;
		}
		line += token;
		used += tokenWidth;
	}
	if (line || lines.length === 0) lines.push(line);
	return lines;
}

export function taskHeader(tasks: readonly TaskProjection[]): string {
	const counts = [
		[tasks.filter((t) => t.status === "completed").length, "done"],
		[tasks.filter((t) => t.status === "in_progress").length, "in progress"],
		[tasks.filter((t) => t.status === "pending").length, "open"],
		[tasks.filter((t) => t.status === "in_review").length, "in review"],
		[tasks.filter((t) => t.status === "cancelled").length, "cancelled"],
	] as const;
	return `● ${tasks.length} tasks (${counts
		.filter(([count]) => count > 0)
		.map(([count, name]) => `${count} ${name}`)
		.join(", ")})`;
}

export function inlineTasks(tasks: readonly TaskProjection[]): TaskProjection[] {
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

function taskIdentity(task: TaskProjection): string | undefined {
	const latestTeammate = task.attempts.at(-1)?.teammateName;
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

export function renderTasksHub(data: TasksHubData, fg: ThemeFg, width: number, height: number): string[] {
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
		if (selected.description) details.push(` ${fg("muted", selected.description)}`);
		if (selected.spec.acceptanceCriteria?.length)
			details.push(` ${fg("accent", "Acceptance")}`, ...selected.spec.acceptanceCriteria.map((x) => `  • ${x}`));
		if (selected.spec.scope?.paths?.length)
			details.push(` ${fg("accent", "Scope")} ${selected.spec.scope.paths.join(", ")}`);
		if (selected.spec.scope?.outOfScope?.length)
			details.push(` ${fg("muted", `Out of scope: ${selected.spec.scope.outOfScope.join(", ")}`)}`);
		if (selected.spec.expectedOutput)
			details.push(` ${fg("accent", "Expected output")} ${selected.spec.expectedOutput}`);
		if (selected.spec.constraints?.length)
			details.push(` ${fg("accent", "Constraints")}`, ...selected.spec.constraints.map((x) => `  • ${x}`));
		if (selected.context.background) details.push(` ${fg("accent", "Context")} ${selected.context.background}`);
		if (selected.context.decisions?.length) details.push(...selected.context.decisions.map((x) => `  • ${x}`));
		for (const reference of selected.context.references ?? [])
			details.push(
				` ${fg("muted", `${reference.kind}: ${reference.target}${reference.note ? ` — ${reference.note}` : ""}`)}`,
			);
		if (selected.dependencies.length)
			details.push(` ${fg("muted", `Prerequisites: ${selected.dependencies.join(", ")}`)}`);
		const taskRefs = new Set([selected.id, ...(selected.code ? [selected.code] : [])]);
		const dependents = data.tasks.filter(
			(task) => task.id !== selected.id && task.dependencies.some((dependency) => taskRefs.has(dependency)),
		);
		if (dependents.length)
			details.push(` ${fg("muted", `Dependents: ${dependents.map((task) => task.code ?? task.id).join(", ")}`)}`);
		if (selected.blockedBy.length) details.push(` ${fg("warning", `Blocked by: ${selected.blockedBy.join(", ")}`)}`);
		const latestRunId = selected.attempts.at(-1)?.runId;
		const run = data.runs?.find((candidate) => candidate.id === latestRunId);
		if (run) {
			const elapsed = Math.max(0, (run.completedAt ?? data.now ?? Date.now()) - run.startedAt);
			details.push(` ${fg("muted", `Run metrics: ${formatElapsedMs(elapsed)} · ↓ ${run.totalTokens} tokens`)}`);
		}
		if (selected.outcome?.summary) details.push(` ${fg("accent", "Outcome")} ${selected.outcome.summary}`);
		for (const artifact of selected.outcome?.artifacts ?? []) details.push(` ${fg("muted", `Artifact: ${artifact}`)}`);
		for (const issue of selected.outcome?.remainingIssues ?? [])
			details.push(` ${fg("warning", `Remaining issue: ${issue}`)}`);
		for (const check of selected.outcome?.verification ?? [])
			details.push(
				` ${check.outcome === "passed" ? fg("success", "✓") : check.outcome === "failed" ? fg("error", "!") : fg("muted", "○")} ${check.check}${check.evidence ? ` — ${check.evidence}` : ""}`,
			);
		for (const attempt of selected.attempts)
			details.push(
				` ${attempt.status === "failed" ? fg("error", "!") : fg("muted", "·")} attempt ${attempt.status}${attempt.teammateName ? ` ${identity(attempt.teammateName, data.rosterColors, fg)}` : ""} · ${attempt.runId}${attempt.error ? `: ${attempt.error}` : ""}${attempt.resultFile ? ` · ${fg("muted", `result ${attempt.resultFile}`)}` : ""}${attempt.partialResult ? ` ${attempt.partialResult}` : ""}`,
			);
	} else details.push(` ${fg("muted", "No tasks match this filter.")}`);
	const wrappedDetails = details.flatMap((detail) => wrapAnsi(detail, split ? rightWidth - 1 : inner));
	const listRows: string[] = [` ${fg("muted", `Search: ${oneLine(data.query) || "(none)"} · ${data.filter}`)}`];
	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i];
		if (!task) continue;
		const chosen = task.id === selected?.id;
		const glyph = statusGlyph(task, fg, data.runs);
		const assignee = taskIdentity(task);
		const branch = i === tasks.length - 1 ? "└─" : "├─";
		listRows.push(
			`${chosen ? fg("accent", "›") : " "} ${fg("borderMuted", branch)} ${glyph} ${fg("muted", task.code ?? task.id)} ${identity(assignee, data.rosterColors, fg)} ${oneLine(task.title)}${task.blockedBy.length ? ` ${fg("warning", `← ${task.blockedBy.join(",")}`)}` : ""}`,
		);
	}
	const selectedRow = tasks.findIndex((t) => t.id === selected?.id) + 1;
	const start = Math.max(0, Math.min(listRows.length - rowLines, selectedRow - rowLines + 1));
	const visibleList = listRows.slice(start, start + rowLines);
	const visibleDetails = wrappedDetails.slice(
		Math.max(0, data.detailScroll ?? 0),
		Math.max(0, data.detailScroll ?? 0) + bodyEnd,
	);
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

function inlineTaskHeader(tasks: readonly TaskProjection[]): string {
	const counts = [
		[tasks.filter((task) => task.status === "in_progress").length, "in progress"],
		[tasks.filter((task) => task.status === "in_review").length, "in review"],
		[tasks.filter((task) => task.status === "pending").length, "open"],
	] as const;
	return `● ${tasks.length} tasks (${counts
		.filter(([count]) => count > 0)
		.map(([count, name]) => `${count} ${name}`)
		.join(", ")})`;
}

export function renderInlineTasks(
	tasks: readonly TaskProjection[],
	colors: ReadonlyMap<string, string>,
	fg: ThemeFg,
	width: number,
	runs: readonly AgentListRow[] = [],
	now = Date.now(),
): string[] {
	const visible = inlineTasks(tasks);
	if (!visible.length || width < 8) return [];
	const ordered = [...visible].sort((a, b) => {
		const rank = (task: TaskProjection) =>
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
		return rank(a) - rank(b) || a.createdAt - b.createdAt;
	});
	const lines = [truncateToWidth(fg("accent", inlineTaskHeader(visible)), width)];
	const shown = ordered.slice(0, 2);
	for (let i = 0; i < shown.length; i++) {
		const task = shown[i];
		if (!task) continue;
		const running = activeTaskRun(task, runs);
		const glyph = statusGlyph(task, fg, runs);
		const who = taskIdentity(task);
		const elapsed = running
			? ` ${formatElapsedMs(Math.max(0, now - running.startedAt))} · ↓ ${running.totalTokens} tokens`
			: "";
		const line = `${i === shown.length - 1 ? "└─" : "├─"} ${glyph} ${task.code ?? task.id} ${identity(who, colors, fg)} ${oneLine(task.title)}${task.blockedBy.length ? ` ${fg("warning", `blocked by ${task.blockedBy.join(", ")}`)}` : ""}${elapsed ? fg("muted", elapsed) : ""}`;
		lines.push(truncateToWidth(line, width));
	}
	if (visible.length > shown.length)
		lines.push(truncateToWidth(fg("muted", `  +${visible.length - shown.length} more tasks`), width));
	return lines;
}

export function createTasksHubComponent(
	_tui: TUI,
	theme: Theme,
	getData: () => TasksHubData | null,
	onSelect?: (id: string) => void,
	onWheel?: (delta: number) => void,
): Component & Focusable {
	const fg = bindThemeFg(theme);
	let renderedWidth = _tui.terminal.columns;
	return {
		focused: true,
		handleInput() {},
		handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			const data = getData();
			if (!data) return undefined;
			if (event.type === "wheel" && event.wheelDelta !== undefined) {
				onWheel?.(event.wheelDelta < 0 ? -1 : 1);
				return { handled: true, render: true };
			}
			if (event.type !== "click" || event.button !== "left" || !onSelect || data.detail) return undefined;
			const tasks = visibleTasks(data);
			const bodyEnd = Math.max(0, _tui.terminal.rows - 3);
			const selectedIndex = tasks.findIndex((task) => task.id === data.selection);
			const rowStart = Math.max(0, Math.min(tasks.length + 1 - bodyEnd, selectedIndex + 2 - bodyEnd));
			const taskIndex = event.y - 2 + rowStart;
			if (
				taskIndex < 0 ||
				taskIndex >= tasks.length ||
				event.x < 1 ||
				event.x > (renderedWidth >= 76 ? Math.floor((renderedWidth - 2) * 0.48) : renderedWidth - 1)
			)
				return undefined;
			const task = tasks[taskIndex];
			if (!task) return undefined;
			onSelect(task.id);
			return { handled: true, render: true };
		},
		render(width: number) {
			const data = getData();
			renderedWidth = width;
			return data ? renderTasksHub(data, fg, width, _tui.terminal.rows) : [];
		},
		invalidate() {},
	};
}
