# ADR 0004: Independent process runtime with native control bridge

- **Status:** Accepted (lifetime independence superseded by [ADR 0007](./0007-session-bound-agent-teams.md); process runtime, authenticated control and native settlement remain)

## Context

Specialists serve direct delegation and a separate `pi-tasks` consumer. Their lifetime must not depend on parent conversation/session transitions. A real native Pi TUI is valuable for inspection, but terminal paste and pane/JSONL polling are not reliable control or completion protocols.

## Decision

Every child is an independent OS process. One process backend selects launchers:

```text
HerdR native Pi TUI → tmux native Pi TUI → independent headless worker
```

Interactive children load only a small bridge extension. Headless uses native SDK inside its own process. Parent manager never creates child AgentSessions. Interactive CLI resolves from the installed supported Pi peer, not a global PATH binary.

The bridge exposes authenticated owner-only Unix-socket NDJSON RPC: native prompt, steer, abort, state, transcript and ordered events. Native settled state owns completion. Terminal launcher owns creation/attachment/verified termination only. JSONL owns durable history and cold recovery, never continuous progress authority.

Native settlement first preserves outcome/session/worktree metadata, then automatically closes the verified child and HerdR/tmux pane. Resume always creates a new child using saved native JSONL and invocation configuration. Parent shutdown/session transitions detach control without killing active children. Startup reconnects saved authenticated handles and closes authenticated terminal outcomes through the same finalization policy. Disconnection is not fake completion; uncertain cleanup retains recovery receipts and blocks resume until resolved.

Model/auth admission precedes run IDs, queue slots, worktrees and child/pane creation. A usable specialist pin remains primary; unavailable primaries fall back through caller model, captured live parent and deterministic native authenticated models. No usable model rejects tool/events RPC without a started run. Cold resume validates the saved bootstrap first. Launch rechecks queued auth before resources; this does not claim remote credentials/quota validation.

Native interactive auth preflight is checked before the void-returning message dispatch, so missing credentials produce an authenticated failed RPC outcome rather than a permanently active bridge run. Failed handles follow manager finalization. Exited-resource cleanup verifies original process/group absence and saved endpoint/terminal ownership; failed reconnection or `alive(false)` alone never authorizes termination or dropping receipts. Session metadata advertises only materialized JSONL history.

Shared workspace is default. Optional isolated worktrees preserve existing agent commits and remaining changes, retain checkout for review/test, and expose ordered commit/cherry-pick metadata. Reviewer integrates explicitly, then releases checkout. Runtime does not merge, cherry-pick, force-prune or delete unpreserved changes.

## Constraints

- Child sessions exclude parent orchestration tools, preventing recursive delegation.
- Socket/bootstrap/registry credentials are owner-only; child identity and child protocol v2 are authenticated.
- HerdR identity uses saved socket/pane/terminal, PID birth and foreground group plus bridge PID; process title/environment are not durable ownership proofs.
- tmux/headless validate saved process/resource identity before destructive operations.
- Foreground/background share one concurrency budget.
- Public integration uses protocol v3; Task state stays outside the runtime.
- Worktree isolation is not a security sandbox against tools running as the same OS user.
- Supported environment requires an owner-only control transport (Unix sockets; named pipes on native Windows), Node >=22.19 and Pi peers >=1.0.4 <1.1.0.

## Trade-offs

Independent processes require authenticated reconnect, ownership checks and retained cleanup receipts. Socket pathname limits require a private short temp directory separate from durable artifacts. Interactive launch commands must be safely shell-quoted. Transport uncertainty deliberately retains resources rather than risking termination of a foreign process.

Native JSONL and saved bootstrap configuration are required for cold continuation; there is no retained idle child or parent SDK execution path. See [Architecture](../ARCHITECTURE.md) for recovery/security invariants and [Configuration](../CONFIGURATION.md#6-backend-selection) for launcher selection.
