import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 32 * 1024;

export interface WindowsAclEvidence {
	ownerSid: string;
	currentSid: string;
	daclProtected: boolean;
	reparsePoint: boolean;
	unexpectedAccess: boolean;
	currentUserFullControl: boolean;
}

export function isPrivateWindowsAcl(evidence: WindowsAclEvidence): boolean {
	return (
		/^S-1-/.test(evidence.currentSid) &&
		evidence.ownerSid === evidence.currentSid &&
		evidence.daclProtected &&
		!evidence.reparsePoint &&
		!evidence.unexpectedAccess &&
		evidence.currentUserFullControl
	);
}

/** Resolves both source-tree and packaged-dist locations for the shipped ACL helper. */
export function resolveWindowsPeerAclScriptPath(moduleUrl = import.meta.url): string {
	const sourceScript = fileURLToPath(new URL("./windows-peer-acl.ps1", moduleUrl));
	const packagedScript = fileURLToPath(new URL("../../extension-src/pi-teams/pi/windows-peer-acl.ps1", moduleUrl));
	if (existsSync(sourceScript)) return sourceScript;
	if (existsSync(packagedScript)) return packagedScript;
	throw new Error("Windows peer ACL helper source is missing from this installation");
}

/** Creates missing path components without traversing reparse points, protects the designated leaf, and audits all descendants. */
export async function ensureWindowsPeerStorage(path: string, signal?: AbortSignal): Promise<boolean> {
	if (process.platform !== "win32") return false;
	try {
		const scriptPath = resolveWindowsPeerAclScriptPath();
		const { stdout } = await execFileAsync(
			"powershell.exe",
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				scriptPath,
				"-Path",
				path,
				"-ProvisionLeaf",
			],
			{ timeout: 15_000, maxBuffer: MAX_BUFFER, windowsHide: true, signal },
		);
		const evidence = parseWindowsAclEvidence(stdout);
		return evidence !== undefined && isPrivateWindowsAcl(evidence);
	} catch (error) {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
		return false;
	}
}

export function parseWindowsAclEvidence(output: string): WindowsAclEvidence | undefined {
	try {
		const value: unknown = JSON.parse(output.trim());
		if (typeof value !== "object" || value === null) return undefined;
		const v = value as Record<string, unknown>;
		if (
			typeof v.ownerSid !== "string" ||
			typeof v.currentSid !== "string" ||
			typeof v.daclProtected !== "boolean" ||
			typeof v.reparsePoint !== "boolean" ||
			typeof v.unexpectedAccess !== "boolean" ||
			typeof v.currentUserFullControl !== "boolean"
		)
			return undefined;
		return {
			ownerSid: v.ownerSid,
			currentSid: v.currentSid,
			daclProtected: v.daclProtected,
			reparsePoint: v.reparsePoint,
			unexpectedAccess: v.unexpectedAccess,
			currentUserFullControl: v.currentUserFullControl,
		};
	} catch {
		return undefined;
	}
}
