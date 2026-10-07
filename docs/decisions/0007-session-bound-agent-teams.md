# ADR 0007: Session-bound agent teams with peer mailboxes and a shared task board

- **Status:** Accepted
- **Supersedes:** lifetime-independence guarantees in [ADR 0004](./0004-independent-process-runtime.md)
- **Amends:** [ADR 0005](./0005-separate-task-and-agent-domains.md)

## Context

Direct delegation moves to Claude-Code-agent-teams semantics: named peers that message each other directly, coordinate through a shared task board, and stop when the owning session stops. Child survival across parent restarts is not required. Observable native TUI children remain the differentiator, so execution stays in independent processes (ADR 0004's runtime, minus its lifetime guarantee).

## Decision

### 1. Session-bound lifetime

Teammates live and die with the owning session:

- Session end/switch/shutdown performs graceful teardown: abort request, bounded cooperative grace, then verified launcher force-termination (the budget-enforcement path), closing owned panes.
- Children stopped by teardown record partial results and recovery notes where possible (requires the full-result channel, roadmap 1.1b).
- `pi --resume` no longer re-adopts live children (feature removed). Explicit cold resume by run ID from persisted native JSONL stays: it is an artifact action, not a live child.
- **Orphan detection:** an unexpected parent death needs no heartbeat. Losing the authenticated control socket is a reliable local death signal: Unix sockets have no network partition, and the new model has no deliberate detach-without-kill. On control-loss the child bridge aborts the current turn through the native cooperative path, flushes native JSONL, writes an annotated partial `result.md` ("stopped: parent control lost") and exits (headless) or closes its TUI pane (interactive). Startup never re-adopts: leftover active registry rows are archived as `stopped` with an honest recovery note; their resources go through verified disposal.
- Worktree checkouts, preserved branches, history and result files survive sessions.

### 2. Team topology

- One team per session; the session is the fixed lead. Teammates are named at spawn; the name is the mailbox and board address, unique per team.
- Flat topology: teammates do not spawn teammates (ADR 0003 unchanged). Agent definitions serve as teammate roles.
- Team roster lives in `.pi/teams/t/<team-id>/config.json`; children read it to discover peers.

### 3. Peer messaging

- Every participant, including the lead, has a mailbox directory `.pi/teams/t/<team-id>/inboxes/<name>/`; one JSON file per message, written temp-then-rename (atomic, lock-free, crash-safe; a malformed entry never blocks the mailbox).
- A teammate's bridge watches its mailbox and injects messages into its conversation automatically; the lead reads its mailbox and injects as steering/notifications. The model never polls.
- Sender authenticity: messages are HMAC-signed with a per-team key distributed through the authenticated bootstrap; invalid entries are quarantined, not delivered.
- Model surface is one tool, `send_message` (target: teammate name or `lead`). Delivery receipts (queued/delivered/consumed) remain internal correctness state. The three inbox tools and the memory-only inbox are replaced.
- Peer messages carry no authority: a message can never encode or relay a permission approval. Permission prompts happen in each child's own native surface; messages from peers are treated as untrusted content, never as confirmation (Claude auto-mode rule adopted as a free invariant; a content-classifier review gate is deliberately not built — optional setting if ever needed).
- Composer `@name` addressing (Claude parity, verified in-product: typing `@` offers teammates with a send-message hint): the existing agent-mention autocomplete becomes a delivery entry point — a composer message whose target resolves to a live teammate routes directly into that teammate's mailbox instead of the lead conversation. Non-resolving mentions keep today's inline-mention behavior. Lands with the mailbox in T3.
- Lifecycle push to the lead stays out of the mailbox: settlement is parent-side knowledge (`agent_settled` → `run_settled`), so the idle/completion notification remains a runtime-authored `teammate-notification` message (followUp, `triggerTurn: true`) carrying the final answer preview and `resultFile` pointer. Presentation belongs to companion visual extensions: the runtime ships no custom message renderer — structured plain-text `content` is canonical, `customType` + `details` form the stable contract a renderer (pi-style) may target; without one the plain text displays verbatim (Claude parity). Notifications are lead-only — peers learn state through `send_message` or the board.

### 4. Shared task board

- `.pi/teams/t/<team-id>/tasks/<id>.json`: `pending | in_progress | completed` plus dependency ids; completing a task unblocks dependents automatically.
- Teammates self-claim through atomic lock directories; concurrent readers are tolerated.
- The board persists under the same retention as history; a new session starts a new team and never mutates an old board.

- The board is a coordination primitive only. Retry, acceptance criteria, review, priority and assignment policy remain `pi-tasks` domain (ADR 0005 boundary); integration v3 is unchanged.

The board does not replace `pi-tasks`. Board clients are teammates — child processes only the runtime can hand tools to — so the coordination primitive must live here. `pi-tasks` stays the durable, consumer-level task manager per ADR 0005 (priority, retry, acceptance, review, prompt construction; integration v3 unchanged). The two meet in one place only: a settled team's final board is a read-only artifact that `pi-tasks` may consume; no shared mutable state. Board tools exposed to teammates are namespaced `team_task_*` to avoid colliding with any consumer-level task tool surface in the same session.

Quality gates are two narrow, configured commands — not a generic hook framework: `team_task` completion may require an acceptance command, and a teammate going idle may require a definition-of-done command; exit code 2 blocks the transition and feeds the reason back to the agent. Built after the board exists.

### 5. Removed machinery

Live-child restore/re-adoption, quarantine for live runs, deferred active-row cleanup and session-scope re-attach disappear with the lifetime guarantee. Verified process identity, authenticated control, native settlement, model admission, launcher termination, worktree preservation and durable history remain.

## Constraints

- Execution stays in independent processes (no in-process backend); headless remains the non-terminal launcher.
- Team directories live under `.pi/teams/t/<team-id>/` with owner-only permissions matching other artifacts; the artifact root rename is [ADR 0008](./0008-rename-to-pi-teams.md).
- Child protocol v2 additions (mailbox/board integration) are additive.
- No broadcast primitive: one message per recipient (Claude parity).

## Trade-offs

Session crash loses in-flight teammate turns (JSONL keeps partial work). File mailboxes trade the single-writer hub for peer autonomy; per-message files and HMAC restore atomicity and sender identity. A persisted board can outlive its team as read-only data. Fixed lead, one team per session and no nested teams follow Claude parity.
