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

Status snapshots contain identity/type/description/status, `backend: "process"`, per-run turns/tools/usage, owner/delivery, start time and optional model/fallback, completion time/duration, session/result/error/recovery and worktree metadata. Additive optional `teammateName` carries the teammate address a run was spawned under (`Agent(name:)`); it also appears in lifecycle broadcasts and completion-notification `details`. Additive optional `resultFile` carries the absolute path of the run's full-result artifact (`sessions/<child-id>/result.md`, written by the child at settlement) whenever one exists; the inline `result` stays preview-bounded and `resultTruncated`/`resultOriginalLength` mark truncation. Additive optional `budgetExhausted` (`"timeout"` or `"idle_timeout"`) and `budgetSeconds` appear when a run was stopped by its time budget. Unknown run IDs return `null`. Control credentials/serialized launcher handles are **not** in this public snapshot. Connection loss does not manufacture completion; `recoveryError` exposes preservation/cleanup failures and uncertain-resource receipts remain durable.

Instance color is additive: snapshots/lifecycle/history use `teammateColor`; Agent and completion-notification `details` use `color` alongside `teammateName`; lead peer-message `details` use `from` and `color`. Values are effective roster identity, not merely the latest invocation request. Companion extensions own tool/message rendering; pi-teams installs no competing renderer.

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

Conversation delivery checks the spawning session/branch context. Delivery subscriptions survive session transitions, but children do not: `/new`, resume and shutdown await teardown before a new team starts. Old control connections are not reattached.

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

Startup reconciliation is archive-only, before UI initialization. Owned stale active rows become stopped history with a recovery note; saved terminal outcomes remain authoritative. Persisted resources go through identity-checked disposal without manager runs, capacity slots or mailbox subscriptions. Failed cleanup is logged and retained in history metadata, not deferred as an active row. Foreign-owner rows remain untouched; incompatible raw rows remain opaque. Explicit cold continuation from native JSONL stays available.

`pi-tasks` restores its own tasks/mappings, probes `ping`, calls `status`, subscribes to lifecycle and decides assignment/retry/review. Assignment prompts must be self-contained: goal, parent context, exact scope/non-goals, edit policy, acceptance and verification. The runtime does not validate task-specific acceptance criteria.

## Peer mailboxes

Messaging is independent of public integration v3 orchestration and runtime-authored completion notifications.

`send_message` accepts `{ target: "teammate-name" | "lead", message: string }`. The lead and named teammates receive the tool; children do not receive `Agent`, result retrieval or parent orchestration tools. Targets must resolve to the current team's roster. There is no broadcast primitive.

Each participant has `.pi/teams/t/<team-id>/inboxes/<name>/`. A message is a single JSON file written with an exclusive temporary file and atomic rename (0700 directories, 0600 files). A per-team HMAC key is generated with the roster and distributed through the authenticated, owner-only bootstrap. Verification rejects malformed, tampered or wrong-recipient entries; quarantine preserves invalid entries and logs the reason.

Bridges watch their own mailbox and inject automatically: an idle teammate starts a new native assignment, while a busy teammate receives steering. Assignment metadata—not peer content—crosses the parent control socket to obtain the same `maxConcurrent` capacity as an `Agent` invocation. Native `agent_settled` remains the settlement authority. An `Agent` assignment under a settled name reuses its live native child; specialist roles remain fixed for that teammate.

The lead receives runtime-authored `teammate-message` custom messages (`deliverAs: "steer"`, `triggerTurn: true`, provenance in `details`). Its mailbox file is consumed only after the matching native `message_end` event proves conversation injection. Child files are consumed after native prompt/steer admission. Queued/delivered/consumed receipts remain internal; model output reports only queuing, not an approval or execution guarantee.

The main TUI composer offers live teammates in `@` completion. `@name message` is intercepted before normal submission and written directly to that mailbox; unresolved names retain inline-mention behavior. Routing never takes input from an overlay, panel navigation or autocomplete menu. Failed writes preserve the editor text without forwarding it to the lead.

Messages carry no permission authority. The shared team key authenticates team-originated content, not a permission grant or isolation between mutually untrusted native processes. Each child's native permission surface remains authoritative. Session teardown stops peers; persisted mailboxes never restart them.

## Shared team task board

The lead and named teammates receive these tools:

| Tool | Arguments |
|---|---|
| `team_task_create` | `{ title: string, description?: string, dependencies?: string[] }` |
| `team_task_update` | `{ id: string, status: "pending" \| "in_progress" \| "completed" }` |
| `team_task_get` | `{ id: string }` |
| `team_task_list` | `{}` |

Tasks persist as atomic 0600 files in `.pi/teams/t/<team-id>/tasks/` (0700 directory). Results include `blockedBy`, computed from incomplete prerequisites. Dependency IDs must exist in the same board. Claiming sets the caller as owner only when blockers are empty; the owner alone may release or complete it. Completed tasks cannot reopen. Exclusive lock-directory conflicts surface as native tool errors without automatic retries.

Tool definitions resolve the current team when executed; they accept no team directory or caller-selected owner. A new session cannot use them to mutate an old board. Cold named continuation gets the current team's bootstrap, never the old team's key/path.

The board does not replace consumer task management. Integration v3 is unchanged; `pi-tasks` owns retries, acceptance, review, priorities and assignment policy and may read a settled final board as an artifact.

