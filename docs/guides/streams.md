# Streams

A JetStream stream is a persistent, ordered log of messages matching one or more subjects. Unlike core NATS, messages are stored on the server and can be replayed, consumed durably, and retained across reconnects.

## Declaring streams in nuxt.config.ts

```ts
nats: {
  streams: [
    {
      name: 'ORDERS',
      subjects: ['orders.>'],
      retention: 'limits',
      storage: 'file',
      replicas: 1,
      maxAge: '7d',
      maxBytes: 1_073_741_824,     // 1 GB
      duplicateWindow: '2m',
      provision: 'startup',
    },
  ],
},
```

### provision modes

| Value | Behaviour |
|---|---|
| `'never'` (default) | Module does not touch the stream. Create it externally via CLI or IaC. |
| `'startup'` | Calls `jsm.streams.add()` on every boot. If the stream already exists with a different config, logs a warning and skips. |
| `'update'` | Calls `jsm.streams.add()` on every boot. If the stream already exists with a different config, calls `jsm.streams.update()` to reconcile in place. |

**When to use `'update'`:** Use when your app owns the authoritative stream config and the stream is shared with other services that may add subjects dynamically. On every boot the app ensures the stream reflects the declared config — useful when subjects are managed by multiple services and your app is responsible for keeping them current.

**`'update'` vs `'startup'`:** `'startup'` warns and skips on config drift (safe for production, prevents accidental overwrites). `'update'` reconciles automatically (useful for local dev and shared streams where the app is the owner). Note that `jsm.streams.update()` cannot change `storage` or `retention` on an existing stream — those require delete-and-recreate.

In production, prefer `'never'` and provision via the NATS CLI or IaC. See [ADR-008](../adr/008-stream-provisioning.md) for the rationale.

### retention policies

| Policy | When to use |
|---|---|
| `'limits'` (default) | General event log — keep up to age/size limits |
| `'workqueue'` | Task queue — messages deleted after any consumer acks |
| `'interest'` | Pub/sub — messages kept only while consumers exist |

### storage types

| Type | When to use |
|---|---|
| `'file'` (default) | Durable — survives server restart |
| `'memory'` | Ephemeral / cache — fastest, lost on restart |

### replicas

Replication factor for the stream across the NATS cluster. Must be an odd number (for Raft quorum) and cannot exceed the cluster size.

| Value | Use case |
|---|---|
| `1` | Development, single-node setups |
| `3` | Standard production (tolerates 1 node loss) |
| `5` | High-availability production (tolerates 2 node losses) |

`replicas: 5` (R5) is the practical maximum — NATS JetStream supports up to 5 replicas per stream. Beyond R5, the Raft consensus overhead outweighs the durability benefit. Most production deployments use R3 (3-node cluster) or R5 (5-node cluster).

## Managing streams at runtime

Use `useJetStreamManager()` for dynamic stream operations:

```ts
// server/api/admin/streams.get.ts
export default defineEventHandler(async () => {
  const jsm = useJetStreamManager()
  const streams = await jsm.streams.list().next()
  return streams.map(s => ({ name: s.config.name, messages: s.state.messages }))
})
```

### Creating a stream at runtime

```ts
const jsm = useJetStreamManager()

await jsm.streams.add({
  name: 'NOTIFICATIONS',
  subjects: ['notifications.>'],
  retention: 'limits',
  storage: 'file',
  num_replicas: 1,
  max_age: 86_400_000_000_000,   // 24h in nanoseconds
})
```

### Purging a stream

```ts
await jsm.streams.purge('ORDERS')
```

### Deleting a stream

```ts
await jsm.streams.delete('OLD_STREAM')
```

## Subject hierarchy

Design subjects hierarchically for flexible consumer filtering:

```
orders.{region}.{status}

orders.us-east.created
orders.eu-west.shipped
orders.us-east.cancelled
```

A stream with subject `orders.>` captures all of these. Consumers can filter to `orders.us-east.>` or `orders.*.created` without a separate stream per region.

## Deduplication

Duration fields (`maxAge`, `duplicateWindow`) accept Go-style duration strings: `"30s"`, `"5m"`, `"2h"`, `"7d"`. These are converted to nanoseconds on startup.

Enable the `duplicateWindow` field (default: 2 minutes when not set explicitly) to prevent duplicate messages during retried publishes:

```ts
// nuxt.config.ts
streams: [{ name: 'ORDERS', subjects: ['orders.>'], duplicateWindow: '5m' }]
```

Then pass a stable `msgId` per publish:

```ts
await jsPublish('orders.created', payload, { msgId: order.id })
```

If the same `msgId` arrives within the duplicate window, JetStream discards it silently and returns a `PubAck` with `duplicate: true`.
