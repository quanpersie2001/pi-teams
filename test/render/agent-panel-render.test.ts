// Agent panel visible-width discipline at width 80 and narrow/wide boundaries.
// A deterministic ANSI-emitting theme exercises escape-sequence handling.

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentListRow, AgentListView } from "../../extension-src/pi-teams/domain/ui-view.js";
import {
	createAgentHubComponent,
	renderAgentHub,
	renderAgentPanel,
} from "../../extension-src/pi-teams/features/agent-panel/index.js";
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
		totalTokens: 146_500,
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

describe("team hub rendering", () => {
	it("splits on wide screens, collapses to selected details on narrow screens and bounds all lines", () => {
		const selected = row({ id: "selected", teammateName: "peer", description: "Inspect repository" });
		const data = { view: view([selected]), selection: selected.id, stopArmedFor: null, focus: null };
		for (const [width, height] of [
			[100, 24],
			[40, 12],
			[8, 3],
			[1, 1],
		]) {
			const { lines, targets } = renderAgentHub(data, fg, width, height, NOW);
			expect(lines).toHaveLength(height);
			assertWidthSafe(lines, width);
			if (width < 70) expect(targets.size).toBe(0);
		}
		expect(renderAgentHub(data, fg, 100, 24, NOW).lines.join("\n")).toContain("@peer");
		expect(renderAgentHub(data, fg, 40, 12, NOW).lines.join("\n")).toContain("Context   unknown");
	});

	it("colors teammate identity separately from status, context and subtle frame", () => {
		const named = row({
			id: "named",
			teammateName: "peer",
			teammateColor: "#E879F9",
			status: "completed",
			resourceState: "idle",
		});
		const data = {
			view: view([named]),
			selection: named.id,
			stopArmedFor: null,
			focus: {
				runId: named.id,
				currentRunId: null,
				model: "provider/model",
				thinking: "high",
				cwd: null,
				context: { usedTokens: 164_000, windowTokens: 1_000_000 },
				capabilities: [],
				items: [],
				truncatedHead: false,
				closed: true,
			},
		};
		const rgb = "\x1b[38;2;232;121;249m";
		const theme = renderTheme();
		for (const width of [1, 8, 40, 69, 70, 80, 100, 200]) {
			const lines = renderAgentHub(data, fg, width, 24, NOW).lines;
			assertWidthSafe(lines, width);
			if (width >= 40) {
				const text = lines.join("\n");
				expect(text).toContain(`${rgb}@peer\x1b[39m`);
				expect(text).toContain(fg("muted", "idle"));
				expect(text).toContain(fg("success", "━━"));
				expect(text).toContain(fg("borderMuted", "────────"));
			}
			if (width >= 70) {
				expect(lines.join("\n")).toContain(`${rgb}▸\x1b[39m`);
				expect(lines[1]).toContain(fg("borderMuted", "│"));
			}
		}
		const bg = vi.spyOn(theme, "bg");
		try {
			const component = createAgentHubComponent(
				{ terminal: { rows: 24, columns: 40 } } as never,
				theme,
				() => data,
				() => {},
				() => {},
				() => {},
				() => {},
				() => NOW,
			);
			for (const width of [8, 40, 70, 100]) {
				const lines = component.render(width);
				expect(lines).toEqual(renderAgentHub(data, fg, width, 24, NOW).lines);
				assertWidthSafe(lines, width);
				expect(lines.join("\n")).not.toContain("\x1b[49m");
				expect(lines.join("\n")).not.toContain("\x1b[48;");
			}
			expect(component.render(40).join("\n")).toContain(rgb);
			expect(bg).not.toHaveBeenCalled();
		} finally {
			bg.mockRestore();
		}
	});

	it("colors verified focus context at the green/yellow/red boundaries, including overflow", () => {
		const run = row({ id: "context", totalTokens: 999_999 });
		for (const [usedTokens, color, filled, percent] of [
			[69_000, "success", 7, 69],
			[70_000, "warning", 7, 70],
			[89_000, "warning", 9, 89],
			[90_000, "error", 9, 90],
			[120_000, "error", 10, 120],
		] as const) {
			const data = {
				view: view([run]),
				selection: run.id,
				stopArmedFor: null,
				focus: {
					runId: run.id,
					currentRunId: run.id,
					model: null,
					thinking: null,
					cwd: null,
					context: { usedTokens, windowTokens: 100_000 },
					capabilities: [],
					items: [],
					truncatedHead: false,
					closed: false,
				},
			};
			for (const width of [40, 100]) {
				const lines = renderAgentHub(data, fg, width, 24, NOW).lines;
				assertWidthSafe(lines, width);
				const text = lines.join("\n");
				expect(text).toContain(fg(color, "━".repeat(filled)));
				if (filled < 10) expect(text).toContain(fg("borderMuted", "─".repeat(10 - filled)));
				expect(text).toContain(`${percent}%`);
			}
		}
		const unknown = renderAgentHub(
			{ view: view([run]), selection: run.id, stopArmedFor: null, focus: null },
			fg,
			100,
			24,
			NOW,
		).lines.join("\n");
		expect(unknown).toContain("Context   unknown");
		expect(unknown).not.toContain("━");
	});

	it("colors outcomes by status rather than by teammate identity", () => {
		for (const [status, resourceState, color] of [
			["completed", "closed", "success"],
			["error", "closed", "error"],
			["queued", "pending", "muted"],
		] as const) {
			const run = row({ id: status, teammateName: "peer", teammateColor: "#e879f9", status, resourceState });
			const text = renderAgentHub(
				{ view: view([run]), selection: run.id, stopArmedFor: null, focus: null },
				fg,
				100,
				24,
				NOW,
			).lines.join("\n");
			expect(text).toContain(fg(color, status));
			expect(text).toContain("\x1b[38;2;232;121;249m@peer\x1b[39m");
		}
	});

	it("falls back to theme colors for absent or malformed teammate color", () => {
		for (const color of [undefined, "not-a-color", "#12345g"]) {
			const unnamed = row({ id: "fallback", teammateName: "peer", teammateColor: color });
			const text = renderAgentHub(
				{ view: view([unnamed]), selection: unnamed.id, stopArmedFor: null, focus: null },
				fg,
				100,
				24,
				NOW,
			).lines.join("\n");
			expect(text).toContain(fg("accent", "▸"));
			expect(text).toContain(fg("text", "@peer"));
			expect(text).toContain(fg("accent", "running"));
			expect(text).not.toContain("\x1b[38;2;232;121;249m");
		}
	});

	it("distinguishes retained idle resources from closed history and uses only focus context", () => {
		const idle = row({ id: "idle", status: "completed", resourceState: "idle", totalTokens: 900_000 });
		const closed = row({ id: "closed", status: "completed", resourceState: "closed" });
		const base = { view: view([idle, closed]), stopArmedFor: null };
		const unknown = renderAgentHub({ ...base, selection: "idle", focus: null }, fg, 100, 24, NOW).lines.join("\n");
		expect(unknown).toContain("idle");
		expect(unknown).toContain("Context   unknown");
		// The real focus port marks settled runs closed even when the named child is retained.
		const settledFocus = {
			runId: "idle",
			currentRunId: null,
			model: "provider/model",
			thinking: "high",
			cwd: null,
			context: { usedTokens: 164_000, windowTokens: 1_000_000 },
			capabilities: [],
			items: [],
			truncatedHead: false,
			closed: true,
		};
		const focused = renderAgentHub({ ...base, selection: "idle", focus: settledFocus }, fg, 100, 24, NOW).lines.join(
			"\n",
		);
		expect(focused).toContain("164K/1M 16%");
		expect(focused).toContain("provider/model");
		const historical = renderAgentHub(
			{ ...base, selection: "closed", focus: { ...settledFocus, runId: "closed" } },
			fg,
			100,
			24,
			NOW,
		).lines.join("\n");
		expect(historical).toContain("completed");
		expect(historical).toContain("Context   unknown");
		expect(historical).not.toContain("164K/1M");
	});

	it("maps clicks to visible windowed rows, never the footer or hidden runs", () => {
		const rows = Array.from({ length: 12 }, () => row());
		const data = { view: view(rows), selection: rows[9]?.id ?? "main", stopArmedFor: null, focus: null };
		const focused: string[] = [];
		const component = createAgentHubComponent(
			{ terminal: { rows: 12, columns: 100 } } as never,
			renderTheme(),
			() => data,
			() => {},
			(id) => focused.push(id),
			() => focused.push("main"),
			() => {},
			() => NOW,
		);
		component.render(100);
		const event = (y: number, x = 2) => ({
			type: "click" as const,
			button: "left" as const,
			y,
			x,
			screenX: x,
			screenY: y,
			width: 100,
			height: 12,
			shift: false,
			alt: false,
			ctrl: false,
		});
		const targets = renderAgentHub(data, fg, 100, 12, NOW).targets;
		const [y, id] = [...targets].find(([, target]) => target === rows[9]?.id) ?? [];
		expect(y).toBeDefined();
		component.handleMouse?.(event(y ?? 0));
		expect(focused).toEqual([id]);
		component.handleMouse?.(event(10)); // footer
		component.handleMouse?.(event(y ?? 0, 38)); // divider (roster ends at x=37)
		component.handleMouse?.(event(y ?? 0, 60)); // detail pane at the same row
		component.handleMouse?.(event(2, 60)); // detail pane beside main
		expect(focused).toEqual([id]);
		component.handleMouse?.(event(2)); // main roster row remains clickable
		expect(focused).toEqual([id, "main"]);
	});
});

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

	it("preserves teammate identity and frozen elapsed/token stats when a long description is truncated", () => {
		const named = row({
			teammateName: "lat1-mechanical",
			teammateColor: "#e879f9",
			description: "Lát 1 mechanical caller adaptation ".repeat(10),
			status: "completed",
			completedAt: 1_508_000,
			activity: "RESULT_PREVIEW_MUST_NOT_APPEAR",
		});
		const lines = renderAgentPanel({ view: view([named]), selection: null, stopArmedFor: null }, fg, 100, 9_000_000);
		const text = lines.join("\n");
		expect(text).toContain("@lat1-mechanical");
		expect(text).toContain("\u001b[38;2;232;121;249m");
		expect(text).toContain("25m 7s · ↓ 146.5k tokens");
		expect(text).not.toContain("RESULT_PREVIEW_MUST_NOT_APPEAR");
		assertWidthSafe(lines, 100);
	});

	it("keeps abort and unconfirmed cleanup warnings visible on narrow rows", () => {
		for (const armed of [false, true]) {
			const selected = row({ id: "uncertain", resourceState: "cleanup-unconfirmed" });
			const lines = renderAgentPanel(
				{ view: view([selected]), selection: selected.id, stopArmedFor: armed ? selected.id : null },
				fg,
				40,
				NOW,
			);
			expect(lines.join("\n")).toContain(armed ? "x again to ABORT" : "cleanup unconfirmed");
			assertWidthSafe(lines, 40);
		}
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
