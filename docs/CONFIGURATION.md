# Configuration

This guide covers specialist definitions, invocation behavior, and operational settings. For runtime boundaries see [Architecture](./ARCHITECTURE.md); for public request fields and delivery see [Integration](./INTEGRATION.md); for user-facing basics see [README](../README.md).

## 1. Agent definitions

Definitions describe reusable specialist roles; Tasks describe work requirements. Bundled agents are documented in the [README](../README.md#bundled-specialists).

Create a Markdown file with YAML frontmatter in a supported agent directory:

```md
---
name: reviewer
description: Read-only code reviewer
tools: read, grep, find, ls
thinking: low
max_turns: 20
prompt_mode: replace
---
Review the requested changes. Return concise findings with evidence.
```

Omit `model` to use the invocation or parent model; use canonical `provider/modelId` to pin one.

## 2. Frontmatter

| Field | Default / meaning |
|---|---|
| `name` | Filename stem; dispatch identity. `:` is reserved. |
| `description` | Name if omitted; shown to model/UI. |
| `tools` | Default built-in toolset if omitted; CSV or array. Empty/`none` disables built-ins; `*`/`all` enables all built-ins. |
| `model` | Unpinned if omitted. A definition pin is preferred but can fall back if unavailable. |
| `thinking` | Optional: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; model availability varies. |
| `max_turns` | Omitted: invocation value, then `defaultMaxTurns`; explicit `0`: unlimited. Nonnegative integer. |
| `timeout` | Optional positive whole seconds; wall-clock run limit. |
| `idle_timeout` | Optional positive whole seconds without child output. `idle-timeout` is an alias; do not specify both. |
| `prompt_mode` | `replace` (default) or `append`. |
| `run_in_background` | Omitted: `backgroundByDefault`; explicit invocation mode wins. |
| `isolation` | `off` (default) or `worktree`; requires `worktreeIsolation: true`. |
| `enabled` | `true`; `false` removes the definition from dispatch/discovery. |

Built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Children also get scoped messaging tools, not parent orchestration tools; allowlists are not OS sandboxes. Unsupported fields include `memory`, `allowed_subagents`, `schedule`, and join modes.

## 3. Agent source precedence

Definitions load in ascending precedence; later files replace a same-named definition:

```text
bundled defaults
< ~/.pi/agent/agents/*.md
< <configCwd>/.agents/agents/*.md
< <configCwd>/.pi/agents/*.md
```

The global location follows Pi's configured agent directory. `configCwd` is the original parent working directory (not an isolated worktree). Existing admitted runs retain their resolved definition after reload. New or changed files load at `session_start`.

## 4. Invocation precedence

For model, thinking, tools, and turn limit, a definition pin wins over invocation values; otherwise invocation values win over applicable settings/defaults. Background mode is separate: invocation mode wins over the definition default.

An invocation model (such as `Agent`'s `model`) must resolve uniquely when `strictModelAdmission` is enabled (default): ambiguous or unregistered references fail admission. This strict rule applies to invocation requests, **not** definition model pins. Pins and models without usable authentication may fall back to the caller/parent model or authenticated candidates. Use `provider/modelId` to avoid ambiguous bare names.

Time budgets use the opposite precedence:

```text
invocation timeout / idle_timeout > definition frontmatter > defaultTimeout / defaultIdleTimeout
```

Settings budgets default to `0` (unlimited); `0` is valid only for settings. Invocation and frontmatter limits must be positive whole seconds. `timeout` bounds the run; `idle_timeout` measures time without child output. See [Integration](./INTEGRATION.md) for available invocation fields and [Architecture](./ARCHITECTURE.md) for lifecycle details.

Isolation is configuration-only: enable `worktreeIsolation` and set definition `isolation: worktree`. There is no per-invocation isolation override. Worktrees preserve changes and are not automatically integrated; inspect and review before release. Agent sessions use native history, but do not inherit the parent's conversation context automatically—include necessary context in the prompt. See [Integration](./INTEGRATION.md) for named continuation/context controls.

## 5. Operational settings

Global settings: `~/.pi/agent/teams.json` (Pi agent directory). Project settings: `<configCwd>/.pi/teams.json`. Files are merged per key, project over global; nested `tasks` and `peers` keys also merge individually. Missing/unreadable files are ignored; invalid JSON warns and is ignored. The merged result is sanitized, with unsupported or mistyped values falling back to defaults. These files are read-only to the runtime.

Starter configuration:

```json
{
  "maxConcurrent": 4,
  "defaultMaxTurns": 30,
  "defaultTimeout": 0,
  "backgroundByDefault": true,
  "worktreeIsolation": false,
  "backend": "auto"
}
```

| Setting | Default | Meaning |
|---|---:|---|
| `tasks.autoCascade` | `false` | Automatically launch eligible planned dependent Tasks after completion. |
| `tasks.reminders` | `false` | Add periodic task summaries to lead context. |
| `peers.enabled` | `false` | Opt in to peer messaging. Windows peer support requires `pwsh` (PowerShell 7+) for the named-pipe helper, a protected per-user ACL, and .NET `CurrentUserOnly`; unsupported hosts fail closed and native Windows verification remains pending. |
| `peers.scope` | `project` | `project` or `all`; project setting may narrow scope but cannot broaden it beyond global scope. |
| `peers.policy` | `hold` | Receiver approval policy: `hold`, `accept`, or `refuse`. Project settings cannot override global/user policy. Held messages require user approval; queued receipt is not proof of acceptance, and missing acknowledgement is ambiguous. |
| `maxConcurrent` | `4` | Shared foreground/background active-run capacity; clamped to 1–1024. |
| `defaultMaxTurns` | `30` | Default turn limit; `0` means unlimited. |
| `defaultTimeout` | `0` | Default wall-clock seconds; `0` means unlimited. |
| `defaultIdleTimeout` | `0` | Default idle seconds; `0` means unlimited. |
| `graceTurns` | `3` | Turns allowed for wrap-up after turn-limit steering. |
| `backgroundByDefault` | `true` | Default for definitions omitting `run_in_background`. |
| `worktreeIsolation` | `false` | Enables worktree isolation for definitions that request it. |
| `rememberAgents` | `true` | Retain settled history for explicit continuation; does not restore live children. |
| `strictAgentFiles` | `false` | Strictly fail on malformed/invalid definition files instead of warning and correcting/skipping. |
| `strictModelAdmission` | `true` | Enforce unique registration for invocation model requests; definition pins still may fall back. |
| `fallbackSubagent` | `none` | Specialist used for unknown/disabled/ambiguous requests; `none` rejects. |
| `agentPanel` | `true` | Master switch for Team UI; `false` disables broader UI. |
| `agentInlinePanel` | `true` | Startup default for inline Agents panel; does not persist session `/agents panel` changes. |
| `backend` | `auto` | `auto` detects a viewer; `headless` never attaches a multiplexer. |

Numeric settings are clamped where appropriate; default time budgets accept nonnegative whole seconds, with zero unlimited. See [README](../README.md#everyday-controls) for backend overview.

## 6. Backend selection

For new children, selection precedence is:

```text
/teams-backend (current session) > PI_TEAMS_BACKEND > settings backend > auto
```

The command and setting accept `auto` or `headless`; the environment variable additionally accepts `herdr` or `tmux` to force a viewer. `auto` selects HerdR, then tmux, then headless with no viewer. Native Windows runs headless (no multiplexer viewer). Peer messaging is separately opt-in and fails closed unless `pwsh` (PowerShell 7+) and .NET security prerequisites are available; native Windows verification remains pending. Every assignment executes in an independent native SDK worker, regardless of presentation. Session command changes affect future children; existing children retain their selected mode. See [Architecture](./ARCHITECTURE.md#9-launcher-selection) for implementation and platform details.

## 7. Persistence artifacts

Persistent registry, history, and child session artifacts live under `.pi/teams/` nearest the original configuration working directory, not the execution worktree. Settled history may be explicitly continued using its native session; startup does not re-adopt live child processes. See [Integration](./INTEGRATION.md) for messaging and [Architecture](./ARCHITECTURE.md#10-durable-registry-and-recovery) for recovery and cleanup invariants.

Worktree isolation retains the checkout and its changes. Review, test, and manually integrate them before releasing the worktree; do not assume automatic merge or cleanup. A released/missing worktree is not recreated on continuation.

## 8. Owner and delivery request

Extensions may explicitly assign ownership and delivery routing:

```ts
{ owner: { kind: "extension", id: "pi-tasks", ref: "task-123" }, delivery: "event" }
```

Direct model-facing `Agent` calls use conversation ownership and delivery by default. See [Integration](./INTEGRATION.md) for request fields and delivery policies.
