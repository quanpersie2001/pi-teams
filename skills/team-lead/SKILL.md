---
name: team-lead
description: Use this skill when the user asks to delegate work to teammates, spawn or coordinate parallel specialist agents, work through unified session Tasks, or when Agent or tasks_* tool calls fail with validation or ownership errors.
---

# Lead a Pi specialist team

Coordinate pi-teams specialists from the session lead: delegate bounded assignments to named teammates, run independent work in parallel, use the unified session-scoped Tasks board, and recover cleanly when `Agent` or `tasks_*` calls fail. This skill orchestrates existing specialists; creating or refining a specialist definition is the `create-agent` skill's job.

## Spawn checklist

Every NEW model-facing `Agent` spawn must carry all four identity fields. A spawn missing any of them is rejected before model admission:

| Field | Requirement |
| --- | --- |
| `subagent_type` | Exact canonical name from the live enabled catalog (bundled roles or enabled Markdown definitions). A near-miss name is not repaired for you. |
| `description` | 3–5 word UI label for the assignment. It labels the run; the `prompt` carries the task. |
| `name` | Unique teammate name. It is the visible `@name` and the teammate's mailbox/board address, and it is refused while that teammate is still working. |
| `color` | `#RGB` or `#RRGGBB`. Fixed per teammate: later assignments under the same `name` must pass the same color, because the roster preserves it. |

- `Agent(resume: "<run-id>", prompt: ...)` needs none of the new-spawn fields; it creates a new run from persisted transcript. It is distinct from continuing a teammate's retained live context.
- Prompts must be bounded and self-contained: children do not inherit the parent conversation. State the goal, scope, constraints, inputs (paths, diffs, change context, verification evidence), and the exact expected output — everything the child cannot discover on its own.

## Teammate context and lifecycle

Use `teammate_status { name }` before lifecycle decisions when state or recovery is uncertain. State is `idle`, `busy` (including queued work), `released`, or `retired`; availability/recovery status is separate. `contextAvailable` is true only when idle with a verified backend/handle and no runtime/roster unavailability. `currentRunId` is the live runtime owner; `lastRunId` is the latest assignment artifact and can remain after release. A busy teammate must settle before release or retirement. `teammate_release` and `teammate_retire` are idempotent once settled and do not change task-board claims; retirement prevents implicit resurrection. Report lifecycle cleanup failures honestly and use the status/recovery error to decide whether to retry or recover a transcript.

For a named teammate, omitted `Agent` context continues an idle retained native conversation; when no context exists (new/released identity), it starts fresh. Explicit `context: "continue"` requires an idle retained context and fails otherwise. Choose `context: "fresh"` to replace a retained context only after verified idle close; role/name/color remain fixed. Pending mailbox entries for that teammate are archived with the reset reason, not replayed. For cold transcript recovery of a named run, explicitly release its retained context first and then use `Agent(resume: runId, prompt)`; retired names cannot be resumed or reassigned as teammates.

`send_message` is available to eligible idle/busy participants. A queued response means mailbox enqueue, not confirmed delivery. Released, retired, or unavailable recipients are rejected. Do not poll inboxes or invent delivery guarantees; native watchers deliver automatically. A successful teammate release/retire does not release or complete any task-board claim.

Complete spawn example (a read-only lookup delegated to a named teammate):

```json
{
	"subagent_type": "explore",
	"description": "Locate auth entrypoints",
	"name": "auth-scout",
	"color": "#47a3e8",
	"prompt": "Locate the authentication entrypoints in this repository. Report each exact file path with the function or route it exposes. Read-only: do not edit files or run checks. Stop after reporting.",
	"run_in_background": true
}
```

## Unified Tasks lifecycle

Tasks are session-scoped work records, separate from `AgentRun` executions. Use `tasks_create` with a concise title and, where useful, acceptance criteria, scope, constraints, expected output, context/references and dependencies. `tasks_list` and `tasks_get` expose derived blockers, outcomes and attempt history.

Claim with `tasks_update { id, status: "in_progress" }`; blockers must be clear. Only edit requirements while pending. The owner can release its claim to pending or request review when review was requested. Execute an unblocked pending or claimed task with `tasks_execute`; a non-coordinator executing a claimed task must be its owner. Inspect with `tasks_output` and stop an active attempt with `tasks_stop`. Attempt completion is not task completion. The owner (or lead/coordinator) must explicitly accept via `tasks_update { id, status: "completed", outcome }`; review-requested tasks must first enter `in_review`. Stopping an attempt does not complete or cancel its task. `tasks_cancel` is separate and only cancels eligible pending tasks without dependents.

Dependencies are supplied using task IDs/short codes; incomplete prerequisites block claiming. Optional automation is controlled by `tasks.autoCascade` and `tasks.reminders` (both off by default). `executionPlan: { type, name?, color?, model?, maxTurns? }` is set on task create/update, not `tasks_execute`; `executionPlan: null` clears it on a pending task and increments its requirement revision. An empty expected output is a valid spec patch. When enabled, cascade runs only after newly observed accepted completion (including peer board-service updates; existing completed tasks are not replayed at startup), only for pending planned tasks whose dependencies intersect completed task IDs/codes and whose blockers are all clear. It uses normal task execution admission and launches each planned task at most once per service. Automation reserves with both the observed requirement revision and `expectedStatus: "pending"`, validated atomically before mutation; this prevents stale automation from overwriting a concurrent manual claim. A precondition mismatch (including a plan change/clear such as `type`, `name`, or `model`, even while waiting to reserve) skips the launch before spawn, makes no owner/attempt mutation, and clears dedupe without immediate rescheduling. This pending-status precondition is automation-only; manual `tasks_execute` is unchanged. Only typed reservation-lock conflicts receive bounded asynchronous retries (100/250/500 ms) before launch; spawn failures are not retried, and retry exhaustion clears dedupe for a later completion trigger. Disposal cancels queued work/retries and post-reservation cancellation rolls back before spawn. Lead reminders are bounded and appear every four lead turns, reset by `tasks_*` tool results; they do not nag when no relevant tasks exist and are not sent to child agents. Tasks remain session-scoped; cross-session scheduling is not provided. The versioned events RPC is retained compatibility for third-party consumers, not the first-party task workflow. Disable the separate legacy `pi-tasks` extension when switching to unified Tasks to avoid two task workflows; do not assume it is the unified board or that its standalone workflow is supported. The Tasks Hub shows colored terminal/pending attempt history, retained teammate names, run/result-file pointers, outcomes, artifacts, issues, prerequisites and dependents. Historical stopped/aborted/error runs with `recoveryError` remain unverified and fail closed rather than being reconciled as settled task attempts. Interactive manual TUI smoke testing is pending.

## While agents run

| Need | Do |
| --- | --- |
| The turn can proceed without the answer | Launch detached (`run_in_background: true`). A batch of only background launches ends the coordinator turn; do not poll. Completion notifications start a new turn with the result. |
| The next action needs the answer immediately | `get_subagent_result` with `wait: true` — reserved for explicit immediate dependencies, never for passive background reports. |
| Redirect a queued or running agent | `steer_subagent { agent_id, message }`; it only works on an active run. |
| Continue an idle named teammate | Default `Agent` assignment (`context: "continue"`) or `send_message { target, message }`; both preserve the retained context. |
| Start a clean teammate context | For a retained idle context, verify `contextAvailable`, then use `Agent(..., context: "fresh")`. New/released identities default to fresh when context is omitted. Pending mailbox messages are archived for that teammate. |
| Release or retire a teammate | `teammate_release { name }` frees a settled context; `teammate_retire { name }` additionally prevents reuse. Neither changes board claims. |
| Cold-resume a settled run | After explicitly releasing its retained child with `teammate_release` (and only if the teammate is not retired), use `Agent(resume: runId, prompt)` to recover persisted transcript into a new run. Do not release merely to deliver a peer reply. This is not live-context continuation; retired identities cannot be resumed/reassigned as teammates. |

## Failure → recovery

Match the exact runtime error, apply the fix, retry. `<task>` stands for the task label as rendered by the board (e.g. `T4 "Fourth"`) and `<owner>` for the claiming teammate's name:

| Runtime error | Fix |
| --- | --- |
| `A new Agent spawn requires subagent_type and description. Resume needs only resume and prompt.` | The new spawn is missing `subagent_type` or `description`. Include all four required fields (`subagent_type`, `description`, `name`, `color`) and retry; for a resume, pass only `resume` and `prompt`. |
| `A new Agent spawn requires both name and color (#RGB or #RRGGBB). Resume inherits its existing identity.` | Add the unique teammate `name` and its `color`. Reuse the roster color for an existing teammate. |
| `Requested model "<ref>" matches multiple native Pi models (ambiguous; specify provider/modelId): <candidates>` | The model passed in the spawn invocation is ambiguous; the error lists the sorted candidates. Re-spawn with the canonical `provider/modelId` chosen from them, or narrow the request. An unregistered invocation reference fails instead of falling back with a distinct message (`Requested model "<ref>" is not registered in the native Pi model runtime.`) that names the reference and lists no candidates. A model pinned in a definition/agent-file is unaffected and still falls back with a recorded note. Run `list_models` before spawning to resolve a reference; set `strictModelAdmission: false` to opt out and fall back to the caller/definition/parent model with a recorded `Model fallback: ...` note. |

## End-to-end coordination recipe

1. Plan work as session Tasks in dependency order.
2. `tasks_create` each task with acceptance criteria and prerequisites.
3. Spawn one bounded, self-contained teammate per independent task — all four spawn fields. Omitted context continues only an idle retained teammate; use explicit `context: "fresh"` when a retained idle identity needs a clean context.
4. Teammates claim their tasks (`in_progress`), do the work, and complete them; only the claimant can finish a task.
5. The lead collects results through the completion notifications that start later turns, then verifies, follows up with `send_message`, or files follow-up tasks.
