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
- **Board task** — a `.pi/teams/t/<team-id>/tasks/<id>.json` coordination item (`pending | in_progress | completed` + deps) claimed via `team_task_*` tools. Deliberately distinct from **Task** (capital T): the durable entity owned by `pi-tasks`.
- **Idle notification** — the runtime-authored `teammate-notification` push to the lead when a teammate finishes (turn settles): preview + `resultFile` pointer. Lead-only.

## Addresses and identifiers

- **Specialist type** — definition name; selects the role at spawn (`subagent_type`).
- **Teammate name** — the team-unique address: mailbox path segment, `send_message` target, `@name` composer mention, board actor. Not the definition name.
- **Run id** — `AgentRun` identifier (`Task-7`); `get_subagent_result`/resume key.

## Verbs

- **Spawn** — admit and launch a run. **Steer** — mid-run guidance to a child. **Settle** — reach the native terminal state (`agent_settled` owns settlement). **Teardown** — session-end shutdown of all children (graceful + preserve, ADR 0007). **Cold resume** — reopen a settled run's persisted JSONL in a new child; an artifact action, never re-adoption.

## Legacy terms

- **Subagent** — legacy umbrella for this extension's children. New prose uses *teammate* (teams mode) or *specialist run* (direct mode). The product is named **pi-teams** ([ADR 0008](./decisions/0008-rename-to-pi-teams.md)): package, `teams.json`, `/teams-backend`, `PI_TEAMS_*` and `.pi/teams/` all carry the new name. The word survives only in model tool names (`Agent`, `get_subagent_result`, `steer_subagent`) until the T2/T3 teams API replaces them.
