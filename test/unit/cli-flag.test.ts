import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DISABLE_PI_TEAMS_FLAG, isDisabledByCli } from "../../extension-src/pi-teams/pi/cli-flag.js";
import extension from "../../extension-src/pi-teams/pi/index.js";

afterEach(() => vi.restoreAllMocks());

describe("pi-teams disable flag", () => {
	it("is off by default and ignores other flags", () => {
		for (const args of [[], ["--disable-teams"], ["--disable-pi-style"], ["--disable-pi-teams-extra"]]) {
			expect(isDisabledByCli(args)).toBe(false);
		}
	});

	it("matches the flag and Pi boolean presence syntax", () => {
		for (const arg of ["--disable-pi-teams", "--disable-pi-teams=true", "--disable-pi-teams=false"]) {
			expect(isDisabledByCli(["--mode", "rpc", arg])).toBe(true);
		}
	});

	it("does not treat positional prompts after -- as flags", () => {
		expect(isDisabledByCli(["--", "--disable-pi-teams"])).toBe(false);
		expect(isDisabledByCli(["--disable-pi-teams", "--"])).toBe(true);
	});

	it("reads launch arguments, not the executable or entry path", () => {
		vi.spyOn(process, "argv", "get").mockReturnValue(["--disable-pi-teams", "--disable-pi-teams"]);
		expect(isDisabledByCli()).toBe(false);
	});

	it("registers only the flag when disabled", () => {
		vi.spyOn(process, "argv", "get").mockReturnValue(["node", "pi", "--disable-pi-teams"]);
		const registerFlag = vi.fn();
		const api = new Proxy(
			{ registerFlag },
			{
				get(target, key) {
					if (key === "registerFlag") return target.registerFlag;
					throw new Error(`Disabled extension accessed ${String(key)}`);
				},
			},
		) as unknown as ExtensionAPI;
		extension(api);
		expect(registerFlag).toHaveBeenCalledExactlyOnceWith(DISABLE_PI_TEAMS_FLAG, {
			type: "boolean",
			default: false,
			description: "Disable pi-teams tools, commands, UI, and lifecycle hooks for this process",
		});
	});
});
