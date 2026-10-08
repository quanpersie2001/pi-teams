import { isAbsolute } from "node:path";
import type { LauncherCommandRunner } from "../domain/process-launcher.js";
import type { PaneGeometry, PaneLayoutParent, TerminalPaneLayoutAdapter } from "./terminal-pane-layout.js";

const HERDR_ENV_VAR = "HERDR_ENV";
const HERDR_PANE_ID_VAR = "HERDR_PANE_ID";
const HERDR_SOCKET_PATH_VAR = "HERDR_SOCKET_PATH";

interface HerdrIdentity {
	socketPath: string;
	terminalId: string;
}

interface HerdrRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface HerdrSplit {
	ratio: number;
	area: HerdrRect;
}

function parseJson(stdout: string, operation: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(stdout);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const envelope = value as Record<string, unknown>;
			return object(envelope.result) ?? envelope;
		}
	} catch {
		// The operation-specific error below is more useful than JSON.parse's detail.
	}
	throw new Error(`HerdR ${operation} returned invalid JSON`);
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function rect(value: unknown): HerdrRect | undefined {
	const item = object(value);
	if (!item) return undefined;
	const { x, y, width, height } = item;
	if (
		typeof x !== "number" ||
		typeof y !== "number" ||
		typeof width !== "number" ||
		typeof height !== "number" ||
		![x, y, width, height].every(Number.isFinite) ||
		width <= 0 ||
		height <= 0
	) {
		return undefined;
	}
	return { x, y, width, height };
}

function identityFromParent(parent: PaneLayoutParent): HerdrIdentity {
	let identity: unknown;
	try {
		identity = JSON.parse(parent.identity);
	} catch {
		throw new Error("Invalid saved HerdR parent identity");
	}
	const value = object(identity);
	if (
		!value ||
		typeof value.socketPath !== "string" ||
		typeof value.terminalId !== "string" ||
		!isAbsolute(value.socketPath) ||
		value.socketPath !== parent.socketPath ||
		!value.terminalId
	) {
		throw new Error("Invalid saved HerdR parent identity");
	}
	return { socketPath: value.socketPath, terminalId: value.terminalId };
}

export function createHerdrPaneLayoutAdapter(
	runner: LauncherCommandRunner,
	env: Record<string, string | undefined>,
): TerminalPaneLayoutAdapter {
	const run = (args: readonly string[], socketPath: string) =>
		runner.run("herdr", args, {
			env: {
				...process.env,
				...env,
				[HERDR_SOCKET_PATH_VAR]: socketPath,
			},
		});

	const readPane = async (paneId: string, socketPath: string): Promise<Record<string, unknown>> => {
		const result = parseJson((await run(["pane", "get", paneId], socketPath)).stdout, "pane get");
		const pane = object(result.pane) ?? result;
		if (pane.pane_id !== paneId || typeof pane.terminal_id !== "string" || !pane.terminal_id) {
			throw new Error("HerdR pane get omitted pane identity");
		}
		return pane;
	};

	const verifyParent = async (parent: PaneLayoutParent): Promise<HerdrIdentity> => {
		const identity = identityFromParent(parent);
		const pane = await readPane(parent.paneId, parent.socketPath);
		if (pane.terminal_id !== identity.terminalId) {
			throw new Error("HerdR parent terminal identity changed");
		}
		return identity;
	};

	return {
		async parent() {
			if (env[HERDR_ENV_VAR] !== "1") throw new Error("Not running inside a HerdR pane");
			const paneId = env[HERDR_PANE_ID_VAR];
			const socketPath = env[HERDR_SOCKET_PATH_VAR];
			if (!paneId || !socketPath || !isAbsolute(socketPath)) {
				throw new Error("HerdR parent pane and absolute socket identity are required");
			}
			const pane = await readPane(paneId, socketPath);
			return {
				paneId,
				identity: JSON.stringify({ socketPath, terminalId: pane.terminal_id }),
				socketPath,
			};
		},

		async inspect(parent) {
			await verifyParent(parent);
			const result = parseJson(
				(await run(["pane", "layout", "--pane", parent.paneId], parent.socketPath)).stdout,
				"pane layout",
			);
			const layout = object(result.layout) ?? result;
			const area = rect(layout.area);
			if (!area || !Array.isArray(layout.panes)) throw new Error("HerdR pane layout omitted area or panes");
			const panes: PaneGeometry[] = [];
			for (const entry of layout.panes) {
				const item = object(entry);
				const paneRect = rect(item?.rect);
				if (!item || typeof item.pane_id !== "string" || !paneRect) {
					throw new Error("HerdR pane layout contains invalid pane geometry");
				}
				panes.push({ paneId: item.pane_id, ...paneRect });
			}
			if (!panes.some((pane) => pane.paneId === parent.paneId)) {
				throw new Error("HerdR parent is not in its saved tab layout");
			}
			return panes;
		},

		async moveBelow(parent, paneId, targetPaneId) {
			await verifyParent(parent);
			const result = parseJson(
				(await run(["pane", "layout", "--pane", parent.paneId], parent.socketPath)).stdout,
				"pane layout",
			);
			const layout = object(result.layout);
			if (
				!layout ||
				typeof layout.tab_id !== "string" ||
				!Array.isArray(layout.panes) ||
				!layout.panes.some((entry) => object(entry)?.pane_id === paneId) ||
				!layout.panes.some((entry) => object(entry)?.pane_id === targetPaneId)
			)
				throw new Error("HerdR column move left the saved parent tab");
			const focused = layout.focused_pane_id === paneId;
			const source = await readPane(paneId, parent.socketPath);
			// HerdR deliberately ignores same-tab moves. Roundtrip through an unfocused
			// temporary tab; returning its only pane automatically removes that tab.
			await run(["pane", "move", paneId, "--new-tab", "--no-focus"], parent.socketPath);
			await verifyParent(parent);
			await run(
				[
					"pane",
					"move",
					paneId,
					"--tab",
					layout.tab_id,
					"--target-pane",
					targetPaneId,
					"--split",
					"down",
					"--ratio",
					"0.5",
					"--no-focus",
				],
				parent.socketPath,
			);
			const returned = await readPane(paneId, parent.socketPath);
			if (returned.terminal_id !== source.terminal_id || returned.tab_id !== layout.tab_id)
				throw new Error("HerdR column move changed pane identity");
			if (focused) {
				const neighbor = object(
					parseJson(
						(await run(["pane", "neighbor", "--pane", targetPaneId, "--direction", "down"], parent.socketPath)).stdout,
						"pane neighbor",
					).neighbor,
				);
				if (neighbor?.pane_id !== targetPaneId || neighbor.neighbor_pane_id !== paneId)
					throw new Error("HerdR moved pane is not its verified target neighbor");
				await run(["pane", "focus", "--pane", targetPaneId, "--direction", "down"], parent.socketPath);
			}
		},

		async resize(parent, paneId, height) {
			if (!Number.isSafeInteger(height) || height <= 0)
				throw new Error("HerdR pane height must be a positive cell count");
			await verifyParent(parent);
			const result = parseJson(
				(await run(["pane", "layout", "--pane", parent.paneId], parent.socketPath)).stdout,
				"pane layout",
			);
			const layout = object(result.layout) ?? result;
			const area = rect(layout.area);
			if (!area || !Array.isArray(layout.panes) || !Array.isArray(layout.splits)) {
				throw new Error("HerdR pane layout omitted geometry or split boundaries");
			}
			const panes: PaneGeometry[] = [];
			for (const entry of layout.panes) {
				const item = object(entry);
				const paneRect = rect(item?.rect);
				if (!item || typeof item.pane_id !== "string" || !paneRect) {
					throw new Error("HerdR pane layout contains invalid pane geometry");
				}
				panes.push({ paneId: item.pane_id, ...paneRect });
			}
			const target = panes.find((pane) => pane.paneId === paneId);
			if (!target) throw new Error("HerdR resize target is not in the saved parent tab");
			const difference = height - target.height;
			if (difference === 0) return;
			const below = panes.find(
				(pane) => pane.x === target.x && pane.width === target.width && pane.y === target.y + target.height,
			);
			let sourcePane = target;
			let direction: "up" | "down" = "down";
			if (difference < 0) {
				if (!below) throw new Error("HerdR lower resize boundary has no verified adjacent row");
				sourcePane = below;
				direction = "up";
			}
			const edge = direction === "up" ? sourcePane.y : sourcePane.y + sourcePane.height;
			// Mirror HerdR's nearest-edge split choice; the CLI receives only pane, direction, and delta.
			let chosen: HerdrSplit | undefined;
			let chosenDistance = Number.POSITIVE_INFINITY;
			for (const candidate of layout.splits) {
				const item = object(candidate);
				const splitArea = rect(item?.rect);
				if (
					!item ||
					!splitArea ||
					item.direction !== "down" ||
					typeof item.ratio !== "number" ||
					!Number.isFinite(item.ratio) ||
					splitArea.x >= sourcePane.x + sourcePane.width ||
					sourcePane.x >= splitArea.x + splitArea.width
				)
					continue;
				const position = splitArea.y + Math.round(splitArea.height * item.ratio);
				const distance = Math.abs(position - edge);
				if (distance <= 1 && distance < chosenDistance) {
					chosen = { ratio: item.ratio, area: splitArea };
					chosenDistance = distance;
				}
			}
			if (!chosen) throw new Error("HerdR resize target has no adjacent vertical split boundary");
			const nextRatio = (target.y + height - chosen.area.y) / chosen.area.height;
			const amount = Math.abs(nextRatio - chosen.ratio);
			if (!Number.isFinite(amount) || amount <= 0 || nextRatio < 0.1 || nextRatio > 0.9)
				throw new Error("Requested HerdR pane height exceeds the adjacent split's adjustable range");
			await run(
				["pane", "resize", "--pane", sourcePane.paneId, "--direction", direction, "--amount", String(amount)],
				parent.socketPath,
			);
		},
		async resizeWidth(parent, paneId, width) {
			if (!Number.isSafeInteger(width) || width <= 0) throw new Error("HerdR pane width must be a positive cell count");
			await verifyParent(parent);
			const result = parseJson(
				(await run(["pane", "layout", "--pane", parent.paneId], parent.socketPath)).stdout,
				"pane layout",
			);
			const layout = object(result.layout) ?? result;
			const area = rect(layout.area);
			if (!area || !Array.isArray(layout.panes) || !Array.isArray(layout.splits))
				throw new Error("HerdR pane layout omitted geometry or split boundaries");
			const panes: PaneGeometry[] = [];
			for (const entry of layout.panes) {
				const item = object(entry);
				const paneRect = rect(item?.rect);
				if (!item || typeof item.pane_id !== "string" || !paneRect)
					throw new Error("HerdR pane layout contains invalid pane geometry");
				panes.push({ paneId: item.pane_id, ...paneRect });
			}
			const target = panes.find((pane) => pane.paneId === paneId);
			if (!target) throw new Error("HerdR resize target is not in the saved parent tab");
			const difference = width - target.width;
			if (difference === 0) return;
			const boundaries: HerdrSplit[] = [];
			for (const candidate of layout.splits) {
				const item = object(candidate);
				const splitArea = rect(item?.rect);
				if (
					!item ||
					!splitArea ||
					item.direction !== "right" ||
					typeof item.ratio !== "number" ||
					!Number.isFinite(item.ratio) ||
					splitArea.x > target.x ||
					splitArea.x + splitArea.width < target.x + target.width ||
					splitArea.y > target.y ||
					splitArea.y + splitArea.height < target.y + target.height
				)
					continue;
				const position = splitArea.x + Math.round(splitArea.width * item.ratio);
				if (target.x + target.width === position) boundaries.push({ ratio: item.ratio, area: splitArea });
			}
			boundaries.sort((left, right) => left.area.width - right.area.width);
			const chosen = boundaries[0];
			if (!chosen) throw new Error("HerdR resize target has no right horizontal split boundary");
			const nextRatio = (target.x + width - chosen.area.x) / chosen.area.width;
			const amount = Math.abs(nextRatio - chosen.ratio);
			if (!Number.isFinite(amount) || amount <= 0 || nextRatio < 0.1 || nextRatio > 0.9)
				throw new Error("Requested HerdR pane width exceeds the adjacent split's adjustable range");
			const right = panes.find(
				(pane) =>
					pane.x === target.x + target.width && pane.y < target.y + target.height && target.y < pane.y + pane.height,
			);
			if (!right) throw new Error("HerdR right resize boundary has no verified adjacent pane");
			await run(
				[
					"pane",
					"resize",
					"--pane",
					difference < 0 ? right.paneId : paneId,
					"--direction",
					difference < 0 ? "left" : "right",
					"--amount",
					String(amount),
				],
				parent.socketPath,
			);
		},
	};
}
