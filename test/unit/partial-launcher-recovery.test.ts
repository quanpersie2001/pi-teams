import { describe, expect, it } from "vitest";
import type { LauncherHandle, ProcessLauncher } from "../../extension-src/pi-teams/domain/process-launcher.js";
import { createProcessLaunchers } from "../../extension-src/pi-teams/pi/process-launchers.js";

function fixture(kind: "tmux" | "herdr") {
	const pid = 1900000003;
	const state = {
		available: false,
		paneId: "owned",
		terminalId: "terminal",
		pid,
		server: "1899999999",
		token: "launch-token",
		start: "original-start",
		empty: false,
		closed: false,
		missing: false,
	};
	let probes = 0;
	const probe = { before: (_count: number) => {} };
	const handle: LauncherHandle = {
		kind,
		childId: "child",
		paneId: "owned",
		socketPath: "/tmp/partial-recovery.sock",
		...(kind === "herdr" ? { terminalId: "terminal" } : {}),
		identity:
			kind === "tmux"
				? { ownerToken: "launch-token", serverPid: state.server }
				: { ownerToken: "launch-token", sourcePaneId: "parent" },
	};
	const mutations: string[] = [];
	const launcher = createProcessLaunchers({
		env: {
			TMUX: "/tmp/partial-recovery.sock,1,0",
			HERDR_ENV: "1",
			HERDR_PANE_ID: "parent",
			HERDR_SOCKET_PATH: "/tmp/partial-recovery.sock",
		},
		runner: {
			async run(command, args) {
				if (!state.available) throw new Error("identity probe unavailable");
				if (state.missing && command !== "ps") throw new Error("pane_not_found");
				const reply = (value: unknown) => ({ stdout: JSON.stringify({ result: value }), stderr: "" });
				if (command === "ps") return { stdout: args.includes("lstart=") ? state.start : state.token, stderr: "" };
				if (command === "tmux") {
					const op = args.slice(2);
					if (op[0] === "kill-pane") {
						mutations.push("kill-pane");
						state.closed = true;
						return { stdout: "", stderr: "" };
					}
					if (op.includes("#{pane_id} #{pane_pid} #{pid}")) {
						probe.before(++probes);
						return { stdout: `${state.paneId} ${state.pid} ${state.server}`, stderr: "" };
					}
					if (op.includes("#{pane_start_command}")) return { stdout: state.token, stderr: "" };
				} else if (command === "herdr") {
					if (args[1] === "get") {
						probe.before(++probes);
						return reply({ pane: { pane_id: state.paneId, terminal_id: state.terminalId } });
					}
					if (args[1] === "process-info")
						return reply({
							process_info: {
								pane_id: state.paneId,
								foreground_process_group_id: state.pid,
								foreground_processes: state.empty ? [] : [{ pid: state.pid }],
							},
						});
					if (args[1] === "close") {
						mutations.push("close");
						state.closed = true;
						return reply({});
					}
				}
				throw new Error(`unexpected command ${command} ${args.join(" ")}`);
			},
		},
	}).find((candidate) => candidate.kind === kind) as ProcessLauncher;
	return { launcher, handle, state, mutations, probe };
}

for (const kind of ["tmux", "herdr"] as const) {
	describe(`${kind} partial cleanup recovery`, () => {
		it("recovers original ownership after transient probes return, without mutating or signaling", async () => {
			const { launcher, handle, state, mutations } = fixture(kind);
			const before = structuredClone(handle);
			await expect(launcher.recoverForCleanup?.(handle)).resolves.toBeUndefined();
			state.available = true;
			const recovered = await launcher.recoverForCleanup?.(handle);
			expect(recovered).toMatchObject({ kind, childId: handle.childId, pid: state.pid });
			expect(handle).toEqual(before);
			expect(mutations).toEqual([]);
		});

		it.each(["token", "paneId", ...(kind === "tmux" ? ["server"] : ["terminalId"])])(
			"keeps a foreign %s fenced",
			async (field) => {
				const { launcher, handle, state, mutations } = fixture(kind);
				state.available = true;
				Object.assign(state, { [field]: "foreign" });
				await expect(launcher.recoverForCleanup?.(handle)).resolves.toBeUndefined();
				expect(mutations).toEqual([]);
			},
		);

		it("does not adopt a missing pane as a recovered process", async () => {
			const { launcher, handle, state, mutations } = fixture(kind);
			state.available = true;
			state.missing = true;
			await expect(launcher.recoverForCleanup?.(handle)).resolves.toBeUndefined();
			expect(mutations).toEqual([]);
		});

		it("rejects process identity changing between the two ownership probes", async () => {
			const { launcher, handle, state, mutations, probe } = fixture(kind);
			state.available = true;
			probe.before = (count) => {
				if (count === 2) state.pid++;
			};
			await expect(launcher.recoverForCleanup?.(handle)).resolves.toBeUndefined();
			expect(mutations).toEqual([]);
		});

		it("does not infer ownership when the original token is unavailable", async () => {
			const { launcher, handle, state, mutations } = fixture(kind);
			state.available = true;
			delete handle.identity?.ownerToken;
			await expect(launcher.recoverForCleanup?.(handle)).resolves.toBeUndefined();
			expect(mutations).toEqual([]);
		});

		it("cleans verified-exited resources using recovered identity without a native outcome", async () => {
			const { launcher, handle, state, mutations } = fixture(kind);
			state.available = true;
			const recovered = await launcher.recoverForCleanup?.(handle);
			if (!recovered) throw new Error("missing original ownership");
			state.empty = true;
			await expect(launcher.cleanupExited(recovered)).resolves.toBe(true);
			expect(mutations).toEqual([kind === "tmux" ? "kill-pane" : "close"]);
		});

		it("refuses to rebind an already-recorded PID", async () => {
			const { launcher, handle, state, mutations } = fixture(kind);
			state.available = true;
			handle.pid = state.pid + 1;
			await expect(launcher.recoverForCleanup?.(handle)).resolves.toBeUndefined();
			expect(mutations).toEqual([]);
		});
	});
}

it("cleans a partial HerdR receipt with saved group exit proof even when no start-time probe ever succeeded", async () => {
	const { launcher, handle, state, mutations } = fixture("herdr");
	state.available = true;
	state.empty = true;
	handle.pid = state.pid;
	handle.identity = { ...handle.identity, foregroundProcessGroupId: String(state.pid) };
	await expect(launcher.cleanupExited(handle)).resolves.toBe(true);
	expect(mutations).toEqual(["close"]);
});

it("keeps a partial HerdR terminal fenced when no original process/group evidence exists", async () => {
	const { launcher, handle, state, mutations } = fixture("herdr");
	state.available = true;
	state.empty = true;
	await expect(launcher.recoverForCleanup?.(handle)).resolves.toBeUndefined();
	await expect(launcher.cleanupExited(handle)).rejects.toThrow("Incomplete HerdR launcher handle");
	expect(mutations).toEqual([]);
});

it("uses saved original HerdR PID/start identity after title rewriting, but rejects reused start times", async () => {
	const { launcher, handle, state, mutations } = fixture("herdr");
	state.available = true;
	const recovered = await launcher.recoverForCleanup?.(handle);
	if (!recovered) throw new Error("missing original ownership");
	state.token = "title-rewritten";
	await expect(launcher.recoverForCleanup?.(recovered)).resolves.toEqual(recovered);
	state.start = "reused-start";
	await expect(launcher.recoverForCleanup?.(recovered)).resolves.toBeUndefined();
	expect(mutations).toEqual([]);
});

it("does not close an empty HerdR pane while the recorded process or group could still be alive", async () => {
	const { launcher, handle, state, mutations } = fixture("herdr");
	state.available = true;
	state.empty = true;
	handle.pid = process.pid;
	handle.identity = { ...handle.identity, foregroundProcessGroupId: String(process.pid) };
	await expect(launcher.cleanupExited(handle)).resolves.toBe(false);
	expect(mutations).toEqual([]);
});

it.each(["panePid", "foregroundProcessGroupId"])("refuses to rebind retained %s evidence", async (field) => {
	const kind = field === "panePid" ? "tmux" : "herdr";
	const { launcher, handle, state, mutations } = fixture(kind);
	state.available = true;
	handle.identity = { ...handle.identity, [field]: String(state.pid + 1) };
	await expect(launcher.recoverForCleanup?.(handle)).resolves.toBeUndefined();
	expect(mutations).toEqual([]);
});
