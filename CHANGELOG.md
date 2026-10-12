# Changelog

- Add an inline Tasks widget above the editor for pending/in-progress/in-review tasks, with terminal tasks retained in Hub history; keep the Agents panel below the editor and add session-only `/agents panel [show|hide|toggle]` visibility plus the `agentInlinePanel` startup default.

## Unreleased

### Features

- Merge the `references/pi-tasks` workflow into session-scoped unified Tasks tools, with typed task requirements/context/outcomes and explicit execution-attempt lifecycle

- Add named-teammate status, release and retirement controls; explicit continue/fresh context policy; fail-closed mailbox availability guards and per-teammate pending-message archiving on context replacement
- Additive v3 RPC capabilities and teammate lifecycle operations; preserve existing run-ID status/release semantics

### Documentation

- Document unified Tasks Hub controls, v2 task schema normalization, opt-in cascade/reminder automation, and fail-closed board-lock recovery
- Document teammate lifecycle states, recovery availability, context replacement, mailbox receipts and additive RPC compatibility

## [0.1.5] - 2026-10-10

### Bug Fixes

- Harden headless teardown and fail-closed force-kill per review
- *(windows)* Pass the module loader to --import as a file URL

### Features

- Add Team Hub details and restore child terminal modes
- Add verified Windows headless launcher behind platform selection
- Port child control transport to Windows named pipes
- Enable native Windows headless execution with actionable backend errors
- *(task-board)* Short task codes, edit/cancel ops and readable tool rendering
- *(guidance)* Model-facing tool contracts, recovery errors, team-lead skill

### Miscellaneous Tasks

- Add native windows-latest integration job and document windows support
- *(windows)* Surface child boot logs in identity failures

### Testing

- Prove verified teardown of a live windows child in native integration

## [0.1.4] - 2026-10-09

### Bug Fixes

- Gate unsupported Windows headless runtime and test package URLs
- Load isolated child hook via file URL on Windows

### Features

- Match teammate identity and style in child view

## [0.1.3] - 2026-10-09

### Bug Fixes

- Resolve host Pi modules in terminal viewer

## [0.1.2] - 2026-10-09

### Documentation

- Embed demo video and simplify Pi installation

### Features

- Refine teammate hub and runtime delivery

## [0.1.1] - 2026-10-08

### Documentation

- Record gpt-6-luna teams pivot quality gates

### Features

- *(full-result)* Durable result.md channel + repeatable get_subagent_result (roadmap 1.1b)
- *(teams)* Session-bound teardown + orphan self-termination (ADR 0007 §1, roadmap T1)
- *(teams)* Named teammates + roster + run-to-teammate mapping (ADR 0007 §2, roadmap T2)
- Add signed peer mailboxes and native teammate assignment reuse
- Add shared task board and remove live child restoration
- *(teams)* Freeze instance identity and reconcile native viewers
- *(teams)* Restore styled native panes and close idle viewers

### Miscellaneous Tasks

- Use supported Node 24 action runtimes

### Other

- Pi-subagents → pi-teams (ADR 0008)

