# @quandev104/pi-teams

[![CI](https://github.com/quanpersie2001/pi-teams/actions/workflows/ci.yml/badge.svg)](https://github.com/quanpersie2001/pi-teams/actions/workflows/ci.yml)
[![Pi compatibility](https://img.shields.io/badge/Pi-%3E%3D1.0.4%20%3C1.1.0-8b5cf6)](https://pi.dev)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

> Specialist agents in independent Pi processes — with live steering, native session history, and a shared Team Hub.

Delegate implementation, local exploration, external research, and code review without hosting child `AgentSession`s in the parent. Each agent executes in an independent native Pi SDK process. HerdR/tmux panes attach to Pi's real `InteractiveMode` in that same process through a detachable terminal transport.

https://github.com/user-attachments/assets/2f715c97-838d-461c-a6a2-7122ae26facf

[Install](#install) · [Quick start](#quick-start) · [Bundled agents](#bundled-agents) · [Configuration](#configuration) · [Documentation](#documentation) · [Related extensions](#related-extensions)

---

## Features

- **Independent execution and native UI** — SDK workers host Pi's own transcript, editor, footer and menus in HerdR/tmux; presentation changes never restart execution. Explicit headless workers do not initialize the TUI.
- **Live control** — launch, inspect, steer, and stop runs over an authenticated, owner-only control endpoint: a Unix domain socket on Unix, a named pipe on Windows. Live state never depends on terminal input or JSONL polling.
- **Opt-in time budgets** — optional `timeout`/`idle_timeout` limits in seconds hard-stop runaway children; the idle clock refreshes on child output only, and enforcement stops when the parent session shuts down.
- **One Team Hub** — Main and child conversations share navigation, while keeping drafts, scroll positions, and tool expansion independent.
- **Focused specialists** — four bundled roles, layered Markdown definitions, native `@agent` autocomplete, and packaged `create-agent` and `team-lead` skills.
- **Recoverable sessions** — durable native JSONL history supports explicit cold continuation in a new child process. Anonymous children close after durable finalization; named teammates retain their native child while idle.
- **Session-owned runs** — other sessions never adopt or control a conversation's live runs. Session end/switch/shutdown tears children down (abort → bounded grace → verified force-kill); control-socket loss stops an orphan with an annotated partial result. Startup archives stale owned rows instead of re-adopting them; foreign-owner rows remain untouched.
- **Workspace choice** — shared files by default, or opt-in Git worktrees with retained commits/checkouts and explicit cleanup.
- **Extension integration** — signed peer mailboxes and public events RPC for consumers that own scheduling, retries, and review policy.
- **Unified Tasks** — session-scoped task records with typed requirements/context/outcomes, dependencies and execution-attempt history; completion is explicit and distinct from run settlement.

---

## Install

**Requires:** Node.js ≥22.19 and Pi ≥1.0.4 and <1.1.0. Unix keeps owner-only Unix sockets; native Windows is supported through headless OS-children: named-pipe control endpoints (`\\.\pipe\pi-teams-<childId>\control`), `taskkill /T` tree lifecycle and CIM CreationDate + argv-token identity — exercised by the windows-latest CI job (which runs on GitHub runners, not on this machine). HerdR/tmux viewers are not available on Windows in this increment; headless children still support the parent Hub and child view. Pi supplies SDK, TUI and TypeBox to the parent extension. Standalone children resolve the same host packages from the running Pi installation through a Node module hook, without installing duplicate copies in the package.

Install the package with Pi:

```bash
pi install npm:@quandev104/pi-teams
```

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
  "name": "pi-compat",
  "color": "#47a3e8",
  "description": "Check Pi compatibility",
  "prompt": "Read package.json. Report the supported Pi version range. Do not edit files.",
  "run_in_background": true
}
```

Every new model-facing `Agent` spawn requires `subagent_type`, `description`, `name` and `color`; `Agent(resume: ..., prompt: ...)` needs none of those new-spawn fields and inherits the original identity. The `name` is the visible `@name` and mailbox address, while the run ID remains available for result/steer/resume operations. External RPC consumers can still launch anonymous runs. In the interactive TUI, a tool batch containing only background Agent launches ends the coordinator turn; completed results arrive later in a new turn. A mixed batch continues normally. In print/JSON/RPC modes, Agent calls block and return their result inline, even when background was requested, because those modes cannot rely on a later interactive turn.

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
| `/agents` | Open the Team Hub on Agents |
| `/tasks` | Open the Team Hub on Tasks |
| **Alt+G** | Toggle the Team Hub; reopening uses its last tab (Agents initially) |
| `/teams-backend [auto\|headless]` | Show or switch the launcher mode for this session (session-start value comes from settings/env) |
| **Left twice within 500 ms** at Main's document start or from bottom navigation | Open Hub without losing the draft |
| **Down** from empty Main | Enter the visible inline bottom navigation |
| **Arrows / Enter** in the Agents Hub | Select / open a child |
| **Tab / Shift+Tab** in the Hub | Switch between Agents and Tasks; these keys are owned by the Hub, not task forms |
| **↑/↓, Enter, Esc** in Tasks | Select task / open or leave details / return from details or close Hub |
| **n / e** in Tasks | Create task / edit a pending task |
| **c / x / r / a** in Tasks | Claim or release / choose agent type and execute or retry / request review / enter outcome and accept completion |
| **k / o / d / v** in Tasks | Stop attempt / read output / cancel pending task / view latest attempt |
| **/** or **f** in Tasks | Search / filter tasks |
| **Enter** in the child composer | Assign an idle named teammate/start fresh or cold-resume an explicitly released run |
| **Esc** in a child view | Return without aborting |
| **Alt+Left/Right / Alt+Up** with an empty child composer | Switch siblings / return to Main |
| **Ctrl+X twice / Alt+O** with an empty child composer | Abort / open a verified live native pane |

Native menus, dialogs, and ordinary cursor movement retain their arrows. The document-start gestures (double Left, Down from an empty prompt) work alongside editor-styling extensions whose custom editor still preserves native `Editor` semantics (such as `pi-style`); with an opaque custom editor they defer and `/agents`/Alt+G remain the entry points. Child `/model <provider/id>` and `/thinking <level>` commands affect only the focused live child. Unsupported commands preserve the draft and report an error; `/compact` is intentionally unavailable because native compaction aborts the active turn.

HerdR/tmux's six-child threshold counts every live runtime-owned child, including named idle teammates, excluding Main. Above six, every child pane closes; returning to at most six restores panes only for running assignments, preserving execution PID, child ID, context and style. Idle children never keep a pane. Layout uses the visible child panes: zero leaves Main alone; 1–3 use two horizontal partitions; 4–6 use three equal horizontal partitions, with child rows 2+2, 3+2 and 3+3. Layout changes preserve focus and unrelated panes; unverified ownership/geometry is rejected.

### Model-facing tools

| Tool | Purpose |
|---|---|
| `Agent` | Launch a specialist with an explicit assignment — optionally `name:` it a teammate of this session's team (`@name` becomes its messaging/board address; a name is refused while busy, and role/name/color stay fixed). For named teammates, omitted context continues an idle retained child and starts fresh for a new/released identity; explicit `context: "continue"` requires an idle retained context, while `context: "fresh"` explicitly replaces one after verified idle close. `resume` with a settled run ID is separate transcript recovery and requires explicit release for a named teammate. |
| `teammate_status` | Inspect lifecycle state (`idle`, `busy` including queued work, `released`), recovery availability, `contextAvailable`, live `currentRunId` and artifact `lastRunId` |
| `teammate_release` | Release a settled teammate's retained native child/context; idempotent and does not change task-board claims |
| `teammate_shutdown` | Stops/cancels work, verifies cleanup and required task reconciliation, then removes live membership; failures retain recovery state |
| `list_models` | Resolve a model reference before spawning: optional `query` (string) and `limit` (number) return up to `limit` (default 50) matching `provider/id — display name` rows sorted canonically, plus the total match count |
| `get_subagent_result` | Read a run's durable full result from `result.md`; use `wait: true` only when the current turn explicitly needs the answer immediately, not for passive background completions |
| `steer_subagent` | Send guidance to an active run |
| `send_message` | Queue `{ target, message }` through a signed team mailbox. Teammates may address teammates or lead; lead may address teammates. A queued receipt is not delivery confirmation. |
| `peer_sessions` | Discover independent sessions in the configured local project scope (peer support must be enabled). |
| `peer_send` | Enqueue plain text to an exact peer runtime address; receipt describes enqueue, not model comprehension. |
| `peer_activity` | Set or clear this session's short activity advertisement. |

Peer inbound policy is receiver-owned (`hold` by default); held messages require explicit approval before model injection. Unix authenticated transport and a provider-free automated smoke using two independent Pi SDK sessions cover signed delivery, held privacy, approval, SDK acceptance and delivered receipt. This does not verify production extension-loader wiring, interactive/manual TUI behavior, or busy SDK steering. Windows peer runtime remains disabled/fail-closed because no real storage ACL verifier is implemented.
| `tasks_create` | Create a session task with typed requirements/context, dependencies, optional review request and optional `executionPlan` |
| `tasks_list` | List session tasks and derived blockers |
| `tasks_get` | Read a task, its outcome and attempt history |
| `tasks_update` | Edit pending requirements/plan or explicitly claim/release/request review/accept completion |
| `tasks_cancel` | Cancel an eligible pending task |
| `tasks_execute` | Execute an unblocked pending or claimed task through the existing AgentManager |
| `tasks_output` | Read output from the latest execution attempt |
| `tasks_stop` | Stop a running attempt; does not complete the task |

Named teammates stay alive while idle, but their multiplexer panes close. When context is omitted, an idle retained child continues; a new or released identity starts fresh. Explicit `context: "continue"` requires an idle retained child and fails without one. Explicit `context: "fresh"` closes a verified-idle retained child and starts a new session without changing role/name/color. Pending mailbox files for that teammate are archived with a reset reason before successful release, shutdown, or fresh-context replacement; they are never replayed into a fresh session. `busy` includes queued work. Teammate lifecycle state is separate from recovery availability. `contextAvailable` is true only for idle teammates with a verified backend/handle and no runtime or roster unavailability; `currentRunId` identifies the live runtime owner, while `lastRunId` identifies the latest assignment artifact and may remain after release. Use `teammate_status` before lifecycle actions. `send_message` queues for eligible idle or busy recipients; released and unavailable recipients are refused. A queued receipt is not delivery confirmation. Bridges watch mailboxes automatically—models never poll. In the main composer, `@name message` routes to an eligible teammate; unresolved mentions retain normal inline behavior.
`Agent(name: "review-api", color: "#e879f9")` sets creation-time identity (`#RGB` or `#RRGGBB`). Identity is stored in the team roster, not agent frontmatter. Later assignments preserve role and color. `teammate_release` frees retained execution/context; released teammates start fresh by default, while explicit `context: "continue"` fails. `stop` ends an assignment but preserves membership. `teammate_shutdown` is distinct: it fences new work, cancels/stops the member, reconciles task state, verifies cleanup, then removes membership; same-name reuse creates a new identity. Failed/unverifiable cleanup retains recovery state and prevents reuse.
Cold `Agent(resume: ...)` is distinct: it starts a new run from persisted transcript after release; it does not restore a live teammate handle or automatically bind another team's mailbox/board context.

Mailboxes use one owner-only, HMAC-signed file per message under `.pi/teams/t/<team-id>/inboxes/<name>/`. Invalid entries are quarantined with a warning. Messages are untrusted content and cannot approve permissions. Files are consumed only after native injection; they survive ordinary reload as artifacts, but pending entries are archived for that teammate on successful release, shutdown, fresh-context replacement, or cold resume. A queued receipt is not delivery confirmation.

The session-scoped unified Tasks board stores atomic owner-only task records. Tasks include typed spec/context/outcome, optional execution plan and attempt history; `Task` remains distinct from each referenced `AgentRun`. Claiming is explicit, execution does not accept completion, and only explicit owner/coordinator acceptance completes. Stopping an attempt does not complete the task. The Tasks Hub provides list/detail, search/filter and task actions; create/edit prompts cover title, description, scope paths/out-of-scope paths, constraints, expected output, acceptance criteria, dependencies, context background/decisions/references (references entered as JSON), assignee and review requirement. Completion prompts collect summary, artifacts, verification JSON and remaining issues. The optional root `executionPlan` (`type`, `name?`, `color?`, `model?`, `maxTurns?`) is tool-only and is accepted only by `tasks_create`/`tasks_update`, not `tasks_execute`; `tasks_update { executionPlan: null }` clears it on a pending task. An empty `expectedOutput` is a valid spec patch. The board does not survive as a cross-session workflow.

Optional automation is configured with `tasks: { "autoCascade": false, "reminders": false }` in `.pi/teams.json` or `~/.pi/agent/teams.json`. Cascade runs only for explicitly planned pending dependencies after a newly observed accepted completion (including peer board-service updates; no startup replay). Automation reservation atomically validates the captured requirement revision and `expectedStatus: "pending"` before mutation, so stale automation cannot overwrite a manual claim; manual `tasks_execute` is unchanged. A mismatch (including while waiting to reserve) skips launch before spawn without owner/attempt mutation and clears dedupe without immediate rescheduling. Each planned task is launched at most once per service; only typed reservation-lock conflicts are retried before launch (bounded 100/250/500 ms), never spawn failures, and retry exhaustion clears dedupe for a later completion trigger. Reminders are lead-only, bounded, every four turns, and reset by `tasks_*` tool results. Both are off by default. The task implementation contains no copied external content.

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
  "strictModelAdmission": true,
  "backend": "auto"
}
```

`strictModelAdmission` (default `true`) requires a model passed explicitly in the spawn invocation (`Agent`'s `model`) to resolve to exactly one registered model. An ambiguous invocation reference fails admission with the candidate models listed, and an unregistered one fails admission with a distinct message naming the reference, instead of falling back to the parent's model; a definition/agent-file model pin is unaffected and still falls back to the caller/definition/parent model with a recorded note, as does a model that resolves but has no usable authentication. Set it to `false` to restore caller/definition/parent fallback for the invocation `model` too, recorded as `Model fallback: ...` in the agent result. Pass models as `provider/modelId` and resolve a reference with `list_models` first: the bare `glm-5.3-flash` is ambiguous across five providers, while `zai/glm-5.3-flash` resolves exactly.

`backend` selects presentation: `auto` (default) detects HerdR → tmux and falls back to no pane; `headless` never attaches a multiplexer. Precedence for new children: `/teams-backend <mode>` (current session) > `PI_TEAMS_BACKEND` > settings `backend` > `auto`. The env variable does not override a session switch, and switching affects only new children. Existing children retain their selected presentation launcher, subject to the all-headless presentation threshold above six. Execution and native UI state remain in the same independent worker when panes close or reopen. A forced unavailable launcher fails explicitly.

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
  "name": "config-audit",
  "color": "#e879f9",
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
- Expiry aborts the child; if it has not settled after 2 seconds, the parent terminates the owned headless execution process (`SIGTERM` → `SIGKILL`) and closes its verified viewer. Refusal or unverifiable ownership surfaces a visible `recoveryError` with a retained receipt, not a successful stop, and proving exit can take longer than the budget itself.
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

The skill writes project specialists under `.pi/agents/` by default, selects minimal supported tools, and provides an invocation example. Start a new session or restart Pi after creating/changing definitions, then confirm the canonical type appears before dispatching. For delegating to spawned teammates — parallel runs, the shared task board, and recovery from failed `Agent`/`tasks_*` calls — use the packaged [`team-lead` skill](skills/team-lead/SKILL.md) (`/skill:team-lead`).

---

## Workspaces and cleanup

Children share the workspace by default. For isolated checkouts, enable `worktreeIsolation` and set `isolation: worktree` on the specialist definition; there is no per-invocation isolation override.

Worktree runs retain commits/checkouts for manual review and cherry-pick. Cleanup is explicit:

```text
/agents release <run-id>             # retry resource cleanup; retain checkout
/agents release <run-id> --worktree  # remove the reviewed, preserved checkout
```

Cleanup refuses dirty/unpreserved changes and retains preserved branches. There is no automatic merge, cherry-pick, or force-prune. Worktrees isolate filesystems, not tools running as the same OS user.

Anonymous children close after durable finalization; named teammates retain idle execution until explicit release or session teardown. Multiplexer panes close at native idle settlement and reopen on a new assignment without replacing retained workers or their context/style. Settled closed and idle rows leave the inline Agents panel but remain in Hub history. Tasks render in a dedicated widget above the editor (eligible pending/in-progress/in-review only); terminal tasks disappear from that widget but remain in Hub history/read access. `/agents panel [show|hide|toggle]` (bare command toggles) hides/shows only inline Agents for the session; `agentInlinePanel` sets its startup default. Hub and inline rows show a compact name, description, elapsed time and token count. Uncertain cleanup stays visible and retains its receipt; cold resume requires persisted native history and starts a new execution process.

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

First-party task workflow is session-scoped; cross-session scheduling is not delivered. The versioned events RPC remains compatibility for third-party consumers. Disable the separate legacy `pi-tasks` extension when using unified Tasks; its standalone workflow is not the unified board. Interactive manual TUI smoke testing remains pending.

---

## Development

```bash
npm ci
npm run check   # typecheck, lint, layer checks, build/tests, package smoke
npm run dev:pi  # load the extension and skill with the installed peer CLI
```

Source follows `shared → domain → features → app → pi`, enforced by dependency-cruiser. Parent, bridge, headless-worker and raw-terminal-client entrypoints build into `dist/extensions/`.

Lifecycle/terminal changes also need isolated native-process smokes; UI changes need observation in the actual Pi TUI. Unit tests alone do not establish terminal compatibility. Native terminal/UI verification has used macOS; automated Linux and native Windows runtime tests run in hosted CI, but neither establishes commercial-provider auth/quota or hands-on TUI behavior.

GitHub **CI** runs on pushes and pull requests to `main` with Node 22, `npm ci`, typecheck, lint, dependency boundaries, serialized integration tests and package smoke, plus windows-latest jobs for package resolution, headless availability and the native Windows runtime integration. Hosted CI does not replace the native multiplexer smokes above.

The manual **Release** workflow mirrors `pi-style`'s patch/minor/major/alpha/beta channels. Configure the repository Actions secret `NPM_TOKEN` with publish access to `@quandev104/pi-teams` (including unattended/2FA authorization). Repository rules must allow the release job's `contents: write` token to push its version commit and annotated tag. Secrets are repository-specific; an existing `pi-style` secret is not automatically inherited.

```bash
gh workflow run publish.yml --repo quanpersie2001/pi-teams --ref main -f version=patch
```

Release checks run before version changes; the workflow updates `package.json`, `package-lock.json` and the generated changelog, pushes the version commit/tag, publishes npm's `latest`/`alpha`/`beta` channel, then creates the GitHub Release. Failed npm publication fails the workflow rather than reporting a successful GitHub Release. Ordinary pushes run CI only; they do not publish.

---

## Related extensions

| Extension | What it adds |
|---|---|
| [@quandev104/pi-style](https://www.npmjs.com/package/@quandev104/pi-style) | A cohesive native-layout visual system for Pi: status line, editor, startup, messages, tool presentation, and themes. |

Install `pi-style` separately to customize Pi's visual surfaces:

```bash
pi install npm:@quandev104/pi-style
```

`pi-style` is an optional companion, not a dependency of `pi-teams`. Native HerdR/tmux children load Main's already-loaded `pi-style` source, including temporary `-e` sources, without loading other Main extensions. SDK-only/headless children do not load UI extensions. Closing and reattaching panes preserves the same native editor, footer and session-local style.

---

## License

[MIT](LICENSE) covers the package. One bundled skill carries separate attribution: `create-agent` ships its own [LICENSE](skills/create-agent/LICENSE) covering the upstream material it adapts, as described in its [Provenance section](skills/create-agent/SKILL.md). The `team-lead` skill ships no separate license file and its [SKILL.md](skills/team-lead/SKILL.md) documents no provenance.
