// Deterministic process-backend fake for manager/tool tests.
// Execution changes only when a test emits a backend status event; command
// acknowledgements are separate from run settlement.

import type { SerializableBackendHandle } from "../../extension-src/pi-teams/app/run-registry.js";
import type {
	AgentBackendHandle,
	AgentExecutionBackend,
	AgentLaunchInput,
	AgentResumeInput,
	BackendStatus,
	ModelAdmission,
	ModelAdmissionInput,
} from "../../extension-src/pi-teams/domain/backend.js";
import type { ChildState } from "../../extension-src/pi-teams/domain/child-protocol.js";
import type { LauncherKind } from "../../extension-src/pi-teams/domain/process-launcher.js";
import {
	emptyTranscriptSnapshot,
	type TranscriptItem,
	type TranscriptSnapshot,
} from "../../extension-src/pi-teams/domain/transcript.js";

export class FakeBackend implements AgentExecutionBackend {
	readonly kind = "process" as const;
	launcherKind: LauncherKind = "headless";
	availableResult = true;
	steerError: Error | undefined;
	stopError: Error | undefined;
	disposeError: Error | undefined;
	launchGate: Promise<void> | undefined;
	admissionGate: Promise<void> | undefined;
	admissionError: Error | undefined;
	admissionResult: ModelAdmission | undefined;
	/** Budget-enforcement port result; set an error to simulate a visible enforcement failure. */
	enforceTerminateError: Error | undefined;
	enforceTerminateStatus: BackendStatus | undefined;
	/** Disable to simulate a backend without the enforcement capability. */
	enforceTerminate: ((handle: AgentBackendHandle, graceMs: number) => Promise<BackendStatus>) | undefined = async (
		handle,
	) => {
		this.enforced.push(handle.handle);
		if (this.enforceTerminateError) throw this.enforceTerminateError;
		return this.enforceTerminateStatus ?? { state: "stopped" };
	};
	readonly admissions: ModelAdmissionInput[] = [];
	readonly defaultModel = "fake/deterministic";

	readonly launches: AgentLaunchInput[] = [];
	readonly resumes: AgentResumeInput[] = [];
	readonly stops: string[] = [];
	readonly steers: Array<{ handle: string; message: string }> = [];
	readonly detachedHandles: string[] = [];
	readonly disposedHandles: string[] = [];
	readonly disposeAttempts: string[] = [];
	readonly enforced: string[] = [];

	private readonly statuses = new Map<string, BackendStatus>();
	private readonly runByHandle = new Map<string, string>();
	private readonly listeners = new Map<string, Set<(status: BackendStatus) => void>>();
	private readonly focusListeners = new Map<string, Set<(state: ChildState) => void>>();
	private readonly focusSeqByRun = new Map<string, number>();
	private nextHandle = 0;
	private readonly launchWaiters: Array<PromiseWithResolvers<AgentLaunchInput>> = [];

	async available(): Promise<boolean> {
		return this.availableResult;
	}

	async prepareModel(input: ModelAdmissionInput): Promise<ModelAdmission> {
		this.admissions.push(input);
		if (this.admissionGate) await this.admissionGate;
		if (this.admissionError) throw this.admissionError;
		return this.admissionResult ?? { model: input.model ?? this.defaultModel };
	}

	async launch(input: AgentLaunchInput): Promise<AgentBackendHandle> {
		this.launches.push(input);
		this.setStatus(input.runId, { state: "starting" });
		if (this.launchGate) await this.launchGate;
		this.nextHandle += 1;
		const handle: AgentBackendHandle = { kind: "process", handle: `fake-handle-${this.nextHandle}` };
		this.runByHandle.set(handle.handle, input.runId);
		if (this.statuses.get(input.runId)?.state === "starting") this.setStatus(input.runId, { state: "running" });
		for (const waiter of this.launchWaiters.splice(0)) waiter.resolve(input);
		return handle;
	}

	/**
	 * Deterministic signal for the next launch()/resume() call — resolves with
	 * the launch input once the stored status already reads "running", so a
	 * test's setStatus/complete can never be overwritten by the launch itself
	 * and the manager's post-subscribe status probe observes it.
	 */
	nextLaunch(): Promise<AgentLaunchInput> {
		const waiter = Promise.withResolvers<AgentLaunchInput>();
		this.launchWaiters.push(waiter);
		return waiter.promise;
	}

	async resume(input: AgentResumeInput): Promise<AgentBackendHandle> {
		this.resumes.push({ ...input });
		return this.launch({
			runId: input.runId,
			type: "resumed",
			description: "resumed run",
			prompt: input.prompt,
			systemPrompt: "",
			promptMode: "text",
			cwd: input.cwd,
			configCwd: input.cwd,
			background: input.background,
		});
	}

	async status(handle: AgentBackendHandle): Promise<BackendStatus> {
		const runId = this.runByHandle.get(handle.handle);
		return (runId !== undefined ? this.statuses.get(runId) : undefined) ?? { state: "starting" };
	}

	async steer(handle: AgentBackendHandle, message: string): Promise<boolean> {
		if (this.steerError) throw this.steerError;
		this.steers.push({ handle: handle.handle, message });
		return true;
	}

	async stop(handle: AgentBackendHandle): Promise<boolean> {
		if (this.stopError) throw this.stopError;
		this.stops.push(handle.handle);
		return true;
	}

	async readTranscript(_handle: AgentBackendHandle): Promise<TranscriptSnapshot> {
		return emptyTranscriptSnapshot();
	}

	async dispose(handle: AgentBackendHandle): Promise<void> {
		this.disposeAttempts.push(handle.handle);
		if (this.disposeError) throw this.disposeError;
		this.disposedHandles.push(handle.handle);
	}
	async attach(_handle: AgentBackendHandle): Promise<boolean> {
		return this.launcherKind !== "headless";
	}

	serializeHandle(handle: AgentBackendHandle): SerializableBackendHandle | undefined {
		if (this.disposedHandles.includes(handle.handle)) return undefined;
		const runId = this.runByHandle.get(handle.handle);
		if (!runId) return undefined;
		const childId = `child-${runId}`;
		return {
			kind: "process",
			childId,
			socketPath: `/tmp/${childId}.sock`,
			token: `token-${childId}`,
			runDir: `/tmp/${childId}`,
			launcher: { kind: this.launcherKind, childId, pid: 1, identity: { ownerToken: childId } },
		};
	}

	detach(handle: AgentBackendHandle): void {
		this.detachedHandles.push(handle.handle);
	}

	subscribe(handle: AgentBackendHandle, listener: (status: BackendStatus) => void): () => void {
		let listeners = this.listeners.get(handle.handle);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(handle.handle, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners?.delete(listener);
			if (listeners?.size === 0) this.listeners.delete(handle.handle);
		};
	}

	// -- test controls ---------------------------------------------------------

	setStatus(runId: string, status: BackendStatus): void {
		this.statuses.set(runId, status);
		const handle = [...this.runByHandle].find(([, id]) => id === runId)?.[0];
		if (handle) {
			for (const listener of this.listeners.get(handle) ?? []) listener(status);
		}
	}

	subscribeFocus(handle: AgentBackendHandle, listener: (state: ChildState) => void): () => void {
		const runId = this.runByHandle.get(handle.handle);
		if (runId === undefined) return () => {};
		let listeners = this.focusListeners.get(runId);
		if (!listeners) {
			listeners = new Set();
			this.focusListeners.set(runId, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners?.delete(listener);
			if (listeners?.size === 0) this.focusListeners.delete(runId);
		};
	}

	/** Emit an authenticated child snapshot as if the child had produced `items`. */
	emitFocus(runId: string, items: Array<Pick<TranscriptItem, "kind" | "timestamp"> & Partial<TranscriptItem>>): void {
		const seq = (this.focusSeqByRun.get(runId) ?? 0) + 1;
		this.focusSeqByRun.set(runId, seq);
		const state: ChildState = {
			childId: `child-${runId}`,
			pid: 1,
			execution: "running",
			currentRunId: runId,
			seq,
			transcript: { items: [...items], cursor: items.length },
		};
		for (const listener of [...(this.focusListeners.get(runId) ?? [])]) listener(state);
	}

	complete(
		runId: string,
		result: string,
		sessionFile?: string,
		extra?: Pick<BackendStatus, "resultFile" | "resultTruncated" | "resultOriginalLength">,
	): void {
		this.setStatus(runId, {
			state: "completed",
			result,
			...(sessionFile !== undefined ? { sessionFile } : {}),
			...extra,
		});
	}

	fail(runId: string, error: string): void {
		this.setStatus(runId, { state: "failed", error });
	}

	settleStopped(runId: string): void {
		this.setStatus(runId, { state: "stopped" });
	}
}
