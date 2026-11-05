# Implementation and review

Use for features, bug fixes, and behavior-preserving refactors. The lead owns design coherence and integration; workers own bounded deliverables. Read [Parallel work](parallel-work.md) before fan-out and [Handoffs](../references/handoffs.md) before assignments.

## 1. Ground and define done

Inspect the affected flow, boundaries, invariants, callers, and tests. Delegate bounded investigation when several areas need understanding; synthesize its results before implementation. For a defect, reproduce it or establish a concrete failing case before choosing a fix. For a refactor, name the behavior to preserve.

Write acceptance criteria and the relevant verification commands or manual procedure. Distinguish code review from execution. Do not ask a reviewer without shell access to reproduce a runtime bug.

## 2. Plan the units and contracts

Use the decomposition checkpoint in the main skill. Give each unit one coherent outcome and a context footprint that does not require learning the whole feature. Identify interface/data-shape decisions that block downstream work. Explore competing designs only when a material uncertainty warrants it; do not mandate multiple implementations for routine edits.

Split oversized units before execution. Prefer tracked Tasks for dependent work. Each dependency means an accepted prerequisite, not merely a worker saying it finished. Define completion of an implementation slice honestly as code-ready with its local checks; whole-feature correctness belongs to a later integration/review gate.

## 3. Dispatch in waves

Start contract/unknown-resolution units first. Once their evidence is accepted, provide each ready worker only its relevant contract and inputs. Launch independent writers together only with disjoint ownership. While they run, the lead can prepare verification inputs, not edit their owned paths.

If a writer discovers an unresolved cross-cutting decision or an expanding scope, have it report the blocker and preserved progress. Resolve or split the remaining work at the lead rather than adding every concern to that worker's context.

## 4. Inspect and integrate

Read each diff and relevant code, not just the summary. Check unintended edits and prerequisite assumptions. In isolated worktrees, inspect and integrate changes explicitly; there is no automatic merge. For the shared workspace, inspect the combined diff and wait for relevant writers to settle before final checks.

Integrate in dependency order. Give conflict resolution a single owner and count its edits as new changes requiring verification. Recheck behavior across the slices' boundaries, with end-to-end or matching-surface checks where appropriate. Compiling alone does not prove behavioral acceptance.

## 5. Independently review the integrated state

For nontrivial changes, give a non-author reviewer the [review packet](../references/handoffs.md#review-packet), including base/comparison evidence and exact artifact identity. The reviewer does not have git or a shell. Capture the diff as a readable artifact and provide relevant base content when comparison requires it.

Reviewing slices early can catch defects cheaply, but does not replace review of the combined state. Match review depth to risk; a trivial mechanical change can use a lead inspection and focused check with that scope disclosed.

## 6. Fix, verify, and re-review

Triage findings as fix, dismiss with concrete evidence, or unresolved. Delegate fixes with named findings and a narrow write boundary. Reuse a coherent retained writer context when useful; replace bloated contexts with a consolidated brief, after verified settlement.

Rerun affected checks. Have the reviewer examine fixes and their interactions at the new artifact identity. A changed patch invalidates the affected part of an earlier verdict. Repeat within the [recovery budget](../references/recovery.md); replan rather than silently waiving a failed gate.

## 7. Accept and report

Accept the integration/review gate only when required checks and findings are resolved. Record `not_run` and blockers honestly; an unavailable check is not a pass. For tracked Tasks, follow [Tasks](../references/tasks.md), including `in_review` when requested. Do not merge, publish, or expand external permissions without authorization.

Report the delivered behavior, artifacts, integrated verification, independent review and fix status, and residual risk.
