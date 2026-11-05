# Unified Tasks workflow

Read before tracked execution. Task records, execution attempts, and retained teammate contexts are different entities. The board is session-scoped, not a cross-session scheduler. Disable the separate legacy `pi-tasks` extension to avoid two workflows.

## Tracked execution: recommended for dependent work

1. `tasks_create` bounded units with acceptance criteria, scope, constraints, expected output, references, and prerequisite IDs/codes. Use `reviewRequested: true` when acceptance needs an explicit review stage. Do not launch an umbrella task in addition to its executable slices.
2. `tasks_execute { id, type, name?, color?, model?, maxTurns?, additionalContext? }` on an unblocked pending or claimed task. It reserves ownership, builds the worker packet, spawns through the existing runtime, and binds the attempt. A non-coordinator executing a claimed task must own it and cannot assign another teammate.
3. The execution worker returns artifacts/checks/issues. Its injected protocol says not to create nested agents or manage this task. Do not also tell it to claim or complete the task. `tasks_execute` has no `context` or per-call isolation field; choose a new teammate name for an independent context instead of inventing parameters.
4. Inspect completion evidence with `tasks_output { id }` after notification, and read the artifact. Do not poll; reserve `wait: true` for an explicit immediate dependency. `tasks_list`/`tasks_get` show blockers and attempt history.
5. If review was requested, after execution settles the owner or lead sets `tasks_update { id, status: "in_review" }`. This does not launch a reviewer. The lead must obtain review evidence and coordinate fixes before acceptance.
6. After the applicable checks, the owner or lead accepts with `tasks_update { id, status: "completed", outcome }`. In this coordination workflow the lead owns the acceptance decision. Completion of an attempt alone never completes the task.

A prerequisite blocks dependent execution until accepted. Define slice-level completion accurately: code-ready with local checks can unblock integration, but does not prove whole-feature correctness. Put combined verification/review in a later bounded task whose acceptance means the overall outcome is ready. Do not mark an implementation task globally reviewed merely to unblock its reviewer.

For fixes to a task already `in_review`, release to pending after settlement, update pending requirements if needed, and execute again. Alternatively create a separate fix task with the relevant evidence, without creating a dependency cycle. Return through `in_review` before accepting a review-requested task.

## Manual board work: separate from tracked attempts

Direct work or a deliberate `Agent` assignment can use `tasks_update { id, status: "in_progress" }` to claim a pending unblocked task. Pass the task ID and claim/report instructions explicitly if a worker manages it. An ordinary Agent call does not bind an execution attempt; do not describe it as tracked execution.

Do not mix manual claim instructions into a `tasks_execute` brief. For review-gated work, prefer tracked execution with lead acceptance rather than asking a worker to self-approve.

## Transition rules

| Operation | Rule |
| --- | --- |
| Claim | Pending, prerequisites accepted; claimant becomes owner. |
| Edit requirements/dependencies | Pending only; release settled work before replanning. |
| Release to pending | Current owner or lead, no active execution. |
| Submit `in_review` | Current owner or lead, from `in_progress`, review requested, no active execution. |
| Accept `completed` | Owner or lead, from `in_progress` or `in_review`, no active execution. Review-requested tasks must be `in_review`. |
| Stop attempt | `tasks_stop`; does not accept, release, or cancel the task. |
| Cancel | `tasks_cancel`; pending only, no active execution or dependents. |

Failed/stopped attempts need an explicit outcome for manual acceptance. That runtime escape hatch is not permission to label failed checks passed. Inspect remaining criteria and preserve the failure/gap in the outcome. Unverified recovery/cleanup is a blocker, not proof of settlement.

## Optional automation

`tasks.autoCascade` and `tasks.reminders` are off by default. Do not assume dependents launch automatically. `executionPlan: { type, name?, color?, model?, maxTurns? }` belongs on task create/update, not `tasks_execute`; clear it with `executionPlan: null` while pending.

When enabled, cascade reacts to newly accepted completions and launches eligible pending planned dependents through normal admission. It does not replay existing completions at startup. Revision/status preconditions prevent stale automation from overwriting a manual claim or changed plan. It retries typed reservation conflicts with bounded backoff, not arbitrary worker failures. Re-check the board before a manual launch when automation is enabled; task completion should reflect actual evidence, never be used merely to trigger scheduling.
