import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
/** Stable visibility key: canonical Git common directory, or caller-designated non-Git root. */
export async function resolvePeerProjectId(cwd: string, explicitNonGitRoot?: string): Promise<string> {
	const canonicalCwd = await realpath(resolve(cwd));
	try {
		const { stdout } = await execFileAsync("git", ["-C", canonicalCwd, "rev-parse", "--git-common-dir"], {
			timeout: 2_000,
		});
		const common = stdout.trim();
		if (!common) throw new Error("Git returned an empty common directory");
		return `git:${await realpath(resolve(canonicalCwd, common))}`;
	} catch {
		if (!explicitNonGitRoot) throw new Error("Non-Git peer discovery requires an explicit project root");
		const root = await realpath(resolve(explicitNonGitRoot));
		return `dir:${root}`;
	}
}
