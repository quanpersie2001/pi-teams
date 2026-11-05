# Assignment and review handoffs

Read when preparing a worker brief. A child sees its own assignment, not the lead's conversation or siblings' reports. Match the packet to its slice; sufficient context is not the same as all available context.

## Assignment brief

```text
Goal: user's desired outcome, briefly.
Slice: this worker's independently verifiable deliverable.
Inputs and decisions: relevant facts, stable contracts, readable source/artifact paths.
Write boundary: allowed paths, shared interfaces owned elsewhere, exclusions.
Acceptance criteria: observable conditions for this slice, not the entire program.
Verification: commands/procedure and expected behavior; disclose unavailable tools.
Expected output: artifact paths, criteria covered, checks/evidence, remaining issues.
Escalate/stop: missing contract, overlapping writes, expanding scope, or permission boundary.
```

Put mandatory behavioral requirements in the assignment itself or Tasks `acceptanceCriteria`/`constraints`. Supply just the contract facts this worker needs. Summarize decisions, not entire transcripts; link large evidence as readable artifacts. A pointer must include why it matters, and the worker needs access from its execution workspace. Do not assume a worktree contains uncommitted files from the lead checkout.

Map tracked brief fields to `description`, `scope`, `acceptanceCriteria`, `constraints`, `expectedOutput`, and context references. Tasks execution has a 16,000-character context packet: criteria, scope, constraints, expected output and protocol are protected; goal/description can be truncated. Prerequisite summaries, background, decisions, references, and `additionalContext` are appended within the remaining budget and can be omitted. Keep the goal short and essential artifact pointers in the required spec when their loss would block execution. This packet cap is not a guarantee about total worker context consumption.

## Outcome

Ask general-purpose workers for:

```text
Status: complete | partial | blocked
Outcome and artifacts: paths and inspected revision/snapshot where relevant.
Acceptance criteria: what is satisfied, absent, or uncertain.
Verification: check, passed | failed | not_run, and evidence.
Remaining issues: blockers, gaps, assumptions, and scope deviations.
```

For Tasks outcomes, map these to `summary`, `artifacts`, `verification`, and `remainingIssues`. Retain a specialist's own compatible output format; in particular, use the reviewer's `complete | partial | blocked` status and `mergeable | not mergeable | undetermined` verdict. An execution ending successfully does not mean its criteria passed.

## Review packet

Before assigning bundled `reviewer`, provide:

```text
Goal: what acceptable/mergeable means.
Scope: changed paths and directly relevant dependencies; exclusions.
Intended semantics: what each change should do and why.
Parent facts: decisions/constraints learned outside the named files.
Acceptance criteria: observable behavior to establish.
Comparison: base revision plus a readable diff and relevant base content.
Artifact identity: reviewed commit, or captured dirty-state diff/content checksums.
Verification evidence: exact commands/procedures, results, logs, and not_run checks.
Requested review: actionable defects, path:line evidence, verdict, and residual risks.
```

The reviewer has only `read`, `grep`, `find`, and `ls`, not git, bash, network, or test execution. A PR URL or commit name alone is not a usable diff. The lead or a capable worker must capture evidence and make it readable. Do not fabricate a diff path or claim checks ran because tests exist.

Freeze writes to reviewed paths until review finishes, or review an immutable snapshot. Identify both comparison baseline and current contents; HEAD alone does not identify dirty files. Subsequent changes require review/checks of affected behavior and interactions. Partial/blocked review is not approval; resolve missing inputs or report the limit.

For a fix round, add the finding, concrete failure scenario, current artifact identity, allowed fix scope, regression check, and the reviewer context needed to recheck it. Do not resend all unrelated earlier reports.
