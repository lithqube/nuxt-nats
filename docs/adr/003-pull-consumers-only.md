# ADR-003: Pull consumers only — no push consumer API

**Status:** Accepted  
**Date:** 2026-05-11

## Context

JetStream has two consumer delivery models:

**Push consumers** (`js.subscribe()` in legacy SDK):
- Server pushes messages to the client as they arrive
- Client registers a subject to receive deliveries
- Simple to use, but removed in `@nats-io/jetstream` v3

**Pull consumers** (`js.consumers.get().consume()` in v3 SDK):
- Client explicitly pulls messages from the server
- Supports backpressure — the client controls the rate
- Supports batching
- The only consumer model available in the v3 SDK

## Decision

`defineNatsConsumer` uses pull consumers exclusively via the v3 API:

```ts
const consumer = await js.consumers.get(stream, durable)
const iter = await consumer.consume({ max_messages: 1 })
for await (const msg of iter) { ... }
```

No push consumer API is planned.

## Consequences

- **Backpressure by default.** Workers cannot be overwhelmed by a fast producer — message delivery is gated by the pull loop.
- **Natural pause/resume.** `iter.stop()` immediately stops delivery without leaving messages in-flight. Clean shutdown is straightforward.
- **Single message per iteration step.** `max_messages: 1` is used so each handler invocation is independent and error isolation is clean. Batch pull (`max_messages: N`) is available if users access the consumer directly via `useJetStream()`.
- **No v3 push consumer support.** The v3 SDK does provide push consumers for ordered/ephemeral use cases (e.g., `OrderedPushConsumerOptions`), but these are not surfaced in `defineNatsConsumer` because they are not suitable for durable worker queues. Advanced users can access them via `useJetStream()` directly.

## Alternatives considered

**Expose push consumers for ordered replay:** Could be useful for event sourcing / read model rebuilds. Deferred to v2 — the use case requires different options (no ack, ordered delivery) and would complicate the `defineNatsConsumer` API significantly.
