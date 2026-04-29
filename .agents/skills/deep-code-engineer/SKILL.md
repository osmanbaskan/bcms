---
name: deep-code-engineer
description: Advanced software engineering discipline enforcing deep thinking, architectural design, and code quality for any programming task. Use when (1) writing or editing code in any language, (2) designing software architecture or system components, (3) implementing algorithms or business logic, (4) refactoring existing code, (5) debugging or error analysis, (6) reviewing code for quality, security, or performance, (7) creating technical specifications or API designs. Triggers on all software development, scripting, automation, and code-related requests.
---

# Deep Code Engineer

## Overview

Enforce a four-phase engineering discipline on every coding task. Surface-level solutions are prohibited. Before any code is written, complete deep analysis, architectural design, edge-case exploration, and implementation planning.

## Core Philosophy

1. **Think First, Code Second**: Never start typing the solution before understanding the problem boundary, constraints, and failure modes.
2. **Architecture Before Implementation**: Define data structures, interfaces, and component boundaries before writing business logic.
3. **Quality is Non-Negotiable**: Type safety, error handling, logging, and validation are mandatory, not optional.
4. **Verify Before Deliver**: Self-review using the quality checklist before presenting any solution.

## Phase 1: Deep Analysis (Mandatory)

Before writing or editing any code:

### Requirement Decomposition
- Identify the core problem versus secondary concerns.
- Separate functional requirements from non-functional (performance, security, scalability).
- Define explicit inputs, outputs, and side effects.

### Edge Case & Constraint Exploration
- Enumerate empty inputs, maximum inputs, malformed inputs, concurrent access, race conditions.
- Identify implicit assumptions and convert them into explicit checks or documented constraints.
- Consider failure modes: What happens when dependencies fail, network drops, or data is corrupt?

### Context Gathering
- Read relevant existing code before modifying.
- Identify coding patterns and conventions already in use in the codebase.
- Map integration points: who calls this, what does it depend on?
- **BCMS projects**: Load the relevant BCMS reference files listed below before designing backend routes, frontend components, or security changes.

## Phase 2: Architecture & Design (Mandatory)

### Design Pattern Selection
- Match the problem to an appropriate pattern. See [references/design-patterns.md](references/design-patterns.md).
- Prefer composition over inheritance.
- Use dependency injection for testability.
- Apply the Strategy pattern when multiple algorithms or behaviors vary.
- Apply the Factory pattern when object creation logic is complex or conditional.

### Interface & Data Contract Definition
- Define function signatures, types, and interfaces before implementation.
- Use explicit typing; avoid `any`, `unknown` without guards, or implicit dynamic types.
- Document preconditions, postconditions, and invariants.

### Component Boundaries
- Apply Single Responsibility Principle: one reason to change per module/function.
- Minimize coupling: a module should not know unnecessary details about others.
- Design for testability: each unit must be independently verifiable.

## Phase 3: Implementation Discipline

### Defensive Coding
- Validate all inputs at function entry points; fail fast with clear error messages.
- Use early returns to reduce nesting depth.
- Avoid null/undefined propagation; use Result/Either types or explicit null checks.

### Error Handling & Resilience
- Distinguish between recoverable errors (retry, fallback) and fatal errors (terminate, alert).
- Never swallow exceptions silently.
- Log contextual information at error boundaries: function name, input summary, stack trace if appropriate.

### Type Safety & Correctness
- Prefer static typing. In dynamic languages, add runtime type guards for external boundaries.
- Use immutable data structures where mutation is not required.
- Make impossible states unrepresentable in the type system when feasible.

### Readability & Maintainability
- Use descriptive names that reveal intent, not implementation details.
- Keep functions under 30 lines when possible; extract pure logic into helper functions.
- Add comments only for *why*, not *what*. Code explains what; comments explain business rationale or non-obvious constraints.

## Phase 4: Verification & Refinement

### Self-Review Checklist
Before finalizing any solution, load and apply [references/quality-checklist.md](references/quality-checklist.md).

### Mental Simulation
- Walk through the code with at least three scenarios: happy path, edge case, error path.
- Verify resource cleanup: files closed, connections released, memory freed, subscriptions cancelled.

### Test Strategy (When Applicable)
- Define unit tests for pure functions with boundary values.
- Define integration tests for external dependencies with mocks/stubs.
- Include at least one test for each identified edge case from Phase 1.

## Anti-Patterns to Reject

- God classes / God functions that do everything.
- Magic numbers and strings without named constants.
- Deep nesting (arrowhead anti-pattern).
- Copy-paste programming; extract shared logic immediately.
- Premature optimization without profiling data.
- Tight coupling to concrete implementations.
- Leaving TODO/FIXME in delivered code without documentation.

## References

- **Design Patterns**: See [references/design-patterns.md](references/design-patterns.md) for pattern selection guidance.
- **Quality Checklist**: See [references/quality-checklist.md](references/quality-checklist.md) for mandatory verification steps before code delivery.

## BCMS Project References (Load when relevant)

When working on the BCMS (Broadcast Content Management System) codebase, load these project-specific references in addition to the generic guidance above:

- **BCMS Architecture**: See [references/bcms-architecture.md](references/bcms-architecture.md) for service topology, Docker layout, RabbitMQ queues, and API/worker split rules.
- **BCMS Backend Patterns**: See [references/bcms-patterns.md](references/bcms-patterns.md) for Prisma audit extension rules, optimistic locking, group-based auth, Zod validation, and error handling conventions.
- **BCMS Frontend Patterns**: See [references/bcms-frontend.md](references/bcms-frontend.md) for Angular 21 standalone/Signals patterns, Keycloak auth guard, dialog patterns, and component size limits.
- **BCMS Security**: See [references/bcms-security.md](references/bcms-security.md) for JWT verification, rate limiting, audit logging, secrets management, and the 11-group permission model.", "file_path": "/mnt/agents/output/deep-code-engineer/SKILL.md", "maxLength": 100000}