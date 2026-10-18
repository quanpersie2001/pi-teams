# Extension integration

## Boundary

First-party Tasks are session-scoped entities managed by pi-teams and remain distinct from `AgentRun` execution attempts. The versioned events RPC documented here remains a retained compatibility surface for third-party consumers; existing default RPC ownership may remain `pi-tasks`. This compatibility default does not provide the legacy extension's standalone task workflow: disable the separate `pi-tasks` extension when using unified Tasks.

## Public transport: version 3

Use `pi.events` channels `subagents:rpc:<op>`. Subscribe to `subagents:rpc:<op>:reply:<requestId>` **before** emitting the request. Each request is a flat object with a non-empty `requestId`; fields are not wrapped in `payload`. The version remains 3: teammate operations and `spawn.options.context` are additive, and `ping` returns an additive `capabilities` list. Existing run-ID `status` and `release` meanings are unchanged. New consumers should check `capabilities` before using the additive operations; older consumers may ignore the extra ping field and continue using legacy operations.

```ts
// Request on subagents:rpc:spawn
{
  requestId: "assign-task-123",
  type: "implementer",
  prompt: "Goal: ... Scope: ... Acceptance: ... Verification: ...",
  options: {
    description: "Implement auth fix",
    isBackground: true,
    maxTurns: 40,
    name: "auth-worker",
    color: "#47a3e8",
    context: "fresh" // optional teammate context: continue | fresh
  },
  owner: { kind: "extension", id: "pi-tasks", ref: "task-123" },
  delivery: "event"
}
```

`options` accepts `description`, `isBackground`, `maxTurns`, `model`, `name`, `color`, and `context` (`continue` or `fresh`). `color`/`context` require `name`; named identity role/name/color are fixed. When context is omitted, an idle retained context continues; new/released identities start fresh. Explicit `continue` requires an idle retained context and fails otherwise. Explicit `fresh` replaces a retained context only after verified idle close, preserving identity and archiving pending messages. The wire flag is **isBackground**, not `background` or `run_in_background`; unknown option keys return an error. Isolation is specialist/master configuration, not an RPC option. Specialist pins win for model/turn limit, while explicit `isBackground` overrides the specialist's default mode. Time budgets are also not RPC options: effective limits come from the specialist definition and `defaultTimeout`/`defaultIdleTimeout` settings.

Spawn/resume await native model/auth admission before allocation. Spawn prefers a usable specialist pin; unavailable primaries fall back through caller model, captured parent and stable authenticated native candidates. Cold resume validates its saved bootstrap and prefers the saved model. Missing/corrupt bootstrap is an error, not new context. No usable model returns `{ success: false, error }` without a run ID/started event. Admissions finishing after session shutdown/replacement also reject without allocation.

Reply envelopes:

```ts
{ success: true, data: ... }
{ success: false, error: "..." }
```

| Operation | Request fields besides `requestId` | Success `data` |
|---|---|---|
| `ping` | optional `version` | `{ version: 3, capabilities?: string[] }` (additive capabilities include teammate lifecycle and spawn context) |
| `spawn` | `type`, `prompt`, optional `options`, `owner`, `delivery` | `{ id, model?, modelFallback? }` |
| `status` | `agentId` | `AgentRunSnapshot` or `null` |
| `steer` | `agentId`, `message` | `{ accepted: true, queued: boolean }` |
| `stop` | `agentId` | `{ stopped: true }` |
| `resume` | `agentId`, `prompt`, optional `isBackground` | `{ agentId }` — NEW run id |
| `release` | `agentId`, optional `cleanupWorktree` | `{ released: true }` (legacy run-resource cleanup; unchanged) |
| `teammate_status` | `name` | teammate snapshot or `null` (`state`, `availability`, `contextAvailable`, optional `currentRunId`, `lastRunId`, `recoveryError`) |
| `teammate_release` | `name` | `{ name, state: "released" }` |
| `teammate_shutdown` | `name` | Stops/cancels work, fences admission, reconciles task attempts, and removes membership only after verified cleanup; failures retain recovery state |

Steer/stop/release await the runtime operation; failures return an error envelope. Steer queues for a `queued`/`starting` run. Stop success acknowledges the abort request, not settlement or process exit; a queued run can stop without launching. Native settlement preserves artifacts and automatically closes owned child/pane resources. Resume opens materialized native JSONL in a new independent child/run; pending cleanup must resolve first. Release requires settled related runs; it is not abort.

Status snapshots contain identity/type/description/status, `backend: "process"`, per-run turns/tools/usage, owner/delivery, start time and optional model/fallback, completion time/duration, session/result/error/recovery and worktree metadata. `teammate_status` is distinct: `state` is `idle|busy|released` (`busy` includes queued work); `availability` plus optional `recoveryError` describes recovery separately. `contextAvailable` is true only when the teammate is idle, its backend and handle are verified by runtime ownership checks, and there is no runtime/roster unavailability; it is not a process-liveness poll/proof. `currentRunId` is the live runtime owner and is absent after release; `lastRunId` identifies the latest assignment artifact and can remain after release. Additive optional `teammateName` carries the teammate address a run was spawned under (`Agent(name:)`); it also appears in lifecycle broadcasts and completion-notification `details`. Additive optional `resultFile` carries the absolute path of the run's full-result artifact (`sessions/<child-id>/result.md`, written by the child at settlement) whenever one exists; the inline `result` stays preview-bounded and `resultTruncated`/`resultOriginalLength` mark truncation. Additive optional `budgetExhausted` (`"timeout"` or `"idle_timeout"`) and `budgetSeconds` appear when a run was stopped by its time budget. Unknown run IDs return `null`. Control credentials/serialized launcher handles are **not** in this public snapshot. Connection loss does not manufacture completion; `recoveryError` exposes preservation/cleanup failures and uncertain-resource receipts remain durable.

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

RPC spawn defaults to `{ kind: "extension", id: "pi-tasks" }` with `delivery: "event"`; this default is retained for compatibility, and explicit valid owner/delivery overrides it. Direct model-facing `Agent` calls get the spawning conversation owner.

| Delivery | Behavior |
|---|---|
| `conversation` | guarded parent-conversation completion |
| `event` | lifecycle only; no duplicate parent completion |
| `both` | lifecycle and guarded conversation completion |
| `none` | caller obtains result/status explicitly |

Conversation delivery checks the spawning session/branch context. In the interactive TUI, a model-facing batch consisting only of successfully admitted background `Agent` launches ends the coordinator's turn (`terminate: true` on each result); completion then triggers a new turn. Mixed tool batches do not force termination. Print/JSON/RPC model-facing Agent calls wait inline instead of relying on a later notification, even if background was requested; public extension RPC spawn policy is unchanged. Delivery subscriptions survive session transitions, but children do not: `/new`, resume and shutdown await teardown before a new team starts. Old control connections are not reattached.

## Completion notification contract (renderer)

Conversation delivery injects a `pi.sendMessage` custom message after a short hold (200 ms by default). If `get_subagent_result` consumed the result before dispatch, the notification is skipped. Background `Agent` calls issued within one Pi turn are joined into one message (the Pi turn boundary finalizes the group; non-Pi hosts may use a 100 ms fallback). Once the first result arrives, the group waits up to 30 seconds for peers, then sends available results; stragglers join for up to 15 seconds. Each member is checked against the live session/branch guard at dispatch, and session switches cancel pending messages. Lifecycle events are still immediate. The runtime ships **no message renderer** — this payload is the stable contract a pi-style companion visual extension may target by registering a renderer for the customType; without one the plain-text `content` displays verbatim.

- **customType:** `teammate-notification` (constant exported as `TEAMMATE_NOTIFICATION_TYPE` from `domain/delivery.ts`)
- **delivery:** `followUp` with `triggerTurn: true` — runtime-authored, lead-only, never sent to teammates
- **content** (structured plain text, canonical presentation):

```text
Teammate <id> finished|failed|stopped (<type>, <duration>)

<preview — result or error text, bounded to 400 chars>
full result: <absolute resultFile path>   ← last line, only when resultFile exists
```

A batch notification contains one section per unconsumed run (`@name (completed|failed|stopped)`, preview, and optional `full result:` path); it remains **one** custom message / follow-up turn. Existing top-level `details` identify the first run; grouped messages add `details.others` with each remaining run's `agentId`, optional `teammateName`/`color`, `status`, `outcome` and optional `resultFile`.

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

`send_message` accepts `{ target, message }`. A teammate addresses another teammate or the lead; the lead addresses teammates only and cannot target `"lead"` (`Unknown teammate: lead`). The lead and named teammates receive the tool; children do not receive `Agent`, result retrieval or parent lifecycle tools. Targets must resolve to the current team's roster and must not be released or unavailable. Busy includes queued work; an eligible busy recipient can have a message queued for its watcher. There is no broadcast primitive.

Each participant has `.pi/teams/t/<team-id>/inboxes/<name>/`. A message is a single JSON file written with an exclusive temporary file and atomic rename (0700 directories, 0600 files). A per-team HMAC key is generated with the roster and distributed through the authenticated, owner-only bootstrap. Verification rejects malformed, tampered or wrong-recipient entries; quarantine preserves invalid entries and logs the reason.

Bridges watch their own mailbox and inject automatically: an eligible idle teammate starts a native assignment, while a busy teammate receives steering. The tool receipt reports `queued`, not delivery; internal queued/delivered/consumed receipts are not a guarantee of injection. Assignment metadata—not peer content—crosses the parent control socket to obtain the same `maxConcurrent` capacity as an `Agent` invocation. Native `agent_settled` remains the settlement authority. An omitted context reuses an idle retained native context and starts fresh for new/released identities. Explicit `continue` requires idle retained context; explicit `fresh` closes a verified-idle retained child and opens a new session under the same fixed role/name/color. A released teammate starts fresh by default; explicit continue fails. Cold transcript resume of a named run requires explicit teammate release and is a separate new run. Shutdown removes membership only after verified cleanup; a later same-name member must be a new identity. Shutdown/task reconciliation, membership identity, native child lifecycle and rendered TUI shutdown progress have automated smoke coverage. Windows-specific peer process/ACL verification remains pending. Release/fresh replacement archive pending inbox files (tagged with the reset reason) for only that teammate before the new context can receive them; failures do not report a settled lifecycle change. No polling is introduced.

The lead receives runtime-authored `teammate-message` custom messages (`deliverAs: "steer"`, `triggerTurn: true`, provenance in `details`). Its mailbox file is consumed only after the matching native `message_end` event proves conversation injection. Child files are consumed after native prompt/steer admission. Queued/delivered/consumed receipts remain internal; model output reports only queuing, not an approval or execution guarantee.

The main TUI composer offers live teammates in `@` completion. `@name message` is intercepted before normal submission and written directly to that mailbox; unresolved names retain inline-mention behavior. Routing never takes input from an overlay, panel navigation or autocomplete menu. Failed writes preserve the editor text without forwarding it to the lead.

Messages carry no permission authority. The shared team key authenticates team-originated content, not a permission grant or isolation between mutually untrusted native processes. Each child's native permission surface remains authoritative. Session teardown stops peers; persisted mailboxes never restart them. `/agents teammate-status <name>` and `/agents teammate-release <name>` mirror the lead tools. `/agents teammate-shutdown <name>` is registered for membership shutdown; `/agents release <run-id> [--worktree]` remains run-resource cleanup. Release preserves identity; shutdown removes membership only after verified cleanup and does not imply task completion. Peer tools are host-wired when `peers.enabled` is true (default false); discovery/send/activity and receiver-controlled inbound policy are integrated. Independent SDK sessions exercise signed peer delivery and approval; production-loader registration and rendered TUI hold/approve/refuse plus busy-child shutdown have automated smoke coverage, not human manual verification. Windows peer ACL/CurrentUserOnly ingress implementation is present and fails closed when prerequisites are unavailable; native Windows verification remains pending. Peer sessions have no lifecycle or shared-task authority.

## Unified Tasks

First-party Tasks are scoped to the active session/team. The public tools are:

| Tool | Purpose |
|---|---|
| `tasks_create` | Create a task with typed acceptance criteria, scope, constraints, expected output, context/references and dependencies |
| `tasks_list` / `tasks_get` | Read tasks, derived blockers and attempt history |
| `tasks_update` | Edit pending requirements; claim, release, request review, or explicitly accept completion |
| `tasks_cancel` | Cancel an eligible pending task |
| `tasks_execute` | Run an unblocked pending or claimed task through AgentManager and record an attempt |
| `tasks_output` / `tasks_stop` | Read latest attempt output or stop its running execution |

Tasks contain `spec`, `context`, `outcome`, requirement revisions/snapshots, optional root `executionPlan`, and `attempts`. `executionPlan` has `{ type, name?, color?, model?, maxTurns? }`; it may be set only through `tasks_create`/`tasks_update`, not `tasks_execute`, and is frozen into the attempt requirement snapshot. On a pending task, `tasks_update { executionPlan: null }` clears the plan and increments `requirementRevision`; an empty `expectedOutput` string is a valid spec patch. Attempt statuses (`running`, `completed`, `stopped`, `failed`) are distinct from task statuses (`pending`, `in_progress`, `in_review`, `completed`, `cancelled`). A completed attempt does not complete its task: owner/coordinator acceptance is explicit. Stopping an attempt is not completion. Review-requested tasks must enter review before acceptance. Task writes atomically use schema version 2 with `requirementRevision`, `spec`, `context` and `attempts` present. Reads accept v2 only when those fields and task/attempt/snapshot structures validate. Unversioned legacy and explicit v1 records normalize missing revision to 1 and missing spec/context/attempts to empty values while preserving supplied valid fields; their next write upgrades to v2. Other or malformed schema versions are rejected, not downgraded.

The board is session-scoped. Nested settings `tasks: { autoCascade: false, reminders: false }` are opt-in and default off. With auto-cascade enabled, the service snapshots current task statuses on startup (no replay of those completed tasks) and observes new accepted transitions to `completed` from local board events and the shared task-directory watcher, including newly discovered completed rows and completions by peer board services. Completed task IDs/codes are coalesced into a microtask; pending tasks with an execution plan are dispatched only when at least one dependency matches those completed references and all blockers are clear. UI and automation watchers share a ref-counted filesystem watcher; disposing either observer unsubscribes only that observer. Dispatch uses normal TaskExecutionService/AgentManager admission. Plans are per-task and the requirement revision observed at dispatch is passed into reservation. Automation also supplies `expectedStatus: "pending"`; `reserveExecution` validates both preconditions atomically before mutating the task, preventing a stale pending decision from overwriting a concurrent manual claim. If the status or requirement revision no longer matches (including a concurrent plan change/clear such as `type`, `name`, or `model`), the automatic launch is skipped before spawn without owner/attempt mutation, and its deduplication entry is cleared, without immediate rescheduling, including when the mismatch occurs while waiting to reserve. This pending-status precondition is specific to automation; manual `tasks_execute` behavior is unchanged. Each planned task is launched at most once per service. Typed reservation-lock conflicts may be retried asynchronously at 100/250/500 ms before launch; spawn failures are not retried. Retry exhaustion also clears deduplication so a later completion transition can trigger another eligibility check. Disposal cancels queued work and in-flight reservation retries; TaskExecutionService checks cancellation after reservation and rolls it back before spawning. Session switch/shutdown disables reminders and disposes automation before freezing task-execution admissions and shutting down children. Reminders are lead-only: every four lead `turn_start` calls, reset by any `tasks_*` `tool_result`, a hidden transient context message summarizes relevant lead-unassigned/lead-assigned pending, lead-owned in-progress, and review-requested in-review tasks. It is bounded to 10 items / 1,700 serialized JSON characters and omitted when there are no relevant tasks. There is no child reminder. No task implementation content was copied from external sources.

Board operations serialize `board.lock` (`pid:uuid`, exclusive `wx`) unlink/reclaim through a sibling `board.lock.mutation` directory. Only the marker creator removes it; the marker is never automatically reclaimed. If stranded after a crash, stop every old and new task-board writer, then manually remove it; until then operations fail closed. Stale reclaim rechecks the exact token, validates the PID with `kill(pid, 0)` requiring `ESRCH`, then unlinks and reacquires under the marker; races fail closed. Owner release compares tokens under the marker and asynchronously retries contention at 10/20/40/80/160/320 ms (no busy-wait); after exhaustion it logs and leaves the lock. A surviving owner token remains blocking until release/process exit, after which PID reclaim can proceed unless the marker was stranded. The public events RPC remains compatibility for third-party consumers; its default owner may still be `pi-tasks`. The Tasks Hub implementation and focused automated UI tests are verified; interactive manual smoke testing has not been performed. See [ADR 0009](./decisions/0009-unified-session-tasks.md).
