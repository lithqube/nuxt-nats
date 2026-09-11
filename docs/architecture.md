# Architecture

## Overview

`nuxt-nats` integrates NATS JetStream into Nuxt 4 as a server-side-only module. The module targets Nitro's server runtime exclusively — no browser-side NATS clients are shipped or encouraged.

```
┌─────────────────────────────────────────────────┐
│                  Browser / Client                │
│           Vue components, useFetch, $fetch       │
└───────────────────┬─────────────────────────────┘
                    │  HTTP
┌───────────────────▼─────────────────────────────┐
│              Nitro Server (Node / Bun)           │
│                                                  │
│  defineEventHandler()                            │
│    └─ jsPublish()      ─── JetStream publish     │
│    └─ useKV()          ─── KV bucket ops         │
│    └─ useObj()         ─── Object Store ops      │
│    └─ useAgents()      ─── call AI agents        │
│    └─ useNats()        ─── raw NatsConnection    │
│                                                  │
│  defineNatsConsumer()  ─── pull consumer loop    │
│  defineDeadLetterConsumer() ─── advisories       │
│  defineNatsAgent()     ─── host an AI agent      │
│    (only when NUXT_NATS_WORKERS=true)            │
└───────────────────┬─────────────────────────────┘
                    │  NATS protocol (TCP or WS)
┌───────────────────▼─────────────────────────────┐
│              NATS Server (JetStream enabled)     │
│  Streams · KV Buckets · Object Stores            │
└─────────────────────────────────────────────────┘
```

## Layers

### 1. Module layer (`src/module.ts`)

Runs at **build time** inside Nuxt's module system. Responsibilities:

- Merge `ModuleOptions` from `nuxt.config.ts` into `runtimeConfig.nats` (private, server-only)
- Register the connection plugin via `addServerPlugin()`
- When `nats.consumers` is non-empty, generate a second Nitro plugin (`nats-consumers.mjs`, built by `src/consumerTemplate.ts`) that statically imports each handler and calls `defineNatsConsumer()` for it, registered after the connection plugin. Invalid definitions fail the build, and the array is deliberately not copied into `runtimeConfig`
- Register server util auto-imports via `addServerImportsDir()`
- Register the health endpoint via `addServerHandler()`, unless `health.enabled` is `false`
- Mark NATS and Synadia packages as Nitro externals so native TCP sockets survive bundling

### 2. Nitro plugin (`src/runtime/server/plugins/nats.ts`)

Runs **once per server process** when Nitro boots. Responsibilities:

- Log a warning or error when the user JWT is close to expiry or already expired (`validateJwt()`)
- Establish a singleton `NatsConnection` (TCP via `@nats-io/transport-node`, or WS via `wsconnect`) with the auth method `buildAuthOptions()` selects
- Instantiate `JetStreamClient` and `JetStreamManager` from the connection
- Provision declared streams whose `provision` is `'startup'` or `'update'`
- Watch connection status: log disconnect / reconnect / error events (auth failures with an `AUTH ERROR` prefix) and fire the `useNatsHooks()` callbacks, with `onReconnect` gated to once per outage
- Register graceful shutdown on the Nitro `close` hook **and** `process.once('SIGTERM'/'SIGINT')`

Nitro calls server plugins in registration order but does not await async ones, so every later plugin, including the generated consumers plugin and your own `server/plugins/`, starts while this one is still connecting. Code that runs at plugin time cannot assume the connection exists; `defineNatsAgent()` waits for it before registering.

### 3. Server utils (`src/runtime/server/utils/`)

Auto-imported into all `server/` code via `addServerImportsDir`, exported types included. Each util is a thin layer over the singletons:

| Util | Returns | Notes |
|---|---|---|
| `useNats()` | `NatsConnection` | Raw connection for advanced use |
| `useJetStream()` | `JetStreamClient` | JetStream publish / consumer access |
| `useJetStreamIfAvailable()` | `JetStreamClient \| null` | `null` instead of throwing before the connection exists |
| `useJetStreamManager()` | `JetStreamManager` | Stream / consumer management |
| `useKV(bucket)` | `Promise<KV>` | Cached per bucket name |
| `useObj(bucket)` | `Promise<ObjectStore>` | Cached per bucket name |
| `jsPublish(subject, payload, opts)` | `Promise<void>` | JSON-encoded, retry, msgId dedup, trace headers |
| `corePublish(subject, payload)` | `void` | Fire-and-forget, no PubAck |
| `useNatsHooks(hooks)` | `void` | Connection lifecycle callbacks |
| `useEphemeralConsumer(opts)` | `Promise<EphemeralConsumerHandle>` | Request-scoped ordered consumer (SSE) |
| `defineNatsConsumer(opts)` | `ActiveConsumer` | Durable pull consumer: opt-in provisioning, heartbeat, backoff, DLQ |
| `defineDeadLetterConsumer(opts)` | `ActiveConsumer` | Durable consumer over max-deliver / terminated advisories |
| `stopAllConsumers()` | `void` | Called on shutdown |
| `defineNatsAgent(opts)` | `NatsAgentHandle` | Host a Synadia Agent Protocol agent |
| `useAgents()` | `Agents` | Discover and prompt agents |
| `getAgentStatuses()` | `Array<…>` | Used by the health endpoint |
| `stopAllAgents()` | `Promise<void>` | Called on shutdown |

### 4. Health endpoint (`src/runtime/server/api/health.get.ts`)

A Nitro handler registered at `/api/_nats/health` (configurable). Reports connection status, RTT, JetStream account stats, and registered agents. Disabled by setting `health.enabled: false`.

## Connection lifecycle

```
Nitro boot (plugins are called in order; async ones are not awaited)
  └─ nats.ts plugin
       └─ validateJwt()  [if userJwt is set; logs only]
       └─ connect() / wsconnect()        ← later plugins start while this is pending
       └─ status() iterator starts (background)
       └─ jetstream() + jetstreamManager()
       └─ provisionStreams() [provision: 'startup' | 'update']
       └─ Nitro 'close' hook + SIGTERM / SIGINT handlers registered
  └─ generated nats-consumers.mjs plugin [if nats.consumers is set]
       └─ defineNatsConsumer() per entry
  └─ your server/plugins/**

Per request
  └─ useNats() / useJetStream() / useKV() / useObj()
       └─ return module-level singleton (no reconnect cost)

Shutdown (SIGTERM / SIGINT, or Nitro 'close'; the first one runs, later calls return)
  └─ stopAllAgents() → closeAgents()
  └─ stopAllConsumers()     stop pulling; handlers still running are not awaited
  └─ nc.drain()             flush pending publishes and acks, then close
  └─ process.exit(0)        [signal path only]
```

## Transport selection

| Runtime | `transport: 'auto'` (default) | Override |
|---|---|---|
| Node.js | TCP (`@nats-io/transport-node`) to `servers` | `'ws'` for WebSocket |
| Bun | WebSocket (`wsconnect`) to `wsServers`, falling back to `servers`; detected via `globalThis.Bun` | `'tcp'` for TCP through Node compat |
| Cloudflare Workers | Not detected: `'auto'` picks TCP, which is unavailable | `transport: 'ws'` with `wsServers` |
| Deno Deploy | Not detected: `'auto'` picks TCP, which is unavailable | `transport: 'ws'` with `wsServers` |

`transport: 'auto'` selects WebSocket only when Bun is detected, and TCP everywhere else. Set `transport: 'ws'` explicitly for edge runtimes.

## Consumer isolation

Consumers and agents are guarded by `NUXT_NATS_WORKERS=true`. This is a deliberate constraint:

- **SSR / serverless deployments** run with `NUXT_NATS_WORKERS` unset — only publish paths are active. No long-lived async iterators, no durable consumer ownership.
- **Worker deployments** set `NUXT_NATS_WORKERS=true` and run the `defineNatsConsumer()`, `defineDeadLetterConsumer()` and `defineNatsAgent()` registrations, including those generated from `nats.consumers`. These require a persistent Node.js or Bun process.

Recommended production topology:

```
┌─────────────────┐     publishes      ┌───────────────┐
│  Nuxt SSR App   │ ─────────────────► │  NATS Server  │
│  (N replicas)   │                    │  JetStream    │
└─────────────────┘                    └───────┬───────┘
                                               │ delivers
                                      ┌────────▼───────┐
                                      │  Worker Process │
                                      │  (1+ replicas) │
                                      └────────────────┘
```

## Singleton pattern and multi-instance safety

The module uses module-level variables (`let _nc`, `let _js`, `let _jsm` in `plugins/_connection.ts`) as the singleton store. This is safe because:

- Each OS process gets its own module scope
- Nitro runs one plugin instance per process
- Multiple Nitro worker threads (if used) each get their own connection — NATS handles fan-out on the server side

For stream provisioning with multiple instances, `jsm.streams.add()` is idempotent when config matches exactly. On config drift (error `10058`), `'startup'` logs a warning and skips, since retention/storage changes can cause data loss; `'update'` calls `jsm.streams.update()` instead, which can race when several instances boot at once.

## Package externals

`@nats-io/transport-node` relies on Node's `net.Socket`. If Nitro bundles it, the socket implementation breaks. The module registers these packages as Nitro externals via the `nitro:config` hook:

```ts
const natsPackages = [
  '@nats-io/nats-core',
  '@nats-io/transport-node',
  '@nats-io/jetstream',
  '@nats-io/kv',
  '@nats-io/obj',
  '@nats-io/nkeys',
  '@nats-io/services',
  '@synadia-ai/agents',
  '@synadia-ai/agent-service',
]
```

This means they are resolved from `node_modules` at runtime rather than inlined into the Nitro bundle.
