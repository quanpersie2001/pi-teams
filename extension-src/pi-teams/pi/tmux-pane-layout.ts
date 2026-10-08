import { isAbsolute } from "node:path";
import type { LauncherCommandRunner } from "../domain/process-launcher.js";
import type { PaneGeometry, PaneLayoutParent, TerminalPaneLayoutAdapter } from "./terminal-pane-layout.js";

interface TmuxPaneIdentity {
	paneId: string;
	panePid: string;
	serverPid: string;
	windowId: string;
}

function parseIdentity(value: string): TmuxPaneIdentity {
	const [paneId, panePid, serverPid, windowId, ...extra] = value.trim().split(/\s+/);
	if (!paneId || !panePid || !serverPid || !windowId || extra.length !== 0)
		throw new Error("tmux returned incomplete pane identity");
	return { paneId, panePid, serverPid, windowId };
}

function encodeIdentity(identity: TmuxPaneIdentity): string {
	return JSON.stringify(identity);
}

function decodeIdentity(value: string): TmuxPaneIdentity {
	const parsed: unknown = JSON.parse(value);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("paneId" in parsed) ||
		!("panePid" in parsed) ||
		!("serverPid" in parsed) ||
		!("windowId" in parsed) ||
		typeof parsed.paneId !== "string" ||
		typeof parsed.panePid !== "string" ||
		typeof parsed.serverPid !== "string" ||
		typeof parsed.windowId !== "string"
	)
		throw new Error("Invalid saved tmux pane identity");
	return {
		paneId: parsed.paneId,
		panePid: parsed.panePid,
		serverPid: parsed.serverPid,
		windowId: parsed.windowId,
	};
}

export function createTmuxPaneLayoutAdapter(
	runner: LauncherCommandRunner,
	env: Record<string, string | undefined>,
): TerminalPaneLayoutAdapter {
	const socketPath = env.TMUX?.split(",", 1)[0];
	let sourcePaneId = env.TMUX_PANE;
	const run = (args: readonly string[], socket: string) => {
		if (!isAbsolute(socket)) throw new Error("tmux socket path is unavailable");
		return runner.run("tmux", ["-S", socket, ...args], { env: { ...process.env, ...env } });
	};
	const resolveIdentity = async (paneId: string, socket: string) =>
		parseIdentity(
			(
				await run(["display-message", "-p", "-t", paneId, "#{pane_id} #{pane_pid} #{pid} #{window_id}"], socket)
			).stdout.trim(),
		);

	return {
		async parent(): Promise<PaneLayoutParent> {
			if (!socketPath || !isAbsolute(socketPath)) throw new Error("tmux socket path is unavailable");
			sourcePaneId ??= (await run(["display-message", "-p", "#{pane_id}"], socketPath)).stdout
				.trim()
				.split(/\r?\n/)
				.at(-1);
			const paneId = sourcePaneId;
			if (!paneId) throw new Error("tmux could not identify the calling pane");
			const identity = await resolveIdentity(paneId, socketPath);
			if (identity.paneId !== paneId) throw new Error("tmux calling pane identity changed");
			return { paneId, identity: encodeIdentity(identity), socketPath };
		},
		async inspect(parent: PaneLayoutParent): Promise<readonly PaneGeometry[]> {
			if (!parent.socketPath || !isAbsolute(parent.socketPath)) throw new Error("Invalid saved tmux socket path");
			const expected = decodeIdentity(parent.identity);
			if (expected.paneId !== parent.paneId) throw new Error("Saved tmux parent identity does not match its pane");
			const actual = await resolveIdentity(parent.paneId, parent.socketPath);
			if (encodeIdentity(actual) !== encodeIdentity(expected))
				throw new Error("Saved tmux parent identity no longer matches the pane/server/window");
			const listing = await run(
				[
					"list-panes",
					"-t",
					expected.windowId,
					"-F",
					"#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}",
				],
				parent.socketPath,
			);
			const geometries: PaneGeometry[] = [];
			for (const line of listing.stdout.trim().split(/\r?\n/)) {
				const [paneId, x, y, width, height, ...extra] = line.trim().split(/\s+/);
				const values = [x, y, width, height].map(Number);
				if (!paneId || extra.length !== 0 || values.some((value) => !Number.isSafeInteger(value)))
					throw new Error("tmux returned invalid pane geometry");
				const [paneX, paneY, paneWidth, paneHeight] = values;
				if (paneX === undefined || paneY === undefined || paneWidth === undefined || paneHeight === undefined)
					throw new Error("tmux returned incomplete pane geometry");
				geometries.push({ paneId, x: paneX, y: paneY, width: paneWidth, height: paneHeight });
			}
			if (!geometries.some((pane) => pane.paneId === parent.paneId))
				throw new Error("Saved tmux parent is no longer in its original window");
			return geometries;
		},
		async moveBelow(parent, paneId, targetPaneId) {
			const panes = await this.inspect(parent);
			if (!panes.some((pane) => pane.paneId === paneId) || !panes.some((pane) => pane.paneId === targetPaneId))
				throw new Error("tmux column move left the saved parent window");
			const focused =
				(await run(["display-message", "-p", "-t", paneId, "#{pane_active}"], parent.socketPath)).stdout.trim() === "1";
			await run(["join-pane", "-v", "-d", "-l", "50%", "-s", paneId, "-t", targetPaneId], parent.socketPath);
			await this.inspect(parent);
			// -d prevents target focus, but tmux still changes active pane when removing its current leaf.
			if (focused) await run(["select-pane", "-t", paneId], parent.socketPath);
		},
		async resize(parent: PaneLayoutParent, paneId: string, height: number): Promise<void> {
			if (!Number.isSafeInteger(height) || height < 1) throw new Error("Invalid tmux pane height");
			const expected = decodeIdentity(parent.identity);
			if (expected.paneId !== parent.paneId) throw new Error("Saved tmux parent identity does not match its pane");
			const actual = await resolveIdentity(parent.paneId, parent.socketPath);
			if (encodeIdentity(actual) !== encodeIdentity(expected))
				throw new Error("Saved tmux parent identity no longer matches the pane/server/window");
			await run(["resize-pane", "-y", String(height), "-t", paneId], parent.socketPath);
		},
		async resizeWidth(parent, paneId, width) {
			if (!Number.isSafeInteger(width) || width < 1) throw new Error("Invalid tmux pane width");
			const expected = decodeIdentity(parent.identity);
			if (expected.paneId !== parent.paneId) throw new Error("Saved tmux parent identity does not match its pane");
			const actual = await resolveIdentity(parent.paneId, parent.socketPath);
			if (encodeIdentity(actual) !== encodeIdentity(expected))
				throw new Error("Saved tmux parent identity no longer matches the pane/server/window");
			await run(["resize-pane", "-x", String(width), "-t", paneId], parent.socketPath);
		},
	};
}
