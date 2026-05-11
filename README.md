# nuxt-nats

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

NATS JetStream integration for Nuxt 4. Server-side publish, typed consumers, KV and Object Store — wired into Nitro's lifecycle with zero boilerplate.

- [✨ &nbsp;Release Notes](/CHANGELOG.md)

## Features

- **JetStream publish** with automatic JSON encoding, retry, and per-message deduplication (`Nats-Msg-Id`)
- **Pull consumers** with ackWait heartbeats, configurable backoff, and dead-letter routing
- **KV buckets** via `useKV(bucket)` — cached per process
- **Object Store** via `useObj(bucket)` — stream large blobs through Nitro handlers
- **Stream auto-provisioning** on startup (opt-in per stream)
- **Health endpoint** at `/api/_nats/health` — connection status, RTT, JetStream account stats
- **Typed subjects** — augment `NatsEvents` to get end-to-end type safety on `jsPublish`
- **Graceful shutdown** — drains in-flight messages on `SIGTERM`/`SIGINT` (works around [nitrojs/nitro#4015](https://github.com/nitrojs/nitro/issues/4015))
- **Bun-ready** — auto-detects Bun runtime and uses WebSocket transport

## Requirements

- Nuxt `>= 3.0.0`
- Node.js `>= 20` (or Bun)
- NATS Server `>= 2.10` with JetStream enabled

## Setup

```bash
npm install nuxt-nats
```

Add the module to `nuxt.config.ts`:

```ts
export default defineNuxtConfig({
  modules: ['nuxt-nats'],

  nats: {
    servers: ['nats://localhost:4222'],
  },
})
```

Credentials and server URLs can be overridden at runtime via environment variables:

```bash
NUXT_NATS_SERVERS=nats://prod.example.com:4222
NUXT_NATS_TOKEN=your-auth-token
```

## Usage

All server utilities are auto-imported inside `server/` — no manual imports needed.

### Publish to JetStream

```ts
// server/api/orders.post.ts
export default defineEventHandler(async (event) => {
  const body = await readBody(event)

  await jsPublish('orders.created', {
    id: body.id,
    total: body.total,
  }, {
    msgId: body.id,   // deduplication key
  })

  return { ok: true }
})
```

### Core publish (fire-and-forget)

```ts
// No PubAck, no durability — use for metrics or ephemeral events
corePublish('metrics.pageview', { path: '/home' })
```

### KV Store

```ts
export default defineEventHandler(async (event) => {
  const kv = await useKV('sessions')

  await kv.put('user:123', JSON.stringify({ role: 'admin' }))

  const entry = await kv.get('user:123')
  return JSON.parse(entry?.string() ?? 'null')
})
```

### Object Store

```ts
// Upload
export default defineEventHandler(async (event) => {
  const data = await readRawBody(event)
  const obs = await useObj('uploads')
  await obs.put({ name: 'report.pdf' }, data)
  return { ok: true }
})

// Download
export default defineEventHandler(async () => {
  const obs = await useObj('uploads')
  const entry = await obs.get('report.pdf')
  return entry?.data   // ReadableStream
})
```

### Consumers

Workers run only when `NUXT_NATS_WORKERS=true`. This prevents long-lived consumers from starting in serverless or stateless environments.

```ts
// server/workers/billing.ts
defineNatsConsumer({
  stream: 'ORDERS',
  durable: 'billing',
  ackWait: 30_000,
  maxDeliver: 5,
  deadLetterSubject: 'orders.dlq',

  async handler(msg, payload) {
    await processBillingEvent(payload)
    msg.ack()
  },
})
```

```bash
NUXT_NATS_WORKERS=true node .output/server/index.mjs
```

> **Tip:** For production, run the Nuxt server (publisher) and a separate worker process (consumers) as distinct deployments. Workers need a persistent Node.js or Bun runtime — not serverless.

### Typed subjects

Augment the `NatsEvents` interface to get full type safety across all `jsPublish` calls:

```ts
// types/nats.d.ts
declare module 'nuxt-nats' {
  interface NatsEvents {
    'orders.created': { id: string; total: number }
    'user.registered': { id: string; email: string }
    'invoice.paid': { invoiceId: string; amount: number }
  }
}
```

Now `jsPublish` is typed per subject:

```ts
await jsPublish('orders.created', { id: '123', total: 99.99 })  // ✅
await jsPublish('orders.created', { id: '123', foo: 'bar' })    // ✗ type error
```

## Configuration

```ts
export default defineNuxtConfig({
  nats: {
    // TCP servers (Node.js / Bun via compat)
    servers: ['nats://localhost:4222'],

    // WebSocket servers (Bun native / Cloudflare Workers)
    wsServers: ['wss://nats.example.com'],

    // 'auto' | 'tcp' | 'ws'  — default: 'auto'
    transport: 'auto',

    // Auth — prefer env vars in production
    token: '',
    user: '',
    pass: '',

    // -1 = infinite reconnects (default)
    maxReconnectAttempts: -1,

    // JetStream domain for multi-tenant setups
    jsDomain: '',

    // Streams to provision on startup
    streams: [
      {
        name: 'ORDERS',
        subjects: ['orders.>'],
        retention: 'limits',      // 'limits' | 'workqueue' | 'interest'
        storage: 'file',          // 'file' | 'memory'
        replicas: 1,
        provision: 'startup',     // 'startup' | 'never' (default: 'never')
      },
    ],

    health: {
      enabled: true,
      endpoint: '/api/_nats/health',
    },
  },
})
```

### Environment variables

All `runtimeConfig.nats.*` values can be overridden at runtime. Prefix with `NUXT_NATS_`:

| Variable | Description |
|---|---|
| `NUXT_NATS_SERVERS` | Comma-separated TCP server URLs |
| `NUXT_NATS_TOKEN` | Auth token |
| `NUXT_NATS_USER` | Username |
| `NUXT_NATS_PASS` | Password |
| `NUXT_NATS_WORKERS` | Set to `true` to start registered consumers |

## Health endpoint

```
GET /api/_nats/health
```

```json
{
  "connected": true,
  "status": "ok",
  "server": "nats://localhost:4222",
  "rttMs": 1,
  "jetstream": {
    "available": true,
    "streams": 3,
    "consumers": 7,
    "memory": 0,
    "storage": 204800
  }
}
```

## Architecture notes

### NATS lives on the server

The module only injects server-side utilities. Browser composables for NATS are intentionally excluded — credentials, JetStream consumers, and reconnect logic are server concerns.

```
Browser → Nuxt Server API → NATS / JetStream
```

### Serverless vs worker mode

| Mode | Publish | Consume | Runtimes |
|---|---|---|---|
| Default | ✅ | ❌ | Vercel, Netlify, Node, Bun |
| `NUXT_NATS_WORKERS=true` | ✅ | ✅ | Node, Bun (persistent only) |

For Cloudflare Workers, set `transport: 'ws'` and configure `wsServers`. Publish-only; consumers are not supported on edge runtimes.

### Stream provisioning

`provision: 'startup'` is idempotent when config matches exactly. If an existing stream has a different config, the module logs a warning and skips — it never auto-updates (storage/retention changes can cause data loss). Use the `nats` CLI or IaC to reconcile.

## Contribution

```bash
# Install dependencies
npm install

# Generate type stubs and prepare playground
npm run dev:prepare

# Start dev server (requires NATS on localhost:4222)
npm run dev

# Type check
npx tsc --noEmit

# Run tests
npm run test

# Build
npm run prepack
```

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/nuxt-nats/latest.svg?style=flat&colorA=020420&colorB=00DC82
[npm-version-href]: https://npmjs.com/package/nuxt-nats

[npm-downloads-src]: https://img.shields.io/npm/dm/nuxt-nats.svg?style=flat&colorA=020420&colorB=00DC82
[npm-downloads-href]: https://npm.chart.dev/nuxt-nats

[license-src]: https://img.shields.io/npm/l/nuxt-nats.svg?style=flat&colorA=020420&colorB=00DC82
[license-href]: https://npmjs.com/package/nuxt-nats

[nuxt-src]: https://img.shields.io/badge/Nuxt-020420?logo=nuxt
[nuxt-href]: https://nuxt.com
