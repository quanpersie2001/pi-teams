// Agent panel visible-width discipline at width 80 and narrow/wide boundaries.
// A deterministic ANSI-emitting theme exercises escape-sequence handling.

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { AgentListRow, AgentListView } from "../../extension-src/pi-teams/domain/ui-view.js";
import { renderAgentPanel } from "../../extension-src/pi-teams/features/agent-panel/index.js";
import { renderTheme } from "../helpers/render-theme.js";

const fg = renderTheme().fg.bind(renderTheme());

let nextId = 0;
function row(overrides: Partial<AgentListRow> = {}): AgentListRow {
	nextId += 1;
	return {
		id: `run-${nextId}`,
		type: "explore",
		description: "Find auth files across the repository and summarize the entrypoints",
		status: "running",
		backend: "process",
		resourceState: "open",
		startedAt: 1_000,
		completedAt: undefined,
		toolUses: 3,
		turns: 5,
		isBackground: true,
		capabilities: { attachable: false, viewable: true, steerable: true, stoppable: true, resumable: false },
		...overrides,
	};
}

function view(rows: readonly AgentListRow[]): AgentListView {
	return {
		rows,
		runningCount: rows.filter((r) => r.status === "running" || r.status === "queued").length,
		generatedAt: 2_000,
	};
}

function assertWidthSafe(lines: readonly string[], width: number): void {
	for (const line of lines) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
}

const NOW = 61_000; // elapsed 60s

describe("agent panel rendering", () => {
	it("renders at width 80 without throwing and respects line widths", () => {
		const lines = renderAgentPanel(
			{
				view: view([row(), row({ status: "completed", completedAt: 50_000 }), row({ status: "queued" })]),
				selection: "main",
				stopArmedFor: null,
			},
			fg,
			80,
			NOW,
		);
		expect(lines.length).toBeGreaterThan(0);
		assertWidthSafe(lines, 80);
	});

	it("width matrix incl. very narrow viewports never exceeds the viewport", () => {
		for (const width of [0, 1, 10, 20, 40, 60, 80, 120, 200]) {
			const lines = renderAgentPanel(
				{
					view: view([
						row({ ownerRef: "task:auth-fix", branch: "agent/auth-fix-a1b2c3d4", activity: "read login.ts" }),
						row({ id: "long", type: "GeneralPurposeImplementerWithAVeryLongName", description: "x".repeat(300) }),
					]),
					selection: null,
					stopArmedFor: null,
				},
				fg,
				width,
				NOW,
			);
			if (width >= 8) assertWidthSafe(lines, width);
			else expect(lines).toEqual([]);
		}
	});

	it("shows the selected row's stop-armed state and run stats", () => {
		const selectedRow = row({ id: "sel", backend: "process" });
		const lines = renderAgentPanel(
			{ view: view([selectedRow, row()]), selection: "sel", stopArmedFor: "sel" },
			fg,
			100,
			NOW,
		);
		const joined = lines.join("\n");
		expect(joined).toContain("main");
		expect(joined).toContain("60s");
		expect(joined).toContain("3 tools");
		assertWidthSafe(lines, 100);
	});
	it("labels verified closed resources and unconfirmed cleanup receipts honestly", () => {
		const lines = renderAgentPanel(
			{
				view: view([
					row({ status: "completed", resourceState: "closed", completedAt: 2_000 }),
					row({ id: "uncertain", status: "completed", resourceState: "cleanup-unconfirmed", completedAt: 2_000 }),
				]),
				selection: "main",
				stopArmedFor: null,
			},
			fg,
			180,
			NOW,
		);
		expect(lines.join("\n")).toContain("Pi process closed");
		expect(lines.join("\n")).toContain("Pi process close unconfirmed");
	});

	it("windows long lists with more-indicators and keeps widths bounded", () => {
		const many = Array.from({ length: 12 }, () => row());
		const lines = renderAgentPanel(
			{ view: view(many), selection: many[7]?.id ?? null, stopArmedFor: null },
			fg,
			80,
			NOW,
		);
		const agentRows = lines.filter((line) => line.includes("explore"));
		expect(agentRows.length).toBeLessThanOrEqual(6); // MAX_AGENT_ROWS
		expect(lines.join("\n")).toContain("more");
		assertWidthSafe(lines, 80);
	});
});
