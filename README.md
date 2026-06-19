# nuxt-nats

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

NATS JetStream integration for Nuxt. Server-side publish, typed consumers, KV and Object Store — wired into Nitro's lifecycle with zero boilerplate.

- [✨ &nbsp;Release Notes](/CHANGELOG.md)

## Features

- **JetStream publish** with automatic JSON encoding, retry, per-message deduplication (`Nats-Msg-Id`), typed tracing headers, and custom NATS message headers
- **Pull consumers** with ackWait heartbeats, configurable backoff, and dead-letter routing
- **Ephemeral consumers** via `useEphemeralConsumer()` — request-scoped consumers with timeout, disconnect cleanup, and per-message error isolation (ideal for SSE endpoints)
- **Connection lifecycle hooks** via `useNatsHooks()` — attach `onConnectError`, `onReconnect`, and `onDisconnect` callbacks for alerting and metrics
- **KV buckets** via `useKV(bucket)` — cached per process
- **Object Store** via `useObj(bucket)` — stream large blobs through Nitro handlers
- **Agent Fabric** via `defineNatsAgent()` / `useAgents()` — expose the server as a discoverable AI agent on the NATS bus or call other agents, on the [Synadia Agent Protocol](docs/guides/agents.md) (streaming, mid-stream human-in-the-loop, heartbeats)
- **Stream auto-provisioning** on startup (opt-in per stream, with `'update'` mode for config reconciliation)
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
  const traceId = getRequestHeader(event, 'x-trace-id') ?? crypto.randomUUID()

  await jsPublish('orders.created', {
    id: body.id,
    total: body.total,
  }, {
    msgId: body.id,                          // deduplication key
    traceId,                                 // sets X-Trace-Id header
    correlationId: traceId,                  // sets X-Correlation-Id header
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

### Ephemeral consumers (SSE / request-scoped)

For SSE endpoints that wait for a single matching event, use `useEphemeralConsumer()`. It creates an ordered, ephemeral JetStream consumer scoped to the request and handles timeout and client-disconnect cleanup automatically.

```ts
// server/api/orders/[id]/status.get.ts
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const stream = createEventStream(event)

  const handle = await useEphemeralConsumer({
    stream: 'ORDERS',
    filterSubjects: ['orders.*.shipped'],
    timeoutMs: 30_000,
    async onMessage(msg) {
      const payload = JSON.parse(new TextDecoder().decode(msg.data))
      if (payload.id !== id) return false          // not our order — keep waiting
      msg.ack()
      await stream.push({ event: 'shipped', data: JSON.stringify(payload) })
      await stream.close()
      return true                                  // done — stop the consumer
    },
    onTimeout: async () => {
      await stream.push({ event: 'timeout', data: '{}' })
      await stream.close()
    },
  })

  stream.onClosed(() => handle.stop())             // client disconnected
  return stream.send()
})
```

### Connection lifecycle hooks

Register callbacks for NATS connection events — useful for alerting and metrics:

```ts
// server/plugins/nats-hooks.ts
export default defineNitroPlugin(() => {
  useNatsHooks({
    onConnectError: (err) => logger.error('NATS connect failed', err),
    onReconnect: (server) => metrics.increment('nats.reconnect', { server }),
    onDisconnect: (server) => logger.warn('NATS disconnected', { server }),
  })
})
```

Multiple `useNatsHooks()` calls accumulate — all registered callbacks are called in order. Hook errors are isolated and never affect the module.

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

### Agent Fabric (Synadia Agent Protocol)

Expose the server as a discoverable AI agent, or call other agents on the bus. Like consumers, `defineNatsAgent` runs only when `NUXT_NATS_WORKERS=true`.

```ts
// server/plugins/assistant.ts — host an agent
export default defineNitroPlugin(() => {
  defineNatsAgent({
    agent: 'nuxt-assistant', owner: 'acme', name: 'web-1',
    async onPrompt(envelope, response) {
      for await (const token of llm.stream(envelope.prompt)) {
        await response.send(token)   // stream chunks back
      }
    },
  })
})
```

```ts
// server/api/ask.post.ts — call an agent
export default defineEventHandler(async (event) => {
  const { prompt } = await readBody(event)
  const [agent] = await useAgents().discover()
  if (!agent) return { error: 'no agents on the fabric' }

  let text = ''
  for await (const msg of await agent.prompt(prompt)) {
    if (msg.type === 'response') text += msg.text
  }
  return { response: text }
})
```

See the [Agent Fabric guide](docs/guides/agents.md) for mid-stream human-in-the-loop, controller endpoints, and lifecycle details.

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
        provision: 'startup',     // 'startup' | 'update' | 'never' (default: 'never')
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
| `NUXT_NATS_NKEY_SEED` | NKey seed (Ed25519 private key) |
| `NUXT_NATS_USER_JWT` | User JWT (signed when `NUXT_NATS_NKEY_SEED` is also set, unsigned otherwise) |
| `NUXT_NATS_WORKERS` | Set to `true` to start registered consumers |

### Authentication

The module selects an auth method based on which credentials are set, in this order:

1. **JWT + NKey (production)** — when both `userJwt` and `nkeySeed` are set, the module uses `jwtAuthenticator(jwt, seed)` from `@nats-io/nats-core`. This is the standard for NATS servers configured with the JWT resolver (`nsc` operator/account/user hierarchy). The JWT is sent during `CONNECT`; the NKey seed is used to sign the server's nonce to prove possession of the private key.
2. **JWT only** — when only `userJwt` is set, uses `jwtAuthenticator(jwt)`. The JWT is sent unsigned — only usable against servers configured to accept it (rare; mostly useful for testing or when the operator pins identity out-of-band).
3. **NKey only (dev)** — when only `nkeySeed` is set, uses `nkeyAuthenticator(seed)`. For static NKey-based servers without a JWT resolver.
4. **Token** — when only `token` is set.
5. **User / pass** — when only `user` (and optionally `pass`) is set.
6. **Anonymous** — when none of the above are set.

#### JWT Auth (production)

Generate a user JWT and NKey seed with [`nsc`](https://github.com/nats-io/nsc) (`nsc generate creds`) and pass them via env vars — never commit them to source:

```bash
NUXT_NATS_USER_JWT='eyJ0eXAiOiJqd3Q...'  # full user JWT
NUXT_NATS_NKEY_SEED='SUACSP3ZI...'       # matching user NKey seed (omit for unsigned JWT)
```

On startup the module checks the JWT's `exp` claim and logs a warning if it expires within 24 hours, or an error if it is already expired. Auth errors from the server (expired, revoked, missing permissions) are logged with an `AUTH ERROR` prefix so they are distinguishable from network errors. See the [NATS JWT guide](https://docs.nats.io/running-a-nats-service/nats_admin/security/jwt) for chain-of-trust details.

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

| `provision` | Behaviour |
|---|---|
| `'never'` (default) | Module does not touch the stream. Create it externally via CLI or IaC. |
| `'startup'` | Calls `jsm.streams.add()` on boot. If the stream already exists with a different config, logs a warning and skips — never auto-updates. |
| `'update'` | Calls `jsm.streams.add()` on boot. If the stream already exists with a different config, calls `jsm.streams.update()` to reconcile in place. Use when the stream config is owned by the app and shared with other services that may add subjects. |

Use `'never'` in production with external IaC. Use `'startup'` for local dev where you want idempotent creation. Use `'update'` when you need the app to own the authoritative stream config (e.g. the stream is shared and the app is responsible for keeping subjects up to date).

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
