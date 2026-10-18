import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	isPrivateWindowsAcl,
	parseWindowsAclEvidence,
	resolveWindowsPeerAclScriptPath,
} from "../../extension-src/pi-teams/pi/windows-peer-acl.js";

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
});
