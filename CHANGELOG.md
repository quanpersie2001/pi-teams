# Changelog

## [Unreleased]

### Added

- Optional per-run time budgets: `defaultTimeout`/`defaultIdleTimeout` settings (seconds, `0` = unlimited) with definition frontmatter (`timeout`, `idle_timeout`/`idle-timeout`) and `Agent` invocation overrides (`timeout`, `idle_timeout`). Precedence is invocation > definition > settings; malformed values fail instead of falling back to unlimited. Expiry triggers the cooperative abort with a bounded window, then verified force-termination of the owned child process group (visible failure instead of fabricated outcome when enforcement is refused); the result identifies the exhausted budget, the limit in seconds and possibly incomplete partial work. Resume re-applies the same effective budgets on fresh clocks.
- Full-result channel (roadmap 1.1b): the child bridge writes the complete final assistant text to `sessions/<child-id>/result.md` at settlement (partial text for stopped runs) and reports its path as the additive `resultFile` on outcomes, snapshots, lifecycle events, registry and history rows. `get_subagent_result` re-reads the artifact on every call (reads are no longer one-shot; `resultConsumed` only suppresses the duplicate completion notification), prints a truncation note with the file path when only the bounded inline copy is available, and degrades honestly when the file is unreadable.
- Named teammates + roster (ADR 0007 §2, roadmap T2): `Agent(name:)` claims a team-unique teammate address (1–64 chars of `[a-zA-Z0-9._-]`, alnum-first, `lead` reserved). Model decision: teammates persist across assignments until the session ends — a name is refused while its teammate is actively working and claimable again once settled; resumed runs keep their teammate. One team per session is created at `session_start` (team id derived from the session id) with a durable roster at `.pi/teams/t/<team-id>/config.json` (owner-only, atomic) recording members and their latest runs; `teammateName` flows additively through AgentRun, registry/history, integration v3 snapshots/lifecycle events, `get_subagent_result` output and completion notifications, whose header now reads `Teammate @<name> …` for named runs.
- Peer mailboxes (ADR 0007 §3, roadmap T3): replace the in-memory inbox and four inbox tools with `send_message`, atomic owner-only message files, per-team HMAC verification and logged quarantine. Lead and child watchers inject automatically; messages remain untrusted and cannot approve permissions. Main-composer `@name message` routes directly to live teammates without a lead turn. Named teammates retain their native child while idle, reuse it for assignments, share the normal active-run capacity queue, and preserve separate full-result artifacts across assignments.
- Shared task board (ADR 0007 §4, roadmap T4): atomic owner-only task files, exclusive lock-directory self-claim, dependency blockers that disappear on completion, and `team_task_create/update/list/get` for lead and named native children. Owner-only release/completion and terminal completed state remain coordination primitives, not consumer retry/review policy. Native cold continuation binds to the current team; idle named child composers reuse their retained native process.

- Independent-process specialist runtime with HerdR/tmux Pi TUIs, a native headless fallback, authenticated child control and durable session recovery.
- Main/children Agents Hub, fullscreen child transcripts, independent composers, child-only model/thinking controls and native `@agent` autocomplete.
- Signed peer messaging and public integration protocol v3 for extension-owned runs.
- Optional isolated Git worktrees with retained commits/checkouts and explicit reviewer-controlled cleanup.
- Packaged `create-agent` skill adapted from OMP v18.6.1's agent-architect workflow, with native Pi definitions, invocation guidance and upstream MIT attribution.
- Bundled `scout` for cited external-source research and shell-free `reviewer` for evidence-backed code review.

### Changed

- Rename the product to `pi-teams` (ADR 0008): package `@quandev104/pi-teams`, source tree `extension-src/pi-teams/`, settings `teams.json`, command `/teams-backend`, environment variables `PI_TEAMS_*`, notification customType `teammate-notification`, and artifact root `.pi/teams/` (`registry.json`, `history.json`, `sessions/<child-id>/`, future `t/<team-id>/`). Model tool names (`Agent`, `get_subagent_result`, `steer_subagent`), child protocol v2 and integration events v3 channels are unchanged. Existing local `.pi/subagents/` state is not migrated — delete it manually.

- Remove live-child restoration machinery (ADR 0007 §5, roadmap T4): archive-only startup reconciliation, no re-adoption, live-run quarantine queue, deferred active cleanup or status-driven session reattachment. Stale owned rows archive stopped with honest cleanup notes; terminal outcomes and cold JSONL/worktree/result artifacts remain intact. Foreign-owner and incompatible rows remain untouched. Session switching now awaits old-team teardown before manager re-arm.
- Target Pi peers >=1.0.4 <1.1.0 and Node >=22.19; package parent, bridge and headless entrypoints.
- Close anonymous owned children/panes after settlement; named teammates retain idle native processes until teardown. Keep Hub history and explicit cleanup uncertainty; cold continuation uses persisted native JSONL in a new process.
- Group terminal children into columns capped at three, balance each column independently and reuse vacancies without compacting survivors.
- Down from an empty Main editor enters inline navigation; double Left at document start opens Hub without intercepting native menus, dialogs or cursor movement.
- Admit authenticated native models before allocating execution resources; expose the selected model and fallback reason.
- Rename bundled `Explore` to canonical `explore` and remove bundled `Plan`; the catalog is `general-purpose`, `explore`, `scout`, `reviewer`.
- Set bundled `explore` thinking to `off` and remove its model pin; it uses the invocation or captured parent model.
- Load the complete package in development/live-smoke commands so its native skill is discoverable alongside the extension.

### Fixed

- Refused retained-teammate assignments now fail and release capacity instead of parking in `starting`; pre-admission ownership rolls back to the idle child. Lost prompt acknowledgements reconcile the new assignment's own handle against native state without inheriting an earlier assignment's result or counters.
- Keep Main's document-start gestures (double Left → Hub, Down → inline navigation) working when a foreign custom editor still preserves native `Editor` semantics (e.g. pi-style's `CustomEditor` subclass); defer only to opaque custom editors whose cursor/autocomplete state cannot be observed. `/agents` and Alt+G remain available in every mode.
- Preserve pane/process identity, focus and unrelated geometry during terminal layout changes; handle HerdR odd-height rounding and tmux exited-pane identity replies safely.
- Preserve saved outcomes and uncertain receipts during reconnect, cleanup and startup recovery; reject foreign resources and authenticated PID mismatches.
- Keep delivery, widgets and autocomplete correct across session changes/reload, with independent drafts, scroll/tool expansion and per-run outcome previews.

### Maintenance

- Teams-pivot quality gates (roadmap T5): `gpt-6-luna` task-board and archive/native-lifecycle reviews, native peer/lead tool execution, contested claims and dependency unlocks, session-isolated cold continuation, same-child TUI assignment, verified teardown, and the complete `npm run check` gate. Retain native regressions for refused-assignment capacity and duplicate teammate-address prevention.
- Remove unused utilities/exports, obsolete architecture documents, duplicated smoke diaries and stale test artifacts; keep one documentation index and include linked docs in the package.
- Reorganize the README with compatibility badges, installation/quick-start guidance, bundled-agent and control tables, documentation links, and the optional `pi-style` companion.
