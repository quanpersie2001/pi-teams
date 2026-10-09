// Conversation-only completion batching. Lifecycle events remain immediate;
// this queue controls only the model-facing notification. A Pi turn boundary
// finalizes a batch of Agent launches; a configurable fallback also covers
// hosts without turn_end or an interrupted turn. Results fetched before dispatch are filtered by the caller.
import type { AgentLifecycleEvent } from "../domain/integration-protocol.js";

export interface CompletionQueueOptions {
	holdMs?: number;
	batchWindowMs?: number;
	groupTimeoutMs?: number;
	stragglerTimeoutMs?: number;
}

interface Group {
	remaining: Set<string>;
	completed: Map<string, AgentLifecycleEvent>;
	timer: ReturnType<typeof setTimeout> | undefined;
	stragglers: boolean;
}

export class CompletionQueue {
	private readonly pending = new Map<string, AgentLifecycleEvent>();
	private readonly individualTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly groups = new Set<Group>();
	private readonly heldTimers = new Set<ReturnType<typeof setTimeout>>();
	private readonly groupByAgent = new Map<string, Group>();
	private readonly batch = new Set<string>();
	private batchTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly holdMs: number;
	private readonly batchWindowMs: number;
	private readonly groupTimeoutMs: number;
	private readonly stragglerTimeoutMs: number;

	constructor(
		private readonly deliver: (events: AgentLifecycleEvent[]) => void,
		options: CompletionQueueOptions = {},
	) {
		this.holdMs = options.holdMs ?? 200;
		this.batchWindowMs = options.batchWindowMs ?? 100;
		this.groupTimeoutMs = options.groupTimeoutMs ?? 30_000;
		this.stragglerTimeoutMs = options.stragglerTimeoutMs ?? 15_000;
	}

	/** Called only for successful, background conversation-owned Agent tool launches. */
	trackSpawn(id: string): void {
		this.batch.add(id);
		this.cancelIndividual(id);
		if (this.batchTimer) clearTimeout(this.batchTimer);
		// Pi uses a long safety fallback so slow parallel calls can join at
		// turn_end; hosts without that boundary may use a short window.
		if (this.batchWindowMs > 0) this.batchTimer = setTimeout(() => this.finishBatch(), this.batchWindowMs);
	}

	/** Turn boundary: all concurrently issued Agent calls have returned. */
	finishBatch(): void {
		if (this.batchTimer) clearTimeout(this.batchTimer);
		this.batchTimer = undefined;
		const ids = [...this.batch];
		this.batch.clear();
		if (ids.length < 2) {
			for (const id of ids) if (this.pending.has(id)) this.scheduleIndividual(id);
			return;
		}
		const group: Group = { remaining: new Set(ids), completed: new Map(), timer: undefined, stragglers: false };
		this.groups.add(group);
		for (const id of ids) {
			this.groupByAgent.set(id, group);
			const event = this.pending.get(id);
			if (event) this.completeInGroup(group, event);
		}
	}

	add(event: AgentLifecycleEvent): void {
		const id = event.agentId;
		if (this.pending.has(id)) return;
		this.pending.set(id, event);
		const group = this.groupByAgent.get(id);
		if (group) this.completeInGroup(group, event);
		else if (!this.batch.has(id)) this.scheduleIndividual(id);
	}

	/** Drop queued messages when the owning session is replaced or the app disposes. */
	clear(): void {
		if (this.batchTimer) clearTimeout(this.batchTimer);
		this.batchTimer = undefined;
		this.batch.clear();
		for (const timer of this.individualTimers.values()) clearTimeout(timer);
		this.individualTimers.clear();
		for (const group of this.groups) if (group.timer) clearTimeout(group.timer);
		this.groups.clear();
		for (const timer of this.heldTimers) clearTimeout(timer);
		this.heldTimers.clear();
		this.groupByAgent.clear();
		this.pending.clear();
	}

	private cancelIndividual(id: string): void {
		const timer = this.individualTimers.get(id);
		if (timer) clearTimeout(timer);
		this.individualTimers.delete(id);
	}

	private scheduleIndividual(id: string): void {
		this.cancelIndividual(id);
		if (this.holdMs === 0) {
			const event = this.pending.get(id);
			this.pending.delete(id);
			if (event) this.deliver([event]);
			return;
		}
		this.individualTimers.set(
			id,
			setTimeout(() => {
				this.individualTimers.delete(id);
				const event = this.pending.get(id);
				this.pending.delete(id);
				if (event) this.deliver([event]);
			}, this.holdMs),
		);
	}

	private completeInGroup(group: Group, event: AgentLifecycleEvent): void {
		if (!group.remaining.has(event.agentId)) return;
		group.completed.set(event.agentId, event);
		if (group.completed.size === group.remaining.size) {
			this.flushGroup(group);
		} else if (!group.timer) {
			group.timer = setTimeout(
				() => this.flushGroup(group),
				group.stragglers ? this.stragglerTimeoutMs : this.groupTimeoutMs,
			);
		}
	}

	private flushGroup(group: Group): void {
		if (group.timer) clearTimeout(group.timer);
		group.timer = undefined;
		const events = [...group.completed.values()];
		group.completed.clear();
		for (const event of events) {
			group.remaining.delete(event.agentId);
			this.groupByAgent.delete(event.agentId);
			this.pending.delete(event.agentId);
		}
		if (group.remaining.size === 0) this.groups.delete(group);
		group.stragglers = true;
		// Hold once more so a parent waiting on the last child can consume its
		// result before a notification is committed to the Pi message queue.
		if (events.length > 0) {
			if (this.holdMs === 0) {
				this.deliver(events);
				return;
			}
			const timer = setTimeout(() => {
				this.heldTimers.delete(timer);
				this.deliver(events);
			}, this.holdMs);
			this.heldTimers.add(timer);
		}
	}
}
