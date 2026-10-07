import type { ChildLaunchSpec, LauncherHandle, ProcessLauncher } from "../domain/process-launcher.js";
import { ProcessLaunchCleanupPendingError } from "../domain/process-launcher.js";

export interface PaneGeometry {
	paneId: string;
	x: number;
	y: number;
	width: number;
	height: number;
}
export interface PaneLayoutParent {
	paneId: string;
	identity: string;
	socketPath: string;
}
export interface TerminalPaneLayoutAdapter {
	parent(): Promise<PaneLayoutParent>;
	inspect(parent: PaneLayoutParent): Promise<readonly PaneGeometry[]>;
	resize(parent: PaneLayoutParent, paneId: string, height: number): Promise<void>;
	moveBelow(parent: PaneLayoutParent, paneId: string, targetPaneId: string): Promise<void>;
}
export interface PaneSplitPlan {
	parent: PaneLayoutParent;
	targetPaneId: string;
	direction: "right" | "down";
}
interface PaneGroup {
	parent: PaneLayoutParent;
	children: Map<string, LauncherHandle>;
}
type PaneLifecycle = Omit<ProcessLauncher, "launch">;
type GroupAttachment = (
	handle: LauncherHandle,
	parent: PaneLayoutParent,
	peers: readonly LauncherHandle[],
) => Promise<void>;

const MAX_CHILDREN_PER_COLUMN = 3;

function groupKey(parent: PaneLayoutParent): string {
	return JSON.stringify([parent.socketPath, parent.paneId, parent.identity]);
}
function parentOf(handle: LauncherHandle): PaneLayoutParent | undefined {
	const paneId = handle.identity?.layoutParentPaneId;
	const identity = handle.identity?.layoutParentIdentity;
	return paneId && identity && handle.socketPath ? { paneId, identity, socketPath: handle.socketPath } : undefined;
}

/** One lock covers split, rollback, resize and removal; focus is never used as allocation authority. */
export function withTerminalPaneLayout(
	lifecycle: PaneLifecycle,
	adapter: TerminalPaneLayoutAdapter,
	launch: (spec: ChildLaunchSpec, plan: PaneSplitPlan) => Promise<LauncherHandle>,
	attachGroup?: GroupAttachment,
	ownsPane: (handle: LauncherHandle) => Promise<boolean | undefined> = lifecycle.alive.bind(lifecycle),
): ProcessLauncher {
	const groups = new Map<string, PaneGroup>();
	let queue: Promise<unknown> = Promise.resolve();
	let callingParent: PaneLayoutParent | undefined;
	function serial<T>(operation: () => Promise<T>): Promise<T> {
		const result = queue.then(operation, operation);
		queue = result;
		return result;
	}
	function remember(handle: LauncherHandle): PaneGroup | undefined {
		const parent = parentOf(handle);
		if (!parent || !handle.paneId) return undefined;
		const key = groupKey(parent);
		let group = groups.get(key);
		if (!group) {
			group = { parent, children: new Map() };
			groups.set(key, group);
		}
		group.children.set(handle.childId, handle);
		return group;
	}
	async function layout(group: PaneGroup): Promise<{ main: PaneGeometry; columns: PaneGeometry[][] }> {
		const panes = await adapter.inspect(group.parent);
		const main = panes.find((pane) => pane.paneId === group.parent.paneId);
		if (!main) throw new Error("Managed layout parent is missing");
		const byX = new Map<number, PaneGeometry[]>();
		for (const handle of group.children.values()) {
			const pane = panes.find((candidate) => candidate.paneId === handle.paneId);
			const owned = await ownsPane(handle);
			if (!pane && owned === false) {
				group.children.delete(handle.childId);
				continue;
			}
			if (!pane || owned !== true) throw new Error("Cannot resize an unverified child pane");
			const rows = byX.get(pane.x) ?? [];
			rows.push(pane);
			byX.set(pane.x, rows);
		}
		const columns = [...byX.values()].sort((a, b) => (a[0]?.x ?? 0) - (b[0]?.x ?? 0));
		let right = main.x + main.width;
		for (const rows of columns) {
			rows.sort((a, b) => a.y - b.y);
			const first = rows[0];
			const last = rows.at(-1);
			if (
				!first ||
				!last ||
				rows.length > MAX_CHILDREN_PER_COLUMN ||
				first.x < right ||
				first.y !== main.y ||
				last.y + last.height !== main.y + main.height ||
				rows.some(
					(row, index) =>
						row.width !== first.width ||
						row.height < 1 ||
						(index > 0 && row.y < (rows[index - 1]?.y ?? 0) + (rows[index - 1]?.height ?? 0)),
				)
			)
				throw new Error("Managed pane layout changed; refusing to rearrange user panes");
			right = first.x + first.width;
		}
		const members = new Set([main.paneId, ...columns.flat().map((row) => row.paneId)]);
		if (
			panes.some(
				(pane) =>
					!members.has(pane.paneId) &&
					pane.x < right &&
					main.x < pane.x + pane.width &&
					pane.y < main.y + main.height &&
					main.y < pane.y + pane.height,
			)
		)
			throw new Error("Foreign pane entered the managed layout; refusing to resize it");
		return { main, columns };
	}
	async function balance(group: PaneGroup): Promise<void> {
		const { main, columns } = await layout(group);
		for (const rows of columns) {
			if (rows.length < 2) continue;
			const used = rows.reduce((sum, row) => sum + row.height, 0);
			const height = Math.floor(used / rows.length);
			const remainder = used % rows.length;
			if (height < 1) throw new Error("Not enough terminal height for the child column");
			for (let index = 0; index < rows.length - 1; index++) {
				const row = rows[index];
				if (!row) continue;
				const desired = height + (index >= rows.length - remainder ? 1 : 0);
				const current = await layout(group);
				if (
					current.main.x !== main.x ||
					current.main.y !== main.y ||
					current.main.width !== main.width ||
					current.main.height !== main.height
				)
					throw new Error("Parent geometry changed during child resize");
				if (current.columns.flat().find((pane) => pane.paneId === row.paneId)?.height !== desired)
					await adapter.resize(group.parent, row.paneId, desired);
			}
			const after = await layout(group);
			if (
				after.main.x !== main.x ||
				after.main.y !== main.y ||
				after.main.width !== main.width ||
				after.main.height !== main.height ||
				rows.some((row) => {
					const actual = after.columns.flat().find((pane) => pane.paneId === row.paneId);
					return !actual || actual.height < height || actual.height > height + 1;
				})
			)
				throw new Error("Terminal could not balance the managed child column");
		}
	}
	async function removed(handle: LauncherHandle): Promise<void> {
		const parent = parentOf(handle);
		if (!parent) return;
		const key = groupKey(parent);
		const group = groups.get(key);
		if (!group) return;
		group.children.delete(handle.childId);
		if (group.children.size === 0) groups.delete(key);
		else await balance(group);
	}
	return {
		...lifecycle,
		restore(handle) {
			remember(handle);
		},
		launch(spec) {
			return serial(async () => {
				if (!(await lifecycle.available())) throw new Error(`${lifecycle.kind} launcher is unavailable`);
				callingParent ??= await adapter.parent();
				const key = groupKey(callingParent);
				let group = groups.get(key);
				if (!group) {
					group = { parent: callingParent, children: new Map() };
					groups.set(key, group);
				}
				const { columns } = await layout(group);
				const vacancy = columns.find((rows) => rows.length < MAX_CHILDREN_PER_COLUMN);
				const lastColumn = columns.at(-1);
				const openingColumn = !vacancy && lastColumn !== undefined;
				const handle = await launch(spec, {
					parent: group.parent,
					targetPaneId: vacancy?.at(-1)?.paneId ?? lastColumn?.[0]?.paneId ?? group.parent.paneId,
					direction: vacancy ? "down" : "right",
				});
				handle.identity = {
					...handle.identity,
					layoutParentPaneId: group.parent.paneId,
					layoutParentIdentity: group.parent.identity,
				};
				remember(handle);
				try {
					if (openingColumn && lastColumn) {
						// Split the top row right, then reparent its old siblings underneath it.
						// Removing those old leaves expands both horizontal branches to full height.
						for (let index = 1; index < lastColumn.length; index++) {
							const source = lastColumn[index];
							const target = lastColumn[index - 1];
							if (!source || !target) throw new Error("Managed column lost its split source");
							for (const member of group.children.values()) {
								if ((await ownsPane(member)) !== true) throw new Error("Cannot move an unverified child pane");
							}
							await adapter.moveBelow(group.parent, source.paneId, target.paneId);
						}
					}
					await balance(group);
					return handle;
				} catch (error) {
					try {
						await lifecycle.terminate(handle);
						await removed(handle);
					} catch (cleanupError) {
						throw new ProcessLaunchCleanupPendingError(
							"Pane layout failed and owned split cleanup remains unconfirmed",
							{ cause: cleanupError },
						);
					}
					throw error;
				}
			});
		},
		async alive(handle) {
			const result = await lifecycle.alive(handle);
			if (result === true) remember(handle);
			return result;
		},
		cleanupExited(handle) {
			return serial(async () => {
				const closed = await lifecycle.cleanupExited(handle);
				if (closed) await removed(handle);
				return closed;
			});
		},
		terminate(handle) {
			return serial(async () => {
				await lifecycle.terminate(handle);
				await removed(handle);
			});
		},
		...(lifecycle.attach
			? {
					attach: (handle: LauncherHandle) =>
						serial(async () => {
							const group = remember(handle);
							if (group && attachGroup) {
								await layout(group);
								await attachGroup(handle, group.parent, [...group.children.values()]);
							} else await lifecycle.attach?.(handle);
						}),
				}
			: {}),
	};
}
