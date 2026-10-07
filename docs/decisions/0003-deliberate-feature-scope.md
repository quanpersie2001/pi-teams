# ADR 0003: Giới hạn feature scope để giữ core nhỏ và dễ bảo trì

- **Status:** Accepted
- **Amendment 1 (sau khi rà soát `edxeth/pi-subagents`):** tái khẳng định **không hỗ trợ nested swarm/spawn lồng nhau** — xem mục "Tái khẳng định" cuối ADR.

## Context

Specialist execution and task management have different lifecycles. Keeping them in separate extensions avoids duplicate workflow state and makes the runtime usable without a task consumer.

## Decision

### Core của pi-subagents

- specialist agent definitions;
- `Agent`, `get_subagent_result`, `steer_subagent`;
- foreground/background AgentRun;
- backend abstraction;
- process-only runtime: HerdR/tmux native TUI hoặc independent headless child;
- concurrency queue;
- steer/stop/resume;
- durable run/session registry;
- completion/lifecycle events;
- inline panel, Agents Hub and remote child focus;
- agent mentions/native autocomplete and a model-visible specialist catalog;
- scoped, bounded process-local inbox messaging;
- optional managed Git worktree isolation and manual review/integration;
- versioned cross-extension integration;
- operational settings documented in [Configuration](../CONFIGURATION.md).

### Không thuộc pi-subagents

- Task entity/status/dependencies/priority;
- assignment policy/retry/review workflow;
- task UI và task registry;
- nested agents;
- scheduling/cron;
- persistent semantic memory;
- group join notifications.

## Rationale

- Worktree, backend, session và transcript là execution concerns nên thuộc `pi-subagents`.
- Task state machine và assignment là work-management concerns nên thuộc `pi-tasks`.
- Nested agents và scheduling tạo orchestration graph/daemon không cần cho hai-layer design.
- Group join chỉ là notification optimization.

## Consequences

- `AgentRun` không chứa Task fields.
- `pi-tasks` lưu task → agentRun mapping.
- owner/delivery policy trở thành core để tránh duplicate notification.
- process-backed restore nằm trong subagent runtime; task restore nằm trong task extension.
- public integration protocol phải versioned và test độc lập; see [Integration](../INTEGRATION.md).

## Tái khẳng định: không nested swarm

Sau khi rà soát `references/edxeth-pi-subagents` (v2.9.2, hỗ trợ spawn lồng qua `spawning`/`spawn-depth`/`spawn-width`/`visible-to`, allowance persist vào launch metadata và hẹp dần theo từng cấp, resume không được nới rộng), quyết định **vẫn giữ hai-layer design parent → specialists, không mở nested delegation**.

Lý do:

- giữ orchestration graph phẳng, dễ suy luận về token cost và ownership;
- child protocol không cần khái niệm "cho phép của tổ tiên" hay allowance kế thừa;
- nhu cầu phân rã sâu hơn thuộc về consumer (ví dụ `pi-tasks`) hoặc parent tự phối hợp nhiều specialists song song — cơ chế này đã có (concurrency queue + scoped inbox).

Enforcement hiện có giữ nguyên: children set `PI_SUBAGENTS_CHILD=1`, không load parent orchestration extension, không nhận `Agent`/`get_subagent_result`/`steer_subagent`. Không mở lại phạm vi này trừ khi một ADR mới thay thế ADR này.
