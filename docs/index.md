# nuxt-nats Documentation

NATS JetStream integration for Nuxt 4. Server-side publish, typed consumers, KV and Object Store.

## Contents

### Guides

| Guide | Description |
|---|---|
| [Getting Started](./guides/getting-started.md) | Install, minimal setup, first publish, health check |
| [Streams](./guides/streams.md) | Configure retention, storage, provisioning, deduplication |
| [Consumers](./guides/consumers.md) | Durable pull consumers, ack patterns, DLQ, scaling |
| [KV Store](./guides/kv.md) | Key-value storage, watch, typed helpers |
| [Object Store](./guides/object-store.md) | Blob storage, streaming upload/download |
| [Agent Fabric](./guides/agents.md) | Host or call AI agents on the Synadia Agent Protocol over NATS |
| [Typed Events](./guides/typed-events.md) | NatsEvents augmentation, end-to-end type safety |
| [Deployment](./guides/deployment.md) | Node, Docker, Kubernetes, Vercel, Cloudflare Workers, Bun |

### Reference

| Document | Description |
|---|---|
| [API Reference](./api.md) | All auto-imported server utils, types, options |
| [Architecture](./architecture.md) | System design, layers, lifecycle, connection model |

### Architecture Decision Records

| ADR | Decision |
|---|---|
| [ADR-001](./adr/001-modular-nats-sdk.md) | Use `@nats-io/*` modular SDK over legacy `nats` package |
| [ADR-002](./adr/002-server-side-only.md) | Server-side only — no browser-side NATS client |
| [ADR-003](./adr/003-pull-consumers-only.md) | Pull consumers only — no push consumer API |
| [ADR-004](./adr/004-worker-guard.md) | Consumer guard via `NUXT_NATS_WORKERS` env var |
| [ADR-005](./adr/005-sigterm-handlers.md) | Manual SIGTERM/SIGINT handlers alongside Nitro close hook |
| [ADR-006](./adr/006-nitro-externals.md) | Mark `@nats-io/*` packages as Nitro externals |
| [ADR-007](./adr/007-typed-events.md) | `NatsEvents` interface augmentation for typed subjects |
| [ADR-008](./adr/008-stream-provisioning.md) | Stream provisioning defaults to `'never'`, opt-in per stream |

## Quick reference

```ts
// nuxt.config.ts
nats: {
  servers: ['nats://localhost:4222'],
  streams: [{ name: 'ORDERS', subjects: ['orders.>'], provision: 'startup' }],
}

// server/api/order.post.ts
await jsPublish('orders.created', { id: '123', total: 99.99 }, { msgId: '123' })

// server/workers/billing.ts  (NUXT_NATS_WORKERS=true)
defineNatsConsumer({
  stream: 'ORDERS', durable: 'billing',
  async handler(msg, payload) { await process(payload); msg.ack() },
})

// server/api/config.ts
const kv = await useKV('config')
await kv.put('theme', 'dark')

// server/api/upload.post.ts
const obs = await useObj('uploads')
await obs.put({ name: 'file.pdf' }, await readRawBody(event))
```
