# Changelog

## [0.1.11] - 2026-10-20

### Features

- *(cli)* Add process-scoped pi-teams disable flag

## [0.1.10] - 2026-10-19

### Features

- *(settings)* In-app settings editor, schema and writer
- *(ui)* Task glyph table, hanging cards and default task renderers

### Refactor

- *(settings)* Drop the arrow key-list overlay for sequential dialogs

## [0.1.9] - 2026-10-18

### Bug Fixes

- Make Windows peer fixtures portable and expose ACL diagnostics
- Isolate Windows ACL helper from PowerShell module path conflicts
- Provision private Windows storage for elevated token owners
- Canonicalize verified Windows peer storage and coalesce ACL checks
- Use cancellable Windows pipe reads and isolate native fixtures
- Bound Windows delete-pending quota lock retries
- Reset Windows lock retry bounds between contention episodes
- Serialize same-host quota admission before global file locking

### Documentation

- Record passing native Windows peer and lifecycle CI evidence
- Illustrate teammate lifecycle and peer message flow
- Remove CI verification notes from README

### Features

- Add teammate shutdown and secure local peer messaging
- Complete lifecycle migration and secure Windows peer transport

### Testing

- Cover Windows peer path aliases and ACL cache invalidation
- Preserve ACL evidence and bound native integration waits
- Keep Windows quota stress fixtures live through native I/O
- Reuse independent Windows registry observer during withdrawal

## [0.1.8] - 2026-10-13

### Bug Fixes

- Improve team and task hub rendering and mouse interaction
- Satisfy hub lint and formatting checks

## [0.1.6] - 2026-10-10

### Bug Fixes

- *(model)* Apply strict admission to the launch re-check too
- *(hub)* Size the roster from the terminal, not the inline panel
- *(hub)* Page by the rendered window, not the panel page size

### Documentation

- Document team_task_edit/cancel and the send_message target rules
- State the skill attribution scope

### Features

- *(model)* Reject ambiguous or unregistered invoked models
- Unify session tasks and improve teammate runtime and UI

### Miscellaneous Tasks

- *(package)* Stop publishing the internal porting document

### Refactor

- Share the tool-registration guard

### Testing

- Close the audit coverage gaps

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

