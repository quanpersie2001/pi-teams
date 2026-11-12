# Regression checks

Run the complete pipeline in each installed checkout:

```sh
npm run check
(cd ../pi-style && npm run check)
```

The sibling checkout is optional. Combined UI tests explicitly skip when it is absent; separate-package passes alone do not establish cross-extension behavior.

## Failure-path coverage

- `test/unit/launch-cleanup-ownership.test.ts`, `runtime-cleanup-regressions.test.ts`, `partial-launcher-recovery.test.ts`, `agent-manager.test.ts` and `test/integration/process-runtime.test.ts`: allocated-but-unconfirmed receipts, named/anonymous cleanup, budget/settlement races, gated startup, hung abort acknowledgements, and verified resource loss. Native outcomes and process ownership are separate assertions.
- `test/unit/task-execution-regressions.test.ts`: lock conflicts, fast settlement, membership/claim association, legacy fencing, and replacement claims interposed before binding/release. Shutdown authority is rechecked under the board lock.
- `test/unit/child-mailbox-retry.test.ts`: transient rejection without another inbox event, bounded backoff, membership fencing and close cancellation. Ambiguous native acceptance is not an exactly-once delivery guarantee.
- `test/integration/ui-host.test.ts` and `test/render/agent-view-*.test.ts`: Main/Child roster hit targets, per-run drafts and pending submissions, remapped native submission, child-only metadata and conditional acknowledgement after navigation.
- `test/render/child-presentation-parity.test.ts` plus pi-style's detached/public renderer tests: actual optional providers, native structured result budgets, full modular/bundled coordinator patches, session replacement, terminal-control sanitization and image fallback.
- `test/unit/focus-service.test.ts`, `child-session-stats.test.ts` and combined teammate footer tests: native model identity, session-wide recorded usage/cost, missing-vs-zero cost, retained idle and continuation ownership, plus cached Git for distinct child worktrees. Late Git results must not overwrite a different run/cwd or newer native metadata; empty/relative cwd must never resolve against Main. Footer render must perform no Git I/O. `test/unit/runtime-cleanup-regressions.test.ts` also exercises real process-backend subscriptions: unchanged active/retained-idle reads must stay bounded, same-sequence native metadata changes must notify, and stale snapshots must remain silent.

## Interactive checks

Automated rendering and process tests are not visual terminal sign-off. Manually check both extension load orders, roster remounts, above/below status placement, autocomplete, remapped submission, pending request navigation, tool expansion and an idle child view (no continuous redraw).

Exercise real tmux/HerdR and Windows separately where available. Missing or changed identity proof must remain fenced; never relax signaling checks merely to make cleanup succeed. Complete images within the bounded transcript projection may render natively; oversized/unsupported content must show an omission notice rather than clipped image data.
