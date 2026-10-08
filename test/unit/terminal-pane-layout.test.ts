import { describe, expect, it } from "vitest";
import type {
	ChildLaunchSpec,
	LauncherHandle,
	ProcessLauncher,
} from "../../extension-src/pi-teams/domain/process-launcher.js";
import { type PaneGeometry, withTerminalPaneLayout } from "../../extension-src/pi-teams/pi/terminal-pane-layout.js";

type PaneTree = { paneId: string } | { direction: "right" | "down"; ratio: number; first: PaneTree; second: PaneTree };

function fixture() {
	const panes = new Map<string, PaneGeometry>();
	const owners = new Map<string, boolean>();
	const areas = new Map<PaneTree, PaneGeometry>();
	const painted = new Set<string>();
	let tree: PaneTree = { paneId: "main" };
	const focusedPaneId = "main";
	let rejectMove = false;
	let rejectResize = false;
	function paint(node = tree, area: PaneGeometry = { paneId: "main", x: 0, y: 0, width: 120, height: 36 }): void {
		if (node === tree) {
			for (const id of painted) panes.delete(id);
			painted.clear();
			areas.clear();
		}
		areas.set(node, area);
		if ("paneId" in node) {
			panes.set(node.paneId, { ...area, paneId: node.paneId });
			painted.add(node.paneId);
			return;
		}
		if (node.direction === "right") {
			const width = Math.round(area.width * node.ratio);
			paint(node.first, { ...area, width });
			paint(node.second, { ...area, x: area.x + width, width: area.width - width });
		} else {
			const height = Math.round(area.height * node.ratio);
			paint(node.first, { ...area, height });
			paint(node.second, { ...area, y: area.y + height, height: area.height - height });
		}
	}
	function replace(node: PaneTree, id: string, replacement: PaneTree): PaneTree {
		if ("paneId" in node) return node.paneId === id ? replacement : node;
		node.first = replace(node.first, id, replacement);
		node.second = replace(node.second, id, replacement);
		return node;
	}
	function detach(node: PaneTree, id: string): PaneTree | undefined {
		if ("paneId" in node) return node.paneId === id ? undefined : node;
		const first = detach(node.first, id);
		const second = detach(node.second, id);
		if (!first) return second;
		if (!second) return first;
		node.first = first;
		node.second = second;
		return node;
	}
	paint();
	const lifecycle: Omit<ProcessLauncher, "launch"> = {
		kind: "tmux",
		async available() {
			return true;
		},
		async alive(handle) {
			return owners.get(handle.childId) ?? false;
		},
		async terminate(handle) {
			if (!panes.has(handle.paneId ?? "")) return;
			if (!owners.get(handle.childId)) throw new Error("Unverified owner");
			tree = detach(tree, handle.paneId ?? "") ?? { paneId: "main" };
			owners.delete(handle.childId);
			paint();
		},
		async cleanupExited(handle) {
			await this.terminate(handle);
			return true;
		},
	};
	function launcher() {
		return withTerminalPaneLayout(
			lifecycle,
			{
				async parent() {
					return { paneId: "main", identity: "parent-birth", socketPath: "/tmp/owned-layout.sock" };
				},
				async inspect() {
					return [...panes.values()].map((pane) => ({ ...pane }));
				},
				async moveBelow(_parent, paneId, targetPaneId) {
					if (rejectMove) {
						rejectMove = false;
						throw new Error("Move refused");
					}
					tree = detach(tree, paneId) ?? { paneId: "main" };
					tree = replace(tree, targetPaneId, {
						direction: "down",
						ratio: 0.5,
						first: { paneId: targetPaneId },
						second: { paneId },
					});
					paint();
				},
				async resize(_parent, paneId, height) {
					if (rejectResize) {
						rejectResize = false;
						throw new Error("Resize refused");
					}
					const pane = panes.get(paneId);
					const boundary = [...areas.entries()].find(
						([node, area]) =>
							pane &&
							!("paneId" in node) &&
							node.direction === "down" &&
							area.x === pane.x &&
							area.width === pane.width &&
							area.y + Math.round(area.height * node.ratio) === pane.y + pane.height,
					);
					if (!pane || !boundary || "paneId" in boundary[0]) throw new Error("No lower boundary");
					boundary[0].ratio += (height - pane.height) / boundary[1].height;
					paint();
				},
				async resizeWidth(_parent, paneId, width) {
					const pane = panes.get(paneId);
					const boundary = [...areas.entries()].find(
						([node, area]) =>
							pane &&
							!("paneId" in node) &&
							node.direction === "right" &&
							area.y === pane.y &&
							area.height === pane.height &&
							area.x + Math.round(area.width * node.ratio) === pane.x + pane.width,
					);
					if (!pane || !boundary || "paneId" in boundary[0]) throw new Error("No right boundary");
					boundary[0].ratio += (width - pane.width) / boundary[1].width;
					paint();
				},
			},
			async (spec, plan) => {
				await Promise.resolve();
				if (!panes.has(plan.targetPaneId)) throw new Error("Split source missing");
				tree = replace(tree, plan.targetPaneId, {
					direction: plan.direction,
					ratio: 0.5,
					first: { paneId: plan.targetPaneId },
					second: { paneId: spec.childId },
				});
				owners.set(spec.childId, true);
				paint();
				return { kind: "tmux", childId: spec.childId, paneId: spec.childId, socketPath: plan.parent.socketPath };
			},
		);
	}
	return {
		launcher,
		panes,
		owners,
		focusedPaneId() {
			return focusedPaneId;
		},
		rejectNextResize() {
			rejectResize = true;
		},
		rejectNextMove() {
			rejectMove = true;
		},
	};
}
function spec(childId: string): ChildLaunchSpec {
	return {
		childId,
		runDir: "/tmp",
		cwd: "/tmp",
		env: {},
		interactiveArgv: ["node"],
		headlessCommand: "node",
		headlessArgv: [],
	};
}
function geometry(panes: Map<string, PaneGeometry>) {
	return [...panes.values()].sort((a, b) => a.x - b.x || a.y - b.y);
}

describe("managed terminal pane column", () => {
	it("serializes concurrent children, balances removal, and restores Main after the last child", async () => {
		const state = fixture();
		const launcher = state.launcher();
		const handles = await Promise.all(["a", "b", "c"].map((id) => launcher.launch(spec(id))));
		expect(geometry(state.panes)).toEqual([
			{ paneId: "main", x: 0, y: 0, width: 60, height: 36 },
			{ paneId: "a", x: 60, y: 0, width: 60, height: 12 },
			{ paneId: "b", x: 60, y: 12, width: 60, height: 12 },
			{ paneId: "c", x: 60, y: 24, width: 60, height: 12 },
		]);
		const [a, b, c] = handles as [LauncherHandle, LauncherHandle, LauncherHandle];
		await launcher.terminate(b);
		expect(geometry(state.panes).slice(1)).toEqual([
			{ paneId: "a", x: 60, y: 0, width: 60, height: 18 },
			{ paneId: "c", x: 60, y: 18, width: 60, height: 18 },
		]);
		await launcher.terminate(a);
		await launcher.terminate(c);
		expect(geometry(state.panes)).toEqual([{ paneId: "main", x: 0, y: 0, width: 120, height: 36 }]);
	});
	it("adopts persisted membership before allocating another child", async () => {
		const state = fixture();
		const first = state.launcher();
		const handles = await Promise.all(["a", "b"].map((id) => first.launch(spec(id))));
		const restored = state.launcher();
		for (const handle of handles) restored.restore?.(JSON.parse(JSON.stringify(handle)) as LauncherHandle);
		await restored.launch(spec("c"));
		expect(geometry(state.panes).map((pane) => [pane.paneId, pane.x, pane.width, pane.height])).toEqual([
			["main", 0, 60, 36],
			["a", 60, 60, 12],
			["b", 60, 60, 12],
			["c", 60, 60, 12],
		]);
	});
	it("preserves unrelated panes and refuses a reused child before splitting", async () => {
		const state = fixture();
		state.panes.set("unrelated", { paneId: "unrelated", x: 0, y: 40, width: 120, height: 20 });
		const launcher = state.launcher();
		await launcher.launch(spec("a"));
		const before = geometry(state.panes).map((pane) => ({ ...pane }));
		state.owners.set("a", false);
		await expect(launcher.launch(spec("b"))).rejects.toThrow("unverified child");
		expect(geometry(state.panes)).toEqual(before);
	});
	it("rolls back only its new split after resize failure and does not poison the queue", async () => {
		const state = fixture();
		const launcher = state.launcher();
		await launcher.launch(spec("a"));
		await launcher.launch(spec("b"));
		state.rejectNextResize();
		await expect(launcher.launch(spec("c"))).rejects.toThrow("Resize refused");
		expect(geometry(state.panes).map((pane) => [pane.paneId, pane.height])).toEqual([
			["main", 36],
			["a", 18],
			["b", 18],
		]);
		await launcher.launch(spec("d"));
		expect(geometry(state.panes).map((pane) => [pane.paneId, pane.height])).toEqual([
			["main", 36],
			["a", 12],
			["b", 12],
			["d", 12],
		]);
	});
	it("keeps one child column through three viewers, then balances two columns through six", async () => {
		for (const count of [1, 2, 3, 4, 5, 6]) {
			const state = fixture();
			const launcher = state.launcher();
			const handles = await Promise.all(
				["a", "b", "c", "d", "e", "f"].slice(0, count).map((id) => launcher.launch(spec(id))),
			);
			const panes = geometry(state.panes);
			const main = panes.find((pane) => pane.paneId === "main");
			const children = panes.filter((pane) => pane.paneId !== "main");
			const childColumns = [...new Set(children.map((pane) => pane.x))];
			expect(main?.width).toBe(count > 3 ? 40 : 60);
			expect(childColumns).toHaveLength(count > 3 ? 2 : 1);
			expect(children.map((pane) => pane.paneId).sort()).toEqual(["a", "b", "c", "d", "e", "f"].slice(0, count).sort());
			const columnSizes = childColumns.map((x) => children.filter((pane) => pane.x === x).length);
			expect(Math.max(...columnSizes) - Math.min(...columnSizes)).toBeLessThanOrEqual(1);
			expect(state.focusedPaneId()).toBe("main");
			expect(children.every((pane) => pane.width === main?.width)).toBe(true);
			for (const handle of handles) await launcher.terminate(handle);
			expect(geometry(state.panes)).toEqual([{ paneId: "main", x: 0, y: 0, width: 120, height: 36 }]);
		}
	});
	it("refuses a seventh viewer without allocating a pane or altering existing geometry", async () => {
		const state = fixture();
		const launcher = state.launcher();
		const handles = await Promise.all(["a", "b", "c", "d", "e", "f"].map((id) => launcher.launch(spec(id))));
		const before = geometry(state.panes);
		await expect(launcher.launch(spec("g"))).rejects.toThrow("at most six visible children");
		expect(geometry(state.panes)).toEqual(before);
		expect(state.focusedPaneId()).toBe("main");
		for (const handle of handles) await launcher.terminate(handle);
	});
	it("rebalances the three/four boundary without replacing surviving panes", async () => {
		const state = fixture();
		const launcher = state.launcher();
		const handles = await Promise.all(["a", "b", "c", "d"].map((id) => launcher.launch(spec(id))));
		const originalPaneIds = handles.map((handle) => handle.paneId).sort();
		const removed = handles[3];
		if (!removed) throw new Error("Fixture lost its fourth child");
		await launcher.terminate(removed);
		expect(
			geometry(state.panes)
				.map((pane) => pane.paneId)
				.filter((id) => id !== "main")
				.sort(),
		).toEqual(originalPaneIds.slice(0, 3));
		expect(
			new Set(
				geometry(state.panes)
					.filter((pane) => pane.paneId !== "main")
					.map((pane) => pane.x),
			).size,
		).toBe(1);
		for (const handle of handles.slice(0, 3)) await launcher.terminate(handle);
		expect(geometry(state.panes)).toEqual([{ paneId: "main", x: 0, y: 0, width: 120, height: 36 }]);
	});
	it("restores persisted membership and leaves foreign panes outside the managed region", async () => {
		const state = fixture();
		state.panes.set("unrelated", { paneId: "unrelated", x: 0, y: 40, width: 120, height: 20 });
		const first = state.launcher();
		const handles = await Promise.all(["a", "b", "c", "d"].map((id) => first.launch(spec(id))));
		const restored = state.launcher();
		for (const handle of handles) restored.restore?.(JSON.parse(JSON.stringify(handle)) as LauncherHandle);
		const before = state.panes.get("unrelated");
		const removed = handles[0];
		if (!removed) throw new Error("No child pane was launched");
		await restored.terminate(removed);
		expect(state.panes.get("unrelated")).toEqual(before);
		for (const handle of handles.slice(1)) await restored.terminate(handle);
		expect(state.panes.get("unrelated")).toEqual(before);
	});
	it("rolls back a new column when reparenting fails before touching existing children", async () => {
		const state = fixture();
		const launcher = state.launcher();
		await Promise.all(["a", "b", "c"].map((id) => launcher.launch(spec(id))));
		const before = geometry(state.panes).map((pane) => ({ ...pane }));
		state.rejectNextMove();
		await expect(launcher.launch(spec("d"))).rejects.toThrow("Move refused");
		expect(geometry(state.panes)).toEqual(before);
	});
});
