# Publishing with nuxt-nats

Two publish functions, auto-imported in `server/`.

## `jsPublish`: durable JetStream publish

```ts
await jsPublish('orders.created', { id: '123', total: 99.99 }, {
  msgId: '123',                 // Nats-Msg-Id: deduped within the stream's duplicate window
  traceId,                      // X-Trace-Id
  correlationId: traceId,       // X-Correlation-Id
})
```

- It **resolves `void`**, not the `PubAck`. For the ack (for example `ack.duplicate`), use `useJetStream().publish()` directly.
- Pass a plain object, array, string, number, boolean or `null`; it is JSON-encoded for you.
- `PublishOpts`: `msgId`, `timeout` (PubAck ms, default 5000), `retries` (default 3), `retryDelay` (initial ms, doubles, default 200), `traceId`, `correlationId`, `headers`.
- Header precedence: `headers` first, then `traceId` / `correlationId`, then `msgId`, which always wins. It throws after the retries are exhausted.
- **`msgId` is the idempotency lever.** Make it deterministic per logical event (the row id, `orders.created.<orderId>`) so a retried publish cannot double-book. Dedup only holds inside the stream's `duplicateWindow` (default 2 minutes): size it at least as long as your slowest retry or outbox-drain path.

### At-least-once with idempotent effects

The honest "exactly once" on NATS is a **transactional outbox**: write the event to an outbox table in the same DB transaction as the change, and have a single relay publish rows with `msgId = row id` and mark them sent. A crash between publish and commit republishes, and broker dedup absorbs it. Make consumers idempotent too, keyed on `Nats-Msg-Id`.

## `corePublish`: fire-and-forget

```ts
corePublish('metrics.pageview', { path: '/home' })   // no PubAck, no persistence, no dedup
```

Use only for loss-tolerant signals (metrics, presence). Without a live subscriber the message is gone.

## Typed subjects (`NatsEvents`)

Declare subjects and payloads once and every `jsPublish` is checked. The file must live under `server/` or `shared/` and **must start with `import type {} from 'nuxt-nats'`**, or the augmentation silently does nothing:

```ts
// server/types/nats.d.ts
import type {} from 'nuxt-nats'

declare module 'nuxt-nats' {
  interface NatsEvents {
    'orders.created': { id: string; total: number }
  }
}
```

A declared subject accepts only its declared payload (a wrong shape is a type error). Undeclared literal subjects and `string`-typed subjects fall through to the untyped overload. See `docs/guides/typed-events.md` in the module repo.

## Discipline that pays off

- **One writer per subject family.** Do not write to the database and to NATS from two places; enqueue to the outbox and let one relay publish.
- **IDs on the wire, not sensitive payloads**, where consumers can re-read from the source of truth. Log counts and trace ids, not payloads.
- **Schema version goes in a header or payload field, never in the subject** (`document.uploaded.v2` bakes it into stream config and breaks replay).
- Consumers read tracing headers from the message: `msg.headers?.get('X-Trace-Id')`.
