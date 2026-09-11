# nuxt-nats

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

NATS JetStream integration for Nuxt. Server-side publish, typed consumers, KV and Object Store — wired into Nitro's lifecycle with zero boilerplate.

> **Status: Beta** — production-validated since June 2026. Running in multi-replica Docker Swarm deployments with JWT+NKey auth, JetStream publish, ephemeral consumers, and 5+ KV buckets under real traffic. API is stable; breaking changes unlikely before 1.0.

- [✨ &nbsp;Release Notes](/CHANGELOG.md)

## Features

- **JetStream publish** with automatic JSON encoding, retry, per-message deduplication (`Nats-Msg-Id`), typed tracing headers, and custom NATS message headers
- **Pull consumers** via `defineNatsConsumer()` or declared in `nuxt.config`, with opt-in durable provisioning, ackWait heartbeats, configurable backoff, and dead-letter routing
- **Dead-letter handling** via `defineDeadLetterConsumer()` — NATS has no dead-letter queue, so this consumes max-deliver and terminated advisories from a stream and recovers the original message
- **Ephemeral consumers** via `useEphemeralConsumer()` — request-scoped consumers with timeout, disconnect cleanup, and per-message error isolation (ideal for SSE endpoints)
- **Connection lifecycle hooks** via `useNatsHooks()` — attach `onConnectError`, `onReconnect` (once per outage), and `onDisconnect` callbacks for alerting and metrics
- **KV buckets** via `useKV(bucket)` — cached per process
- **Object Store** via `useObj(bucket)` — stream large blobs through Nitro handlers
- **Agent Fabric** via `defineNatsAgent()` / `useAgents()` — expose the server as a discoverable AI agent on the NATS bus or call other agents, on the [Synadia Agent Protocol](docs/guides/agents.md) (streaming, mid-stream human-in-the-loop, heartbeats)
- **Stream auto-provisioning** on startup (opt-in per stream, with `'update'` mode for config reconciliation)
- **Health endpoint** at `/api/_nats/health` — connection status, RTT, JetStream account stats, registered agents
- **Typed subjects** — augment `NatsEvents` to get end-to-end type safety on `jsPublish`
- **Graceful shutdown** — stops agents and consumers, then drains the connection on `SIGTERM`/`SIGINT` (works around [nitrojs/nitro#4015](https://github.com/nitrojs/nitro/issues/4015))
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

Workers run only when `NUXT_NATS_WORKERS=true`. This prevents long-lived consumers from starting in serverless or stateless environments. Without it the consumer logs a skip warning and the app publishes but consumes nothing.

Declare consumers in a **Nitro server plugin**. Nitro auto-registers `server/plugins/**`; it does not scan `server/workers/`, so a file there is never imported and the consumer never registers.

```ts
// server/plugins/billing.ts
export default defineNitroPlugin(() => {
  defineNatsConsumer({
    stream: 'ORDERS',
    durable: 'billing',
    filterSubjects: ['orders.created'],
    ackWait: 30_000,
    maxDeliver: 5,
    deadLetterSubject: 'orders.dlq',

    async handler(msg, payload) {
      await processBillingEvent(payload)
      msg.ack()
    },
  })
})
```

#### The durable has to exist

`defineNatsConsumer` binds to a durable, it does not create one by default, because a consumer's config is server-side state that usually belongs in IaC. Pass `provision: 'startup'` when you want the module to create it from the declared config instead:

```ts
defineNatsConsumer({
  stream: 'ORDERS',
  durable: 'billing',
  filterSubjects: ['orders.created'],
  provision: 'startup',   // create it if missing; default is 'never'
  async handler(msg) { msg.ack() },
})
```

Under the default `provision: 'never'`, a missing durable is reported once with an actionable error rather than retried silently.

`filterSubjects`, `ackPolicy`, `ackWait`, `maxDeliver` and `backoff` describe the durable and are written to it only when this call creates it; `ackWait`, `maxDeliver` and `backoff` also drive the module's own heartbeat, dead-letter and nak timing on every run. When the durable already exists, a declared `filterSubjects` that disagrees with the live one is reported as a mismatch: binding cannot change a server-side filter, so the consumer receives the live set.

The same options can be declared in `nuxt.config` instead; see [Declarative consumers](#declarative-consumers-in-nuxtconfig). Either way, start the process that should consume with the flag set:

```bash
NUXT_NATS_WORKERS=true node .output/server/index.mjs
```

> **Tip:** For production, run the Nuxt server (publisher) and a separate worker process (consumers) as distinct deployments. Workers need a persistent Node.js or Bun runtime — not serverless.

### Declarative consumers in `nuxt.config`

As an alternative to `defineNatsConsumer()`, declare consumers in config. The module
compiles them into a Nitro plugin at build time, statically importing each handler, so this
works with a bundled server and with files under `server/workers/` that Nitro does not scan.

```ts
// nuxt.config.ts
nats: {
  consumers: [
    {
      stream: 'ORDERS',
      durable: 'billing',
      filterSubjects: ['orders.created'],
      ackPolicy: 'explicit',
      ackWait: 30_000,
      maxDeliver: 5,
      deadLetterSubject: 'orders.dlq',
      provision: 'startup',
      handler: 'workers/billing',   // relative to server/, or absolute
    },
  ],
}
```

```ts
// server/workers/billing.ts
import type { JsMsg } from '@nats-io/jetstream'

export default async function (msg: JsMsg, payload: unknown) {
  await processBillingEvent(payload)
  msg.ack()
}
```

A missing `stream`, `durable` or `handler` fails the build, as does declaring two consumers
on the same durable. Consumers still start only when `NUXT_NATS_WORKERS=true`.

### Dead-letter handling

**NATS has no dead-letter queue.** Not in any released server, and not in 2.15-RC. When a
message exhausts `max_deliver` the server drops it and publishes an advisory, and that
advisory is the only signal you get.

`deadLetterSubject` on a consumer covers the common case: on the `maxDeliver`-th delivery
this module republishes the message to that subject, then terminates it with a reason, which
the server records in a `MSG_TERMINATED` advisory. If the republish still fails after
`jsPublish`'s retries, the failure is logged and the message is terminated anyway, so that
advisory is its only record. The durable's own `max_deliver` must be at least `maxDeliver` (or
unlimited), otherwise the server gives up first and the republish never happens; under
`provision: 'startup'` the module creates the durable with `max_deliver` set to `maxDeliver`.
For everything else, including messages that died on consumers you do not own, consume the
advisories directly:

```ts
// nuxt.config.ts — capture advisories into a stream you own
nats: {
  streams: [
    {
      name: 'JS_ADVISORY',
      subjects: [
        '$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>',
        '$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.>',
      ],
      retention: 'limits',
      storage: 'file',
      maxAge: '30d',
      provision: 'startup',
    },
  ],
}
```

```ts
// server/plugins/dead-letter.ts
export default defineNitroPlugin(() => {
  defineDeadLetterConsumer({
    stream: 'JS_ADVISORY',
    durable: 'dead-letter-handler',
    provision: 'startup',
    async onDeadLetter(event, msg) {
      // event.message is the ORIGINAL, fetched by sequence from event.stream
      await recordPoisonMessage({
        kind: event.kind,               // 'max_deliver' | 'terminated'
        stream: event.stream,
        consumer: event.consumer,
        seq: event.streamSeq,
        reason: event.reason,           // the msg.term(reason) string, when there was one
        body: event.message?.data,
      })
      msg.ack()
    },
  })
})
```

Two mistakes this exists to avoid. Do not use `jsm.advisories()`: it subscribes to
`$JS.EVENT.ADVISORY.>`, the whole-account firehose, which includes an audit advisory
published on *every* JetStream API response. And do not use a plain core subscription:
advisories are fire-and-forget, so anything published while your subscriber is redeploying
is gone permanently. Consuming them from a stream is what makes the failure path as durable
as the happy path.

The advisory carries a stream sequence, not the message, so the original is fetched by
sequence. That can legitimately return nothing if the message has already aged out of its
stream, in which case `event.message` is null and the handler still runs.

`MaxDeliverAdvisory` and `TerminatedAdvisory` are exported. The client types
`Advisory.data` as `unknown` and ships no payload types, so these are declared here. Note
`max_deliver` has no `consumer_seq`; only `terminated` does.

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
    // TCP servers. Default: ['nats://localhost:4222']
    servers: ['nats://localhost:4222'],

    // WebSocket servers for the WebSocket transport (falls back to `servers` when empty)
    wsServers: ['wss://nats.example.com'],

    // 'auto' | 'tcp' | 'ws' — default 'auto': WebSocket when running on Bun, TCP otherwise
    transport: 'auto',

    // Auth — prefer env vars in production. The first match wins:
    // userJwt + nkeySeed > userJwt > nkeySeed > token > user/pass > anonymous
    userJwt: '',
    nkeySeed: '',
    token: '',
    user: '',
    pass: '',

    // TLS: caFile for server TLS; add certFile + keyFile for mTLS
    tls: {
      caFile: '/etc/ssl/certs/nats-ca.pem',
    },

    // -1 = infinite reconnects (default)
    maxReconnectAttempts: -1,

    // JetStream domain and API prefix for multi-tenant setups
    jsDomain: '',
    jsApiPrefix: '',

    // Stream definitions, created on boot when provision is 'startup' or 'update'
    streams: [
      {
        name: 'ORDERS',
        subjects: ['orders.>'],
        retention: 'limits',      // 'limits' | 'workqueue' | 'interest'
        storage: 'file',          // 'file' | 'memory'
        replicas: 1,
        maxAge: '7d',             // Go-style durations: '30s', '5m', '2h', '7d'
        maxBytes: 1_073_741_824,  // 1 GB
        duplicateWindow: '5m',
        provision: 'startup',     // 'startup' | 'update' | 'never' (default: 'never')
      },
    ],

    // Consumers compiled into a generated Nitro plugin (see Declarative consumers above)
    consumers: [],

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
2. **JWT (unsigned)** — when `userJwt` is set without `nkeySeed`, uses `jwtAuthenticator(jwt)`. The JWT is sent unsigned — usable only against servers explicitly configured to accept unsigned JWTs, such as when identity is pinned out-of-band by operator policy or in test environments.
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

On startup the module checks the JWT's `exp` claim and logs a warning if it expires within 24 hours, or an error if it is already expired. Connection-status errors that mention `Authorization` or `Permissions Violation` are logged with an `AUTH ERROR` prefix so they are distinguishable from network errors; see [Auth errors](docs/guides/auth.md#auth-errors) for the exact format. See the [NATS JWT guide](https://docs.nats.io/running-a-nats-service/nats_admin/security/jwt) for chain-of-trust details.

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

When agents are registered in the process, the response also carries an `agents` array, and a process with no connection returns `{ "connected": false, "status": "disconnected" }`. See the [API reference](docs/api.md#health-endpoint).

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

# Lint and type check (module + playground)
npm run lint
npm run test:types

# Unit tests; integration tests need Docker (Testcontainers)
npm test
npm run test:integration

# Build
npm run prepack
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the pull request workflow and release steps.

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/nuxt-nats/latest.svg?style=flat&colorA=020420&colorB=00DC82
[npm-version-href]: https://npmjs.com/package/nuxt-nats

[npm-downloads-src]: https://img.shields.io/npm/dm/nuxt-nats.svg?style=flat&colorA=020420&colorB=00DC82
[npm-downloads-href]: https://npm.chart.dev/nuxt-nats

[license-src]: https://img.shields.io/npm/l/nuxt-nats.svg?style=flat&colorA=020420&colorB=00DC82
[license-href]: https://npmjs.com/package/nuxt-nats

[nuxt-src]: https://img.shields.io/badge/Nuxt-020420?logo=nuxt
[nuxt-href]: https://nuxt.com
