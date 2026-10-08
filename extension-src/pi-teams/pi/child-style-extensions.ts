import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse } from "node:path";
import { DefaultPackageManager, type SettingsManager } from "@earendil-works/pi-coding-agent";

const STYLE_PACKAGE_NAME = "@quandev104/pi-style";

export interface ResolveChildStyleExtensionsOptions {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	/** Loaded Main extension files; when supplied, even an empty list is authoritative. */
	parentExtensionPaths?: readonly string[];
}

/**
 * Resolve only enabled extension resources belonging to pi-style. Package resolution is
 * deliberately read-only: missing npm/git sources are skipped rather than installed.
 */
export async function resolveChildStyleExtensions({
	cwd,
	agentDir,
	settingsManager,
	parentExtensionPaths,
}: ResolveChildStyleExtensionsOptions): Promise<string[]> {
	if (parentExtensionPaths?.length === 0) return [];
	const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolved =
		parentExtensionPaths === undefined
			? await manager.resolve(async () => "skip")
			: await manager.resolveExtensionSources(parentExtensionPaths.filter(isAbsolute), { temporary: true });
	const paths: string[] = [];
	const seen = new Set<string>();

	for (const resource of resolved.extensions) {
		if (!resource.enabled || seen.has(resource.path)) continue;
		const packageName = resource.metadata.packageRoot
			? await readPackageName(resource.metadata.packageRoot)
			: await findPackageName(resource.path);
		if (packageName !== STYLE_PACKAGE_NAME) continue;
		seen.add(resource.path);
		paths.push(resource.path);
	}

	return paths;
}

async function findPackageName(resourcePath: string): Promise<string | undefined> {
	let current = dirname(resourcePath);
	const filesystemRoot = parse(current).root;
	while (current !== filesystemRoot) {
		const name = await readPackageName(current);
		if (name !== undefined) return name;
		current = dirname(current);
	}
	return undefined;
}

async function readPackageName(packageRoot: string): Promise<string | undefined> {
	try {
		const manifest: unknown = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
		if (typeof manifest === "object" && manifest !== null && "name" in manifest && typeof manifest.name === "string") {
			return manifest.name;
		}
	} catch {
		// A plain extension file or malformed/unreadable package manifest has no package identity.
	}
	return undefined;
}
