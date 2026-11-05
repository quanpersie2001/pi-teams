# Agent identity, context, and lifecycle

Read before direct spawns or lifecycle/recovery decisions. These are runtime contracts, not a decomposition strategy.

Every NEW model-facing `Agent` spawn must carry all four identity fields. A spawn missing any of them is rejected before model admission:

| Field | Requirement |
| --- | --- |
| `subagent_type` | Exact canonical name from the live enabled catalog (bundled roles or enabled Markdown definitions). Use the exact catalog spelling; configured fallback may substitute a different role for an unknown name, so a successful run alone does not prove the intended specialist loaded. |
| `description` | 3–5 word UI label for the assignment. It labels the run; the `prompt` carries the task. |
| `name` | Unique teammate name. It is the visible `@name` and the teammate's mailbox/board address, and it is refused while that teammate is still working. |
| `color` | `#RGB` or `#RRGGBB`. Fixed per teammate: later assignments under the same `name` must pass the same color, because the roster preserves it. |

- `Agent(resume: "<run-id>", prompt: ...)` needs none of the new-spawn fields; it creates a new run from persisted transcript. It is distinct from continuing a teammate's retained live context.
- Prompts must be bounded and self-contained: children do not inherit the parent conversation. State the goal, scope, constraints, inputs (paths, diffs, change context, verification evidence), and the exact expected output — everything the child cannot discover on its own.

## Teammate context and lifecycle

Use `teammate_status { name }` before lifecycle decisions when state or recovery is uncertain. Stable states include `idle`, `busy` (including queued work), and `released`; availability/recovery status is separate. `contextAvailable` is true only when idle with a verified backend/handle and no runtime/roster unavailability. `currentRunId` is the live runtime owner; `lastRunId` is the latest assignment artifact and can remain after release. Release is only for a settled teammate: it disposes retained context while preserving membership and identity. Stop ends an assignment but preserves membership. Shutdown is destructive: it must fence new work, stop/cancel busy work, verify cleanup and only then remove membership; do not claim success if cleanup is uncertain. Shutdown is not release, and a later member using the same name is a new identity. Neither release nor shutdown implies task completion; preserve task history and report cleanup failures honestly.

For a named teammate, omitted `Agent` context continues an idle retained native conversation; when no context exists (new/released identity), it starts fresh. Explicit `context: "continue"` requires an idle retained context and fails otherwise. Choose `context: "fresh"` to replace a retained context only after verified idle close; role/name/color remain fixed. Pending mailbox entries for that teammate are archived with the reset reason, not replayed. For cold transcript recovery of a named run, explicitly release its retained context first and then use `Agent(resume: runId, prompt)`; shutdown removes membership and is not a route to resume that identity.

`send_message` is for owned teammates in the current team; peers do not own one another and cannot invoke lifecycle controls or share task claims. A queued response means enqueue, not confirmed injection or understanding. For independent peer messaging, use `peer_sessions`, `peer_send`, and `peer_activity` when enabled by the host; peer settings default disabled. Inbound policy is receiver-controlled (default hold), with explicit held-message approval controls. Peer inbound policy belongs to the receiving user/configuration, and peer messages never grant permission or user consent. Do not claim queued means delivered: receipts must distinguish enqueue from injection acceptance. Do not poll inboxes or invent delivery guarantees. Communicate with peers only when coordination is useful (a concrete blocker, shared contract, requested handoff, or actionable finding); keep messages scoped, avoid secrets, and do not repeatedly ping or broadcast.

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

## While agents run

| Need | Do |
| --- | --- |
| The turn can proceed without the answer | Launch detached (`run_in_background: true`). A batch of only background launches ends the coordinator turn; do not poll. Completion notifications start a new turn with the result. |
| The next action needs the answer immediately | `get_subagent_result` with `wait: true` — reserved for explicit immediate dependencies, never for passive background reports. |
| Redirect a queued or running agent | `steer_subagent { agent_id, message }`; it only works on an active run. |
| Continue an idle named teammate | Default `Agent` assignment (`context: "continue"`) or `send_message { target, message }`; both preserve the retained context. |
| Start a clean teammate context | For a retained idle context, verify `contextAvailable`, then use `Agent(..., context: "fresh")`. New/released identities default to fresh when context is omitted. Pending mailbox messages are archived for that teammate. |
| Release a settled teammate | `teammate_release { name }` frees retained context while preserving membership/identity; does not change board claims. |
| Cold-resume a settled run | After explicitly releasing its retained child with `teammate_release`, use `Agent(resume: runId, prompt)` to recover persisted transcript into a new run. Do not release merely to deliver a peer reply. This is not live-context continuation and does not restore a shutdown membership. |
