import { describe, expect, it } from "vitest";
import type { LauncherCommandRunner } from "../../extension-src/pi-teams/domain/process-launcher.js";
import { createHerdrPaneLayoutAdapter } from "../../extension-src/pi-teams/pi/herdr-pane-layout.js";

// Native split trees observed in HerdR 0.9.1. Direction chooses the adjacent
// boundary, not an unconditional height delta on the requested pane.
function nativeFixture(height = 51, initialFirstRatio = 0.22549021, splitTail = true, initialSecondRatio = 0.5) {
	let firstRatio = initialFirstRatio;
	let secondRatio = initialSecondRatio;
	let mainWidthRatio = 0.5;
	function layout() {
		const mainWidth = Math.round(156 * mainWidthRatio);
		const childWidth = 156 - mainWidth;
		const firstHeight = Math.round(height * firstRatio);
		const remaining = height - firstHeight;
		const secondHeight = Math.round(remaining * secondRatio);
		const tail = remaining - secondHeight;
		const thirdHeight = splitTail ? Math.round(tail * 0.5) : tail;
		return {
			area: { x: 0, y: 0, width: 156, height },
			panes: [
				{ pane_id: "main", rect: { x: 0, y: 0, width: mainWidth, height } },
				{ pane_id: "a", rect: { x: mainWidth, y: 0, width: childWidth, height: firstHeight } },
				{ pane_id: "b", rect: { x: mainWidth, y: firstHeight, width: childWidth, height: secondHeight } },
				{ pane_id: "c", rect: { x: mainWidth, y: firstHeight + secondHeight, width: childWidth, height: thirdHeight } },
				...(splitTail
					? [
							{
								pane_id: "d",
								rect: {
									x: mainWidth,
									y: firstHeight + secondHeight + thirdHeight,
									width: childWidth,
									height: tail - thirdHeight,
								},
							},
						]
					: []),
			],
			splits: [
				{ direction: "right", ratio: mainWidthRatio, rect: { x: 0, y: 0, width: 156, height } },
				{ direction: "down", ratio: firstRatio, rect: { x: mainWidth, y: 0, width: childWidth, height } },
				{
					direction: "down",
					ratio: secondRatio,
					rect: { x: mainWidth, y: firstHeight, width: childWidth, height: remaining },
				},
				...(splitTail
					? [
							{
								direction: "down",
								ratio: 0.5,
								rect: { x: mainWidth, y: firstHeight + secondHeight, width: childWidth, height: tail },
							},
						]
					: []),
			],
		};
	}
	const runner: LauncherCommandRunner = {
		async run(_command, args) {
			let result: unknown;
			if (args[1] === "get") result = { pane: { pane_id: "main", terminal_id: "main-birth" } };
			else if (args[1] === "layout") result = { layout: layout() };
			else if (args[1] === "resize") {
				const pane = args[args.indexOf("--pane") + 1];
				const direction = args[args.indexOf("--direction") + 1];
				const amount = Number(args[args.indexOf("--amount") + 1]);
				if (direction === "up") {
					if (pane === "b") firstRatio = Math.fround(Math.fround(firstRatio) - Math.fround(amount));
					else if (pane === "c") secondRatio = Math.fround(secondRatio - amount);
					else throw new Error("Unexpected vertical resize boundary");
				} else if (direction === "down" && pane === "a") {
					firstRatio = Math.fround(firstRatio + amount);
				} else if (direction === "left" && pane === "a") {
					mainWidthRatio = Math.fround(mainWidthRatio - amount);
				} else {
					throw new Error("Unexpected resize boundary");
				}
				result = { type: "ok" };
			} else throw new Error("Unexpected geometry operation");
			return { stdout: JSON.stringify({ id: "cli", result }), stderr: "" };
		},
	};
	return runner;
}

describe("HerdR native pane geometry", () => {
	it("shrinks a middle row through its lower boundary without changing an already balanced row", async () => {
		const adapter = createHerdrPaneLayoutAdapter(nativeFixture(), {
			HERDR_ENV: "1",
			HERDR_PANE_ID: "main",
			HERDR_SOCKET_PATH: "/tmp/owned-herdr.sock",
		});
		const parent = await adapter.parent();
		await adapter.resize(parent, "b", 13);
		expect(await adapter.inspect(parent)).toEqual([
			{ paneId: "main", x: 0, y: 0, width: 78, height: 51 },
			{ paneId: "a", x: 78, y: 0, width: 78, height: 12 },
			{ paneId: "b", x: 78, y: 12, width: 78, height: 13 },
			{ paneId: "c", x: 78, y: 25, width: 78, height: 13 },
			{ paneId: "d", x: 78, y: 38, width: 78, height: 13 },
		]);
	});
	it("targets cell centers at odd terminal heights instead of accumulating half-cell rounding drift", async () => {
		const adapter = createHerdrPaneLayoutAdapter(nativeFixture(89, 0.5, false), {
			HERDR_ENV: "1",
			HERDR_PANE_ID: "main",
			HERDR_SOCKET_PATH: "/tmp/owned-herdr.sock",
		});
		const parent = await adapter.parent();
		await adapter.resize(parent, "a", 29);
		expect(await adapter.inspect(parent)).toEqual([
			{ paneId: "main", x: 0, y: 0, width: 78, height: 89 },
			{ paneId: "a", x: 78, y: 0, width: 78, height: 29 },
			{ paneId: "b", x: 78, y: 29, width: 78, height: 30 },
			{ paneId: "c", x: 78, y: 59, width: 78, height: 30 },
		]);
	});
	it("resizes through a larger valid split-ratio delta and keeps the adjacent pane geometry consistent", async () => {
		const adapter = createHerdrPaneLayoutAdapter(nativeFixture(39, 8 / 39, false), {
			HERDR_ENV: "1",
			HERDR_PANE_ID: "main",
			HERDR_SOCKET_PATH: "/tmp/owned-herdr.sock",
		});
		const parent = await adapter.parent();
		await adapter.resize(parent, "a", 31);
		expect(await adapter.inspect(parent)).toEqual([
			{ paneId: "main", x: 0, y: 0, width: 78, height: 39 },
			{ paneId: "a", x: 78, y: 0, width: 78, height: 31 },
			{ paneId: "b", x: 78, y: 31, width: 78, height: 4 },
			{ paneId: "c", x: 78, y: 35, width: 78, height: 4 },
		]);
	});
	it("resizes the owned horizontal boundary through an adjacent child while preserving parent identity", async () => {
		const adapter = createHerdrPaneLayoutAdapter(nativeFixture(), {
			HERDR_ENV: "1",
			HERDR_PANE_ID: "main",
			HERDR_SOCKET_PATH: "/tmp/owned-herdr.sock",
		});
		const parent = await adapter.parent();
		await adapter.resizeWidth(parent, "main", 50);
		expect(await adapter.inspect(parent)).toEqual([
			{ paneId: "main", x: 0, y: 0, width: 50, height: 51 },
			{ paneId: "a", x: 50, y: 0, width: 106, height: 12 },
			{ paneId: "b", x: 50, y: 12, width: 106, height: 20 },
			{ paneId: "c", x: 50, y: 32, width: 106, height: 10 },
			{ paneId: "d", x: 50, y: 42, width: 106, height: 9 },
		]);
	});
});
