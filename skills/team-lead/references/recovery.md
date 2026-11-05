# Recovery and replanning

Use when a worker is blocked, drifting, failing, missing evidence, or returning stale results. Read [Lifecycle](lifecycle.md) before stopping, replacing, resetting, or resuming teammates, and [Tasks](tasks.md) before board transitions.

## Diagnose before retrying

| Signal | Response |
| --- | --- |
| Missing input or inaccessible artifact | Supply the specific missing decision/evidence, not the whole parent transcript. |
| Context/turn exhaustion or repeatedly expanding scope | Preserve artifacts, split remaining work into smaller verifiable units, and issue consolidated briefs. Do not just raise the limit. |
| Conflicting results | Inspect the disputed source or run a discriminating check; do not decide by majority vote. |
| Scope drift | Stop or steer active work with explicit boundaries; separate useful out-of-scope findings into follow-ups. |
| Repeated fixes fail the same criterion | Revisit the invariant/premise and replan; do not keep patching the same assumption. |
| Transient connection/tool failure | Inspect actual run/cleanup state before retrying. Never assume an error means no child or file changes exist. |
| Model admission failure | Resolve a valid canonical model with `list_models`; do not invent names or silently change a pinned role's behavior. |
| Missing verification receipt | Request the named check/artifact once; after another miss, retain a gap rather than infer a pass. |
| Stale/late result | Compare against the current artifact identity. Preserve unique findings, but do not apply an obsolete patch or reuse a stale verdict blindly. |

Default to at most two recovery attempts per blocked unit after its initial attempt. A review fix round counts when it retries that blocked unit; normal successful dependency waves do not. If the unit still fails, stop the loop, reduce/replan scope, and report unresolved evidence. Replanning is not a way to hide or repeatedly reset the same failure budget. Ask the user for a genuine product/permission decision or a blocker that cannot safely be resolved, not routine retry mechanics.

## Replace safely and preserve useful state

Before a replacement writer starts, request stop of the old assignment and verify runtime settlement and cleanup/recovery status. For tracked work, use `tasks_stop`; if cleanup is uncertain, do not transfer its write ownership. `teammate_shutdown` removes membership only after verified cleanup; it is not a shortcut around uncertainty.

Capture the original goal, narrowed remaining scope, accepted decisions, current artifact/worktree/branch, checks already run, failed hypotheses, and next action. Give a replacement the relevant consolidated brief, not an interrupt chain or full transcript. Account for the old run and reconcile any late result against the new state.

Continue an idle context for the same coherent assignment when useful live state would be costly to move. For unrelated work or bloated context, use a new teammate or verified-idle `Agent(..., context: "fresh")`. The same name keeps its role and color; `tasks_execute` has no context override. Cold `Agent(resume: runId, prompt)` restores persisted transcript into a new run, requires explicit retained-context release for a named teammate, and does not restore shutdown membership.

## Common invocation errors

- Missing `subagent_type`/`description` or `name`/`color`: provide all four for a new model-facing Agent spawn. Resume inherits identity.
- Unknown specialist: use the live canonical catalog; a configured fallback is not evidence that the requested definition loaded.
- Ambiguous model: use the exact `provider/modelId` from the error candidates or `list_models`. Definition pins remain primary; consult the effective definition before changing an invocation.
- Busy or unavailable teammate: check `teammate_status`, including recovery status. Do not force reuse, release active work, or confuse `lastRunId` with a live context.
- Task transition rejected: inspect task status, owner, blockers, and active attempts. Settle execution before release/review/accept, and edit requirements only while pending. Do not bypass a review requirement to make the call succeed.
