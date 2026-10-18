import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	isPrivateWindowsAcl,
	parseWindowsAclEvidence,
	resolveWindowsPeerAclScriptPath,
} from "../../extension-src/pi-teams/pi/windows-peer-acl.js";

const execFileAsync = promisify(execFile);

const safe = {
	ownerSid: "S-1-5-21-1",
	currentSid: "S-1-5-21-1",
	daclProtected: true,
	reparsePoint: false,
	unexpectedAccess: false,
	currentUserFullControl: true,
};

describe("Windows peer ACL evidence", () => {
	it("accepts only protected, non-reparse, current-user-owned evidence", () => {
		expect(isPrivateWindowsAcl(safe)).toBe(true);
		for (const change of [
			{ ownerSid: "S-1-5-18" },
			{ daclProtected: false },
			{ reparsePoint: true },
			{ unexpectedAccess: true },
			{ currentUserFullControl: false },
		])
			expect(isPrivateWindowsAcl({ ...safe, ...change })).toBe(false);
	});
	it("resolves the ACL helper from bundled dist through the package-root source fallback", () => {
		const bundleUrl = pathToFileURL(resolve("dist/extensions/pi-teams.js")).href;
		expect(resolveWindowsPeerAclScriptPath(bundleUrl)).toBe(resolve("extension-src/pi-teams/pi/windows-peer-acl.ps1"));
	});
	it("parses complete typed evidence and rejects malformed/partial output", () => {
		expect(parseWindowsAclEvidence(JSON.stringify(safe))).toEqual(safe);
		expect(parseWindowsAclEvidence("not json")).toBeUndefined();
		expect(parseWindowsAclEvidence(JSON.stringify({ ...safe, unexpectedAccess: "false" }))).toBeUndefined();
	});
	it.skipIf(process.platform !== "win32")(
		"uses trusted Windows PowerShell security modules despite poisoned PSModulePath",
		async () => {
			const temp = await mkdtemp(join(tmpdir(), "peer-acl-module-path-"));
			const poisonedModules = join(temp, "poisoned-modules");
			const poisonModule = join(poisonedModules, "Microsoft.PowerShell.Security");
			await mkdir(poisonModule, { recursive: true });
			await writeFile(
				join(poisonModule, "Microsoft.PowerShell.Security.psm1"),
				"function Get-Acl { throw 'poison module loaded' }; Export-ModuleMember -Function Get-Acl",
			);
			try {
				const script = resolveWindowsPeerAclScriptPath();
				const { stdout } = await execFileAsync(
					"powershell.exe",
					[
						"-NoLogo",
						"-NoProfile",
						"-NonInteractive",
						"-ExecutionPolicy",
						"Bypass",
						"-File",
						script,
						"-Path",
						join(temp, "storage"),
						"-ProvisionLeaf",
					],
					{ env: { ...process.env, PSModulePath: poisonedModules }, timeout: 15_000, windowsHide: true },
				);
				const evidence = parseWindowsAclEvidence(stdout);
				if (evidence === undefined) throw new Error("ACL helper did not return valid evidence");
				expect(isPrivateWindowsAcl(evidence)).toBe(true);
			} finally {
				await rm(temp, { recursive: true, force: true });
			}
		},
	);
});
