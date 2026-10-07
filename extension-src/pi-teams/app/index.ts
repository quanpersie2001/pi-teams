// Application composition root for the pi-teams runtime (ARCHITECTURE.md §4).
//
// Host-injectable by contract: concrete adapters (agent-file loader, backend
// instances, session id source, durable registry store, restore observers) are
// passed in by pi/index.ts. This module never imports from pi/ (ARCH-004).

import type { AgentExecutionBackend } from "../domain/backend.js";
import type { SubagentsSettings } from "../domain/config.js";
import { isConversationOwner } from "../domain/delivery.js";
import type { AgentLifecycleEvent } from "../domain/integration-protocol.js";
import type { InboxMessage } from "../domain/message.js";
import type { AgentManagerOptions } from "./agent-manager.js";
import { AgentManager } from "./agent-manager.js";
import { AgentRegistry, type RawAgentLoader } from "./agent-registry.js";
import { type DeliveryHost, DeliveryService } from "./delivery-service.js";
import { MessageService } from "./message-service.js";
import { partitionOwnedEntries, restoreRegisteredRuns } from "./restore.js";
import type {
	IncompatibleRegistryEntry,
	PersistedRegistryEntry,
	RestoreObservers,
	SubagentRunStore,
} from "./run-registry.js";
import type { WorktreeService } from "./worktree-service.js";

export interface PiSubagentsAppOptions {
	/** Agent source directories, ascending precedence (pi/ resolves them). */
	sources: string[];
	/** Filesystem loader adapter (pi/agent-files.ts). */
	loader: RawAgentLoader;
	/** Sanitized operational settings as read by the host. */
	settings: SubagentsSettings;
	/** Registered execution backends (concrete instances built in pi/). */
	backends: readonly AgentExecutionBackend[];
	cwd: string;
	configCwd: string;
	/** Session id provider for default conversation ownership. */
	getSessionId?: () => string;
	/**
	 * Durable registry/history store (pi/registry-host.ts). When omitted the
	 * run registry stays in-memory only and no restore happens.
	 */
	runStore?: SubagentRunStore;
	/**
	 * Restore adapters built on process RPC/filesystem state by the host; required
	 * together with `runStore` for startup restore.
	 */
	restoreObservers?: RestoreObservers;
	/** Extra manager knobs for deterministic tests. */
	managerOverrides?: Partial<Pick<AgentManagerOptions, "idFactory" | "now">>;
	/**
	 * Conversation-delivery host adapter (pi/delivery-host.ts). When omitted,
	 * no conversation notifications are sent — lifecycle events still flow to
	 * subscribers (pi.events) so extension consumers keep working.
	 */
	deliveryHost?: DeliveryHost;
	sendToParent?(message: InboxMessage): Promise<boolean>;
	/** Managed worktree service. Checkouts remain until explicit release. */
	worktreeService?: WorktreeService;
}

export interface PiSubagentsApp {
	sessionStart(): Promise<void>;
	sessionShutdown(): Promise<void>;
	/**
	 * Replace operational settings and propagate them to every consumer
	 * (registry, manager, worktree service). Called by the host at each
	 * session_start after re-reading global/project settings files so edits
	 * apply without a process restart. The manager applies them immediately;
	 * the registry applies them to subsequent loads/resolutions.
	 */
	updateSettings(settings: SubagentsSettings): void;
	readonly registry: AgentRegistry;
	readonly manager: AgentManager;
	readonly messages: MessageService;
	/** Owner-aware conversation delivery; present only with a deliveryHost. */
	readonly delivery?: DeliveryService;
	/** Summary of the last session_start restore pass, when one ran. */
	lastRestoreSummary?: Awaited<ReturnType<typeof restoreRegisteredRuns>>;
	/**
	 * Subscribe to owner-aware lifecycle events (AgentLifecycleEvent payloads).
	 * The pi host forwards these onto pi.events channels `subagents:<name>`;
	 * the RPC layer reuses the same stream.
	 */
	subscribe(listener: (event: AgentLifecycleEvent) => void): () => void;
}

export function createPiSubagentsApp(options: PiSubagentsAppOptions): PiSubagentsApp {
	const registry = new AgentRegistry({
		sources: options.sources,
		loader: options.loader,
		settings: options.settings,
	});
	const managerOptions: AgentManagerOptions = {
		registry,
		settings: options.settings,
		backends: options.backends,
		cwd: options.cwd,
		configCwd: options.configCwd,
	};
	if (options.worktreeService !== undefined) managerOptions.worktreeService = options.worktreeService;
	if (options.getSessionId !== undefined) managerOptions.getSessionId = options.getSessionId;
	if (options.runStore !== undefined) managerOptions.registryStore = options.runStore;
	Object.assign(managerOptions, options.managerOverrides ?? {});
	const manager = new AgentManager(managerOptions);
	const messages = new MessageService({
		getRun: (agentId) => manager.get(agentId),
		sendToChild: (agentId, message) => manager.sendInbox(agentId, message),
		...(options.sendToParent ? { sendToParent: options.sendToParent } : {}),
	});
	manager.setMessageService(messages);

	// Owner-aware completion delivery. Subscribes to the same
	// lifecycle event stream the pi host forwards onto pi.events.
	const delivery = options.deliveryHost ? new DeliveryService(manager, options.deliveryHost) : undefined;

	return {
		registry,
		manager,
		messages,
		...(delivery !== undefined ? { delivery } : {}),

		updateSettings(settings) {
			options.settings = settings;
			registry.updateSettings(settings);
			manager.updateSettings(settings);
			options.worktreeService?.updateSettings(settings);
		},

		async sessionStart() {
			// Load/reload agent definitions; active runs keep their snapshots.
			manager.beginSession();
			await registry.load();
			manager.updateSettings(options.settings);
			options.worktreeService?.updateSettings(options.settings);

			const store = options.runStore;
			const observers = options.restoreObservers;
			if (!store || !observers) return;

			const entries = store.readRegistry();
			// Runs belong to the conversation that launched them: only rows whose
			// conversation owner matches the current session are restored. Rows
			// owned by another conversation or an extension consumer are
			// bookkeeping-only here — settled or verified-dead children are
			// archived to history and dropped; live/unknown rows stay untouched on
			// disk for their owning process and survive this session's rewrites.
			const sessionId = options.getSessionId?.() ?? "unknown-session";
			const { owned, incompatible, foreign } = partitionOwnedEntries(entries, (entry) => {
				const owner = entry.owner;
				return isConversationOwner(owner) && owner.sessionId === sessionId;
			});
			const retainedForeign: PersistedRegistryEntry[] = [];
			for (const entry of foreign) {
				if (!options.settings.rememberAgents && isHiddenTerminal(entry)) {
					retainedForeign.push(entry);
					continue;
				}
				const completion = await observers.detectCompletion(entry);
				const alive = await observers.resourceAlive(entry);
				if (completion.finished) {
					const outcome = completion.outcome ?? "completed";
					const historyRow = { ...entry };
					delete historyRow.handle;
					store.recordCompleted({
						...historyRow,
						status: outcome === "failed" ? "error" : outcome,
						completedAt: entry.completedAt ?? Date.now(),
						...(completion.result !== undefined ? { result: completion.result } : {}),
						...(completion.error !== undefined ? { error: completion.error } : {}),
						...(completion.sessionFile !== undefined ? { sessionFile: completion.sessionFile } : {}),
					});
					continue;
				}
				if (alive === false) {
					const historyRow = { ...entry };
					delete historyRow.handle;
					store.recordCompleted({
						...historyRow,
						status: "error",
						completedAt: entry.completedAt ?? Date.now(),
						error: "owning session ended before the child settled and the child process is no longer available",
					});
					continue;
				}
				retainedForeign.push(entry);
			}
			manager.setForeignRegistryEntries(retainedForeign);
			// rememberAgents=false: terminal rows are neither surfaced nor
			// deleted — hand them to the manager so registry rewrites preserve
			// them on disk untouched.
			manager.setPreservedRegistryEntries(
				[...incompatible, ...owned].filter(
					(entry) =>
						isIncompatibleRegistryEntry(entry) || (!options.settings.rememberAgents && isHiddenTerminal(entry)),
				),
			);

			const summary = await restoreRegisteredRuns([...incompatible, ...owned], {
				...observers,
				reconnect: (entry) => manager.restoreReconnectedRun(entry),
				recordCompleted: (entry) => store.recordCompleted(entry),
				persist: (kept) => store.writeRegistry([...kept, ...retainedForeign]),
				rememberAgents: options.settings.rememberAgents,
				warn: (message) => console.warn(`[pi-teams] ${message}`),
				now: () => Date.now(),
			});
			this.lastRestoreSummary = summary;
		},

		async sessionShutdown() {
			// Detach child clients, not delivery: /new, /resume and /fork reuse this app.
			// Delivery reads the current host context and remains subscribed for the app lifetime.
			await manager.shutdownSession();
		},

		subscribe(listener) {
			return manager.subscribe(listener);
		},
	};
}

function isIncompatibleRegistryEntry(entry: PersistedRegistryEntry): entry is IncompatibleRegistryEntry {
	return "kind" in entry && entry.kind === "incompatible";
}

function isHiddenTerminal(entry: PersistedRegistryEntry): boolean {
	if (isIncompatibleRegistryEntry(entry)) return false;
	const status = entry.status;
	return status === "completed" || status === "stopped" || status === "aborted" || status === "error";
}
