# ADR 0008: Rename to pi-teams

- **Status:** Accepted
- **Follows:** [ADR 0007](./0007-session-bound-agent-teams.md)

## Context

ADR 0007 made the team the unit of organization: one team per session, a fixed lead, named peers, mailboxes and a shared board. The name "sub-agents" describes the superseded delegation model. The package is not yet published, so renaming is a single atomic commit now or a deprecation/migration burden forever after.

## Decision

Rename the product to **pi-teams** and restructure the artifact root in the same commit:

| Was | Becomes |
|---|---|
| Package `@quandev104/pi-subagents` | `@quandev104/pi-teams` |
| Source tree `extension-src/pi-subagents/` | `extension-src/pi-teams/` |
| Settings `subagents.json` | `teams.json` |
| Command `/sub-agents-backend` | `/teams-backend` |
| Env `PI_SUBAGENTS_*` | `PI_TEAMS_*` |
| customType `subagent-notification` | `teammate-notification` |
| Artifact root `.pi/subagents/` | `.pi/teams/` |

Artifact layout under `.pi/teams/`:

```text
.pi/teams/
├── registry.json
├── history.json
├── sessions/<child-id>/        # bootstrap.json, native JSONL, result.md, child.log
└── t/<team-id>/                # config.json (roster), inboxes/<name>/, tasks/<id>.json
```

Team directories are namespaced under `t/` so generated team ids can never collide with the reserved `sessions/` directory or registry files, and the root never reads as `.pi/teams/teams/`.

Unchanged (deliberately): model tool names (`Agent`, `get_subagent_result`, `steer_subagent`) until the T2/T3 teams API replaces them; child protocol v2; integration v3; the `create-agent` skill; Agents Hub UI naming.

## Sequencing

One atomic rename commit lands **before** any 1.1b/T1 implementation, so new code never carries old names. `npm run check` must pass on the rename commit alone. Pre-publish means migration is limited to dev-local state: stale `.pi/subagents/` directories are deleted manually, not migrated.

## Trade-offs

The rename touches package metadata, docs, settings, commands, env vars and artifact paths at once — accepted to avoid two generations of names coexisting in the codebase. Historical ADRs and the porting prompt keep their original paths as records; living docs (README, ARCHITECTURE, CONFIGURATION, INTEGRATION, GLOSSARY) update with the rename.
