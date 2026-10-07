---
name: create-agent
description: Create or refine a focused Pi specialist agent from a task description, with a supported Markdown definition, minimal tools, and a practical invocation example.
---

# Create a Pi specialist agent

Turn the user's requirements into an autonomous, focused specialist for the pi-subagents extension. Deliver a real Markdown agent definition, not an OMP JSON draft. This skill guides creation; it is not itself an agent definition.

## Workflow

1. **Extract intent.** Identify the purpose, responsibilities, inputs, success criteria, explicit preferences, and necessary implicit constraints. For code review, assume recently written or changed code, not an audit of the whole repository, unless requested. Inspect relevant existing agent definitions and applicable `AGENTS.md` and `CLAUDE.md` instructions before designing. Resolve details from available project context; ask a focused question only when a consequential requirement cannot be inferred safely.
2. **Choose an expert persona.** Give the specialist relevant domain expertise and a concrete decision-making role, rather than generic assistance. Write its body in second person, starting with “You are…”.
3. **Define its operating manual.** State scope and exclusions, required inputs, a stepwise domain-specific methodology, relevant project conventions, edge-case handling, escalation for missing prerequisites, and an exact output format. Make it independently capable of completing its assigned slice with minimal further guidance. Children cannot delegate recursively: do not instruct them to create subagents. Task context belongs in the parent's `Agent.prompt`; it is not automatically inherited from the parent conversation.
4. **Build in quality control.** Include domain-appropriate checks, evidence requirements, self-correction, and efficient stopping criteria. Distinguish observed facts from inference. Do not claim checks ran when they did not, or add unrelated retries, telemetry, or broader scope. If required evidence is unavailable, report the precise limitation rather than fabricate it.
5. **Name and describe it.** Use lowercase letters, numbers, and hyphens only; prefer two to four descriptive hyphen-joined words. Choose a memorable function name, not “helper” or “assistant”. Write a precise, self-contained, single-sentence description starting with “Use this agent when…”. No embedded transcripts, example/commentary tags, or multiline triggers.
6. **Select minimal capabilities.** Use only the supported frontmatter below. Normally omit a model pin. Match tools to the task; a read-only specialist normally gets `read, grep, find, ls`, not `bash`, `edit`, or `write`. Include `bash` only when a concrete operation requires it, and explicitly constrain its use. Tool restrictions are not an OS sandbox; bash can mutate files or invoke arbitrary programs.
7. **Save without clobbering.** Default to `<project>/.pi/agents/<name>.md`. Use `~/.pi/agent/agents/<name>.md` only when the user asks for a global agent. Inspect existing names across source locations; never overwrite an unrelated agent or shadow one inadvertently. Revise an existing definition only when requested; otherwise choose a distinct descriptive name. If the user explicitly asks for a draft only, provide the complete file without writing it.
8. **Hand off and validate honestly.** State the path, purpose, tool boundary, and intentional pins. Explain loading and give an exact `Agent` invocation. If live validation is requested and available, load in a new session and perform a small representative task, recording the actual outcome and any warnings. Otherwise label loading/smoke checks as not run and give concrete steps for the user; do not invent a validation command.

## Markdown definition contract

The file has YAML frontmatter followed by the system-prompt body. The declared `name` is the `subagent_type`; keep the filename stem identical. These are the supported fields, not a checklist to fill with unnecessary defaults:

| Field | Meaning and guidance |
| --- | --- |
| `name` | Specialist identifier. Explicitly include it. |
| `description` | Concise single-sentence “Use this agent when…” trigger. Quote YAML strings when needed. |
| `tools` | Minimal built-in allowlist, e.g. `read, grep, find, ls`. Available built-ins: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Omission permits the default built-in toolset; `none` explicitly permits no tools. |
| `model` | Optional native `provider/modelId` string, not a role, list, or invented model identifier. Omit normally to inherit. Pin only a known available model for a concrete reason. |
| `thinking` | Optional `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; omit to allow invocation/native defaults. |
| `max_turns` | Optional nonnegative integer. Omission defers to the invocation limit, then configuration (default 30); `0` explicitly pins unlimited. Do not use unlimited as a routine default. |
| `prompt_mode` | `replace` (default): this body supplies the agent prompt. Use `append` only when the native coding prompt should remain and this body should augment it. |
| `run_in_background` | Optional YAML boolean; omission uses configuration (default true). An invocation can explicitly choose foreground/background. |
| `isolation` | `off` (default shared workspace) or `worktree`. Worktrees also require the master `worktreeIsolation` setting; the file alone cannot enable them. There is no automatic merge. |
| `enabled` | Optional YAML boolean, default true. False disables the definition. |

Definition pins for model, thinking, tools, and turn limit take precedence over invocation requests. A requested model may be admitted as a fallback when the pinned primary is unavailable; it does not replace the primary merely because it was passed. Do not imply that every definition field is immutable: foreground/background is selectable at invocation time.

Do not transplant OMP fields or APIs: no `@roles`, model lists, `spawns`, `output`, `blocking`, `autoloadSkills`, `prewalk`, `advisor`, or `read-summarize`. Do not copy pi-task fields such as `skills`, `readonly`, `proactive`, `disallowed_tools`, or `runtime`. Describe behavior in the prompt and enforce available capability boundaries with `tools`; agent files do not load skill frontmatter.

## Loading and precedence

Definitions with the same name are resolved in ascending precedence:

`bundled < ~/.pi/agent/agents < <project>/.agents/agents < <project>/.pi/agents`

Later sources override earlier ones. The default project destination is the highest-precedence source, not an invitation to replace a bundled or existing definition unintentionally. Restart Pi or start a new session to load a new or changed definition. Do not promise an `/agents reload` command. Confirm the exact name appears among the `Agent` tool's available types before a live smoke invocation; an unknown name may otherwise resolve to a configured fallback, which is not evidence that your agent loaded.

## Complete practical example

Save this as `.pi/agents/changed-code-review.md` when a user requests a read-only reviewer for recent changes. Tailor its domain expertise and project conventions to the real request rather than blindly copying it.

```markdown
---
name: changed-code-review
description: "Use this agent when recently changed code needs a read-only review for actionable correctness, security, and maintainability defects."
tools: read, grep, find, ls
prompt_mode: replace
isolation: off
---

You are a senior code reviewer specializing in evidence-backed analysis of recently changed code.

Scope and boundaries:
- Review only the files or changes identified in the task, plus directly relevant dependencies and tests needed to establish behavior.
- Follow applicable AGENTS.md and CLAUDE.md instructions and existing project conventions.
- Do not edit files, execute shell commands, run checks, or delegate. This is a read-only review, not a whole-repository audit.
- The task must provide changed paths and a diff or before/after context. If change context is absent, review the supplied current code and clearly state that limitation; do not pretend to have inspected a diff.

Method:
1. Read the supplied change context and affected code. Identify intended behavior and acceptance criteria.
2. Trace relevant callers, invariants, error paths, permissions, and data flow using read, grep, find, and ls.
3. Check boundary conditions, compatibility, security impact, and directly relevant tests. Read tests as evidence; do not claim they passed.
4. For each candidate defect, verify it against the actual code and explain a concrete failure scenario. Separate confirmed behavior from assumptions. Discard speculative style complaints and issues unrelated to the changes.
5. Prioritize findings by impact and provide the smallest practical correction direction without making edits.

Output:
- Findings ordered by severity, each with a short title, file and line reference, failure scenario, evidence, and suggested correction direction.
- Open questions or missing prerequisites that affect confidence.
- A brief scope and verification note stating what was inspected and that no checks were executed.
- If no actionable defects are found, say so explicitly and note residual risks; do not invent findings to fill the report.

Before returning, ensure every finding is supported, belongs to the requested scope, and is not duplicated. Stop when the requested changes and directly necessary context have been reviewed.
```

After a new session loads the file, call the model-facing **`Agent`** tool with the following arguments (replace the paths, change context, and acceptance criteria with real task data):

```json
{
  "prompt": "Review the recent changes in src/auth/session.ts and test/auth/session.test.ts. Intended behavior: expired sessions must be rejected before protected handlers run. Change context: the expiry check was moved from the handler into the session lookup; inspect the current functions and tests for ordering regressions. Use only read-only tools; do not edit files or run checks. Report actionable defects with file/line evidence, concrete failure scenarios, and a scope/verification note. Limit review to these changes and directly relevant callers. This is current-code change context, not a supplied diff; state that limitation.",
  "description": "Review session expiry changes",
  "subagent_type": "changed-code-review",
  "run_in_background": false
}
```

Use `run_in_background: false` when the next action requires the result. For independent work, set it to true or omit it to use configured background behavior. This is an `Agent` call, not an OMP `task` call. Supply all necessary task context in `prompt`, including known project constraints; the short `description` is only the UI label. A useful smoke check demonstrates that the exact agent loaded, the task executed within its tool boundary, and the result followed its output contract. Report the actual evidence, not merely successful file creation.

## Provenance

Adapted from the agent-creation architect and user workflows in **oh-my-pi v18.6.1**. Their intent/persona/methodology/quality-control guidance is retained; the original JSON-only `{identifier, whenToUse, systemPrompt}` output is replaced with native Pi Markdown (`name`, `description`, body), supported frontmatter, and the `Agent` invocation contract.

- [Architect source](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.6.1/packages/coding-agent/src/prompts/system/agent-creation-architect.md)
- [User source](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.6.1/packages/coding-agent/src/prompts/system/agent-creation-user.md)
- [Upstream MIT license](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.6.1/LICENSE)

The upstream copyright and permission notice is preserved in [LICENSE](LICENSE).
