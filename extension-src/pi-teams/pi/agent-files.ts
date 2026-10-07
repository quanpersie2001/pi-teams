// Host adapter: filesystem loading of agent Markdown files.
//
// This is the ONLY module in the registry path that touches the filesystem —
// app/agent-registry.ts receives it injected as a loader function, keeping the
// app layer free of concrete I/O (ARCH-004/005).
//
// Source precedence (ascending; later entries override earlier ones on name
// clash), per docs/CONFIGURATION.md §3:
//
//   bundled defaults (in-code, see app/default-agents.ts)
//     < ~/.pi/agent/agents/*.md          (global)
//     < <cwd>/.agents/agents/*.md        (shared workspace)
//     < <cwd>/.pi/agents/*.md            (project authority)

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentFileInput } from "../domain/agent-definition.js";

/** A raw agent .md file reduced to data, or a record of why it could not be. */
export interface RawAgentFile extends AgentFileInput {
	/** Read/frontmatter-parse failure. Absent when the file parsed cleanly. */
	error?: string;
}

/**
 * Collect and parse every *.md file in the given directories.
 * Files are returned grouped per directory in input order (callers pass
 * directories in ascending precedence). A missing/unreadable directory yields
 * no files silently; a file that exists but cannot be read, or whose
 * frontmatter fails to parse, yields a RawAgentFile with `error` set so the
 * caller can apply strictAgentFiles policy (fail vs warn+skip).
 */
export async function loadAgentMarkdownFiles(dirs: string[]): Promise<RawAgentFile[]> {
	const files: RawAgentFile[] = [];
	for (const dir of dirs) {
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			continue;
		}
		for (const name of names.filter((candidate) => candidate.endsWith(".md")).sort()) {
			const sourcePath = join(dir, name);
			const filenameStem = basename(name, ".md");
			try {
				const text = await readFile(sourcePath, "utf8");
				const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(text);
				files.push({
					sourcePath,
					frontmatter: typeof frontmatter === "object" && frontmatter !== null ? frontmatter : {},
					body,
					filenameStem,
				});
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				files.push({ sourcePath, frontmatter: {}, body: "", filenameStem, error: reason });
			}
		}
	}
	return files;
}

/** Ordered agent source directories for a host, ascending in precedence. */
export function resolveAgentSourceDirs(cwd: string, agentDir: string): string[] {
	return [join(agentDir, "agents"), join(cwd, ".agents", "agents"), join(cwd, ".pi", "agents")];
}
