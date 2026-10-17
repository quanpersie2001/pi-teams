# Architecture

## 1. System boundary

`pi-teams` owns specialist definitions, `AgentRun` execution and the unified session-scoped `Task` workflow. `Task` and `AgentRun` are distinct entities: tasks hold requirements/outcomes and refer to execution attempts; attempts use the existing AgentManager runtime. The public events RPC remains compatibility for third-party consumers.

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
extension-src/pi-teams/
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

`pi/index.ts` binds the live Pi context, registers tools/commands, loads settings/definitions, archives stale owned registry rows, installs UI projection and announces integration readiness. Startup never registers old process handles as manager runs or consumes execution capacity.

`Agent.prepareLoadout` exposes canonical enabled specialist names/effective descriptions before each model turn. `pi/agent-mention-autocomplete.ts` wraps public `ctx.ui.addAutocompleteProvider`, merges native/agent suggestions and delegates acceptance to the owning provider. It neither replaces the editor nor launches children.

Build emits `dist/extensions/pi-teams.js`, `child-bridge.js`, `headless-child.js`, `terminal-client.js` and shared chunks. Multiplexer panes run the packaged terminal client; their UI comes from the installed supported Pi peer's public `InteractiveMode`, not a custom Child View or a second Pi session.

## 5. AgentManager

The manager owns run admission, one foreground/background concurrency budget, queueing, pending startup controls, persistence, delivery and worktree coordination.

Spawn resolves the definition without tracking a run, selects an available backend and awaits native model/auth admission. Only then does it allocate the ID/snapshot/slot and launch or queue. A session epoch rejects admissions finishing after shutdown/session replacement. Admission failure creates no run, started event, worktree, child or pane.

Running steer/abort awaits child acceptance. Abort acknowledgement does not settle a launched run; native settlement does. A queued run can be stopped before launch. Lost prompt acknowledgement is admission uncertainty, not permission to forget a potentially running child. Task-specific retries and acceptance checks are not manager policy.

Time budgets add a manager-side watcher armed immediately before launch/resume (not admission or queueing). Only child output refreshes the idle clock. Expiry requests cooperative abort, then verified process-group termination after a 2-second grace; refusal remains a visible recovery error rather than fabricated settlement. Session teardown uses the same verified termination path after its own bounded grace.

## 6. Execution backend contract

`domain/backend.ts` defines the process execution port and optional focus, current-session assignment and native-pane attachment ports. Controls use opaque handles, never caller-supplied child identity.

`pi/process-backend.ts` maintains monotonic per-run outcomes. Child events trigger coalesced refreshes; transient current-session connection recovery authenticates and resynchronizes state. Deliberate detach releases control permanently: status cannot reattach it. Verified disposal may authenticate an old receipt solely to close its owned resource, without registering a run or mailbox observer.

`pi/model-admission.ts` uses native `ModelRuntime` in the child's configuration/auth directory. It captures the parent model before awaits, tries the resolved primary, caller fallback, captured parent and stable authenticated native candidates. Catalog refresh is offline; native OAuth may refresh. This is not a provider request, quota check or remote key-health guarantee. Launch repeats admission before artifacts/resources, covering queued auth changes.

Interactive native `sendUserMessage` is fire-and-forget: preflight failure may have no native settlement event. The bridge validates selected model/auth before dispatch. An authenticated `prompt_failed` rejection is failure authority for that request; retaining the failed handle lets normal finalization preserve receipts and clean resources. A filename with no actual JSONL is not resumable history.

## 7. Launchers and terminal observability

Launchers create, inspect liveness, attach and terminate; they do not execute/control the task through terminal input.

- **HerdR:** raw terminal client for the worker's native Pi UI. Shell-quoted command is passed as one `pane run` argument because that CLI joins command arguments. Ownership uses saved socket/pane/terminal, PID birth time and foreground process group. Process title/environment are not durable ownership evidence; `process-info` exposes `pid`/`argv0`, not an argv array. Attachment focuses only verified owned panes.
- **tmux:** raw terminal client for the worker's native Pi UI. Saved server socket/PID, pane PID and owner-marked startup command prevent targeting a reused pane or another server.
- **Headless execution:** every assignment executes in a detached independent Node process with a native SDK session, owner-marked process identity/group and private diagnostic log. Multiplexer-configured workers additionally run Pi's real `InteractiveMode` against a stable `Terminal`; explicit headless-only workers remain SDK-only. Execution PID, child ID, native context and owner control connection survive presentation changes.

Presentation reconciles against authenticated native execution: only `running` children get panes. Idle settlement tears down the terminal client/pane, not the named native worker; reassignment reconnects to the same UI/context/style. The six-child suppression threshold still counts every live worker, including idle teammates; geometry counts only visible panes.

Launchers never paste steer messages, press Enter for control, infer settlement from pane text/badges, or silently switch implementation after launch failure. Unavailable transport is unknown liveness, never authority to kill an unverified resource.

## 8. Child control bridge

`domain/child-protocol.ts`, `pi/child-rpc-client.ts` and `pi/child-bridge.ts` define child protocol **v2**, separate from public integration v3. `headless-child.ts` hosts execution and, when configured for multiplexer presentation, the native `AgentSessionRuntime`/`InteractiveMode` loop. `native-terminal.ts` implements Pi's public `Terminal`; `terminal-client.ts` relays raw output, keyboard input and dimensions without constructing a session or custom UI. Native identity uses the teammate's name as the child session display name when pi-style is enabled, placing `@name` in its editor frame. Its teammate color is recorded in the child's session through pi-style's editor-border color entry before `session_start`, equivalent to pi-style's `--color` presentation setting; the SDK child does not run Pi CLI flags. On unverified or older pi-style builds whose hex-color renderer crashes with Pi 1.1, border coloring is skipped so child startup remains safe. Without pi-style it retains the colored name widget. The reconnect repaint hook remains registered in both cases.

Interactive child resource loaders allowlist `@quandev104/pi-style` alongside the inline identity/session hooks. Main supplies actual loaded extension paths from public command `sourceInfo`; an empty snapshot means no style. Standalone backends resolve enabled configured package resources without installing missing sources. Package identity is checked before loading; other Main extensions and orchestration never execute in children. Explicit SDK-only workers skip style discovery entirely.

- Owner-only authenticated control endpoint — Unix domain socket on Unix, named pipe (`\\.\pipe\pi-teams-<childId>\control`) on Windows — with NDJSON requests/replies/events and child ID. Presentation uses a separate private terminal socket and HMAC-derived token that cannot authenticate owner RPC. Idle named composition routes through the signed mailbox and parent capacity admission; failed admission stays handled with native feedback rather than falling through to an untracked prompt.
- Newly created private directories use `0700`; bootstrap/socket files use `0600`. Short OS-temp socket paths avoid Unix pathname limits.
- Owner RPC frames are bounded to 1 MiB. Terminal frames are bounded to 64 KiB, with ordered output/backpressure and chunked input events validated as complete UTF-8. Transcript previews carry absolute cursor/offset and truncation metadata; full history remains in native JSONL.
- At settlement the bridge writes the complete final assistant text to an immutable `result.md` (0600): the first assignment uses `sessions/<child-id>/result.md`, subsequent assignments use `sessions/<child-id>/runs/<sha256(run-id)>/result.md`. `ChildOutcome.resultFile` carries the full-result pointer; the inline copy stays 8 KiB-bounded. Write failure degrades honestly to the inline copy without blocking native settlement.
- Orphan self-termination (ADR 0007 §1): losing the last authenticated owner arms the control-loss watch; terminal clients cannot keep an orphan alive. A silent window past reconnect grace means the parent died. The runtime aborts the active run through the native path, gives settlement a bounded window to persist the annotated partial result, then stops the host process. Presentation disconnection alone never aborts execution.
- Sequenced focus state carries native cwd/model/thinking/context/capabilities. Stable transcript IDs/revisions permit partial upserts; stale/wrong-run projections cannot rewind focus.
- Replay/deduplication prevents duplicate prompt admission and request-ID reuse with different contents.
- Native `agent_settled`, not `agent_end`, final text, pane disappearance or a sentinel, owns settlement. A natural final answer at the turn limit completes; continuing tool loops obey soft/grace/hard limits.
- Child messaging infers the sender from authenticated runtime context; children never install parent orchestration or the full-thread inspector.
- Native `/new`, `/resume` and `/fork` cannot replace the parent-owned child session; cancellable native hooks report the restriction. Parent Agent admission and explicit cold continuation own session replacement.

Incompatible live receipts are preserved without adopting their control credentials or terminating their resources.

## 9. Launcher selection

New launches resolve their presentation hint in this order: the session `/teams-backend` runtime switch (`auto`/`headless`), then the `PI_TEAMS_BACKEND` env override (`auto|herdr|tmux|headless`), then the `backend` settings key (`auto`/`headless`), then `auto`. Execution is always independent headless; auto selects the first available viewer launcher:

```text
auto → HerdR viewer → tmux viewer → no viewer
```

Forced unavailable launchers fail explicitly.

Terminal allocation is serialized by saved socket, Main pane and parent identity. Count all live runtime-owned execution children, including unnamed active children and named idle children, excluding Main. Zero leaves Main alone; one–three use two equal horizontal partitions with children stacked vertically; four–six use three equal horizontal partitions with child rows 2+2, 3+2 and 3+3 (separator/cell rounding applies). Above six, remove all managed viewers; returning to at most six recreates viewers without replacing execution PID/child ID/context or replaying assignments. Presentation changes synchronize durable viewer receipts and attachment availability. Preserve focus and foreign panes, and reject unverified/user-modified geometry rather than rearranging it.

Session teardown suppresses viewer recreation before stopping children; removing ending execution children never opens new viewers for the remaining ending cohort. The next session re-enables presentation only after old-team teardown completes.

Adding a full-height column reparents the prior column's lower rows beneath its top row. tmux uses same-window `join-pane`; HerdR uses a no-focus temporary-tab roundtrip because same-tab moves are no-ops. Pane identity is preserved and focused-leaf focus restored.

## 10. Durable registry and recovery

Registry/history live under the nearest original-project `.pi/teams/`; bootstraps and native sessions live under `sessions/<child-id>/`. Atomic registry writes use `0600` because handles include control credentials. Corrupt registry data is not silently rewritten as empty; incompatible records remain preserved.

`app/registry-archive.ts` performs archive-only startup reconciliation. Owned stale active rows become stopped history with an honest recovery note; owned terminal rows retain their saved outcome. Both attempt verified cleanup of any persisted resource. Cleanup failure is logged and recorded in `recoveryError`, not retained as a deferred active row. Historical cold resume fails closed when recovery metadata indicates unconfirmed child disposal. Foreign-owner rows are never inspected or changed; incompatible raw rows remain byte-for-value.

Persisted disposal validates bootstrap/control identity and the authenticated PID before launcher termination, or requires `ProcessLauncher.cleanupExited` proof that the original process/group is absent. Missing RPC or `alive(false)` alone is not permission to kill a replacement process or close an unverified pane. No live restoration, process quarantine queue or session-scope reattachment remains.

History, native JSONL, immutable results, preserved branches and worktree metadata remain available for explicit cold continuation. A saved terminal result cannot be overwritten by later process disappearance or cleanup failure.

Settled headless termination verifies identity before SIGTERM and waits for confirmed process/group exit. Its native signal handler flushes/disposes the SDK session; unconfirmed exit retains the receipt. RPC shutdown is not used first, avoiding an ownership-check race against an exiting process.

Resume is always cold: validate saved bootstrap, admit its model, open persisted native JSONL with saved invocation configuration in a new child/run. Resolve pending cleanup first. Released/missing worktrees are not recreated silently. JSONL is closed history/recovery, never a polled live completion/progress signal.

## 11. Model tools and recursion guard

Parent orchestration tools are `Agent`, `get_subagent_result`, `steer_subagent`, `teammate_status`, `teammate_release` and `teammate_shutdown`. Lifecycle tools are lead-only; children omit them with the parent orchestration extension. Teammate state is `idle|busy|released` (`busy` includes queue); recovery/availability is a separate `available|unavailable` status with optional error. `contextAvailable` is true only when idle with backend/handle verified by runtime ownership checks and no runtime/roster unavailability; it is not a process-liveness poll/proof. `currentRunId` is the live runtime owner, distinct from `lastRunId` (latest assignment artifact), and absent after release. Release requires settled children and preserves membership. Teammate shutdown fences admission, stops busy work, reconciles task attempts/claims, and removes membership only after verified cleanup; unresolved cleanup retains recovery state. Stop ends only the assignment. Neither shutdown nor stop implies task completion. With omitted `Agent` context, idle retained contexts continue and new/released identities start fresh. Explicit `continue` requires idle retained context and fails otherwise; explicit `fresh` closes a verified-idle retained child and starts a new native session with fixed role/name/color. Pending mailbox entries are archived with the reset reason, never replayed. Cold `Agent(resume, prompt)` requires explicit release for named teammates and is separate transcript recovery into a new run. `list_models` is model-facing but not an orchestration tool: read-only, it resolves a model reference against the registered native catalog before spawning (optional `query` and `limit`, canonical `provider/id` rows sorted by reference), and starts no run or run state. A new `Agent` spawn requires type/description/name/color. In the TUI, each successfully admitted background `Agent` call with a deliverable conversation result marks its tool result `terminate: true`. Pi ends the parent turn only if **every** tool result in the batch agrees (pure async-launch batch); a mixed batch or foreground/error result does not force termination. Print/JSON/RPC tool calls wait inline, regardless of requested background mode, because a later lead turn cannot be relied on. The child itself keeps running after the coordinator ends its turn.

`get_subagent_result` is repeatable (roadmap 1.1b): it re-reads the durable `result.md` artifact on every call, prints a truncation note with the file path when only the bounded inline copy is available, and degrades to the inline copy with an explicit note when the file is unreadable. Reading marks `resultConsumed`, which only suppresses the duplicate completion notification. `wait: true` is reserved for an immediate dependency; a pure background launch batch should yield the parent turn and let its completion notification start the next turn.

## 12. Integration

The public boundary is `pi.events` RPC **v3**: legacy `ping`, `spawn`, run `status`, `steer`, `stop`, `resume`, and run `release`, plus additive `teammate_status`, `teammate_release`, and `teammate_shutdown` operations and owner-aware lifecycle broadcasts. Ping advertises optional additive capabilities; existing run-ID operations retain their semantics. The same-process service registry is internal and does not execute specialist sessions in the parent. See [Integration](./INTEGRATION.md).

## 13. Ownership and delivery

Conversation-owned runs notify their owning conversation. Extension-owned runs emit lifecycle events for compatibility consumers; first-party Tasks are separate session-scoped entities whose transitions are explicit. Owner metadata does not conflate Task and AgentRun. See [ADR 0009](./decisions/0009-unified-session-tasks.md).

The completion notification is runtime-authored and lead-only: a `teammate-notification` custom message (`followUp`, `triggerTurn: true`) whose plain-text `content` is the canonical presentation — teammate/outcome header line, 400-char preview, `full result: <path>` footer — and whose `details` (`agentId`, `type`, `description`, `status`, `outcome`, optional `resultFile`/`durationMs`/`totalTokens`) plus the customType form the exported renderer contract ([Integration](./INTEGRATION.md)). Background `Agent` launches in the same turn are joined into one notification with a section/path per unconsumed result (`details.others` for additional runs). The join waits up to 30 seconds after the first settlement, rebatching late stragglers for up to 15 seconds. Conversation notifications are held 200 ms so an explicit result retrieval can suppress them; the guard is checked when dispatched. Lifecycle events never wait for the join. The runtime ships no custom message renderer; hosts without one display the content verbatim.

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

- `session_start`: load configuration, create the session's team, archive stale owned receipts without re-adoption, install UI projection and announce ready.
- Session switch/end/shutdown awaits teardown of every child (abort → 15-second cooperative grace → verified force-termination), then releases control and persists artifacts. A session switch cannot re-arm the manager while the old team's teardown is still running or child cleanup remains unconfirmed. Failed teardown retains recovery state and rejects session replacement rather than reporting success.
- Child-side orphan detection: the authenticated control socket staying silent past a short reconnect grace aborts the current turn natively, preserves the annotated partial `result.md` ("stopped: parent control lost") and stops the child process (headless exit / TUI pane close). A hung parent that keeps its socket changes nothing.
- `stop`: acknowledge native abort; native settlement preserves artifacts. Anonymous children close; named teammates retain their native process for the next assignment until teardown.
- `/agents release <id>` or RPC `release`: retry retained verified child-resource cleanup; retain checkout.
- `/agents release <id> --worktree` or `cleanupWorktree: true`: also remove clean preserved checkout after review/integration.
- Active related runs must settle before release. Cleanup failure retains recovery metadata.

The parent renderer owns the inline panel, Team Hub and remote-focus overlay, not child InteractiveMode. UI disposal/hiding is not runtime dismissal, history deletion or child termination. See the [UI contract](./ui/AGENT-PANEL-AND-VIEW.md) for keyboard, mouse, native editor ownership and terminal-column behavior.

`app/mailbox-service.ts` stores signed peer messages as atomic owner-only files. `pi/child-mailbox.ts` and the lead delivery adapter watch, verify and inject their participant's inbox; malformed entries are quarantined. Models never poll. Native prompt/steer admission (children) or a matching custom-message `message_end` event (lead) precedes consumption. Mailbox assignment metadata passes through the parent's normal capacity queue; peer content is never relayed through a messaging hub. Named idle children remain alive until teardown, and subsequent assignments reuse their native process. Each assignment retains an immutable full-result file; follow-on results live under `sessions/<child-id>/runs/<sha256(run-id)>/result.md`. See [Peer mailboxes](./INTEGRATION.md#peer-mailboxes).

## 18. Team roster (ADR 0007 §2)

One team per session, created at `session_start`; the team id derives from the session id and lives under `.pi/teams/t/<team-id>/` (`config.json`, owner-only, atomic writes). On restart, persisted live members become `released`; roster snapshots never restore live child availability. The roster records identity and lifecycle/availability snapshots (name, specialist type, color, latest run, lifecycle, optional recovery status) through app-layer `TeamService`; absent availability is interpreted as available for compatibility. Role/name/color are fixed. Teammates can be reused while idle; explicit fresh context closes the old idle native child and starts a new session identity without importing prior context. Release archives pending mailbox files after successful resource disposal. The planned shutdown operation removes live membership after verified cleanup; name reuse must allocate a new membership identity. This lifecycle migration is in progress. The completion notification header addresses named runs as `Teammate @<name>`; `lead` is reserved.

## 19. Unified Tasks

`TaskBoardService` persists session-scoped task records with typed spec, context, outcome, revision snapshots and attempts. Task writes atomically use schema version 2 with `requirementRevision`, `spec`, `context` and `attempts` present. Reads accept v2 only when those fields and task/attempt/snapshot structures validate. Unversioned legacy and explicit v1 records normalize missing revision to 1 and missing spec/context/attempts to empty values while preserving supplied valid fields; their next write upgrades to v2. Other or malformed schema versions are rejected, not downgraded. Tasks have pending, in-progress, review, completed and cancelled states; dependency blockers are derived from prerequisite state.

The public `tasks_create/list/get/update/cancel/execute/output/stop` tools manage this entity. An optional root `executionPlan` (`type`, optional `name`, `color`, `model`, `maxTurns`) is supplied only at create/update and frozen into the requirement snapshot; `tasks_execute` does not accept it. Updating a pending task with `executionPlan: null` clears its plan and increments `requirementRevision`; an empty `expectedOutput` is an explicit spec patch. Automatic dispatch passes the observed `expectedRequirementRevision` and `expectedStatus: "pending"`; `reserveExecution` validates both atomically before mutation, preventing a stale pending decision from overwriting a concurrent manual claim. If either precondition mismatches, including a concurrent plan change/clear (such as `type`, `name`, or `model`) while waiting to reserve, launch is skipped before spawn without owner/attempt mutation and the deduplication entry is cleared without immediate rescheduling. The pending-status precondition applies to automation only; manual `tasks_execute` can execute unblocked pending or claimed tasks (non-coordinators must own a claimed task). Reservation retry exhaustion also clears deduplication so a later completion transition can trigger another eligibility check. Claiming is explicit; execution invokes the existing TaskExecutionService/AgentManager and records an attempt. A settled run is not task completion: owner/coordinator acceptance is explicit, and stopping an attempt never completes the task. Requested review must be submitted before acceptance.

Optional automation is configured by nested `tasks.autoCascade` and `tasks.reminders`, both false by default and merged per field. With cascade enabled, startup snapshots current statuses so existing completed tasks are not replayed. New accepted transitions to `completed` are observed from local board events and the shared task-directory watcher (including newly discovered completed rows and peer board-service completions); each transition queues/coalesces its task ID/code into a microtask. It considers pending tasks with a plan whose dependencies intersect those completed references and whose blockers are all clear, then dispatches through normal TaskExecutionService admission. Each planned task is launched at most once per service; typed reservation-lock conflicts get bounded asynchronous retries at 100/250/500 ms before launch. These retries do not retry spawn failures; launch failures are not automatically retried. Disposing automation cancels queued work and in-flight reservation retries; TaskExecutionService rolls back a reservation if cancellation arrives after reserve and before spawn. Session teardown disables reminders and disposes automation, then freezes TaskExecution admissions before child shutdown. Plans are task-specific, not inferred. Reminders are lead-only: every four lead turns, reset by any `tasks_*` tool result, a hidden transient context message summarizes relevant pending (unassigned/lead-assigned), lead-owned in-progress, and review-requested in-review tasks. Summaries are bounded to 10 items and 1,700 serialized JSON characters; no reminder is emitted for an empty set. Session/service disposal bounds automation to the owning session.

Tasks are scoped to the active session/team. Board operations use an exclusive `board.lock` `wx` token (`pid:uuid`); unlink/reclaim is serialized by a sibling `board.lock.mutation` directory. The mutation marker is removed only by its creator and is never auto-reclaimed: if stranded by a crash, stop every old and new writer and remove it manually before operations can resume. Stale-lock reclaim rechecks the exact token, validates the PID with `kill(pid, 0)` requiring `ESRCH`, then unlinks and reacquires under the marker; races fail closed. Owner release compares its token under the marker and asynchronously retries contention at 10/20/40/80/160/320 ms (no busy-wait), then logs and leaves the lock on exhaustion. A surviving owner token remains blocking until release/process exit, after which PID reclaim can proceed unless the marker itself was stranded. The public events RPC remains retained compatibility for third-party consumers; its default owner may still be `pi-tasks`. See [ADR 0009](./decisions/0009-unified-session-tasks.md).

## 20. Exclusions and runtime boundary

No cross-session task workflow, nested delegation, retry/priority automation, semantic memory, group joins, automatic integration, parent SDK fallback, terminal-input task steering or process security sandbox. See [ADR 0003](./decisions/0003-deliberate-feature-scope.md) and [ADR 0009](./decisions/0009-unified-session-tasks.md).

Requires Node **22.19+**, Pi **>=1.0.4 <1.1.0** and an owner-only control transport: Unix domain sockets on Unix, named pipes on native Windows (headless OS-children with `taskkill /T` lifecycle and CIM identity, CI-covered on windows-latest). Pi SDK/TUI packages and TypeBox are host-provided peers. Standalone Node children use a module hook to resolve them from the running Pi installation (the parent's extension-loader aliases do not apply in Node). Optional HerdR/tmux add native terminal attachment; headless does not require them. These requirements do not imply support for platforms without the required process/socket facilities.


### Independent peer messaging status

The Pi host registers `peer_sessions`, `peer_send`, and `peer_activity` when peer support is enabled and exposes receiver-owned accept/hold/refuse controls plus held-message approval actions. Unix authenticated transport and multi-process transport tests pass; Windows peer runtime remains fail-closed until a real ACL verifier is supplied. Native independent Pi-session delivery and TUI approval behavior have not been manually verified. Peers are independent sessions: they do not own one another, share task authority, or gain lifecycle control.
