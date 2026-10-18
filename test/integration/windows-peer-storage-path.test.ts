import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { LocalPeerHost } from "../../extension-src/pi-teams/pi/peer-host.js";
import * as windowsPeerAcl from "../../extension-src/pi-teams/pi/windows-peer-acl.js";

const execFileAsync = promisify(execFile);

describe("Windows peer storage canonical paths", () => {
	it.skipIf(process.platform !== "win32")(
		"accepts a case-alias only after ACL/reparse verification and maps child paths under the canonical root",
		async () => {
			const createdRoot = await mkdtemp(join(tmpdir(), "peer-root-canonical-"));
			try {
				const canonicalRoot = await realpath(createdRoot);
				const requestedRoot = canonicalRoot.replace(/[a-z]/i, (letter) =>
					letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
				);
				expect(requestedRoot).not.toBe(canonicalRoot);
				expect(requestedRoot.toLowerCase()).toBe(canonicalRoot.toLowerCase());
				const host = new LocalPeerHost(requestedRoot);
				await expect(host.list("canonical-path-test")).resolves.toEqual([]);
				expect((await stat(join(canonicalRoot, "registry"))).isDirectory()).toBe(true);
				await expect(host.list("canonical-path-test")).resolves.toEqual([]);
			} finally {
				await rm(createdRoot, { recursive: true, force: true });
			}
		},
	);
	it.skipIf(process.platform !== "win32")(
		"accepts an 8.3 temporary-path alias when it identifies the verified root",
		async ({ skip }) => {
			const createdRoot = await mkdtemp(join(tmpdir(), "peer-root-short-alias-"));
			try {
				const { stdout } = await execFileAsync("cmd.exe", ["/d", "/c", `for %I in ("${createdRoot}") do @echo %~sI`], {
					windowsHide: true,
					timeout: 5_000,
				});
				const shortRoot = stdout.trim();
				if (!shortRoot || shortRoot.toLowerCase() === createdRoot.toLowerCase()) skip();
				const [shortRealPath, longRealPath] = await Promise.all([realpath(shortRoot), realpath(createdRoot)]);
				const [shortStat, longStat] = await Promise.all([stat(shortRealPath), stat(longRealPath)]);
				expect(shortStat.dev).toBe(longStat.dev);
				expect(shortStat.ino).not.toBe(0);
				expect(shortStat.ino).toBe(longStat.ino);
				const host = new LocalPeerHost(shortRoot);
				await expect(host.list("short-alias-test")).resolves.toEqual([]);
			} finally {
				await rm(createdRoot, { recursive: true, force: true });
			}
		},
	);
	it.skipIf(process.platform !== "win32")(
		"coalesces ACL checks, revalidates replaced identities, and rejects cached junction paths",
		async () => {
			const temp = await mkdtemp(join(tmpdir(), "peer-root-acl-cache-"));
			const root = join(temp, "root");
			const registry = join(root, "registry");
			const outside = join(temp, "outside");
			await mkdir(root);
			await Promise.all([mkdir(registry), mkdir(outside)]);
			const aclSpy = vi.spyOn(windowsPeerAcl, "ensureWindowsPeerStorage").mockResolvedValue(true);
			try {
				const host = new LocalPeerHost(root);
				await expect(host.list("cache-test")).resolves.toEqual([]);
				const afterInitialAudit = aclSpy.mock.calls.length;
				expect(afterInitialAudit).toBe(2);
				await expect(host.list("cache-test")).resolves.toEqual([]);
				expect(aclSpy).toHaveBeenCalledTimes(afterInitialAudit);

				const retired = join(root, "registry-retired");
				await rename(registry, retired);
				await mkdir(registry);
				await expect(host.list("cache-test")).resolves.toEqual([]);
				expect(aclSpy).toHaveBeenCalledTimes(afterInitialAudit + 1);

				await rm(registry, { recursive: true, force: true });
				await symlink(outside, registry, "junction");
				await expect(host.list("cache-test")).rejects.toThrow(/reparse point/i);
			} finally {
				aclSpy.mockRestore();
				await rm(temp, { recursive: true, force: true });
			}
		},
	);
});
