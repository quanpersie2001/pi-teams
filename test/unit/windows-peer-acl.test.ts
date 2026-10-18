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
const trustedModulePath = join(
	process.env.SystemRoot ?? "C:\\Windows",
	"System32",
	"WindowsPowerShell",
	"v1.0",
	"Modules",
);
const runPowerShell = (args: string[], options: Parameters<typeof execFileAsync>[2] = {}) =>
	execFileAsync("powershell.exe", args, {
		...options,
		env: { ...process.env, PSModulePath: trustedModulePath, ...options.env },
	});
const trustedSecurityModuleBootstrap = `$ErrorActionPreference = 'Stop'
$trustedSecurityModule = Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'
Import-Module -Name $trustedSecurityModule -ErrorAction Stop -Force`;

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
		"normalizes token-default Administrators ownership only on private storage",
		async ({ skip }) => {
			const temp = await mkdtemp(join(tmpdir(), "peer-acl-admin-owner-"));
			const root = join(temp, "storage");
			const fixtureScript = join(temp, "create-admin-owned-tree.ps1");
			await writeFile(
				fixtureScript,
				`param([string]$Root)
${trustedSecurityModuleBootstrap}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$adminSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole($adminSid) -or $identity.Owner.Value -ne $adminSid.Value) { Write-Output '{"eligible":false}'; exit 0 }
[void][IO.Directory]::CreateDirectory($Root)
$acl = Get-Acl -LiteralPath $Root
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
$user = $identity.User
$rule = [Security.AccessControl.FileSystemAccessRule]::new($user, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($rule)
$acl.SetOwner($adminSid)
Set-Acl -LiteralPath $Root -AclObject $acl
[void][IO.Directory]::CreateDirectory((Join-Path $Root 'child'))
[IO.File]::WriteAllText((Join-Path $Root 'child/file.txt'), 'private')
foreach ($path in @((Join-Path $Root 'child'), (Join-Path $Root 'child/file.txt'))) {
  $childAcl = Get-Acl -LiteralPath $path
  $childAcl.SetOwner($adminSid)
  Set-Acl -LiteralPath $path -AclObject $childAcl
}
Write-Output '{"eligible":true}'
`,
			);
			try {
				const fixture = await runPowerShell(
					["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixtureScript, root],
					{ timeout: 15_000, windowsHide: true },
				);
				expect(fixture.stderr).toBe("");
				if (!JSON.parse(fixture.stdout.trim()).eligible) skip();
				const { stdout, stderr } = await runPowerShell(
					[
						"-NoLogo",
						"-NoProfile",
						"-NonInteractive",
						"-ExecutionPolicy",
						"Bypass",
						"-File",
						resolveWindowsPeerAclScriptPath(),
						"-Path",
						root,
						"-ProvisionLeaf",
					],
					{ timeout: 15_000, windowsHide: true },
				);
				expect(stderr).toBe("");
				const evidence = parseWindowsAclEvidence(stdout);
				if (evidence === undefined) throw new Error("ACL helper did not return valid evidence");
				expect(isPrivateWindowsAcl(evidence)).toBe(true);
				expect(evidence.ownerSid).toBe(evidence.currentSid);
				const verifyScript = join(temp, "verify-descendants.ps1");
				await writeFile(
					verifyScript,
					`param([string]$Root)
${trustedSecurityModuleBootstrap}
$result = @()
foreach ($path in @($Root, (Join-Path $Root 'child'), (Join-Path $Root 'child/file.txt'))) {
  $acl = Get-Acl -LiteralPath $path
  $owner = ([Security.Principal.NTAccount]::new($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
  $result += [pscustomobject]@{ owner=$owner; protected=$acl.AreAccessRulesProtected; rules=@($acl.Access | ForEach-Object { [pscustomobject]@{ sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; type=$_.AccessControlType.ToString(); full=(($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) } }) }
}
$result | ConvertTo-Json -Depth 6 -Compress`,
				);
				const { stdout: verifiedDescendants, stderr: verifyStderr } = await runPowerShell(
					["-NoLogo", "-NoProfile", "-NonInteractive", "-File", verifyScript, root],
					{ timeout: 15_000, windowsHide: true },
				);
				expect(verifyStderr).toBe("");
				for (const entry of JSON.parse(verifiedDescendants)) {
					expect(entry.owner).toBe(evidence.currentSid);
					expect(entry.protected).toBe(true);
					expect(entry.rules).toEqual([{ sid: evidence.currentSid, type: "Allow", full: true }]);
				}
				const tamperScript = join(temp, "set-foreign-owner.ps1");
				await writeFile(
					tamperScript,
					`param([string]$Root)
${trustedSecurityModuleBootstrap}
$path = Join-Path $Root 'child/file.txt'
$acl = Get-Acl -LiteralPath $path
$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-18'))
Set-Acl -LiteralPath $path -AclObject $acl`,
				);
				const { stderr: tamperStderr } = await runPowerShell(
					["-NoLogo", "-NoProfile", "-NonInteractive", "-File", tamperScript, root],
					{ timeout: 15_000, windowsHide: true },
				);
				expect(tamperStderr).toBe("");
				const foreignOwnerFailure = await runPowerShell(
					[
						"-NoLogo",
						"-NoProfile",
						"-NonInteractive",
						"-ExecutionPolicy",
						"Bypass",
						"-File",
						resolveWindowsPeerAclScriptPath(),
						"-Path",
						root,
						"-ProvisionLeaf",
					],
					{ timeout: 15_000, windowsHide: true },
				).then(
					() => undefined,
					(cause: NodeJS.ErrnoException & { stderr?: string }) => cause,
				);
				expect(foreignOwnerFailure).toBeDefined();
				expect(JSON.parse(foreignOwnerFailure?.stderr?.trim() ?? "{}").reason).toBe("wrong-descendant-owner");
			} finally {
				await rm(temp, { recursive: true, force: true });
			}
		},
	);
	it.skipIf(process.platform !== "win32")(
		"rejects inherited write access from ordinary principals before provisioning the leaf",
		async ({ skip }) => {
			const temp = await mkdtemp(join(tmpdir(), "peer-acl-inherited-write-"));
			const fixtureScript = join(temp, "create-inherited-write-root.ps1");
			const parent = join(temp, "parent");
			const root = join(parent, "storage");
			await writeFile(
				fixtureScript,
				`param([string]$Parent, [string]$Root)
${trustedSecurityModuleBootstrap}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$adminSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
[void][IO.Directory]::CreateDirectory($Parent)
$acl = Get-Acl -LiteralPath $Parent
$acl.SetAccessRuleProtection($true, $false)
foreach ($oldRule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($oldRule) }
$full = [Security.AccessControl.FileSystemRights]::FullControl
$inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$userRule = [Security.AccessControl.FileSystemAccessRule]::new($identity.User, $full, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
$everyoneRule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), [Security.AccessControl.FileSystemRights]::WriteData, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($userRule)
[void]$acl.AddAccessRule($everyoneRule)
$acl.SetOwner($identity.User)
Set-Acl -LiteralPath $Parent -AclObject $acl
[void][IO.Directory]::CreateDirectory($Root)
$rootAcl = Get-Acl -LiteralPath $Root
$rootOwner = ([Security.Principal.NTAccount]::new($rootAcl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
$allowed = $identity.User.Value -eq $rootOwner -or ($principal.IsInRole($adminSid) -and $identity.Owner.Value -eq $adminSid.Value -and $rootOwner -eq $identity.Owner.Value)
if (-not $allowed) { Write-Output ('eligible=false owner=' + $rootOwner); exit 0 }
Write-Output ('eligible=true owner=' + $rootOwner)
`,
			);
			try {
				const fixture = await runPowerShell(
					["-NoLogo", "-NoProfile", "-NonInteractive", "-File", fixtureScript, parent, root],
					{ env: { ...process.env, PSModulePath: trustedModulePath }, timeout: 15_000, windowsHide: true },
				);
				expect(fixture.stderr).toBe("");
				if (!fixture.stdout.trim().startsWith("eligible=true")) skip();
				const error = await runPowerShell(
					[
						"-NoLogo",
						"-NoProfile",
						"-NonInteractive",
						"-ExecutionPolicy",
						"Bypass",
						"-File",
						resolveWindowsPeerAclScriptPath(),
						"-Path",
						root,
						"-ProvisionLeaf",
					],
					{ env: { ...process.env, PSModulePath: trustedModulePath }, timeout: 15_000, windowsHide: true },
				).then(
					() => undefined,
					(cause: NodeJS.ErrnoException & { stderr?: string }) => cause,
				);
				expect(error).toBeDefined();
				expect(JSON.parse(error?.stderr?.trim() ?? "{}").reason).toBe("untrusted-inherited-write-ace");
			} finally {
				await rm(temp, { recursive: true, force: true });
			}
		},
	);
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
				const { stdout, stderr } = await runPowerShell(
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
				expect(stderr).toBe("");
				const evidence = parseWindowsAclEvidence(stdout);
				if (evidence === undefined) throw new Error("ACL helper did not return valid evidence");
				expect(isPrivateWindowsAcl(evidence)).toBe(true);
			} finally {
				await rm(temp, { recursive: true, force: true });
			}
		},
	);
});
