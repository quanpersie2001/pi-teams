// Application composition root for the pi-teams runtime (ARCHITECTURE.md §4).
//
// Host-injectable by contract: concrete adapters (agent-file loader, backend
// instances, session id source and durable registry store) are passed in by pi/index.ts.
// This module never imports from pi/ (ARCH-004).

import type { AgentExecutionBackend } from "../domain/backend.js";
import type { SubagentsSettings } from "../domain/config.js";
import { isConversationOwner } from "../domain/delivery.js";
import type { AgentLifecycleEvent } from "../domain/integration-protocol.js";
import type { AgentManagerOptions } from "./agent-manager.js";
import { AgentManager } from "./agent-manager.js";
import { AgentRegistry, type RawAgentLoader } from "./agent-registry.js";
import { type DeliveryHost, DeliveryService, type DeliveryServiceOptions } from "./delivery-service.js";
import { MailboxService } from "./mailbox-service.js";
import { archiveRegistryRuns, partitionOwnedEntries } from "./registry-archive.js";
import type { SubagentRunStore } from "./run-registry.js";
import { TeamService, type TeamStore } from "./team-service.js";
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
	/** Durable registry/history store; when omitted run persistence is in-memory only. */
	runStore?: SubagentRunStore;
	/** Extra manager knobs for deterministic tests. */
	managerOverrides?: Partial<Pick<AgentManagerOptions, "idFactory" | "now">>;
	/**
	 * Conversation-delivery host adapter (pi/delivery-host.ts). When omitted,
	 * no conversation notifications are sent — lifecycle events still flow to
	 * subscribers (pi.events) so extension consumers keep working.
	 */
	deliveryHost?: DeliveryHost;
	/** Conversation completion hold/join timing; useful for deterministic host tests. */
	deliveryOptions?: DeliveryServiceOptions;
	/** Managed worktree service. Checkouts remain until explicit release. */
	worktreeService?: WorktreeService;
	/**
	 * Team roster store factory (pi/teams-host.ts); receives the live session
	 * id at each session_start (one team per session, ADR 0007 §2). When
	 * omitted no roster is kept.
	 */
	createTeamStore?: (sessionId: string) => TeamStore;
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
	/** Owner-aware conversation delivery; present only with a deliveryHost. */
	readonly delivery?: DeliveryService;
	/** Session's team service (roster); present only with a team store factory. */
	readonly teams: TeamService | undefined;
	/** Current session mailbox service, when a team is active. */
	readonly mailbox: MailboxService | undefined;
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

	// One team per session (ADR 0007 §2): the roster records every admitted
	// assignment under a teammate name. Rebuilt at each session_start from the
	// live session id; when no store factory is provided no roster is kept.
	let teams: TeamService | undefined;
	let mailbox: MailboxService | undefined;
	manager.subscribe((event) => {
		if (event.event !== "started" || event.teammateName === undefined) return;
		teams?.recordAssignment({
			name: event.teammateName,
			type: event.type,
			runId: event.agentId,
			...(event.teammateColor !== undefined ? { color: event.teammateColor } : {}),
		});
	});

	// Owner-aware completion delivery. Subscribes to the same
	// lifecycle event stream the pi host forwards onto pi.events.
	const delivery = options.deliveryHost
		? new DeliveryService(manager, options.deliveryHost, options.deliveryOptions)
		: undefined;

	return {
		registry,
		manager,
		...(delivery !== undefined ? { delivery } : {}),
		get teams() {
			return teams;
		},
		get mailbox() {
			return mailbox;
		},

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
			if (options.createTeamStore !== undefined) {
				teams = new TeamService({
					sessionId: options.getSessionId?.() ?? "unknown-session",
					store: options.createTeamStore(options.getSessionId?.() ?? "unknown-session"),
				});
				const roster = teams.sessionStart();
				manager.setTeamService(teams);
				mailbox = new MailboxService({ teamDir: teams.teamDir, teamKey: roster.teamKey, self: "lead" });
			} else {
				teams = undefined;
				mailbox = undefined;
				manager.setTeamService(undefined);
			}

			const store = options.runStore;
			if (!store) return;

			const entries = store.readRegistry();
			// Foreign ownership is never inspected or changed; only this session's
			// receipts are archived, and malformed rows remain byte-for-value.
			const sessionId = options.getSessionId?.() ?? "unknown-session";
			const { owned, incompatible, foreign } = partitionOwnedEntries(entries, (entry) => {
				const owner = entry.owner;
				return isConversationOwner(owner) && owner.sessionId === sessionId;
			});
			manager.setForeignRegistryEntries(foreign);
			await archiveRegistryRuns([...incompatible, ...owned], {
				dispose: (entry) => manager.attemptStaleDisposal(entry),
				recordCompleted: (entry) => store.recordCompleted(entry),
				persist: (kept) => {
					manager.setPreservedRegistryEntries(kept);
					store.writeRegistry([...kept, ...foreign]);
				},
				rememberAgents: options.settings.rememberAgents,
				warn: (message) => console.warn(`[pi-teams] ${message}`),
				now: () => Date.now(),
			});
		},

		async sessionShutdown() {
			// Session-bound lifetime (ADR 0007): teardown every child. Delivery
			// stays subscribed for the app lifetime — /new, /resume and /fork
			// reuse this app and its host reads the latest context dynamically.
			try {
				await manager.shutdownSession();
			} finally {
				// Shutdown itself can settle children; never carry those queued
				// conversation messages into a replacement session.
				delivery?.clearPending();
			}
		},

		subscribe(listener) {
			return manager.subscribe(listener);
		},
	};
}
