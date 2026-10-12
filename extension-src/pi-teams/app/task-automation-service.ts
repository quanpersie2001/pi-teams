import type { TaskBoardChange, TaskBoardService } from "./task-board-service.js";
import {
	TaskExecutionCancelledError,
	TaskExecutionPlanChangedError,
	TaskExecutionReservationConflictError,
	type TaskExecutionService,
} from "./task-execution-service.js";

/** Starts explicitly planned dependent tasks after accepted board completion. */
export class TaskAutomationService {
	private readonly unsubscribe: () => void;
	private readonly unsubscribeWatch: () => void;
	private readonly statuses = new Map<string, string>();
	private readonly attempted = new Set<string>();
	private readonly completedRefs = new Set<string>();
	private readonly reservationRetries = new Map<string, number>();
	private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly launchControllers = new Map<string, AbortController>();
	private scheduled = false;
	private disposed = false;

	constructor(
		private readonly board: TaskBoardService,
		private readonly execution: TaskExecutionService,
		enabled: boolean,
	) {
		for (const task of board.list()) this.statuses.set(task.id, task.status);
		this.unsubscribe = enabled ? board.subscribe((event) => this.onBoardChange(event)) : () => {};
		this.unsubscribeWatch = enabled ? board.watch(() => this.safeObserveExternalChanges()) : () => {};
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribe();
		this.unsubscribeWatch();
		for (const timer of this.retryTimers.values()) clearTimeout(timer);
		this.retryTimers.clear();
		for (const controller of this.launchControllers.values()) controller.abort();
		this.launchControllers.clear();
	}

	private onBoardChange(event: TaskBoardChange): void {
		if (event.type === "removed") {
			this.statuses.delete(event.id);
			return;
		}
		if (!event.task) return;
		const previous = this.statuses.get(event.id);
		this.statuses.set(event.id, event.task.status);
		if (event.task.status === "completed" && previous !== undefined && previous !== "completed")
			this.queueCompletion(event.id, event.task.code);
	}

	private safeObserveExternalChanges(): void {
		try {
			this.observeExternalChanges();
		} catch (error) {
			console.warn(
				`[pi-teams] Could not observe external task changes: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private observeExternalChanges(): void {
		if (this.disposed) return;
		const tasks = this.board.list();
		const present = new Set<string>();
		for (const task of tasks) {
			present.add(task.id);
			const previous = this.statuses.get(task.id);
			this.statuses.set(task.id, task.status);
			if (task.status === "completed" && previous !== "completed") this.queueCompletion(task.id, task.code);
		}
		for (const id of this.statuses.keys()) if (!present.has(id)) this.statuses.delete(id);
	}

	private queueCompletion(id: string, code?: string): void {
		this.completedRefs.add(id);
		if (code) this.completedRefs.add(code);
		if (this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			try {
				this.cascade();
			} catch (error) {
				console.warn(
					`[pi-teams] Task automation cascade failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
	}

	private cascade(): void {
		this.scheduled = false;
		if (this.disposed) return;
		const completedRefs = new Set(this.completedRefs);
		this.completedRefs.clear();
		for (const task of this.board.list({ status: "pending" })) {
			if (this.disposed) return;
			if (
				!task.dependencies.some((dependency) => completedRefs.has(dependency)) ||
				!task.executionPlan ||
				task.blockedBy.length > 0 ||
				this.attempted.has(task.id)
			)
				continue;
			this.launch(task.id);
		}
	}

	private launch(id: string): void {
		if (this.disposed || this.attempted.has(id)) return;
		const task = this.board.get(id);
		if (task?.status !== "pending" || !task.executionPlan || task.blockedBy.length > 0) return;
		this.attempted.add(id);
		const controller = new AbortController();
		this.launchControllers.set(id, controller);
		const plan = task.executionPlan;
		void this.execution
			.execute(id, {
				actor: { name: "lead", coordinator: true },
				type: plan.type,
				...(plan.name !== undefined ? { name: plan.name } : {}),
				...(plan.color !== undefined ? { color: plan.color } : {}),
				...(plan.model !== undefined ? { model: plan.model } : {}),
				...(plan.maxTurns !== undefined ? { maxTurns: plan.maxTurns } : {}),
				expectedRequirementRevision: task.requirementRevision,
				expectedStatus: "pending",
				signal: controller.signal,
			})
			.then(() => this.reservationRetries.delete(id))
			.catch((error: unknown) => {
				if (error instanceof TaskExecutionCancelledError) return;
				if (error instanceof TaskExecutionPlanChangedError) {
					this.attempted.delete(id);
					this.reservationRetries.delete(id);
					return;
				}
				if (error instanceof TaskExecutionReservationConflictError) {
					this.retryReservation(id);
					return;
				}
				console.warn(
					`[pi-teams] Automatic task execution failed for ${task.code ?? task.id}: ${error instanceof Error ? error.message : String(error)}`,
				);
			})
			.finally(() => {
				if (this.launchControllers.get(id) === controller) this.launchControllers.delete(id);
			});
	}

	private retryReservation(id: string): void {
		if (this.disposed) return;
		const attempt = this.reservationRetries.get(id) ?? 0;
		const delays = [100, 250, 500];
		const delay = delays[attempt];
		if (delay === undefined) {
			this.attempted.delete(id);
			this.reservationRetries.delete(id);
			console.warn(`[pi-teams] Automatic task execution reservation remained busy for ${id}; leaving it pending.`);
			return;
		}
		this.reservationRetries.set(id, attempt + 1);
		const timer = setTimeout(() => {
			this.retryTimers.delete(id);
			this.attempted.delete(id);
			this.launch(id);
		}, delay);
		this.retryTimers.set(id, timer);
	}
}
