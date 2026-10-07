# ADR 0006: Layered extension architecture

- **Status:** Accepted

## Context

Definitions, mutable run state, persistence, integration, worktrees, delivery and UI need explicit boundaries. Concrete host APIs and lifecycle ownership must not leak into domain contracts or rendering.

## Decision

Use `extension-src/pi-subagents/{shared,domain,features,app,pi}` with composition order:

```text
shared → domain → features → app → pi
```

Shared/domain calculations remain host-independent. Features render immutable snapshots and emit intent; app composes services/features; pi injects concrete lifecycle, process, socket, filesystem and Git adapters. Dependency-cruiser enforces the import boundaries.

[Architecture](../ARCHITECTURE.md#2-repository-and-layers) owns the exact layer rules and source layout. Tests exercise pure logic/rendering through injected ports; real-process and packaged-entrypoint smokes cover boundaries that fakes cannot establish.

## Alternatives considered

- **Flat source tree:** makes cross-imports and oversized entrypoint orchestration easy.
- **Subsystem-only folders:** do not express dependency direction; domain types can depend on concrete adapters.
- **Ports for every helper:** unnecessary abstraction. Use ports at host, persistence, backend and Git/process boundaries, not for small pure helpers.

## Consequences

Pi-specific code stays isolated; domain/rendering can run without a native session, and backend changes need not leak into UI. Costs are more files, explicit injection and cross-layer contract changes. The rules belong to this package and do not require a sibling repository.
