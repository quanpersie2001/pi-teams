# ADR 0002: Inline agent panel and remote child focus

- **Status:** Accepted

## Context

Main needs compact run navigation. A selected child needs a dedicated transcript viewport and composer without mixing child text with Main or modifying Main's draft.

## Decision

- Keep compact navigation below Main's native editor; use an opaque fullscreen overlay for child focus.
- Use native transcript components and a separate native editor inside the parent renderer, not a mounted child InteractiveMode.
- Render immutable AgentRun/native-focus projections and emit intent; AgentManager retains lifecycle ownership.
- Preserve per-run drafts, scroll and tool expansion independently of Main.
- Hiding or closing UI never terminates an active child or deletes history.

The [UI contract](../ui/AGENT-PANEL-AND-VIEW.md) is the canonical source for gestures, editor/menu ownership, mouse support, capabilities and terminal-column behavior.

## Consequences

The opaque viewport prevents Main transcript/footer bleed-through but must restore background, focus and viewport state across resize and run switches. Native components preserve familiar editing and transcript behavior without giving the viewer ownership of execution. Headers use the child's context/model/thinking and per-run counters, not Main's state or whole-session totals.
