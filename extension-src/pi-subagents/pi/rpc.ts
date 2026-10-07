// Wires IntegrationService onto pi.events and forwards manager lifecycle
// events as consumer-compatible broadcasts (docs/INTEGRATION.md).
//
// Public compatibility boundary = versioned pi.events RPC:
//   requests  subagents:rpc:<op>                → IntegrationService handlers
//   replies   subagents:rpc:<op>:reply:<reqId>  → success/error envelope
//   lifecycle subagents:started|completed|failed|stopped|restored
//   presence  subagents:ready {}                → once per session_start;
//               consumers re-run their ping probe when they see it
//
// Consumer payload compatibility (pi-tasks SubagentRuntime): forwarded
// lifecycle events carry BOTH keys `agentId` (domain shape, used by
// delivery-service) and `id` (consumer alias,
// id === agentId). The consumer reads `event.id` plus
// `result` / `error` / `status`. The alias is added HERE, at the integration
// boundary, so the domain event type and all internal subscribers stay
// unchanged.
//
// Fast path (optional optimization, docs/INTEGRATION.md): the live
// IntegrationService instance is registered under
// `Symbol.for("pi-subagents:service")` on globalThis for same-process callers
// that want direct method access. This is NOT the public contract — events RPC
// remains the compatibility boundary, and anything not going through the
// versioned channels bypasses protocol versioning at its own risk. The key is
// removed on dispose().

import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../app/agent-manager.js";
import { IntegrationService } from "../app/integration-service.js";
import type { AgentLifecycleEvent } from "../domain/integration-protocol.js";

/** globalThis key of the optional in-process fast path (not the public boundary). */
export const SUBAGENTS_SERVICE_KEY: unique symbol = Symbol.for("pi-subagents:service");

/** Lifecycle broadcast payload: domain event + consumer-facing id alias. */
export type LifecycleBroadcast = AgentLifecycleEvent & {
	/** Alias of agentId; pi-tasks consumers read this key. */
	id: string;
};

/** Add the consumer-facing id alias without touching the domain event type. */
export function toLifecycleBroadcast(event: AgentLifecycleEvent): LifecycleBroadcast {
	return Object.freeze({ ...event, id: event.agentId }) as LifecycleBroadcast;
}

export interface SubagentsRpcWiring {
	/** Live RPC service (also exposed via SUBAGENTS_SERVICE_KEY fast path). */
	readonly service: IntegrationService;
	/**
	 * Broadcast `subagents:ready` {}. Called once per session_start by the
	 * host so late-loading consumers re-probe the ping channel.
	 */
	announceReady(): void;
	/** Remove lifecycle forwarding, RPC subscriptions and the fast path key. */
	dispose(): void;
}

export function wireSubagentsRpc(options: { events: EventBus; manager: AgentManager }): SubagentsRpcWiring {
	const { events, manager } = options;

	// Single shared forwarding path: the SAME stream feeds the delivery
	// service (via app.subscribe internally) and these broadcasts — no double
	// emit. Each listener error is contained so one broken consumer can never
	// break run settlement or starve other consumers.
	const unsubscribeManager = manager.subscribe((event) => {
		try {
			events.emit(`subagents:${event.event}`, toLifecycleBroadcast(event));
		} catch {
			/* event delivery must never break run settlement */
		}
	});

	const service = new IntegrationService(manager, { events });
	(globalThis as Record<symbol, unknown>)[SUBAGENTS_SERVICE_KEY] = service;

	return {
		service,

		announceReady() {
			try {
				events.emit("subagents:ready", {});
			} catch {
				/* presence announce must never break session start */
			}
		},

		dispose() {
			unsubscribeManager();
			service.dispose();
			delete (globalThis as Record<symbol, unknown>)[SUBAGENTS_SERVICE_KEY];
		},
	};
}
