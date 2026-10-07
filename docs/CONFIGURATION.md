# Configuration

## 1. Agent definitions

A definition describes a specialist, not a Task. Put task priority, dependencies, acceptance criteria and retry policy in the consumer's assignment prompt, not the agent file.

Bundled specialists:

| Name | Scope | Tools | Model / thinking pins |
|---|---|---|---|
| `general-purpose` | Bounded multi-step research and implementation | Default built-in toolset | None |
| `explore` | Fast local file/symbol lookup, not review or open-ended auditing | `read`, `bash`, `grep`, `find`, `ls` | Model unpinned; `off` thinking |
| `scout` | External docs/API research with retrieved source citations | `read`, `bash`, `grep`, `find`, `ls` | Model unpinned; `high` thinking |
| `reviewer` | Independent correctness/security/regression review of recent named changes | `read`, `grep`, `find`, `ls` | Model unpinned; `max` thinking |

`scout` uses stdout-only `curl` through `bash` to fetch supplied URLs and source links; it has no web-search or browser-rendering tool. `reviewer` cannot run Git or tests: provide the diff/base context and verification evidence in the handoff. Shell-enabled specialists are instructed not to mutate state, but are not sandboxed.

`general-purpose` appends to the native coding prompt; the other bundled roles replace it. All defer background mode and turn limits to configuration unless overridden, and default to shared-workspace execution. Bundled agents do not pin models: model selection follows the invocation or captured parent, with normal admission/fallback. Custom definition model pins remain authoritative when usable.

Use the packaged [`create-agent` skill](../skills/create-agent/SKILL.md) via `/skill:create-agent <requirements>` to author a supported definition. New/changed files load at `session_start`: start a new session or restart Pi, and confirm the canonical type appears before dispatching. The example below intentionally overrides the bundled `reviewer` when saved under that name:

```md
---
name: reviewer
description: Read-only code review specialist
tools: read, grep, find, ls
thinking: low
max_turns: 20
prompt_mode: replace
run_in_background: true
isolation: off
---

Inspect the repository without editing. Return concise findings with evidence.
```

Omit `model` to use the invocation model or captured parent model. To pin a model, use a reference from the native Pi model registry, preferably its canonical `provider/id`.

## 2. Frontmatter

| Field | Contract |
|---|---|
| `name` | Specialist dispatch identity; omitted/empty uses the filename stem. `:` is reserved. |
| `description` | Model/UI description; defaults to the name. |
| `tools` | Built-in allowlist, CSV or array. Omitted uses the default toolset; empty/`none` means no built-ins; `*`/`all` expands built-ins. |
| `model` | Preferred model pin/fuzzy reference; omitted leaves model selection to invocation/parent. |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; actual availability depends on the native model. |
| `max_turns` | Nonnegative integer. Explicit `0` pins unlimited; omitted defers to invocation, then `defaultMaxTurns`. |
| `timeout` | Optional run budget in seconds: a positive whole safe integer that bounds the entire run. Omitted defers to settings unless the invocation overrides (invocation > definition > settings). Malformed values fail the definition load, not an unlimited fallback. |
| `idle_timeout` | Optional idle budget in seconds: a positive whole safe integer measured without child output. Same precedence and load-failure behavior as `timeout`. `idle-timeout` is accepted as a frontmatter alias; specifying both spellings fails the load. |
| `prompt_mode` | `replace` (default) or `append`. |
| `run_in_background` | Default mode for this specialist; omitted uses `backgroundByDefault`. An explicit invocation mode wins. |
| `isolation` | `off` (default) or `worktree`; the latter also requires the master switch. |
| `enabled` | Defaults to `true`; `false` excludes the specialist from dispatch/discovery. |

Built-ins are `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Children also receive scoped messaging tools, but never parent orchestration tools. The allowlist is not an OS security sandbox.

Not implemented: `memory`, `allowed_subagents`, `schedule`, join modes.

## 3. Agent source precedence

```text
bundled defaults
    < ~/.pi/agent/agents/*.md
    < <configCwd>/.agents/agents/*.md
    < <configCwd>/.pi/agents/*.md
```

Later sources override the same specialist name. The global path follows Pi's agent directory if it is overridden. `configCwd` is the original parent working directory, not an isolated execution checkout. Reloading definitions does not mutate an already admitted run's resolved snapshot.

## 4. Invocation precedence

For model, thinking, tools and turn limit:

```text
pinned specialist definition
    > invocation override
    > applicable operational setting
    > built-in default
```

Public `Agent`/spawn RPC expose only their documented inputs; internal invocation fields are not automatically public options. Background mode is separate: explicit invocation mode overrides the specialist default. Description can also be supplied per invocation.

Model admission first tries the resolved primary. If it cannot resolve a native model/auth, it tries the caller model ignored by a pin, captured parent model, then authenticated native candidates in stable `provider/id` order. With neither a pin nor invocation model, the parent model is primary. No usable model rejects before run ID, queue slot, worktree or child/pane creation.

Admission uses the native child's `ModelRuntime`, `models.json` and `auth.json` in Pi's agent directory. Catalog refresh is offline; native auth may refresh OAuth. This does **not** check provider availability, remote key acceptance, billing or quota. Launch rechecks after queueing and the child guards dispatch. `model` and optional `modelFallback` in replies/status/lifecycle/history describe the actual selection.

Isolation is configuration-only. Enable `worktreeIsolation` and set the specialist's `isolation: worktree`; with the master switch off, it runs in the shared workspace. Neither `Agent` nor spawn RPC accepts an isolation override. `Agent` also does not accept instance `name` or `inherit_context`; supply needed context in `prompt`.

### Time budgets

`timeout` and `idle_timeout` (Agent parameters; frontmatter uses `timeout`/`idle_timeout` with `idle-timeout` accepted as an alias, but never both spellings) are optional hard limits in whole seconds. Precedence is deliberately the reverse of model/turn pinning:

```text
invocation override (timeout, idle_timeout)
    > specialist definition frontmatter
    > defaultTimeout / defaultIdleTimeout settings
    > unlimited (off)
```

Semantics:

- `timeout` bounds the entire run on wall clock; `idle_timeout` bounds the span without child output. Both timers start immediately before backend launch (or resume), not at admission, queueing or worktree preparation. If both expire in the same check, the wall-clock `timeout` wins.
- Only arrivals of the child's own output reset the idle clock: a new assistant message (or a newer revision of one currently streaming) and completed tool results. Partial tool updates, tool-call starts, empty assistant upserts, steering, user/inbox messages, state refreshes and usage updates do not. The clock is re-derived from transcript item timestamps after launch or reconnect, so long-running tools need a larger `idle_timeout` (or none).
- Expiry first triggers the cooperative abort with a 2-second grace window for the child to settle on the ordinary path. Past that window, enforcement force-terminates the owned child process group through a verified-identity backend path: a graceful signal, then a forced kill if the owned group survives. Termination is verified — the run never settles as stopped until the process group's exit is proven. A successful enforcement settles the run exactly like an ordinary stop, keeping `budgetExhausted`/`budgetSeconds` and the partial session/transcript. Refused enforcement (foreign/quarantined child identity, multiplexer transports without an owned PID group, unverifiable termination) is a visible failure: the run stays active with a recovery error and retained registry receipt, never a fabricated outcome. Ordinary user stop keeps abort-only semantics. There are no soft warnings or wrap-up grace for budgets (unlike turn limits).
- On expiry the parent-facing result identifies the exhausted budget (`timeout` or `idle_timeout`) and its limit in seconds, and warns that partial work may be incomplete. Durable history preserves the same record.
- Effective budgets and activity timestamps persist with registry/history metadata. Explicit cold continuation re-applies the source limits on fresh clocks, including unlimited; invocation overrides win per field. Transient authenticated connection recovery within the owning session retains its clocks. Startup never restores live child clocks or processes.

## 5. Operational settings

```text
~/.pi/agent/teams.json       global defaults (Pi agent directory)
<configCwd>/.pi/teams.json  project overrides
```

Defaults:

```json
{
  "maxConcurrent": 4,
  "defaultMaxTurns": 30,
  "defaultTimeout": 0,
  "defaultIdleTimeout": 0,
  "graceTurns": 3,
  "backgroundByDefault": true,
  "worktreeIsolation": false,
  "rememberAgents": true,
  "strictAgentFiles": false,
  "fallbackSubagent": "none",
  "agentPanel": true,
  "backend": "auto"
}
```

| Setting | Behavior |
|---|---|
| `maxConcurrent` | One active-run capacity for foreground and background; excess runs queue. Floored/clamped to 1–1024. |
| `defaultMaxTurns` | Default turn limit when not pinned/requested; `0` means unlimited. Floored/clamped to >=0. |
| `defaultTimeout` | Default whole-run budget in seconds for runs without an invocation/definition budget; `0` means unlimited (default). Negative values clamp to `0`; positive non-integers are invalid and fall back to `0`; values above 2147483 clamp to that cap. |
| `defaultIdleTimeout` | Default idle budget in seconds under the same sanitization rules as `defaultTimeout`. |
| `graceTurns` | Wrap-up turns after soft-limit steering before hard abort; floored/clamped to >=0. A natural final answer is completion even at the limit. |
| `backgroundByDefault` | Default mode for definitions that omit `run_in_background`; foreground still uses an independent child. |
| `worktreeIsolation` | Enables managed-worktree capability; default shared workspace. |
| `rememberAgents` | Preserves settled run/session history for explicit cold continuation. It never re-adopts live children. Startup archives stale owned active rows as stopped with recovery metadata; foreign-owner rows remain untouched. |
| `strictAgentFiles` | Strict mode fails loading on malformed files or validated invalid fields, naming the source path. Lenient mode skips unreadable/unparseable files, but corrects invalid fields with warnings while retaining the specialist. |
| `fallbackSubagent` | Specialist name to use when requested type is unknown/disabled/ambiguous; `none` rejects. Empty/mistyped values default to `none`. |
| `agentPanel` | Enables inline panel, Hub and remote child focus; no effect on lifecycle or automatic cleanup. |
| `backend` | Multiplexer mode: `auto` (default) detects HerdR → tmux with a headless fallback; `headless` never attaches a multiplexer. Explicit `herdr`/`tmux` forcing is env-only. `/teams-backend [auto\|headless]` switches the mode for the current session (future launches only). |

Both settings files are read at each `session_start`, merged per key (`project > global`), then sanitized. Missing/unreadable files contribute nothing; corrupt JSON warns and contributes nothing. Unknown keys are dropped and mistyped values use built-in defaults. Project values are not sanitized independently before overriding global values. The runtime only reads these files; operators own edits.

## 6. Backend selection

Selection precedence for new launches:

```text
/teams-backend <mode>   (runtime, current session; auto | headless)
    > PI_TEAMS_BACKEND   (env; auto | herdr | tmux | headless)
    > settings "backend"    (project > global; auto | headless)
    > auto
```

`auto` picks the first available launcher — HerdR, then tmux, then an independent headless process — so explicit herdr/tmux forcing is normally unnecessary. `/teams-backend` without arguments reports the current mode, what auto detects, and any active env override; switching affects only future launches (started children keep their launcher) and resets at the next session start. A forced unavailable launcher fails explicitly; launch failure does not silently switch implementation: Headless uses native SDK in its own child process, never the parent.

Requires Node >=22.19, Unix sockets and Pi peers >=1.0.4 <1.1.0. Interactive launchers use the installed peer's CLI, not global `pi` from PATH. Headless supports the same parent Hub/focus without terminal attachment.

## 7. Persistence artifacts

Artifacts use the nearest `.pi/` from the original configuration cwd (or its `.pi/` when none exists), not the execution worktree:

```text
.pi/teams/registry.json
.pi/teams/history.json
.pi/teams/sessions/<child-id>/bootstrap.json
.pi/teams/sessions/<child-id>/*.jsonl
```

Child ID differs from run ID. Cold continuation validates the saved bootstrap, prefers its saved model and opens the original native JSONL in a new child/run. Missing/corrupt bootstrap is an error, not a fallback to new context. Only a materialized JSONL is advertised as resumable history.

After durable finalization, native settlement automatically closes the verified child/pane. Pending/failed cleanup must resolve before resume. Bootstrap/registry contain authentication metadata: private directories use `0700`, control/bootstrap/registry files use `0600`, and sockets use short private OS-temp paths. Live state/transcript/completion use RPC/events, never JSONL polling; JSONL supplies closed history/recovery.

Worktree completion preserves commits/dirty changes and retains the checkout. Review, test and manually cherry-pick before `/agents release <id> --worktree`. Release refuses dirty/unpreserved changes and retains preserved branches. A released/missing worktree is not silently recreated by resume.

Inbox and consumed-message history are bounded parent-process memory, not durable registry data. Closed-child messages wait for cold continuation; they do not launch children. Reload/restart loses inbox state. Focus `/model` and `/thinking` alter only the live child, not Main's settings.

## 8. Owner and delivery request

An extension can explicitly assign ownership and notification routing:

```ts
{
  owner: { kind: "extension", id: "pi-tasks", ref: "task-123" },
  delivery: "event"
}
```

Direct model-facing `Agent` calls receive conversation ownership and `delivery: "conversation"`. See [Integration](./INTEGRATION.md) for request fields and delivery policies, and [Architecture](./ARCHITECTURE.md) for cleanup/security invariants.
