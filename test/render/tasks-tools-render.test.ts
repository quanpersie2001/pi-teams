// Default `tasks_*` tool renderers (the card shown when no companion style
// package is installed). pi-style replaces these through its public renderer
// resolver, so they are kept small: one bounded list card, hanging row
// receipts, and a verbatim fallback for shapes they cannot parse.

import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createTasksTools } from "../../extension-src/pi-teams/pi/tasks-tools.js";
import { renderTheme } from "../helpers/render-theme.js";

const theme = renderTheme();
const colors = () => [{ name: "worker", color: "#22AA44" }];
const tools = createTasksTools(() => undefined, undefined, colors);

function tool(name: string) {
	const found = tools.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`${name} is not registered`);
	return found;
}

const plain = (lines: string[]): string[] => lines.map((line) => stripTerminalSequences(line).trimEnd());

function resultLines(
	name: string,
	_args: Record<string, unknown>,
	payload: unknown,
	options: { expanded: boolean } = { expanded: false },
): string[] {
	return (
		tool(name)
			.renderResult?.(
				{ content: [{ type: "text", text: JSON.stringify(payload) }] },
				{ expanded: options.expanded, isPartial: false },
				theme,
				{} as never,
			)
			.render(100) ?? []
	);
}

function callLines(name: string, args: Record<string, unknown>): string[] {
	return (
		tool(name)
			.renderCall?.(args as never, theme, {} as never)
			.render(100) ?? []
	);
}

const task = (overrides: Record<string, unknown> = {}) => ({
	id: "id-1",
	code: "T3",
	title: "PostgreSQL migrations",
	status: "in_progress",
	owner: "worker",
	dependencies: [],
	blockedBy: [],
	attempts: [],
	createdAt: 1,
	...overrides,
});

describe("default tasks tool renderers", () => {
	it("renders a bounded list card with counts, colored identity and a more tail", () => {
		const rows = [
			task(),
			task({ id: "id-2", code: "T4", status: "pending", owner: undefined, title: "Internal request" }),
			task({ id: "id-3", code: "T5", status: "pending", blockedBy: ["T1"], title: "Blocked step" }),
			task({ id: "id-4", code: "T6", status: "pending", title: "Fourth step" }),
		];
		const lines = resultLines("tasks_list", {}, rows);
		expect(plain(lines)[0]).toBe("● Tasks (1 in progress, 3 open)");
		expect(lines[1]?.startsWith(`${theme.fg("dim", "└─")} `)).toBe(true);
		expect(plain(lines)[1]).toBe("└─ ◐ T3 @worker PostgreSQL migrations");
		expect(lines[1]).toContain("\x1b[38;2;34;170;68m@worker\x1b[39m");
		expect(plain(lines)[2]).toContain("   ○ T4 unassigned Internal request");
		expect(plain(lines).at(-1)).toBe("   … 1 more");
		const expanded = resultLines("tasks_list", {}, rows, { expanded: true });
		expect(expanded.filter((line) => line.includes("T6"))).toHaveLength(1);
	});

	it("renders mutation and output receipts as single hanging rows", () => {
		const created = resultLines("tasks_create", { title: "New" }, task({ status: "pending", owner: undefined }));
		expect(plain(created).join("\n")).toBe("└─ ○ T3 unassigned PostgreSQL migrations");
		const executed = resultLines(
			"tasks_execute",
			{ id: "T3" },
			{ task: task({ attempts: [{ runId: "r", status: "running", teammateName: "worker" }] }), runId: "r" },
		);
		expect(plain(executed).join("\n")).toBe("└─ ◐ T3 @worker PostgreSQL migrations → @worker");
		const output = resultLines(
			"tasks_output",
			{ id: "T3" },
			{ taskId: "id-1", attempt: { status: "completed", teammateName: "worker" }, result: "first\nsecond" },
		);
		expect(plain(output).join("\n")).toBe("└─ completed · @worker\n  first\n  second");
		const stopped = resultLines("tasks_stop", { id: "T3" }, { stopped: true });
		expect(plain(stopped).join("\n")).toBe("└─ stop requested");
	});

	it("falls back to the verbatim payload and keeps short call lines", () => {
		const broken = resultLines("tasks_list", {}, { unexpected: true });
		expect(plain(broken).join("\n")).toContain('"unexpected"');
		expect(plain(callLines("tasks_update", { id: "T3", status: "completed" })).join("\n")).toBe(
			"▸ tasks_update T3 · completed",
		);
		expect(plain(callLines("tasks_execute", { id: "T3", type: "general-purpose" })).join("\n")).toBe(
			"▸ tasks_execute T3 → general-purpose",
		);
	});
});
