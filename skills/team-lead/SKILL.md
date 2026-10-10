---
name: team-lead
description: Use this skill when the user asks to delegate work to teammates, spawn or coordinate parallel specialist agents, work through the shared team task board, or when Agent or team_task tool calls fail with validation or ownership errors.
---

# Lead a Pi specialist team

Coordinate pi-teams specialists from the session lead: delegate bounded assignments to named teammates, run independent work in parallel, drive the durable shared task board, and recover cleanly when `Agent` or `team_task` calls fail. This skill orchestrates existing specialists; creating or refining a specialist definition is the `create-agent` skill's job.

## Spawn checklist

Every NEW model-facing `Agent` spawn must carry all four identity fields. A spawn missing any of them is rejected before model admission:

| Field | Requirement |
| --- | --- |
| `subagent_type` | Exact canonical name from the live enabled catalog (bundled roles or enabled Markdown definitions). A near-miss name is not repaired for you. |
| `description` | 3–5 word UI label for the assignment. It labels the run; the `prompt` carries the task. |
| `name` | Unique teammate name. It is the visible `@name` and the teammate's mailbox/board address, and it is refused while that teammate is still working. |
| `color` | `#RGB` or `#RRGGBB`. Fixed per teammate: later assignments under the same `name` must pass the same color, because the roster preserves it. |

- `Agent(resume: "<run-id>", prompt: ...)` needs none of the new-spawn fields; it inherits the original identity.
- Prompts must be bounded and self-contained: children do not inherit the parent conversation. State the goal, scope, constraints, inputs (paths, diffs, change context, verification evidence), and the exact expected output — everything the child cannot discover on its own.

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

## Task board lifecycle

The shared board moves tasks through `pending → in_progress → completed`; `cancelled` is a second terminal state, reachable only from `pending`:

| Transition | Call | Rule |
| --- | --- | --- |
| `pending → in_progress` | `team_task_update { id, status: "in_progress" }` | The claimant becomes the owner. Refused while any dependency is incomplete. |
| `in_progress → completed` | `team_task_update { id, status: "completed" }` | Owner only. Terminal — never reverted. |
| `in_progress → pending` | `team_task_update { id, status: "pending" }` | Owner only (releasing the claim). |
| `pending → cancelled` | `team_task_cancel { id }` | Only while pending — a claimed task must be released first. Refused while other tasks depend on it. Terminal. |
| `completed`/`cancelled → anything` | — | Impossible. Create a new task instead. |

- A task must be claimed before it can be completed.
- Only the owner can release or complete a claimed task.
- Edit a pending task's description with `team_task_edit { id, description }`; only pending tasks can be edited.
- Retire a mistaken task with `team_task_cancel` while it is pending — release the claim first if it is claimed. A task that other tasks depend on cannot be cancelled; complete it, or cancel the dependents first.
- Create prerequisite tasks first and pass their returned IDs in `dependencies`; unknown IDs are rejected at creation. A task with incomplete dependencies cannot be claimed until every prerequisite completes — inspect blockers with `team_task_list` or `team_task_get`.

## While agents run

| Need | Do |
| --- | --- |
| The turn can proceed without the answer | Launch detached (`run_in_background: true`). A batch of only background launches ends the coordinator turn; do not poll. Completion notifications start a new turn with the result. |
| The next action needs the answer immediately | `get_subagent_result` with `wait: true` — reserved for explicit immediate dependencies, never for passive background reports. |
| Redirect a queued or running agent | `steer_subagent { agent_id, message }`; it only works on an active run. |
| Continue an idle named teammate | `send_message { target, message }` to it, or a new `Agent` assignment under the same name/color. |
| Cold-resume a settled run | `Agent(resume: ...)` only after the retained child is explicitly released. Do not release merely to deliver a peer reply — `send_message` reaches an idle teammate directly. |

## Failure → recovery

Match the exact runtime error, apply the fix, retry. `<task>` stands for the task label as rendered by the board (e.g. `T4 "Fourth"`) and `<owner>` for the claiming teammate's name:

| Runtime error | Fix |
| --- | --- |
| `A new Agent spawn requires subagent_type and description. Resume needs only resume and prompt.` | The new spawn is missing `subagent_type` or `description`. Include all four required fields (`subagent_type`, `description`, `name`, `color`) and retry; for a resume, pass only `resume` and `prompt`. |
| `A new Agent spawn requires both name and color (#RGB or #RRGGBB). Resume inherits its existing identity.` | Add the unique teammate `name` and its `color`. Reuse the roster color for an existing teammate. |
| `Task is pending: claim it first with status "in_progress", then complete it` | The task was never claimed. Claim it with `team_task_update { id, status: "in_progress" }`, then complete it. |
| `<task> is in_progress - only the owner can complete/release it; owned by <owner>` | Only that owner may complete or release the claim. Route the completion to them, or have them release it back to `pending` first. |
| `<task> is in_progress, owned by @<owner> - only the owner can update it` | Another teammate already claimed this task. Pick a different task, or wait for them to release or complete it. |
| `<task> is blocked by: <ids>` | Prerequisites are incomplete. Complete those tasks first; the blocker clears as soon as every prerequisite completes. |
| `<task> is completed|cancelled - terminal, no further updates` | A terminal task accepts no further updates. Create a new task instead of editing the old one. |
| `Task cancellation requires team_task_cancel` | Use `team_task_cancel { id }` instead of `team_task_update` with `status: "cancelled"`. |
| `Only pending tasks can be cancelled: <task> is <status>` | The task is claimed or already terminal. Release the claim back to `pending` with `team_task_update { id, status: "pending" }`, then cancel. |
| `Cannot cancel <task> - it is a dependency of: <ids>` | Other tasks depend on it. Cancel or complete the dependents first, then retry the cancel. |
| `Requested model "<ref>" matches multiple native Pi models (ambiguous; specify provider/modelId): <candidates>` | The model passed in the spawn invocation is ambiguous; the error lists the sorted candidates. Re-spawn with the canonical `provider/modelId` chosen from them, or narrow the request. An unregistered invocation reference fails instead of falling back with a distinct message (`Requested model "<ref>" is not registered in the native Pi model runtime.`) that names the reference and lists no candidates. A model pinned in a definition/agent-file is unaffected and still falls back with a recorded note. Run `list_models` before spawning to resolve a reference; set `strictModelAdmission: false` to opt out and fall back to the caller/definition/parent model with a recorded `Model fallback: ...` note. |

## End-to-end coordination recipe

1. Plan the work as tasks in dependency order (prerequisites first).
2. `team_task_create` each task, passing prerequisite tasks' returned IDs in `dependencies`.
3. Spawn one bounded, self-contained teammate per independent task — all four spawn fields, no shared implicit context.
4. Teammates claim their tasks (`in_progress`), do the work, and complete them; only the claimant can finish a task.
5. The lead collects results through the completion notifications that start later turns, then verifies, follows up with `send_message`, or files follow-up tasks.
