import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	supportsTeammateStyleColor,
	syncTeammateStyleColor,
} from "../../extension-src/pi-teams/pi/teammate-style-color.js";

function colorSession(entries: Array<{ type: "custom"; customType: string; data: unknown }> = []) {
	const session = {
		getBranch: () => entries,
		appendCustomEntry: (customType: string, data: unknown) => {
			entries.push({ type: "custom", customType, data });
			return "entry";
		},
	} as unknown as Pick<SessionManager, "getBranch" | "appendCustomEntry">;
	return { session, entries };
}

describe("teammate pi-style border color", () => {
	it("skips incompatible pi-style builds that would crash on hex colors", () => {
		const root = mkdtempSync(join(tmpdir(), "teams-style-test-"));
		try {
			const pi = join(root, "pi");
			const editor = join(root, "features", "editor");
			mkdirSync(pi);
			mkdirSync(editor, { recursive: true });
			const entry = join(pi, "index.ts");
			const implementation = join(editor, "index.ts");
			writeFileSync(entry, "");
			writeFileSync(implementation, "rgbBorder(color); style(line, { fg: color })");
			expect(supportsTeammateStyleColor([entry])).toBe(false);
			writeFileSync(implementation, "rgbBorder(color)");
			expect(supportsTeammateStyleColor([entry])).toBe(true);
			expect(supportsTeammateStyleColor([])).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the same persisted color channel as pi-style, before session_start", () => {
		const { session, entries } = colorSession();
		syncTeammateStyleColor(session, { color: "#A3F", styleEnabled: true, resumingWithoutTeammate: false });
		expect(entries).toEqual([
			{ type: "custom", customType: "pi-style.editor-color", data: { color: "#aa33ff", owner: "pi-teams" } },
		]);
		syncTeammateStyleColor(session, { color: "#aa33ff", styleEnabled: true, resumingWithoutTeammate: false });
		expect(entries).toHaveLength(1);
	});

	it("does not write a style setting when pi-style is absent or color is invalid", () => {
		const { session, entries } = colorSession();
		syncTeammateStyleColor(session, { color: "#aabbcc", styleEnabled: false, resumingWithoutTeammate: false });
		syncTeammateStyleColor(session, { color: "red", styleEnabled: true, resumingWithoutTeammate: false });
		expect(entries).toHaveLength(0);
	});

	it("clears team-owned color on anonymous cold continuation", () => {
		const { session, entries } = colorSession([
			{ type: "custom", customType: "pi-style.editor-color", data: { color: "#aabbcc", owner: "pi-teams" } },
		]);
		syncTeammateStyleColor(session, { styleEnabled: true, resumingWithoutTeammate: true });
		expect(entries.at(-1)?.data).toEqual({ color: null, owner: "pi-teams" });
		syncTeammateStyleColor(session, { styleEnabled: true, resumingWithoutTeammate: true });
		expect(entries).toHaveLength(2);
	});

	it("preserves a user's own color on anonymous continuation and reapplies teammate color on a named one", () => {
		const { session, entries } = colorSession([
			{ type: "custom", customType: "pi-style.editor-color", data: { color: "#123456" } },
		]);
		syncTeammateStyleColor(session, { styleEnabled: true, resumingWithoutTeammate: true });
		expect(entries).toHaveLength(1);
		syncTeammateStyleColor(session, { color: "#abc", styleEnabled: true, resumingWithoutTeammate: false });
		expect(entries.at(-1)?.data).toEqual({ color: "#aabbcc", owner: "pi-teams" });
	});
});
