# Team Hub and remote child focus

## Layout and ownership

The inline panel stays below Main's native editor. Down from an empty Main prompt selects inline bottom navigation at Main without opening an overlay. `/agents`, Alt+G or two consecutive Left presses within 500 ms at the start of Main's document opens the native Team Hub with Main and current teammates/runs; an empty Hub still exposes Main. Selecting a child opens an opaque remote-focus overlay with native transcript components and its own composer. There is one parent renderer: no child InteractiveMode is mounted. Returning preserves Main's draft. `agentPanel: false` hides the UI without stopping children.

```text
Main: conversation → native editor → agents panel → native footer
Hub: Main + child rows → keyboard or fullscreen mouse selection
View: child header → native transcript → separate composer → viewer controls
```

If another extension owns the custom editor, do not replace it unconditionally. When the foreign editor still preserves native `Editor` semantics (a styled subclass, e.g. pi-style's `CustomEditor` derivative), the document-start gestures keep working because cursor/autocomplete remain observable. When the foreign editor is opaque — or the focus owner cannot be observed — its keys are never claimed and `/agents` provides the alternative selector/view path.

## State and transcript authority

Every launcher uses the same independent-process backend. Live state/transcript arrives through authenticated bridge RPC/events; terminal badges, pane content and JSONL polling do not decide run completion. JSONL supplies history/recovery when no live child remains.

`AgentManager` owns lifecycle and authoritative focus subscriptions; `app/focus-service.ts` projects native child snapshots without borrowing Main's model, thinking or cwd. Transcript adapters supply closed history, `pi/ui-host.ts` owns installation/routing, and feature renderers consume immutable snapshots and emit intent without filesystem, Git or backend I/O. Rendered lines fit the available visible width.

Initial projection is rendered immediately after registry restore. Per-run turns/tool uses and input/output token totals come from authoritative AgentRun counters, not the whole resumed session history. Active transcript activity is bounded to one line; settled rows retain their own result/error even when a continuation appends to the same JSONL.
Live focus adds native model, thinking, cwd and context usage plus capability-gated controls. Sequenced snapshots and partial-item upserts avoid duplicate streaming text on reconnect. Closed runs expose history and cold continuation, not live controls. The Hub lists one row per named teammate (its latest assignment) and one row per anonymous run from the current manager, not every archived run after reload. Mailbox messages create assignments, not extra teammate rows; durable run history remains available to orchestration by run ID.

## Panel and Team Hub

The inline panel shows queued/starting/running agents and unconfirmed cleanup receipts. Settled runs with confirmed resources disappear automatically, including named teammates whose processes remain idle. When no active assignments or uncertain resources remain, the whole inline widget is removed. The Hub retains the latest row for each named teammate and the current manager's anonymous run history; hiding an idle row does not release its process or context.

Hub and inline rows share a compact layout: one selection/status-colored circle, teammate name (specialist type for anonymous runs), description, then right-aligned elapsed time and total per-run tokens (`25m 7s · ↓ 146.5k tokens`, excluding cache reads). Rows omit process labels, result/activity previews, tool/turn counts, owner references and worktree branches; detailed transcript views retain diagnostic information. Settled elapsed time freezes at completion. Active Hub rows precede settled teammates and anonymous run history. Abort confirmation and unconfirmed cleanup replace the right-hand stats so warnings remain visible on narrow rows.

| Input | Action |
|---|---|
| `/agents`, Alt+G | open Team Hub |
| Left twice within 500 ms at Main document start (including inline navigation) | open Team Hub; first Left stays native |
| Down with empty Main prompt and visible inline rows | select Main in bottom navigation, not Hub |
| Up / Down | select main/run |
| PgUp / PgDn | page selection (six rows) |
| Home / End | main / last row |
| Enter | selected transcript |
| Esc | return editor focus |
| `x` twice on active selection | native abort |
| `x` on settled selection | dismiss row, not resource cleanup |
| `o` on attachable selection | open verified native pane |

Fullscreen Hub row clicks select a child through Pi's public mouse API. Regular mode uses keyboard navigation. The inline panel still belongs to Pi's native viewport; it is not a second terminal UI.

Main arrow gestures require native editor ownership and no autocomplete or other visible overlay. Slash-command menus, text/multiline cursor movement and other dialogs keep their arrows, even when Main's detached draft is empty. Double Left requires line 0/column 0; a nonempty draft at that boundary is preserved. Other input, text/focus/session changes or elapsed time reset the pair. Kitty held-repeat events do not count; legacy terminals without repeat metadata cannot distinguish a held repeat from another press. Inline navigation selects only visible active/uncertain rows, not hidden settled Hub history.

## Agent mentions and discovery

Main's native autocomplete wraps the public Pi provider API, not the editor. `@` and partial names offer enabled bundled and merged file-defined agents with canonical names/effective descriptions. Native files and other provider triggers remain available; selecting a native file retains its original prefix/insertion behavior. Agent acceptance replaces only the mention token, preserves surrounding text and does not auto-spawn.

The `Agent` tool's native `prepareLoadout` hook supplies the live enabled catalog before the model's first call and after registry reload. Models should use canonical names (`general-purpose`, `explore`, `scout`, `reviewer`, or configured names), not guess `general`. Unknown types remain rejected unless an explicit `fallbackSubagent` is configured; no legacy aliases are installed.

## Agent view

Native user/assistant/tool components render normalized transcript items. A matched tool call/result renders **once** with the native result; orphan results remain visible in bounded history. Cached tool components update when output changes. Replayed completed tools do not invent an execution start or display a synthetic `Took 0.0s`.

The header shows status, specialist/description, elapsed time, per-run tools/turns and input/output totals, followed by the child's model, thinking, native context usage and cwd when available. Unknown child state is not replaced by Main's state. The overlay fills the visible viewport with terminal-default background so Main remains hidden without recoloring the entire view. Its header and editor use the selected teammate's name and identity color; an optional pi-style detached editor uses the same identity and live style configuration without borrowing Main's snapshot.

| Input | Action |
|---|---|
| text + Enter, active run | native steer |
| text + Enter, settled run | resume as NEW run with retained native context |
| Up / Down / PgUp / PgDn with empty composer | transcript scrolling |
| Esc | close view; active child continues |
| Alt+Left / Alt+Right with empty composer | previous / next sibling |
| Alt+Up with empty composer | return to Main |
| Ctrl+X twice with empty composer | abort active run |
| Alt+O with empty composer, when advertised | focus/open verified native child pane |
| native expand-tools shortcut (Ctrl+O by default) | expand/collapse tool output |

Printable `x`/`o` are composer text. With non-empty text, cursor/page navigation belongs to the native editor. Enter invokes child RPC, not terminal paste. Drafts, viewport position and global/per-tool expansion are preserved independently per run; returning from mouse-selected focus restores Main keyboard focus.

`/model <provider/id>` and `/thinking <level>` are live-child commands advertised by native capabilities. Accepted commands clear the submitted draft without rewinding a newer streamed snapshot; they never transfer to Main or persist parent settings. Unsupported/invalid commands retain the draft with inline feedback. The focus API does not support manual `/compact`; compaction must not abort a native run as a side effect of a viewer control.

Fullscreen mouse handling uses Pi's public API for row selection, composer focus, wheel scrolling, tool expansion and native visible-screen drag selection. Drag/release events remain owned by Pi, not a custom clipboard implementation. Regular mode is keyboard-driven. Scroll restoration computes expanded tool heights before clamping the viewport.

## Capabilities and errors

HerdR/tmux panes show Pi's actual native `InteractiveMode`: its transcript, editor, footer and built-in menus, not the parent Hub's custom Child View. The UI and SDK execution share one worker/session; a separate terminal client relays raw input/output and resize. Attachment requires verified saved presentation pane/process identity. With no pane, the parent Hub still supports transcript/control. Parent prompt/steer/abort/state/transcript use owner RPC, not multiplexer input injection.

When Main loads optional `pi-style`, native children load that package's actual source for its editor/footer and authorized presentation surfaces, not other Main extensions. Explicit SDK-only children load no UI extensions. Session-local style changes remain in the same native UI while panes are absent and after reattachment.

Main stays full-height on the left of its managed region. The six-child threshold counts all live runtime-owned execution children, including named idle teammates, excluding Main. Above six, remove every managed viewer; returning to at most six restores only running assignments. Idle settlement closes its pane without changing execution PID, child ID, native context or style; a new assignment reopens the retained worker's pane. Layout counts visible child panes: zero shows Main only; 1–3 use two horizontal partitions; 4–6 use three equal horizontal partitions, with child rows 2+2, 3+2 and 3+3 (cell rounding applies). Focus and foreign panes remain intact; unverified/user-modified layouts are rejected. Alt+O is advertised only while a verified viewer is available.

A disconnected child is not treated as completed. Unsupported/invalid actions report errors rather than fake success. Reconnect authenticates active execution children. Managed cold resume opens persisted native JSONL in a new child; named teammates instead retain idle execution until explicit release or session teardown, without an idle pane. The native pane composer steers an active assignment; Main and signed mailbox messages admit new assignments to idle named workers. Idle unnamed children cannot admit new assignments from the pane. Native built-ins such as `/model` retain their own menus. `/new`, `/resume` and `/fork` are refused because the parent owns the child session.

Model/auth admission happens before a run or panel row exists. An unavailable primary automatically falls back to another authenticated native model; if none is usable, tool/RPC reports the error without a failed placeholder row. Auth can still change after queueing or fail remotely: the child retains its dispatch guard, and admitted failures follow normal row finalization. The detailed transcript view identifies verified closed resources. A rejected first prompt with no persisted JSONL has no resume capability; its runtime diagnostic is reported rather than an indefinite “waiting for output” placeholder.

An authenticated PID mismatch is a fatal control-identity failure, not a transient disconnect: unsubscribe/disconnect, stop reconnect attempts and reject steer/abort/resume/attachment. Retain the uncertain launcher receipt for recovery rather than trusting another process.

Esc and panel dismissal do not kill active execution; closing a native viewer disconnects presentation only. Anonymous completion/failure/stop preserves outcome/session/worktree artifacts before closing execution and its viewer; named teammates remain alive while idle. Parent session shutdown tears down both execution and presentation. The Hub keeps the latest teammate row and anonymous history rows. Cleanup errors retain authenticated recovery receipts; explicit release can retry cleanup:

```text
/agents release <id>
/agents release <id> --worktree
```

Release without `--worktree` retains checkout. With it, cleanup is only appropriate after review/test/integration and refuses dirty/unpreserved changes. Preserved commits/branches remain. UI never auto-merges or cherry-picks.

## Completion delivery

Direct conversation runs produce guarded completion notifications. `delivery: event` runs update panel/lifecycle without duplicate conversation completion; `pi-tasks` decides review presentation. Delivery remains functional after native `/new`/resume lifecycle transitions.

Notifications are plain custom messages (`customType: teammate-notification`) with structured plain-text content; the runtime registers no message renderer (the former §7 notification box renderer was removed with roadmap 1.1b — the customType plus `details` schema is the exported contract, see `docs/INTEGRATION.md`). The panel and transcript surfaces are unaffected.
