# Parallel work

Use before multi-worker fan-out. More teammates are useful only when they reduce the critical path or provide independent evidence without creating write conflicts and duplicated context.

## 1. Choose the shape

- **Coverage:** different required slices. Name every slice; completion needs evidence for all of them.
- **Alternatives/race:** independent solutions to the same question. Declare the selection rubric before launch. First satisfactory result is suitable only when one valid solution is sufficient; it cannot establish exhaustive coverage.
- **Mixed:** partition coverage and compare alternatives within selected slices. Track both obligations explicitly.

Use the smallest sufficient fan-out. Respect configured capacity (`maxConcurrent` defaults to four); extra workers queue rather than creating useful simultaneous throughput. Do not copy another harness's worker-count targets.

## 2. Check the decomposition

For each unit, name the artifact, completion evidence, prerequisites, write owner, and minimum context. Ask whether the worker can start and finish without understanding unrelated units.

Split a unit with several independent deliverables or unrelated knowledge requirements. When slices depend on an unstable shared contract, do a bounded discovery/contract wave first, then implementation waves. Do not split a coupled invariant into concurrent writers just to increase agent count.

Example: adding a persisted setting across domain and UI.

```text
A: map config/persistence behavior ─┐
                                 ├→ lead settles setting contract
B: map UI/consumer behavior ──────┘
                                      ├→ C: domain/persistence + local tests
                                      └→ D: UI consumer + local tests
                                              ↓
                                  integrate + behavioral verification
                                              ↓
                                  independent combined-state review
```

C and D run together only when the contract is stable and their writable paths do not overlap. Otherwise serialize the shared core first. A/B receive different discovery briefs; C/D receive the contract and their relevant findings, not every report in full.

## 3. Protect writable state

Shared workspace is the default. Give each path/shared mutable object one active writer, including the lead. List owned test files too. Cross-cutting contract changes go back to the lead for sequencing.

Worktree isolation requires both `worktreeIsolation: true` and definition `isolation: worktree`; there is no per-call isolation override. Do not claim a worker is isolated without that configuration. Worktrees avoid checkout collisions, not semantic integration conflicts, and changes are not automatically merged.

Ownership in a prompt is a coordination convention, not an OS sandbox or runtime file lock. Task-board reservation protects task execution, not workspace files. If a write boundary cannot be kept, serialize or use configured isolation. Do not silently enable settings or overwrite agent definitions to get isolation.

For repeated similar units, prove one complete assignment/verification cycle before scaling out. Independent read-only research does not need a serial pilot by default.

## 4. Launch and supervise

Give each worker a self-contained [handoff](../references/handoffs.md). Keep bulky evidence in slice-specific readable artifacts. Children cannot delegate further, so new work and subsequent waves return to the lead.

Launch ready independent units detached and process completion notifications. Do not poll for progress or send status-only messages. As a prerequisite is accepted, start newly ready units without waiting for unrelated workers. Account for each launched unit as completed, blocked, stopped, or replaced.

## 5. Aggregate and integrate

Use a compact result table with unit, artifact identity, criteria/checks, and gaps. Inspect artifacts and spot-check evidence. Missing or contradictory evidence requires resolution; agent agreement alone is not proof.

A failed or dropped worker leaves its required coverage open. Reassign that slice after safely settling the previous worker, or report an explicit gap. For alternatives, apply the declared rubric rather than silently treating one answer as coverage of all concerns.

Integrate outputs in dependency order and run combined-state checks. Independent review of the integrated artifact follows [Implementation and review](implementation-review.md) for code changes. For investigations, synthesize supported findings and disagreements without editing code.
