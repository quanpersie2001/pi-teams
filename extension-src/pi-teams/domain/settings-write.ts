// Pure patch operations for a raw teams.json object.
//
// The writer edits the operator's file in place: every key it does not own must
// survive, including keys this version does not know. That rules out writing a
// sanitized settings object back to disk, which would silently drop unknown
// keys, comments-adjacent formatting and ordering.

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Copy the containers along `path` so the result can be mutated without touching `raw`. */
function cloneAlong(
	root: unknown,
	path: readonly string[],
): { node: Record<string, unknown>; parents: Array<[Record<string, unknown>, string]> } {
	const node: Record<string, unknown> = isRecord(root) ? { ...root } : {};
	const parents: Array<[Record<string, unknown>, string]> = [[node, ""]];
	let cursor = node;
	for (const segment of path.slice(0, -1)) {
		const child = cursor[segment];
		const next: Record<string, unknown> = isRecord(child) ? { ...child } : {};
		cursor[segment] = next;
		parents.push([cursor, segment]);
		cursor = next;
	}
	return { node, parents };
}

/** Set `value` at `path`, preserving every unrelated key. Returns a new object. */
export function patchSetting(raw: unknown, path: readonly string[], value: unknown): Record<string, unknown> {
	if (path.length === 0) return isRecord(raw) ? { ...raw } : {};
	const { node } = cloneAlong(raw, path);
	let cursor = node;
	for (const segment of path.slice(0, -1)) cursor = cursor[segment] as Record<string, unknown>;
	cursor[path.at(-1) as string] = value;
	return node;
}

/** Delete `path` (reset to the inherited/default value), keeping siblings. */
export function removeSetting(raw: unknown, path: readonly string[]): Record<string, unknown> {
	if (path.length === 0) return isRecord(raw) ? { ...raw } : {};
	const { node, parents } = cloneAlong(raw, path);
	let cursor = node;
	for (const segment of path.slice(0, -1)) cursor = cursor[segment] as Record<string, unknown>;
	delete cursor[path.at(-1) as string];
	// Drop containers this edit emptied; a non-empty parent keeps all of its keys.
	for (let index = parents.length - 1; index > 0; index--) {
		const [parent, segment] = parents[index] as [Record<string, unknown>, string];
		const child = parent[segment];
		if (isRecord(child) && Object.keys(child).length === 0) delete parent[segment];
	}
	return node;
}
