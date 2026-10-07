# ADR 0005: Tách Task domain khỏi Subagent runtime

- **Status:** Accepted (amended by [ADR 0007](./0007-session-bound-agent-teams.md): the runtime owns a session-scoped team coordination board and peer mailboxes; durable task management stays with `pi-tasks`)

## Context

Task consumers create work, manage dependencies/status and assign specialists. Specialist execution must also remain usable directly, without a task extension.

Nếu `pi-subagents` cũng giữ Task entity, hai extension sẽ duplicate state, delivery và ownership.

## Decision

Tách hai bounded contexts:

### pi-subagents

Sở hữu:

- AgentDefinition;
- AgentRun;
- execution backend;
- run registry/session/transcript;
- lifecycle/control;
- worktree;
- main agent panel và fullscreen transcript viewer;
- integration API/events.

### pi-tasks

Sở hữu:

- Task entity;
- status/dependency/priority;
- assignment/retry/review;
- acceptance criteria và prompt construction;
- task registry/UI;
- task → agentRun mapping.

`pi-tasks` gọi `pi-subagents` qua versioned integration contract.

## Ownership and delivery

Task consumers should declare owner/delivery explicitly (RPC otherwise defaults to extension owner `pi-tasks` and delivery `event`):

```ts
owner: { kind: "extension", id: "pi-tasks", ref: taskId }
delivery: "event"
```

Direct `Agent` call dùng conversation owner và `delivery: "conversation"`.

## Consequences

### Positive

- task workflow thay đổi mà không làm phức tạp agent runtime;
- subagents vẫn dùng độc lập không cần pi-tasks;
- tránh duplicate task/agent notifications;
- worktree và backend được tái sử dụng bởi mọi consumer;
- integration có thể version/test riêng.

### Negative

- cần cross-extension protocol;
- cần reconcile restore giữa hai registry;
- owner metadata và delivery policy trở thành correctness requirement;
- debugging assignment cần theo dõi cả task id và agent run id.

## Non-goals

- `pi-subagents` không tự mark Task completed.
- Consumers do not control child processes outside the runtime's versioned API.
- Shared workspace is the default; optional worktrees isolate checkouts, not Task workflow or tool permissions.

See [Integration](../INTEGRATION.md) for the wire contract.
