# Changelog

## [Unreleased]

### Added

- Optional per-run time budgets: `defaultTimeout`/`defaultIdleTimeout` settings (seconds, `0` = unlimited) with definition frontmatter (`timeout`, `idle_timeout`/`idle-timeout`) and `Agent` invocation overrides (`timeout`, `idle_timeout`). Precedence is invocation > definition > settings; malformed values fail instead of falling back to unlimited. Expiry triggers the cooperative abort with a bounded window, then verified force-termination of the owned child process group (visible failure instead of fabricated outcome when enforcement is refused); the result identifies the exhausted budget, the limit in seconds and possibly incomplete partial work. Resume re-applies the same effective budgets on fresh clocks.
- Slash command `/sub-agents-backend [auto|headless]` plus a `backend` settings key to toggle multiplexer usage: `auto` keeps HerdR/tmux auto-detection, `headless` never attaches a multiplexer. `PI_SUBAGENTS_BACKEND` (all four launchers) still overrides settings; runtime switches affect new launches only.

- Independent-process specialist runtime with HerdR/tmux Pi TUIs, a native headless fallback, authenticated child control and durable session recovery.
- Main/children Agents Hub, fullscreen child transcripts, independent composers, child-only model/thinking controls and native `@agent` autocomplete.
- Scoped parent/child/sibling inbox tools and public integration protocol v3 for extension-owned runs.
- Optional isolated Git worktrees with retained commits/checkouts and explicit reviewer-controlled cleanup.
- Packaged `create-agent` skill adapted from OMP v18.6.1's agent-architect workflow, with native Pi definitions, invocation guidance and upstream MIT attribution.
- Bundled `scout` for cited external-source research and shell-free `reviewer` for evidence-backed code review.

### Changed

- Scope runs to their owning conversation: startup restore adopts only rows whose conversation owner matches the current session. Rows owned by other conversations or extension consumers are never surfaced or controlled here — settled/verified-dead foreign rows are archived to history and dropped, live foreign rows stay untouched on disk and survive registry rewrites. Reopening the same session (`pi --resume`) re-adopts its still-running children.
- Target Pi peers >=1.0.4 <1.1.0 and Node >=22.19; package parent, bridge and headless entrypoints.
- Close owned children/panes after settlement; retain Hub history and cleanup uncertainty. Resume in a new process using persisted native JSONL.
- Group terminal children into columns capped at three, balance each column independently and reuse vacancies without compacting survivors.
- Down from an empty Main editor enters inline navigation; double Left at document start opens Hub without intercepting native menus, dialogs or cursor movement.
- Admit authenticated native models before allocating execution resources; expose the selected model and fallback reason.
- Rename bundled `Explore` to canonical `explore` and remove bundled `Plan`; the catalog is `general-purpose`, `explore`, `scout`, `reviewer`.
- Set bundled `explore` thinking to `off` and remove its model pin; it uses the invocation or captured parent model.
- Load the complete package in development/live-smoke commands so its native skill is discoverable alongside the extension.

### Fixed

- Keep Main's document-start gestures (double Left → Hub, Down → inline navigation) working when a foreign custom editor still preserves native `Editor` semantics (e.g. pi-style's `CustomEditor` subclass); defer only to opaque custom editors whose cursor/autocomplete state cannot be observed. `/agents` and Alt+G remain available in every mode.
- Preserve pane/process identity, focus and unrelated geometry during terminal layout changes; handle HerdR odd-height rounding and tmux exited-pane identity replies safely.
- Preserve saved outcomes and uncertain receipts during reconnect, cleanup and startup recovery; reject foreign resources and authenticated PID mismatches.
- Keep delivery, widgets and autocomplete correct across session changes/reload, with independent drafts, scroll/tool expansion and per-run outcome previews.

### Maintenance

- Remove unused utilities/exports, obsolete architecture documents, duplicated smoke diaries and stale test artifacts; keep one documentation index and include linked docs in the package.
- Reorganize the README with compatibility badges, installation/quick-start guidance, bundled-agent and control tables, documentation links, and the optional `pi-style` companion.
