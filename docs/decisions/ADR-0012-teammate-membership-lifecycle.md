# ADR 0012: Teammate membership identity and shutdown

Status: Draft (implementation pending coordinator acceptance)

## Decision

A teammate's display name is an alias, not its durable identity. Each roster membership has an immutable `membershipId`; legacy persisted roster entries receive an ID once when loaded and are persisted through the existing roster store. New membership creation allocates a fresh ID. Historical runs and transcripts remain untouched.

Shutdown is a destructive membership operation, distinct from release: it must fence new admissions, cancel queued or active work, verify owned resources are disposed, reconcile task attempts/claims only after settlement, archive mailbox state by membership, and only then remove live membership. Failure to verify cleanup must retain recovery ownership and prevent alias reuse. No worktree or transcript is deleted.

## Consequences

Callbacks, routing, reservations and resume requests must progressively bind to `membershipId`; name-only historical data must not be rebound to a later incarnation. Legacy retired records require conservative migration. Native process and terminal/UI behavior require platform smoke testing; automated fakes do not prove those behaviors.

This ADR records the lifecycle direction. Automated fake-backend shutdown, migration, queued/busy cancellation, retry, task reconciliation, and stale-event checks are implemented. Native process ownership, force-kill behavior, restart recovery with unresolved child receipts, and actual TUI progress have not been verified; do not claim those checks passed. Any shipped surface not yet meeting the full sequence must be reported as incomplete rather than treated as verified shutdown.
