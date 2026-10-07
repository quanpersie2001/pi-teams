import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Resolve the nearest project Pi data directory, independently of a launcher. */
export function findNearestPiDir(cwd: string): string {
	let current = resolve(cwd);
	for (;;) {
		if (basename(current) === ".pi") return current;
		const candidate = join(current, ".pi");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return join(resolve(cwd), ".pi");
		current = parent;
	}
}
