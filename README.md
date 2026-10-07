# @quandev104/pi-teams

[![Pi compatibility](https://img.shields.io/badge/Pi-%3E%3D1.0.4%20%3C1.1.0-8b5cf6)](https://pi.dev)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

> Specialist agents in independent Pi processes — with live steering, native session history, and a shared Agents Hub.

Delegate implementation, local exploration, external research, and code review without hosting child `AgentSession`s in the parent. Each agent runs in its own native Pi TUI or headless process.

[Install](#install) · [Quick start](#quick-start) · [Bundled agents](#bundled-agents) · [Configuration](#configuration) · [Documentation](#documentation) · [Related extensions](#related-extensions)

---

## Features

- **Independent execution** — native Pi TUIs in HerdR or tmux, with an independent headless worker when no terminal launcher is available.
- **Live control** — launch, inspect, steer, and stop runs over an authenticated, owner-only Unix socket. Live state never depends on terminal input or JSONL polling.
- **Opt-in time budgets** — optional `timeout`/`idle_timeout` limits in seconds hard-stop runaway children; the idle clock refreshes on child output only, and enforcement stops when the parent session shuts down.
- **One Agents Hub** — Main and child conversations share navigation, while keeping drafts, scroll positions, and tool expansion independent.
- **Focused specialists** — four bundled roles, layered Markdown definitions, native `@agent` autocomplete, and a packaged `create-agent` skill.
- **Recoverable sessions** — durable native JSONL history supports cold continuation in a new child process; settled children close after durable finalization.
- **Session-owned runs** — a run belongs to the conversation that launched it: other sessions in the same project never see, adopt, or control it. Teammates are session-bound ([ADR 0007](docs/decisions/0007-session-bound-agent-teams.md)): session end/switch/shutdown tears every child down (abort request → bounded grace → verified force-kill), children detect a dead parent through control-socket loss and stop themselves with an annotated partial `result.md`, and startup never re-adopts leftover active rows — they archive `stopped` with an honest note and go through verified disposal. Settled or verified-dead foreign rows are archived to shared history for explicit cold `resume` by run ID.
- **Workspace choice** — shared files by default, or opt-in Git worktrees with retained commits/checkouts and explicit cleanup.
- **Extension integration** — signed peer mailboxes and public events RPC for consumers that own scheduling, retries, and review policy.

---

## Install

**Requires:** Node.js ≥22.19, Pi peers ≥1.0.4 and <1.1.0, and Unix sockets. HerdR/tmux are optional; headless children still support the parent Hub and child view.

From this checkout:

```bash
npm ci
pi install .
```

Use `pi install --local .` for a project-scoped installation; Pi loads project packages after project trust is granted. Start a new Pi session after installation.

To try the complete package without persisting an installation:

```bash
npm run dev:pi
```

Load the **package**, not only its extension file, to discover the included skill. The local installation is the currently verified distribution path; the npm package is not yet published.

---

## Quick start

1. Start Pi with the package loaded.
2. Ask Pi to delegate a bounded task, for example:

   ```text
   Use explore to locate the authentication entrypoints and report exact file paths.
   ```

3. Open `/agents` or press **Alt+G** to inspect runs. Enter a child view to read its transcript or send a steering message.
4. Return with **Esc**. Leaving a child view does not abort the run.

Type `@` in Main and press **Tab** to insert an agent mention. Autocomplete includes enabled custom definitions alongside file suggestions; inserting a mention does not itself launch a child.

The model launches agents through `Agent`. Example of a self-contained assignment:

```json
{
  "subagent_type": "explore",
  "description": "Check Pi compatibility",
  "prompt": "Read package.json. Report the supported Pi version range. Do not edit files.",
  "run_in_background": true
}
```

Children do not inherit the parent's conversation automatically. For change reviews, include the actual diff/base context and verification evidence in the assignment prompt.

---

## Bundled agents

| Agent | Best for | Tools | Thinking |
|---|---|---|---|
| `general-purpose` | Bounded multi-step research and implementation | Default built-in toolset | Invocation / parent |
| `explore` | Fast local file and symbol lookup | `read`, `bash`, `grep`, `find`, `ls` | `off` |
| `scout` | External docs/API research with retrieved-source citations | `read`, `bash`, `grep`, `find`, `ls` | `high` |
| `reviewer` | Independent correctness, security, and regression review | `read`, `grep`, `find`, `ls` | `max` |

**No bundled agent pins a model.** Selection uses the invocation model or captured parent, with normal admission/fallback. Thinking availability depends on the native model. Custom definitions can override bundled names and pin their own model/thinking.

`scout` fetches supplied URLs/source links using stdout-only `curl`; it has no web-search or browser-rendering tool. `reviewer` has no shell and cannot run Git or tests. Shell-enabled research roles are instructed not to mutate state, but their tool allowlists are **not an OS sandbox**.

---

## Controls and tools

### Native UI

| Input | Action |
|---|---|
| `/agents` or **Alt+G** | Open the Main/children Agents Hub |
| `/teams-backend [auto\|headless]` | Show or switch the launcher mode for this session (session-start value comes from settings/env) |
| **Left twice within 500 ms** at Main's document start or from bottom navigation | Open Hub without losing the draft |
| **Down** from empty Main | Enter the visible inline bottom navigation |
| **Arrows / Enter** in navigation | Select / view a child |
| **Enter** in the child composer | Steer an active child or cold-resume a settled session |
| **Esc** in a child view | Return without aborting |
| **Alt+Left/Right / Alt+Up** with an empty child composer | Switch siblings / return to Main |
| **Ctrl+X twice / Alt+O** with an empty child composer | Abort / open a verified live native pane |

Native menus, dialogs, and ordinary cursor movement retain their arrows. The document-start gestures (double Left, Down from an empty prompt) work alongside editor-styling extensions whose custom editor still preserves native `Editor` semantics (such as `pi-style`); with an opaque custom editor they defer and `/agents`/Alt+G remain the entry points. Child `/model <provider/id>` and `/thinking <level>` commands affect only the focused live child. Unsupported commands preserve the draft and report an error; `/compact` is intentionally unavailable because native compaction aborts the active turn.

HerdR/tmux keep Main on the left and stack at most three children per right-hand column. New columns open as needed, and children reuse the earliest vacancy without compacting survivors. Layout changes preserve focus and unrelated panes; unverified ownership/geometry is rejected.

### Model-facing tools

| Tool | Purpose |
|---|---|
| `Agent` | Launch a specialist with an explicit assignment — optionally `name:` it a teammate of this session's team (`@name` becomes its messaging/board address; a name is refused while that teammate is still working, and a settled name means a new assignment for the same teammate) — or resume a settled run by `resume` run ID |
| `get_subagent_result` | Inspect a run's status and read its full result — durable, re-readable from the run's `result.md` artifact on every call; `wait: true` blocks until the run settles |
| `steer_subagent` | Send guidance to an active run |
| `send_message` | Send `{ target: "teammate-name" \| "lead", message: "..." }` through a signed peer mailbox |

Named teammates stay alive while idle. A new assignment under the same name reuses its native child and specialist role; mailbox messages start an assignment when idle or steer the active turn. The bridge watches its inbox automatically—models never poll. In the main composer, `@name message` routes directly to a live teammate; unresolved mentions retain normal inline behavior.

Mailboxes use one owner-only, HMAC-signed file per message under `.pi/teams/t/<team-id>/inboxes/<name>/`. Invalid entries are quarantined with a warning. Messages are untrusted content and cannot approve permissions. Files are consumed only after native injection; they survive runtime reload as artifacts, but never revive a stopped session's children.

---

## Configuration

No custom agent files are required. Runtime defaults include **4 concurrent runs**, **30 turns + 3 wrap-up turns**, background execution, shared workspaces, and remembered sessions.

Override operational settings in `.pi/teams.json` or globally in `~/.pi/agent/teams.json`:

```json
{
  "maxConcurrent": 4,
  "defaultMaxTurns": 30,
  "defaultTimeout": 0,
  "defaultIdleTimeout": 0,
  "graceTurns": 3,
  "backgroundByDefault": true,
  "worktreeIsolation": false,
  "backend": "auto"
}
```

`backend` selects the multiplexer mode: `auto` (default) detects HerdR → tmux and falls back to headless; `headless` never attaches a multiplexer. Launcher precedence for new launches: `/teams-backend <mode>` (current session) > `PI_TEAMS_BACKEND` > settings `backend` > `auto`. The env variable does not override a session switch, and switching affects only new launches — running children keep their launcher. Auto tries HerdR, then tmux, then an independent headless child. A forced unavailable launcher fails explicitly.

Global paths follow Pi's agent-directory override. Settings merge per key with project values winning. Agent definitions resolve in this order:

```text
bundled < ~/.pi/agent/agents/*.md < .agents/agents/*.md < .pi/agents/*.md
```

Later definitions replace the same canonical name. Definition pins win over invocation overrides for model, thinking, tools, and turn limit; explicit invocation background mode wins over the definition's default. Definitions/settings load at `session_start`; already admitted runs keep their resolved snapshot.

### Time budgets

Optional hard limits in whole seconds, off by default — settings use `0` for unlimited; frontmatter and `Agent` overrides are opt-in positive values:

| Surface | Fields | Contract |
|---|---|---|
| Settings | `defaultTimeout`, `defaultIdleTimeout` | Whole seconds; `0` = unlimited (default). |
| Frontmatter | `timeout`, `idle_timeout` | Positive whole seconds; legacy `idle-timeout` alias accepted, but both spellings together fail. |
| `Agent` invocation | `timeout`, `idle_timeout` | Positive whole seconds; `0` is invalid here. Malformed values reject the launch. |

Precedence is the reverse of model/turn pinning: invocation > definition > settings. Settings clamp to 2147483 seconds; frontmatter and `Agent` values must be 1–2147483 and out-of-range values are rejected, not clamped.

```json
{
  "subagent_type": "explore",
  "description": "Audit config loading with a budget",
  "prompt": "Trace how .pi/teams.json merges over the built-in defaults. Report every key and where it is read. Do not edit files.",
  "run_in_background": true,
  "timeout": 900,
  "idle_timeout": 180
}
```

A specialist definition can carry the same limits. Save as `.pi/agents/budgeted-explore.md` — definitions are self-contained and do not inherit another role's instructions:

```md
---
name: budgeted-explore
description: Read-only exploration with hard time limits
tools: read, bash, grep, find, ls
timeout: 900
idle_timeout: 180
---

Locate the requested files/symbols by reading and searching only. Report exact paths with brief evidence. Do not edit files; the run is hard-stopped once a budget expires.
```

Malformed frontmatter budgets reject the file instead of silently becoming unlimited: lenient mode skips the specialist with a warning; strict mode (`strictAgentFiles`) fails the load. See [Configuration](docs/CONFIGURATION.md) for the complete sanitization and schema.

Behavior:

- Clocks start immediately before the actual launch or resume — not during admission, queueing, or worktree preparation.
- Only child output refreshes the idle clock: new or streaming assistant messages and completed tool results. Steering, inbox/status refreshes, tool starts, and partial tool updates do not; one long tool call can legitimately hit the idle limit.
- Expiry aborts the child; if it has not settled after 2 seconds, the parent terminates the owned child through the launcher — headless escalates `SIGTERM` → `SIGKILL`, while HerdR/tmux use their own verified pane termination. Refusal or unverifiable ownership surfaces a visible `recoveryError` with a retained receipt, not a successful stop, and proving exit can take longer than the budget itself.
- Budgets are enforced by the parent's watcher. A transient child-transport disconnect does not stop the live watcher. Session shutdown now tears children down (session-bound lifetime), so budgets do not outlive the session either.
- The result identifies the exhausted budget and its seconds and warns that partial work may be incomplete.
- Resume by passing `resume: "<run-id>"` to `Agent`: saved limits re-apply on fresh clocks, with positive `timeout`/`idle_timeout` overrides winning per field. Resuming a plain `pi --session` transcript bypasses tracked budgets. There is no automatic resume, and children do not automatically inherit the parent conversation (you can supply needed context in `prompt`).

Model/auth admission happens before resource allocation. It selects a usable native model/auth or rejects; it does **not** verify remote key validity, billing, quota, or endpoint health.

See [Configuration](docs/CONFIGURATION.md) for the complete schema, precedence, admission/fallback, persistence, and turn-limit behavior.

---

## Creating specialists

Use the packaged [`create-agent` skill](skills/create-agent/SKILL.md), adapted from OMP's agent-architect workflow:

```text
/skill:create-agent Create a read-only database schema reviewer for this project
```

The skill writes project specialists under `.pi/agents/` by default, selects minimal supported tools, and provides an invocation example. Start a new session or restart Pi after creating/changing definitions, then confirm the canonical type appears before dispatching.

---

## Workspaces and cleanup

Children share the workspace by default. For isolated checkouts, enable `worktreeIsolation` and set `isolation: worktree` on the specialist definition; there is no per-invocation isolation override.

Worktree runs retain commits/checkouts for manual review and cherry-pick. Cleanup is explicit:

```text
/agents release <run-id>             # retry resource cleanup; retain checkout
/agents release <run-id> --worktree  # remove the reviewed, preserved checkout
```

Cleanup refuses dirty/unpreserved changes and retains preserved branches. There is no automatic merge, cherry-pick, or force-prune. Worktrees isolate filesystems, not tools running as the same OS user.

Settled children/process panes close after durable finalization. Closed rows leave the inline panel but remain in Hub history. Uncertain cleanup stays visible and retains its receipt; resume requires persisted native history and starts a new child process.

---

## Documentation

| Guide | Contents |
|---|---|
| [Documentation index](docs/README.md) | Runtime contracts and architecture decisions |
| [Configuration](docs/CONFIGURATION.md) | Agent definitions, settings, precedence, time budgets, and model admission |
| [Agents UI](docs/ui/AGENT-PANEL-AND-VIEW.md) | Navigation, child composers, transcript controls, and terminal layout |
| [Integration](docs/INTEGRATION.md) | Public events RPC, lifecycle, delivery, and peer mailboxes |
| [Architecture](docs/ARCHITECTURE.md) | Process boundaries, ownership, recovery, and layers |
| [Changelog](CHANGELOG.md) | Product changes |

This package owns specialist execution, not task orchestration. Scheduling, retries, dependencies, and review policy belong to consumers such as `pi-tasks`.

---

## Development

```bash
npm ci
npm run check   # typecheck, lint, layer checks, build/tests, package smoke
npm run dev:pi  # load the extension and skill with the installed peer CLI
```

Source follows `shared → domain → features → app → pi`, enforced by dependency-cruiser. Parent, bridge, and headless entrypoints build into `dist/extensions/`.

Lifecycle/terminal changes also need isolated native-process smokes; UI changes need observation in the actual Pi TUI. Unit tests alone do not establish terminal compatibility. Native terminal/UI verification has used macOS; those smokes do not establish commercial-provider auth/quota or Linux/Windows behavior.

---

## Related extensions

| Extension | What it adds |
|---|---|
| [@quandev104/pi-style](https://www.npmjs.com/package/@quandev104/pi-style) | A cohesive native-layout visual system for Pi: status line, editor, startup, messages, tool presentation, and themes. |

Install `pi-style` separately to customize Pi's visual surfaces:

```bash
pi install npm:@quandev104/pi-style
```

`pi-style` is an optional companion, not a dependency of `pi-teams`.

---

## License

[MIT](LICENSE). The adapted `create-agent` workflow includes its [upstream MIT attribution](skills/create-agent/LICENSE).
