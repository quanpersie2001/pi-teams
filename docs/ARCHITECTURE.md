# Architecture

## 1. System boundary

`pi-subagents` owns specialist definitions and `AgentRun` execution. Task status, dependencies, priority, assignment/retry, acceptance criteria and review belong to consumers such as `pi-tasks`.

```text
model tools / agent UI / extension consumers
                    │
               AgentManager
                    │
       ProcessAgentExecutionBackend
                    │ authenticated Unix-socket RPC
                    ▼
           independent Pi OS process
           ├── native prompt / steer / abort / session
           ├── child control bridge
           └── durable native session JSONL
```

Every specialist runs in an independent process. SDK creates the native session inside the headless child only; the parent has no in-process execution fallback. See [ADR 0004](./decisions/0004-independent-process-runtime.md).

## 2. Repository and layers

```text
extension-src/pi-subagents/
├── shared/     host-independent primitives
├── domain/     contracts, state transitions and policies
├── features/   isolated UI surfaces
├── app/        manager, registries, delivery and worktree services
└── pi/         Pi, process, socket, filesystem and Git adapters
```

Composition order is `shared → domain → features → app → pi`; higher layers may depend on lower layers subject to these rules:

- **ARCH-001:** shared imports no upper layer or Pi package.
- **ARCH-002:** domain imports no concrete Pi, filesystem/process adapter or feature.
- **ARCH-003:** features do not import sibling features; app composes them.
- **ARCH-004:** app does not import pi.
- **ARCH-005:** concrete host/storage/launcher implementations live in pi; ports live in domain/app.
- **ARCH-006:** `pi/index.ts` is a thin extension factory.
- **ARCH-007:** rendering performs no filesystem, Git, process, polling or network I/O.
- **ARCH-008:** immutable snapshots separate mutable runtime state from UI rendering.

Dependency-cruiser enforces import boundaries. See [ADR 0006](./decisions/0006-layered-extension-architecture.md).

## 3. Domain model

`AgentDefinition` resolves specialist instructions, prompt mode, tools, model/thinking, turn budget, optional time budgets (`timeout`, `idle_timeout` with the `idle-timeout` alias), default background mode and isolation. An admitted invocation keeps its resolved snapshot across definition reloads.

`AgentRun` is one invocation, not a Task or an entire session. It contains:

- status: `queued`, `starting`, `running`, `completed`, `aborted`, `stopped`, `error`;
- backend `process`, opaque handle and materialized native session file when available;
- result/error, usage, per-run turns/tools, model/fallback and lifecycle timestamps;
- effective time budgets, budget launch/activity timestamps and the exhausted budget/seconds when a budget stopped the run;
- owner/delivery and parent session/branch context;
- optional worktree and preserved commit metadata;
- separate `recoveryError` for preservation/cleanup failure, without rewriting a valid native outcome.

Steering is a command, not a lifecycle state. Backend `disconnected` is unknown child state, not completion or proof of process death.

## 4. Composition root

`pi/index.ts` binds the live Pi context, registers tools/commands, loads settings/definitions, restores authenticated handles, installs initial UI projection and announces integration readiness. Restoration precedes UI initialization; settled history needs no fresh event to appear. Restored native terminal outcomes follow the same finalization/cleanup policy as new runs.

`Agent.prepareLoadout` exposes canonical enabled specialist names/effective descriptions before each model turn. `pi/agent-mention-autocomplete.ts` wraps public `ctx.ui.addAutocompleteProvider`, merges native/agent suggestions and delegates acceptance to the owning provider. It neither replaces the editor nor launches children.

Build emits `dist/extensions/pi-subagents.js`, `child-bridge.js`, `headless-child.js` and shared chunks. Interactive launchers resolve the installed supported Pi peer's CLI, not global `pi` from PATH.

## 5. AgentManager

The manager owns run admission, one foreground/background concurrency budget, queueing, pending startup controls, persistence, delivery and worktree coordination.

Spawn resolves the definition without tracking a run, selects an available backend and awaits native model/auth admission. Only then does it allocate the ID/snapshot/slot and launch or queue. A session epoch rejects admissions finishing after shutdown/session replacement. Admission failure creates no run, started event, worktree, child or pane.

Running steer/abort awaits child acceptance. Abort acknowledgement does not settle a launched run; native settlement does. A queued run can be stopped before launch. Lost prompt acknowledgement is admission uncertainty, not permission to forget a potentially running child. Task-specific retries and acceptance checks are not manager policy.

Time budgets add a manager-side watcher armed immediately before launch/resume (not admission or queueing) that samples pure `decideTimeBudget` decisions and observes child output through existing backend RPC/events — never session-file polling. The idle clock refreshes only on child output arrivals; steers, inbox/user messages and usage refreshes do not. Budget expiry is the only exception to abort-only stopping: after a 2-second cooperative grace it force-terminates the owned child process group through a budget-only verified backend path, and enforcement refusal surfaces as `recoveryError` with a retained receipt rather than a fabricated settlement. Ordinary steer/stop keeps abort semantics.

## 6. Execution backend contract

`domain/backend.ts` defines the process execution port and optional focus/messaging/attachment ports. Controls use opaque handles, never caller-supplied child identity.

`pi/process-backend.ts` maintains monotonic per-run outcomes. Child events trigger coalesced refreshes; reconnect authenticates and resynchronizes state. Detach removes client observers without terminating active children. Later status/restore can reattach them.

`pi/model-admission.ts` uses native `ModelRuntime` in the child's configuration/auth directory. It captures the parent model before awaits, tries the resolved primary, caller fallback, captured parent and stable authenticated native candidates. Catalog refresh is offline; native OAuth may refresh. This is not a provider request, quota check or remote key-health guarantee. Launch repeats admission before artifacts/resources, covering queued auth changes.

Interactive native `sendUserMessage` is fire-and-forget: preflight failure may have no native settlement event. The bridge validates selected model/auth before dispatch. An authenticated `prompt_failed` rejection is failure authority for that request; retaining the failed handle lets normal finalization preserve receipts and clean resources. A filename with no actual JSONL is not resumable history.

## 7. Launchers and terminal observability

Launchers create, inspect liveness, attach and terminate; they do not execute/control the task through terminal input.

- **HerdR:** interactive native Pi TUI. Shell-quoted command is passed as one `pane run` argument because that CLI joins command arguments. Ownership uses saved socket/pane/terminal, PID birth time, foreground process group and authenticated bridge PID. Process title/environment are not durable ownership evidence; `process-info` exposes `pid`/`argv0`, not an argv array. Attachment focuses only verified owned panes.
- **tmux:** interactive native Pi TUI. Saved server socket/PID, pane PID and owner-marked startup command prevent targeting a reused pane or another server.
- **Headless:** detached independent Node process with a native SDK session, owner-marked process identity/group and private diagnostic log; no terminal attachment.

Launchers never paste steer messages, press Enter for control, infer settlement from pane text/badges, or silently switch implementation after launch failure. Unavailable transport is unknown liveness, never authority to kill an unverified resource.

## 8. Child control bridge

`domain/child-protocol.ts`, `pi/child-rpc-client.ts` and `pi/child-bridge.ts` define child protocol **v2**, separate from public integration v3. `headless-child.ts` uses the same bridge with a native SDK session; interactive children load its small extension.

- Authenticated Unix socket with NDJSON requests/replies/events, child ID and random token.
- Newly created private directories use `0700`; bootstrap/socket files use `0600`. Short OS-temp socket paths avoid Unix pathname limits.
- Frames are bounded to 1 MiB. Transcript previews carry absolute cursor/offset and truncation metadata; full history remains in native JSONL.
- Native prompt, steer, abort, state, focus controls, messaging and shutdown are independent of terminal input.
- Sequenced focus state carries native cwd/model/thinking/context/capabilities. Stable transcript IDs/revisions permit partial upserts; stale/wrong-run projections cannot rewind focus.
- Replay/deduplication prevents duplicate prompt admission and request-ID reuse with different contents.
- Native `agent_settled`, not `agent_end`, final text, pane disappearance or a sentinel, owns settlement. A natural final answer at the turn limit completes; continuing tool loops obey soft/grace/hard limits.
- Child messaging infers the sender from authenticated runtime context; children never install parent orchestration or the full-thread inspector.

Incompatible live receipts are preserved without adopting their control credentials or terminating their resources.

## 9. Launcher selection

New launches resolve their launcher hint in this order: the session `/sub-agents-backend` runtime switch (`auto`/`headless`), then the `PI_SUBAGENTS_BACKEND` env override (`auto|herdr|tmux|headless`), then the `backend` settings key (`auto`/`headless`), then `auto`. It is a launcher hint, not an alternate execution backend. Auto chooses the first available launcher:

```text
auto → HerdR → tmux → independent headless child
```

Forced unavailable launchers fail explicitly.

Terminal allocation is serialized by saved socket, Main pane and parent identity. Main remains full-height on the left. The first child splits Main right at 50%; each child column holds at most three panes. Allocate into the earliest non-full column; when all are full, add a full-height column on the right. Balance only owned rows within their columns; closing a child does not compact survivors across columns. Preserve focus and foreign panes, and reject unverified/user-modified geometry rather than rearranging it.

Adding a full-height column reparents the prior column's lower rows beneath its top row. tmux uses same-window `join-pane`; HerdR uses a no-focus temporary-tab roundtrip because same-tab moves are no-ops. Pane identity is preserved and focused-leaf focus restored.

## 10. Durable registry and recovery

Registry/history live under the nearest original-project `.pi/subagents/`; bootstraps and native sessions live under `sessions/<child-id>/`. Atomic registry writes use `0600` because handles include control credentials. Corrupt registry data is not silently rewritten as empty; incompatible records remain preserved.

Restore validates bootstrap identity, authenticates RPC and reconciles native outcomes. Stored terminal results stay authoritative even if their process later disappears. Verified child loss sets `BackendStatus.outcomeUnavailable`: it fails an active execution but cannot overwrite a saved terminal result/error.

An authenticated PID mismatch against a non-tmux launcher identity quarantines control: disconnect/unwatch, stop reconnect attempts, reject steer/abort/resume/attach, and retain the resource receipt.

Disposal requires an authenticated idle snapshot plus verified launcher termination, or `ProcessLauncher.cleanupExited` proof that the original process/group is absent and the saved terminal endpoint remains owned. `alive(false)` or missing RPC alone is insufficient: it may mean identity mismatch or transport uncertainty. Missing owned resources are idempotent success; foreign/replacement/live-disconnected resources retain a visible cleanup error and receipt. Startup retries this verified disposal for saved terminal rows; active rows without RPC remain deferred.

Settled headless termination verifies identity before SIGTERM and waits for confirmed process/group exit. Its native signal handler flushes/disposes the SDK session; unconfirmed exit retains the receipt. RPC shutdown is not used first, avoiding an ownership-check race against an exiting process.

Resume is always cold: validate saved bootstrap, admit its model, open persisted native JSONL with saved invocation configuration in a new child/run. Resolve pending cleanup first. Released/missing worktrees are not recreated silently. JSONL is closed history/recovery, never a polled live completion/progress signal.

## 11. Model tools and recursion guard

Parent orchestration tools are `Agent`, `get_subagent_result`, `steer_subagent`; stop/release use UI, commands or integration. Children set `PI_SUBAGENTS_CHILD=1`, omit the parent orchestration extension and exclude these tools.

`Agent` accepts only implemented inputs. Instance `name`, `inherit_context` and invocation `isolation` are unsupported; supply context in the prompt and configure isolation on the specialist/master switch.

## 12. Integration

The public boundary is `pi.events` RPC **v3**: `ping`, `spawn`, `status`, `steer`, `stop`, `resume`, `release` and owner-aware lifecycle broadcasts. The same-process service registry is internal and does not execute specialist sessions in the parent. See [Integration](./INTEGRATION.md).

## 13. Ownership and delivery

Conversation-owned runs notify their owning conversation. Extension-owned runs emit lifecycle events; the consumer decides Task transitions/review notifications. Owner metadata does not introduce a Task domain. See [ADR 0005](./decisions/0005-separate-task-and-agent-domains.md).

## 14. Delivery guard

Conversation delivery checks session identity, branch ancestry, policy and consumption state. Stale-context results stay recoverable, never injected into another conversation. Delivery stays subscribed for the app lifetime because `/new`, `/resume` and `/fork` can reuse the app; its host reads the latest context dynamically. Session shutdown detaches clients but must not permanently disable future completions.

## 15. Workspace and optional worktree

Shared workspace is default (`worktreeIsolation: false`). Isolated checkout requires both the master switch and specialist `isolation: worktree`; no invocation override exists.

```text
canonical repository + immutable base SHA
        ↓
detached checkout preserving package-relative execution cwd
        ↓
preserve agent commits and remaining dirty changes on a branch
        ↓
report base/commit SHA, ordered commits and cherry-pick guidance
        ↓
user reviews / tests / manually integrates
        ↓
explicit release removes clean preserved checkout, not branch
```

Preservation failure retains the checkout with `recoveryError`. Release is non-forced and refuses dirty/unpreserved commits. Runtime never auto-merges, auto-cherry-picks, deletes review branches or prunes live review checkouts.

`cwd` is execution location; `configCwd` remains the configuration source; `baseRepo` is the canonical Git root. Canonical containment checks cover monorepo subdirectories and symlink escapes. Worktrees isolate filesystems, not tools running as the same OS user.

## 16. Concurrency

`maxConcurrent` covers active foreground and background runs together. Both queue when capacity is full; foreground waits rather than bypassing the budget. Settlement releases the slot/drains the queue. Physical cleanup follows durable finalization, not terminal activity.

## 17. Lifecycle and explicit cleanup

- `session_start`: load configuration, restore handles, install UI projection, announce ready.
- Session switch/shutdown: detach clients and persist receipts; active children and review checkouts remain independent.
- `stop`: acknowledge native abort; authoritative settlement preserves artifacts and closes owned child/pane.
- `/agents release <id>` or RPC `release`: retry retained verified child-resource cleanup; retain checkout.
- `/agents release <id> --worktree` or `cleanupWorktree: true`: also remove clean preserved checkout after review/integration.
- Active related runs must settle before release. Cleanup failure retains recovery metadata.

The parent renderer owns the inline panel, Agents Hub and remote-focus overlay, not child InteractiveMode. UI disposal/hiding is not runtime dismissal, history deletion or child termination. See the [UI contract](./ui/AGENT-PANEL-AND-VIEW.md) for keyboard, mouse, native editor ownership and terminal-column behavior.

`app/message-service.ts` owns scoped bounded process-local inbox receipts with distinct delivered/consumed timestamps. Messages are separate from composer steer and completion delivery. Closed recipients wait for cold continuation with stable message IDs; reload/restart clears memory. See [Integration messaging](./INTEGRATION.md#scoped-inbox-messaging) for tools, limits and trusted sender/session rules.

## 18. Exclusions and runtime boundary

No Task/DAG workflow, nested delegation, scheduling, semantic memory, group joins, automatic integration, parent SDK fallback, terminal-input task steering or process security sandbox. See [ADR 0003](./decisions/0003-deliberate-feature-scope.md).

Requires Node **22.19+**, Unix sockets and Pi peers **>=1.0.4 <1.1.0**. Optional HerdR/tmux add native terminal attachment; headless does not require them. These requirements do not imply support for platforms without the required process/socket facilities.
