import { describe, expect, it } from "vitest";
import type { LauncherCommandRunner } from "../../extension-src/pi-subagents/domain/process-launcher.js";
import { createHerdrPaneLayoutAdapter } from "../../extension-src/pi-subagents/pi/herdr-pane-layout.js";

// Native split trees observed in HerdR 0.9.1. Direction chooses the adjacent
// boundary, not an unconditional height delta on the requested pane.
function nativeFixture(height = 51, initialFirstRatio = 0.22549021, splitTail = true) {
	let firstRatio = initialFirstRatio;
	let secondRatio = 0.5;
	function layout() {
		const firstHeight = Math.round(height * firstRatio);
		const remaining = height - firstHeight;
		const secondHeight = Math.round(remaining * secondRatio);
		const tail = remaining - secondHeight;
		const thirdHeight = splitTail ? Math.round(tail * 0.5) : tail;
		return {
			area: { x: 0, y: 0, width: 156, height },
			panes: [
				{ pane_id: "main", rect: { x: 0, y: 0, width: 78, height } },
				{ pane_id: "a", rect: { x: 78, y: 0, width: 78, height: firstHeight } },
				{ pane_id: "b", rect: { x: 78, y: firstHeight, width: 78, height: secondHeight } },
				{ pane_id: "c", rect: { x: 78, y: firstHeight + secondHeight, width: 78, height: thirdHeight } },
				...(splitTail
					? [
							{
								pane_id: "d",
								rect: { x: 78, y: firstHeight + secondHeight + thirdHeight, width: 78, height: tail - thirdHeight },
							},
						]
					: []),
			],
			splits: [
				{ direction: "right", ratio: 0.5, rect: { x: 0, y: 0, width: 156, height } },
				{ direction: "down", ratio: firstRatio, rect: { x: 78, y: 0, width: 78, height } },
				{ direction: "down", ratio: secondRatio, rect: { x: 78, y: firstHeight, width: 78, height: remaining } },
				...(splitTail
					? [{ direction: "down", ratio: 0.5, rect: { x: 78, y: firstHeight + secondHeight, width: 78, height: tail } }]
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
				if (direction !== "up") throw new Error("Fixture only models upward boundary movement");
				// Native split ratios and resize amounts use f32, including half-cell rounding.
				if (pane === "b") firstRatio = Math.fround(Math.fround(firstRatio) - Math.fround(amount));
				else if (pane === "c") secondRatio = Math.fround(secondRatio - Math.fround(amount));
				else throw new Error("Unexpected resize boundary");
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
});
