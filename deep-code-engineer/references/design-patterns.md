# Design Patterns Quick Reference

Load this reference when selecting patterns during Phase 2 (Architecture & Design).

## Creational Patterns

### Factory / Abstract Factory
- **When**: Object creation logic is complex, conditional, or varies by configuration.
- **Use**: Creating parsers, database connectors, platform-specific UI components.
- **Avoid**: Simple `new` calls with no variation.

### Builder
- **When**: Constructing objects with many optional parameters or step-by-step assembly.
- **Use**: Query builders, configuration objects, complex DTOs.

### Singleton
- **When**: Exactly one shared instance is required (connection pools, caches).
- **Warning**: Do not use for global mutable state. Prefer dependency injection.

## Structural Patterns

### Adapter
- **When**: Integrating a third-party API or legacy system with an incompatible interface.
- **Use**: Wrapping external SDKs, normalizing response formats.

### Decorator
- **When**: Adding behavior dynamically without subclassing.
- **Use**: Middleware pipelines, request/response interceptors, logging wrappers.

### Facade
- **When**: Hiding complexity of a subsystem behind a simpler interface.
- **Use**: Complex initialization sequences, multi-step business operations.

## Behavioral Patterns

### Strategy
- **When**: Multiple interchangeable algorithms or behaviors exist.
- **Use**: Payment methods, sorting strategies, validation rules, pricing engines.
- **Pattern**: Define a family of algorithms, encapsulate each one, and make them interchangeable.

### Observer / Pub-Sub
- **When**: One event must trigger reactions in multiple independent components.
- **Use**: Event systems, notification services, real-time data updates.
- **Warning**: Always provide unsubscription/cleanup to prevent memory leaks.

### Command
- **When**: Requests must be parameterized, queued, logged, or undone.
- **Use**: Job queues, macro recording, undo/redo systems.

### Template Method
- **When**: An algorithm has invariant steps but variant sub-steps.
- **Use**: Data import pipelines (same flow, different formats), report generators.

## Architectural Patterns

### Dependency Injection
- **When**: Any component has external dependencies (databases, APIs, services).
- **Use**: Constructor injection as default. Interface-based dependencies for testability.

### Repository
- **When**: Abstracting data access logic from business logic.
- **Use**: All database queries go through repository methods; business logic uses domain models.

### Unit of Work
- **When**: Multiple operations must succeed or fail atomically.
- **Use**: Transaction management across multiple repositories or services.

### CQRS (Command Query Responsibility Segregation)
- **When**: Read and write workloads have fundamentally different patterns and optimization needs.
- **Use**: High-read systems where read models can be denormalized or cached.
- **Warning**: Adds complexity. Do not apply unless reads and writes are truly divergent.

## Functional Patterns

### Result / Either Type
- **When**: Functions can fail in expected ways and the caller must handle it.
- **Use**: Validation, parsing, business rule enforcement. Avoid exceptions for control flow.

### Pipeline / Compose
- **When**: Data flows through a series of transformations.
- **Use**: Data processing, ETL steps, request middleware chains.
