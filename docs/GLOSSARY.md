# Glossary

Canonical vocabulary for docs, ADRs, tools and UI copy. One entity, four layers — do not mix layers:

| Layer | Term | Meaning |
|---|---|---|
| Process | **child** | The independent OS process (HerdR/tmux TUI or headless worker) executing work. Runtime internals (`pi/`, ARCHITECTURE). |
| Definition | **specialist** | A Markdown agent definition (`name`, tools, model…). Configuration surface. "Specialist type" is the definition's canonical name. |
| Invocation | **run** (`AgentRun`) | One admitted invocation: `queued → running → settled`. The durable record with result, usage and budgets. |
| Team identity | **teammate** | A named participant of a team (ADR 0007). Persists across assignments until session end; addressable by name. |

## Roles

- **Parent** — the runtime/extension process owning children. Use in technical docs (`pi/` layer, ARCHITECTURE). The parent process itself never changes.
- **Lead** — the session acting as the team's fixed coordinator. Use in team semantics, model-facing copy and UI. Same physical session as the parent's conversation; "lead" names its team role.
- **Peer** — any mailbox participant in messaging context: teammate or lead. "Peer messaging" = agent-authored messages between participants (HMAC-signed).

## Team artifacts (ADR 0007)

- **Team** — session-scoped set: lead + teammates + roster + mailboxes + board. One team per session.
- **Roster** — `.pi/teams/t/<team-id>/config.json` members list; how participants discover each other.
- **Mailbox** — per-participant message directory `.pi/teams/t/<team-id>/inboxes/<name>/`, one file per message. The replacement for the removed in-memory "scoped inbox" — do not say "inbox" in new prose.
- **Task** — the session-scoped unified work entity managed by `tasks_*`; carries typed spec/context/outcome and attempts. Distinct from **AgentRun**, which executes an attempt and has its own lifecycle.
- **Idle notification** — the runtime-authored `teammate-notification` push to the lead when a teammate finishes (turn settles): preview + `resultFile` pointer. Lead-only.

## Addresses and identifiers

- **Specialist type** — definition name; selects the role at spawn (`subagent_type`).
- **Teammate name** — the team-unique address: mailbox path segment, `send_message` target, `@name` composer mention, board actor. Not the definition name. Role/name/color are fixed for the identity.
- **Teammate lifecycle state** — current stable states include `idle | busy | released`; busy includes queued work. State describes the retained teammate lifecycle, not the run-result status. Shutdown is an operation that removes membership, not a retained state.
- **Teammate availability** — `available | unavailable` plus optional `recoveryError`, separate from lifecycle state. Legacy roster entries without availability are treated as available. `contextAvailable` is true only when idle, backend/handle are verified by runtime ownership checks, and there is no runtime/roster unavailability; it is not a process-liveness poll/proof.
- **Continue context** — named-teammate assignment reusing an idle retained child/session. With omitted policy it is the default only when idle context exists; explicit `continue` without one fails.
- **Fresh context** — default for a new/released teammate without a retained child, or an explicit replacement of a verified-idle child with a new session under the same identity; pending mailbox messages for that teammate are archived with a reset reason, not replayed.
- **Live run id** (`currentRunId`) — runtime-owned current execution for a teammate; absent after release. Distinct from `lastRunId`, which identifies the latest assignment artifact and may persist after release.
- **Cold resume** — persisted transcript recovery into a new run after explicit release of a retained teammate context. Distinct from live context continuation.
- **Queued mailbox receipt** — confirmation that a signed message file was enqueued, not that native injection/delivery completed.
- **Run id** — `AgentRun` identifier (`Task-7`); `get_subagent_result`/resume key.

## Verbs

- **Spawn** — admit and launch a run. **Steer** — mid-run guidance to a child. **Settle** — reach the native terminal state (`agent_settled` owns settlement). **Stop** — end an assignment while retaining teammate membership. **Release teammate** — dispose of a settled teammate's retained live context while preserving membership and identity; does not change board claims. **Shutdown teammate** — stop/cancel work, verify cleanup, then remove live membership; preserve run history/transcripts and do not imply task completion. **Session shutdown** — teardown children when the owning session ends. **Cold resume** — reopen a settled run's persisted JSONL in a new child; an artifact action, never re-adoption.

## Legacy terms

- **Subagent** — legacy umbrella for this extension's children. New prose uses *teammate* (teams mode) or *specialist run* (direct mode). The product is named **pi-teams** ([ADR 0008](./decisions/0008-rename-to-pi-teams.md)): package, `teams.json`, `/teams-backend`, `PI_TEAMS_*` and `.pi/teams/` all carry the new name. The word survives only in model tool names (`Agent`, `get_subagent_result`, `steer_subagent`) until the T2/T3 teams API replaces them.
