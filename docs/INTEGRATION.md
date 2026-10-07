# Extension integration

## Boundary

`pi-tasks` owns Task status, dependencies, priority, assignment/retry and review. `pi-teams` owns specialist definitions, independent child processes, AgentRun lifecycle, transcript/result and optional worktree artifacts. Task → run mapping belongs to the consumer; no Task entity is stored in this package.

## Public transport: version 3

Use `pi.events` channels `subagents:rpc:<op>`. Subscribe to `subagents:rpc:<op>:reply:<requestId>` **before** emitting the request. Each request is a flat object with a non-empty `requestId`; fields are not wrapped in `payload`.

```ts
// Request on subagents:rpc:spawn
{
  requestId: "assign-task-123",
  type: "implementer",
  prompt: "Goal: ... Scope: ... Acceptance: ... Verification: ...",
  options: {
    description: "Implement auth fix",
    isBackground: true,
    maxTurns: 40
  },
  owner: { kind: "extension", id: "pi-tasks", ref: "task-123" },
  delivery: "event"
}
```

`options` accepts only `description`, `isBackground`, `maxTurns`, `model`. The wire flag is **isBackground**, not `background` or `run_in_background`; unknown option keys return an error. Isolation is specialist/master configuration, not an RPC option. Specialist pins win for model/turn limit, while explicit `isBackground` overrides the specialist's default mode. Time budgets are also not RPC options: effective limits come from the specialist definition and `defaultTimeout`/`defaultIdleTimeout` settings.

Spawn/resume await native model/auth admission before allocation. Spawn prefers a usable specialist pin; unavailable primaries fall back through caller model, captured parent and stable authenticated native candidates. Cold resume validates its saved bootstrap and prefers the saved model. Missing/corrupt bootstrap is an error, not new context. No usable model returns `{ success: false, error }` without a run ID/started event. Admissions finishing after session shutdown/replacement also reject without allocation.

Reply envelopes:

```ts
{ success: true, data: ... }
{ success: false, error: "..." }
```

| Operation | Request fields besides `requestId` | Success `data` |
|---|---|---|
| `ping` | optional `version` | `{ version: 3 }` |
| `spawn` | `type`, `prompt`, optional `options`, `owner`, `delivery` | `{ id, model?, modelFallback? }` |
| `status` | `agentId` | `AgentRunSnapshot` or `null` |
| `steer` | `agentId`, `message` | `{ accepted: true, queued: boolean }` |
| `stop` | `agentId` | `{ stopped: true }` |
| `resume` | `agentId`, `prompt`, optional `isBackground` | `{ agentId }` — NEW run id |
| `release` | `agentId`, optional `cleanupWorktree` | `{ released: true }` |

Steer/stop/release await the runtime operation; failures return an error envelope. Steer queues for a `queued`/`starting` run. Stop success acknowledges the abort request, not settlement or process exit; a queued run can stop without launching. Native settlement preserves artifacts and automatically closes owned child/pane resources. Resume opens materialized native JSONL in a new independent child/run; pending cleanup must resolve first. Release requires settled related runs; it is not abort.

Status snapshots contain identity/type/description/status, `backend: "process"`, per-run turns/tools/usage, owner/delivery, start time and optional model/fallback, completion time/duration, session/result/error/recovery and worktree metadata. Additive optional `resultFile` carries the absolute path of the run's full-result artifact (`sessions/<child-id>/result.md`, written by the child at settlement) whenever one exists; the inline `result` stays preview-bounded and `resultTruncated`/`resultOriginalLength` mark truncation. Additive optional `budgetExhausted` (`"timeout"` or `"idle_timeout"`) and `budgetSeconds` appear when a run was stopped by its time budget. Unknown run IDs return `null`. Control credentials/serialized launcher handles are **not** in this public snapshot. Connection loss does not manufacture completion; `recoveryError` exposes preservation/cleanup failures and uncertain-resource receipts remain durable.

`model` is the canonical model actually admitted; optional `modelFallback` explains the unavailable primary and selected fallback. These additive v3 fields appear in spawn replies, status and lifecycle/history where known. Older historical runs may omit them. Queue-time revalidation can change the model before launching; subsequent status/lifecycle reflects that selection. Model/auth admission does not validate remote key acceptance, quota or provider availability.

Required strings must be non-empty; optional numeric fields must be finite and boolean fields correctly typed. Invalid requests with a usable `requestId` receive an error envelope; without it, no correlated reply is possible. Unknown/settled controls, failed admission and unsafe cleanup also return errors, not success. `subagents:ready` with `{}` is emitted each `session_start`; late consumers should re-probe version/status.

`Symbol.for("pi-teams:service")` on `globalThis` exposes the current integration service as an optional same-process fast path. Events RPC remains the public versioned boundary; the symbol is removed on disposal.

## Lifecycle

Broadcasts: `subagents:started`, `subagents:completed`, `subagents:failed`, `subagents:stopped`, `subagents:restored`.

`subagents:stopped` and terminal lifecycle events carry the same additive optional `budgetExhausted`/`budgetSeconds` fields as status snapshots when a time budget stopped the run.

Each broadcast carries `protocolVersion: 3`, `event`, `agentId`, `id` (`id === agentId`), type/description/status, owner/delivery, usage and start time. Model/fallback, parent session, session file, `resultFile`, result/error/recoveryError, completion time/duration and worktree/release metadata are included when present. The field is **protocolVersion**, not `version` (only `ping` replies use `version`). `id` is a broadcast alias, not a second domain identity. Consumers check owner and store Task → run mapping before updating their workflow.

Suggested consumer mapping (not runtime policy):

```text
Agent queued/running  → Task assigned/in_progress
Agent completed       → Task review
Agent failed          → Task failed/retry_pending
Agent stopped         → Task cancelled/stopped
worktreeResult        → review artifact
```

## Ownership and delivery

RPC spawn defaults to `{ kind: "extension", id: "pi-tasks" }` with `delivery: "event"`; explicit valid owner/delivery overrides these defaults. Direct model-facing `Agent` calls get the spawning conversation owner.

| Delivery | Behavior |
|---|---|
| `conversation` | guarded parent-conversation completion |
| `event` | lifecycle only; no duplicate parent completion |
| `both` | lifecycle and guarded conversation completion |
| `none` | caller obtains result/status explicitly |

Conversation delivery checks the spawning session/branch context. Extension-owned events remain observable after conversation switches. `/new`/resume lifecycle detaches control connections without killing children or permanently disposing delivery; subsequent session starts reconnect and retain functioning completion routing.

## Completion notification contract (renderer)

Conversation delivery injects a `pi.sendMessage` custom message when a run settles. The runtime ships **no message renderer** — this payload is the stable contract a pi-style companion visual extension may target by registering a renderer for the customType; without one the plain-text `content` displays verbatim.

- **customType:** `teammate-notification` (constant exported as `TEAMMATE_NOTIFICATION_TYPE` from `domain/delivery.ts`)
- **delivery:** `followUp` with `triggerTurn: true` — runtime-authored, lead-only, never sent to teammates
- **content** (structured plain text, canonical presentation):

```text
Teammate <id> finished|failed|stopped (<type>, <duration>)

<preview — result or error text, bounded to 400 chars>
full result: <absolute resultFile path>   ← last line, only when resultFile exists
```

- **details** (machine-readable schema): `agentId`, `type`, `description`, `status`, `outcome` (`completed | failed | stopped`), optional `resultFile`, `durationMs`, `totalTokens`.

The full result is durable and re-readable: `get_subagent_result` returns it on every call (re-reading `resultFile`), and consumers may page the file directly.

## Worktree review

Shared workspace is the default. Enable `worktreeIsolation` and choose `isolation: worktree` for managed per-run checkouts. Execution `cwd` preserves package-relative location; `configCwd` and durable artifacts stay at the original project root.

Completion preserves agent-created commits and commits remaining dirty changes. `worktreeResult` contains:

```ts
{
  path: "/.../retained-checkout/packages/example",
  branch: "agent/...",
  baseSha: "...",
  hasChanges: true,
  commitSha: "...",
  commits: ["first-preserved-sha", "second-preserved-sha"],
  cherryPickCommand: "git cherry-pick first-preserved-sha second-preserved-sha"
}
```

The runtime neither merges nor cherry-picks. Reviewer inspects/tests the retained checkout and integrates selected commits explicitly. `cherryPickCommand` is optional review guidance; adjust selection/mainline for non-linear history. Checkout remains until explicit cleanup:

```ts
// subagents:rpc:release
{ requestId: "review-cleanup", agentId, cleanupWorktree: true }
```

Without `cleanupWorktree: true`, release retries any retained verified child-resource cleanup and keeps the checkout; normally native settlement has already closed the process/pane. Checkout cleanup refuses dirty/unpreserved work and retains the preserved branch. Preservation/cleanup errors keep durable recovery metadata; no force-prune or automatic deletion of uncertain resources.

## Recovery handshake

The parent restores registry records before installing the initial UI projection. Only rows whose conversation owner matches the current session are adopted; rows owned by another conversation or an extension consumer are bookkeeping-only — settled or verified-dead foreign children are archived to history and dropped, live foreign rows stay untouched on disk. Supported process handles reconnect via the authenticated socket and verified launcher identity; terminal records remain available from native session history. Legacy incompatible receipts are retained, not adopted as fake process handles.

`pi-tasks` restores its own tasks/mappings, probes `ping`, calls `status`, subscribes to lifecycle and decides assignment/retry/review. Assignment prompts must be self-contained: goal, parent context, exact scope/non-goals, edit policy, acceptance and verification. The runtime does not validate task-specific acceptance criteria.

## Scoped inbox messaging

Messaging is separate from public v3 task orchestration, composer steering and completion notification:

| Tool | Parameters / visibility |
|---|---|
| `send_inbox_message` | `{ target: "parent" \| { agent_id: string }, text: string }`; parent sends only to children |
| `read_inbox` | `{}`; unread messages addressed to the calling parent/child |
| `consume_inbox_message` | `{ message_id: string }`; only the addressed recipient may consume |
| `inspect_subagent_messages` | `{}`; parent-only retained session thread, including sibling traffic and consumed receipts |

Sender and owning parent session come from trusted runtime context/authenticated child transport, never tool parameters. Parent-session scope is captured for conversation- and extension-owned runs. Cross-session or unscoped legacy targets are rejected. Children get builtin tools plus the three messaging tools, not `Agent`, result/steer orchestration or the inspector.

Receipts distinguish queued, delivered and consumed. Sending to a closed child does not launch it; pending messages transfer to a cold continuation with stable message IDs. Parent delivery injects `subagent-inbox` as steer with `triggerTurn: false` and strips terminal control characters from display. A failed parent delivery stays honestly queued, not marked delivered.

The queue and consumed history are process-local and bounded to 1,000 pending plus 1,000 consumed messages; text is limited to 32,000 characters. Reload/restart loses this state; messaging is not durable storage and does not automatically retry or revive a child.

