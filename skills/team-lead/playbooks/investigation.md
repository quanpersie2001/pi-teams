# Investigation

Use for read-only questions, architectural understanding, evidence gathering, and recommendations. Investigation is not permission to implement a recommended change.

## 1. Frame the question

State the decision or explanation the user needs, scope, and expected evidence. Inspect the local entrypoint or supplied sources enough to form useful investigation slices. A narrow symbol lookup can use one `explore` worker; do not build a team for its own sake.

## 2. Divide by evidence boundary

For a cross-cutting question, use the [parallel-work checkpoint](parallel-work.md) to assign complementary slices such as local runtime flow, external behavior, and failure/recovery paths. Do not send the same broad architecture question to every worker unless deliberately comparing independent interpretations.

Use `general-purpose` for whole-file/cross-file analysis, `explore` for targeted locations, and `scout` for external sources. Bundled `reviewer` is for named changes with review context, not an open-ended repository audit.

Keep each brief read-only and self-contained. Include known constraints and relevant decisions. Request exact path:line or retrieved source citations, observed facts versus inference, and missing evidence. Workers must not edit code, create project artifacts, or run mutating commands unless separately authorized.

## 3. Dispatch and inspect

Launch independent slices detached. Read terminal results and inspect the cited source around important claims. A report is not evidence that its citations are accurate. If a slice is blocked or contradicts another, resolve the specific question with a narrowed follow-up rather than rerunning the entire investigation.

## 4. Synthesize

Return one answer explaining the flow or decision, supported findings, tradeoffs, recommendations, and uncertainty. Preserve missing coverage and meaningful disagreements. Do not paste worker reports or infer consensus from absent results.

For tracked Tasks, accept only the stated investigation deliverable, not implementation of its recommendation. Stop at the requested answer; do not silently turn a recommendation into a code-writing phase.
