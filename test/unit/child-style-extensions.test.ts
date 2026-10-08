import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { resolveChildStyleExtensions } from "../../extension-src/pi-teams/pi/child-style-extensions.js";

let root: string | undefined;

afterEach(async () => {
	if (root) {
		await rm(root, { recursive: true, force: true });
		root = undefined;
	}
});

async function makePackage(packageRoot: string, name: string, extension: string): Promise<string> {
	const extensionPath = join(packageRoot, extension);
	await mkdir(extensionPath, { recursive: true });
	await writeFile(
		join(packageRoot, "package.json"),
		JSON.stringify({ name, pi: { extensions: [`./${extension}/index.ts`] } }),
	);
	await writeFile(join(extensionPath, "index.ts"), "export default function() {}\n");
	return join(extensionPath, "index.ts");
}

async function makeSettings(agentDir: string, cwd: string, values: Record<string, unknown> = {}) {
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify(values));
	return SettingsManager.create(cwd, agentDir);
}

describe("resolveChildStyleExtensions", () => {
	it("returns enabled local pi-style resources and excludes unrelated and disabled resources", async () => {
		root = await mkdtemp(join(tmpdir(), "pi-teams-child-style-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const stylePath = await makePackage(join(root, "style"), "@quandev104/pi-style", "extension-src/pi-style");
		await makePackage(join(root, "other"), "@someone/other-extension", "extension-src/other");
		const settingsManager = await makeSettings(agentDir, cwd, {
			packages: [{ source: join(root, "style"), extensions: [] }, join(root, "other")],
		});

		expect(await resolveChildStyleExtensions({ cwd, agentDir, settingsManager })).toEqual([]);

		const enabledSettingsManager = await makeSettings(agentDir, cwd, {
			packages: [join(root, "style"), join(root, "other")],
		});
		expect(await resolveChildStyleExtensions({ cwd, agentDir, settingsManager: enabledSettingsManager })).toEqual([
			stylePath,
		]);
	});

	it("uses loaded Main paths for temporary extensions and respects an explicitly unstyled Main", async () => {
		root = await mkdtemp(join(tmpdir(), "pi-teams-child-style-main-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const stylePath = await makePackage(join(root, "style"), "@quandev104/pi-style", "extension-src/pi-style");
		const otherPath = await makePackage(join(root, "other"), "@someone/other-extension", "extension-src/other");
		const settingsManager = await makeSettings(agentDir, cwd, {
			packages: [join(root, "style")],
			extensions: [`-${stylePath}`],
		});
		expect(
			await resolveChildStyleExtensions({
				cwd,
				agentDir,
				settingsManager,
				parentExtensionPaths: [stylePath, otherPath, stylePath],
			}),
		).toEqual([stylePath]);
		expect(
			await resolveChildStyleExtensions({
				cwd,
				agentDir,
				settingsManager,
				parentExtensionPaths: [],
			}),
		).toEqual([]);
	});

	it("does not install a missing configured npm package", async () => {
		root = await mkdtemp(join(tmpdir(), "pi-teams-child-style-missing-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const settingsManager = await makeSettings(agentDir, cwd, { packages: ["npm:@quandev104/pi-style@0.5.2"] });

		expect(await resolveChildStyleExtensions({ cwd, agentDir, settingsManager })).toEqual([]);
		await expect(
			readFile(join(agentDir, "npm", "node_modules", "@quandev104", "pi-style", "package.json"), "utf8"),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});
