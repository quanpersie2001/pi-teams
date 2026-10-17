import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PeerDiscoveryService, resolvePeerAddress } from "../../extension-src/pi-teams/app/peer-discovery-service.js";
import { type PeerAdvertisement, validatePeerAdvertisement } from "../../extension-src/pi-teams/domain/peer.js";
import { resolvePeerProjectId } from "../../extension-src/pi-teams/pi/peer-project.js";
import { createPeerEndpointPath } from "../../extension-src/pi-teams/pi/peer-transport.js";

const ad = (id: string, displayName = "Same", updatedAt = 99_950): PeerAdvertisement => ({
	protocolVersion: 1,
	peerSessionId: id,
	runtimeId: `r-${id}`,
	displayName,
	projectId: "p",
	status: "idle",
	updatedAt,
	capabilities: [],
	identityPublicKey: "public-key",
	endpoint: { kind: "unix", path: "/tmp/peer.sock" },
});
describe("peer discovery contracts", () => {
	it("strictly parses both implemented endpoint kinds and rejects malformed pipe paths", () => {
		const unix = ad("unix");
		const pipe = {
			...unix,
			endpoint: { kind: "named_pipe" as const, path: createPeerEndpointPath("unused", "win32") },
		};
		expect(validatePeerAdvertisement(unix)).toBe(true);
		expect(validatePeerAdvertisement(pipe)).toBe(true);
		expect(validatePeerAdvertisement({ ...pipe, endpoint: { kind: "named_pipe", path: "\\\\.\\pipe\\other" } })).toBe(
			false,
		);
	});
	it("filters stale registry entries and rejects ambiguous display names", async () => {
		const service = new PeerDiscoveryService(
			{
				list: async () => [ad("a"), ad("b"), ad("stale", "stale", 1)],
				publish: async () => {},
				remove: async () => {},
			},
			() => 100_000,
		);
		const listed = await service.discover("p");
		expect(listed.map((p) => p.peerSessionId)).toEqual(["a", "b"]);
		expect(() => resolvePeerAddress(listed, "Same")).toThrow(/ambiguous/i);
		expect(resolvePeerAddress(listed, "a/r-a").peerSessionId).toBe("a");
	});
	it("uses the Git common directory to share identity across linked worktrees", async () => {
		const root = await mkdtemp(join(tmpdir(), "peer-worktree-"));
		try {
			const repo = join(root, "repo"),
				worktree = join(root, "other");
			await mkdir(repo);
			execFileSync("git", ["init", repo]);
			execFileSync("git", [
				"-C",
				repo,
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"--allow-empty",
				"-m",
				"init",
			]);
			execFileSync("git", ["-C", repo, "worktree", "add", "-b", "second", worktree]);
			expect(await resolvePeerProjectId(repo)).toBe(await resolvePeerProjectId(worktree));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 15_000);
	it("requires explicit root for non-Git projects", async () => {
		const root = await mkdtemp(join(tmpdir(), "peer-nongit-"));
		try {
			await expect(resolvePeerProjectId(root)).rejects.toThrow(/explicit project root/);
			expect(await resolvePeerProjectId(root, root)).toMatch(/^dir:/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
