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
│    └─ useNats()        ─── raw NatsConnection    │
│                                                  │
│  defineNatsConsumer()  ─── pull consumer loop    │
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

- Accept and validate `ModuleOptions` from `nuxt.config.ts`
- Merge options into `runtimeConfig.nats` (private, server-only)
- Register the Nitro plugin via `addServerPlugin()`
- Register server util auto-imports via `addServerImportsDir()`
- Register the health endpoint via `addServerHandler()`
- Mark NATS packages as Nitro externals so native TCP sockets survive bundling

### 2. Nitro plugin (`src/runtime/server/plugins/nats.ts`)

Runs **once per server process** when Nitro boots. Responsibilities:

- Establish a singleton `NatsConnection` (TCP via `@nats-io/transport-node`, or WS via `wsconnect`)
- Instantiate `JetStreamClient` and `JetStreamManager` from the connection
- Provision declared streams (when `provision: 'startup'`)
- Monitor connection status and log disconnect/reconnect/error events
- Register graceful drain on Nitro `close` hook **and** `process.once('SIGTERM'/'SIGINT')`

### 3. Server utils (`src/runtime/server/utils/`)

Auto-imported into all `server/` code via `addServerImportsDir`. Each util is a thin accessor on top of the singletons:

| Util | Returns | Notes |
|---|---|---|
| `useNats()` | `NatsConnection` | Raw connection for advanced use |
| `useJetStream()` | `JetStreamClient` | JetStream publish / consumer access |
| `useJetStreamManager()` | `JetStreamManager` | Stream / consumer management |
| `useKV(bucket)` | `Promise<KV>` | Cached per bucket name |
| `useObj(bucket)` | `Promise<ObjectStore>` | Cached per bucket name |
| `jsPublish(subject, payload, opts)` | `Promise<void>` | JSON-encoded, retry, msgId dedup |
| `corePublish(subject, payload)` | `void` | Fire-and-forget, no PubAck |
| `defineNatsConsumer(opts)` | `ActiveConsumer` | Pull consumer with DLQ + heartbeat |
| `stopAllConsumers()` | `void` | Called on shutdown |

### 4. Health endpoint (`src/runtime/server/api/health.get.ts`)

A Nitro handler registered at `/api/_nats/health` (configurable). Reports connection status, RTT, and JetStream account stats. Disabled by setting `health.enabled: false`.

## Connection lifecycle

```
Nitro boot
  └─ defineNitroPlugin runs
       └─ connect() / wsconnect()
       └─ jetstream() + jetstreamManager()
       └─ provisionStreams() [if provision: 'startup']
       └─ status() iterator starts (background)
       └─ SIGTERM / SIGINT handlers registered

Per request
  └─ useNats() / useJetStream() / useKV() / useObj()
       └─ return module-level singleton (no reconnect cost)

Shutdown
  └─ SIGTERM received → nc.drain() → process.exit(0)
  └─ OR Nitro 'close' hook → nc.drain()
       (both paths registered; first one wins)
```

## Transport selection

| Runtime | Default transport | Fallback |
|---|---|---|
| Node.js | TCP (`@nats-io/transport-node`) | WS if `transport: 'ws'` |
| Bun | TCP via Node compat | WS if Bun detected (`globalThis.Bun`) |
| Cloudflare Workers | WS (`wsconnect`) | TCP not available |
| Deno Deploy | WS (`wsconnect`) | TCP not available |

`transport: 'auto'` (default) selects TCP on Node and WS when Bun is detected. Set `transport: 'ws'` explicitly for edge runtimes.

## Consumer isolation

Consumers are guarded by `NUXT_NATS_WORKERS=true`. This is a deliberate constraint:

- **SSR / serverless deployments** run with `NUXT_NATS_WORKERS` unset — only publish paths are active. No long-lived async iterators, no durable consumer ownership.
- **Worker deployments** set `NUXT_NATS_WORKERS=true` and run `defineNatsConsumer()` registrations on startup. These require a persistent Node.js or Bun process.

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

The module uses module-level variables (`let _nc`, `let _js`, `let _jsm`) as the singleton store. This is safe because:

- Each OS process gets its own module scope
- Nitro runs one plugin instance per process
- Multiple Nitro worker threads (if used) each get their own connection — NATS handles fan-out on the server side

For stream provisioning with multiple instances, `jsm.streams.add()` is idempotent when config matches exactly. Config drift (error `10058`) logs a warning and skips — never auto-updates, since retention/storage changes can cause data loss.

## Package externals

`@nats-io/transport-node` relies on Node's `net.Socket`. If Nitro bundles it, the socket implementation breaks. The module registers all `@nats-io/*` packages as Nitro externals via the `nitro:config` hook:

```ts
nitroConfig.externals.external.push(
  '@nats-io/nats-core',
  '@nats-io/transport-node',
  '@nats-io/jetstream',
  '@nats-io/kv',
  '@nats-io/obj',
  '@nats-io/nkeys',
)
```

This means the NATS packages are resolved from `node_modules` at runtime rather than inlined into the Nitro bundle.
