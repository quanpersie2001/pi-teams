import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	isSupportedWindowsPipeRuntimeProbe,
	WINDOWS_PIPE_HELPER_EXECUTABLE,
	WINDOWS_PIPE_RUNTIME_PROBE,
} from "../../extension-src/pi-teams/pi/peer-transport.js";

describe("Windows peer pipe runtime capability probe", () => {
	it("accepts only the exact successful PowerShell 7+ capability result", () => {
		expect(WINDOWS_PIPE_HELPER_EXECUTABLE).toBe("pwsh.exe");
		expect(isSupportedWindowsPipeRuntimeProbe("PI_TEAMS_PIPE_RUNTIME_OK\r\n", "", 0)).toBe(true);
		expect(isSupportedWindowsPipeRuntimeProbe("unsupported\r\n", "", 41)).toBe(false);
		expect(isSupportedWindowsPipeRuntimeProbe("PI_TEAMS_PIPE_RUNTIME_OK", "warning", 0)).toBe(false);
		expect(isSupportedWindowsPipeRuntimeProbe("unexpected output", "", 0)).toBe(false);
	});

	it("probes the enum member by name and the helper refuses unsupported runtimes", () => {
		expect(WINDOWS_PIPE_RUNTIME_PROBE).toContain("$PSVersionTable.PSVersion.Major -lt 7");
		expect(WINDOWS_PIPE_RUNTIME_PROBE).toContain("[Enum]::GetNames([IO.Pipes.PipeOptions])");
		expect(WINDOWS_PIPE_RUNTIME_PROBE).toContain("CurrentUserOnly");
		const helper = readFileSync(
			new URL("../../extension-src/pi-teams/pi/windows-peer-pipe.ps1", import.meta.url),
			"utf8",
		);
		expect(helper).toContain("[Enum]::Parse([IO.Pipes.PipeOptions], 'CurrentUserOnly', $false)");
		expect(helper).not.toContain("[IO.Pipes.PipeOptions]::CurrentUserOnly");
	});
});
