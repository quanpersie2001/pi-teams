import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

/**
 * Validate one SKILL.md document the way the host loads it. Returns the list of
 * problems found; an empty list means the file is a usable shipped skill.
 */
function validateSkillFile(directoryName: string, content: string): string[] {
	const problems: string[] = [];
	let frontmatter: Record<string, unknown>;
	try {
		frontmatter = parseFrontmatter(content).frontmatter;
	} catch (error) {
		return [`frontmatter does not parse: ${error instanceof Error ? error.message : String(error)}`];
	}

	const name = frontmatter.name;
	if (typeof name !== "string" || name.trim() === "") {
		problems.push("missing a non-empty string `name`");
	} else if (name !== directoryName) {
		problems.push(`name "${name}" does not match directory "${directoryName}"`);
	}

	const description = frontmatter.description;
	if (typeof description !== "string" || description.trim() === "") {
		problems.push("missing a non-empty string `description`");
	}

	return problems;
}

/** Repository-root `skills/` directory, resolved from this test file, not the cwd. */
const skillsDir = fileURLToPath(new URL("../../skills", import.meta.url));

const skillDirectories = readdirSync(skillsDir, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();

describe("validateSkillFile guard", () => {
	it("accepts a well-formed document", () => {
		expect(validateSkillFile("demo", "---\nname: demo\ndescription: Does a thing.\n---\nBody.")).toEqual([]);
	});

	it("rejects a name that does not match the directory", () => {
		expect(validateSkillFile("demo", "---\nname: other\ndescription: Does a thing.\n---\n")).not.toEqual([]);
	});

	it("rejects a missing name or description", () => {
		expect(validateSkillFile("demo", "---\ndescription: Does a thing.\n---\n")).not.toEqual([]);
		expect(validateSkillFile("demo", "---\nname: demo\n---\n")).not.toEqual([]);
	});

	it("rejects blank name or description values", () => {
		expect(validateSkillFile("demo", '---\nname: demo\ndescription: "  "\n---\n')).not.toEqual([]);
		expect(validateSkillFile("demo", '---\nname: ""\ndescription: Does a thing.\n---\n')).not.toEqual([]);
	});

	it("rejects a document without frontmatter", () => {
		expect(validateSkillFile("demo", "# Just a heading\n")).not.toEqual([]);
	});

	it("rejects frontmatter that does not parse as YAML", () => {
		expect(validateSkillFile("demo", "---\nname: [unclosed\n---\nbody")).not.toEqual([]);
	});
});

describe("shipped skill files", () => {
	it("ships at least one skill directory", () => {
		expect(skillDirectories.length).toBeGreaterThan(0);
	});

	it.each(skillDirectories)("skills/%s/SKILL.md parses with matching name and description", (directoryName) => {
		const skillPath = join(skillsDir, directoryName, "SKILL.md");
		expect(existsSync(skillPath), `${skillPath} is missing`).toBe(true);
		const content = readFileSync(skillPath, "utf8");
		expect(validateSkillFile(directoryName, content)).toEqual([]);
	});
});
