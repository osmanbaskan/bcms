# Quality Checklist

Apply this checklist before delivering any code solution.

## Correctness

- [ ] All identified edge cases from Phase 1 are handled explicitly or documented as accepted constraints.
- [ ] No silent failures: every error path produces a visible error, log, or fallback behavior.
- [ ] Input validation exists at all public entry points (API handlers, top-level functions, event listeners).
- [ ] Race conditions and concurrency risks are addressed where applicable.

## Architecture & Design

- [ ] Each function/module has a single, clear responsibility.
- [ ] Dependencies on external services or state are explicit (injected or clearly documented).
- [ ] No circular dependencies between modules.
- [ ] Design patterns are applied appropriately, not dogmatically.

## Type Safety & Contracts

- [ ] Function signatures define precise types; `any`/`unknown` types are justified and guarded.
- [ ] Null/undefined values are handled; impossible states are prevented at the type level where possible.
- [ ] Preconditions are validated; postconditions are guaranteed or documented.

## Error Handling & Resilience

- [ ] Errors are categorized: recoverable (retry/fallback) vs fatal (halt/alert).
- [ ] No bare catch blocks that swallow exceptions.
- [ ] Error messages include context: what operation failed, what input was involved, what the user should do.
- [ ] Resources are cleaned up in failure paths (files closed, connections released, locks freed).

## Readability & Maintainability

- [ ] Names reveal intent (e.g., `calculateTaxForRegion`, not `calc`).
- [ ] Functions are focused and under ~30 lines; extracted helpers are pure where possible.
- [ ] Magic values are extracted to named constants.
- [ ] Comments explain *why*, not *what*.

## Performance & Safety

- [ ] No N+1 queries or unnecessary nested loops without justification.
- [ ] Sensitive data (passwords, tokens) is not logged or exposed in error messages.
- [ ] No hardcoded secrets or credentials.
- [ ] User input is sanitized before use in queries, commands, or HTML rendering.

## Test Coverage (When Tests Are Required)

- [ ] Happy path covered.
- [ ] Each edge case from Phase 1 has a corresponding test.
- [ ] Error paths and exception branches are tested.
- [ ] External dependencies are mocked/stubbed in unit tests.
