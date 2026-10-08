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

- Merge `ModuleOptions` from `nuxt.config.ts` into `runtimeConfig.nats` (private, server-only), pre-seeding every credential and `credentials.*` / `synadiaApi` leaf with `''` so `NUXT_NATS_*` env vars map at runtime
- With `nats.synadia`, fill in Synadia Cloud's TLS and WebSocket endpoints (`src/synadia.ts`) unless `servers` / `wsServers` are set
- Warn on a build when a credential is set literally in `nuxt.config` (it would be serialized into `.output`), and, with `synadia`, about provisioned streams without `maxBytes`
- Register the connection plugin via `addNitroPlugin()`
- When `nats.consumers` is non-empty, generate a second Nitro plugin (`nats-consumers.mjs`, built by `src/consumerTemplate.ts`) that statically imports each handler and calls `defineNatsConsumer()` for it, registered after the connection plugin. Relative handler paths resolve against `nuxt.options.serverDir`. Invalid definitions fail the build, and the array is deliberately not copied into `runtimeConfig`
- Register server util auto-imports via `addServerImportsDir()`
- Register the health endpoint via `addServerHandler()`, unless `health.enabled` is `false`
- In the `nitro:config` hook, register the virtual module `#nuxt-nats/credentials-provider` (`src/providerTemplate.ts`): it re-exports `credentials.customProvider` when set, otherwise `undefined`
- Mark NATS and Synadia packages as Nitro externals so native TCP sockets survive bundling

### 2. Nitro plugin (`src/runtime/server/plugins/nats.ts`)

Runs **once per server process** when Nitro boots. Responsibilities:

- Resolve credentials:
  - **Static** (default): `describeAuth()` reports the auth method, and `validateJwt()` warns about a JWT close to expiry (from `userJwt`, `creds` or `credsFile`). `buildAuthOptions()` builds the authenticator.
  - **Provider** (`credentials.provider` other than `static`): `createCredentialsProvider()` builds it (or takes the virtual module's custom provider), and `CredentialManager.init()` fetches the first credentials **before connecting**. The client gets `manager.authenticator()`, which reads the current credentials on every (re)connect, with `ignoreAuthErrorAbort: true`. After connecting, `manager.attach(() => nc.reconnect())` starts scheduled refreshes.
- Record the auth mode for the health endpoint (`setAuthMode`)
- Establish a singleton `NatsConnection` (TCP via `@nats-io/transport-node`, or WS via `wsconnect`), named `nuxt-nats@<hostname>:<pid>` unless `name` is set
- Create the `JetStreamClient` and `JetStreamManager`, provision declared streams whose `provision` is `'startup'` or `'update'`, and only then publish the client and manager singletons
- Watch connection status: log disconnect / reconnect / error events (auth failures with an `AUTH ERROR` prefix) and fire the `useNatsHooks()` callbacks, with `onReconnect` gated to once per outage. An authorization or authentication-expired error asks the credential manager for an immediate refresh
- Register graceful shutdown on the Nitro `close` hook **and** `process.once('SIGTERM'/'SIGINT')`

Nitro calls server plugins in registration order but does not await async ones, so every later plugin, including the generated consumers plugin and your own `server/plugins/`, starts while this one is still connecting. Code that runs at plugin time cannot assume the connection exists. `defineNatsAgent()` waits for the connection, and `defineNatsConsumer()` (and so `defineDeadLetterConsumer()` and `nats.consumers`) waits for the JetStream client, which is published only after streams are provisioned.

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
| `defineNatsCredentialsProvider(p)` | `NatsCredentialsProvider` | Types a custom credentials provider file |
| `useSynadiaCloud(opts?)` | `SynadiaClient` | Typed Synadia Control Plane client |

### 4. Health endpoint (`src/runtime/server/api/health.get.ts`)

A Nitro handler registered at `/api/_nats/health` (configurable). Reports connection status, the auth mode (never identities or secrets), RTT, JetStream account stats, and registered agents. With `health.details`, it adds the credential manager's snapshot. Disabled by setting `health.enabled: false`.

### 5. Credentials (`src/runtime/server/credentials/`)

Nitro-free, so it is unit-testable and shared with the CLI.

| File | Role |
|---|---|
| `manager.ts` | `CredentialManager`: single-flight fetch, refresh at `exp − clamp(lifetime × leadRatio, minLeadSec, maxLeadSec)` ±10% jitter, rate-limited reconnect when the credential fingerprint changes, backoff on failure (last good credentials kept), status `pending → ok → stale → expired` (or `failed` at boot) |
| `index.ts` | `createCredentialsProvider()`: maps `runtimeConfig.nats.credentials` to a provider |
| `providers/infisical.ts` | `createInfisicalClient()` (machine-identity login, secret read, write with create-on-404) and the `infisical` provider |
| `providers/synadia.ts` | Issues creds from the Control Plane |
| `cloud/aws.ts`, `gcp.ts`, `azure.ts` | Workload identity for Infisical, without cloud SDKs (AWS: credential chain + SigV4) |
| `http.ts`, `redact.ts`, `types.ts` | Error mapping without response bodies, secret redaction, public provider types |

### 6. Synadia Control Plane client and rotator

- `src/runtime/synadia/client.ts` — a `fetch` client over a curated subset of the Control Plane API, with curated types (`types.ts`) checked against the vendored OpenAPI spec (`openapi/`, not published). Public as `useSynadiaCloud()`.
- `src/runtime/cli/` — `nuxt-nats-rotate` (`bin.ts` → `dist/runtime/cli/bin.js`): `runRotate()` reads the stored creds, issues new ones, optionally verifies and rotates the nkey, writes to a `SecretStore` (`stores.ts`: Infisical, file, custom module) and revokes the old key. See [ADR-010](./adr/010-control-plane-client.md).

## Connection lifecycle

```
Nitro boot (plugins are called in order; async ones are not awaited)
  └─ nats.ts plugin
       └─ credentials:
            static   → describeAuth() + validateJwt()  [logs only]
            provider → CredentialManager.init()        [fetch before connect]
       └─ connect() / wsconnect()        ← later plugins start while this is pending
       └─ manager.attach(nc.reconnect)   [provider only: scheduled refreshes start]
       └─ status() iterator starts (background)
       └─ jetstream() + jetstreamManager()
       └─ provisionStreams() [provision: 'startup' | 'update']
       └─ JetStream client + manager published   ← waiting consumers start here
       └─ Nitro 'close' hook + SIGTERM / SIGINT handlers registered
  └─ generated nats-consumers.mjs plugin [if nats.consumers is set]
       └─ defineNatsConsumer() per entry, each waiting for the JetStream client
  └─ your server/plugins/**

Per request
  └─ useNats() / useJetStream() / useKV() / useObj()
       └─ return module-level singleton (no reconnect cost)

Shutdown (SIGTERM / SIGINT, or Nitro 'close'; the first one runs, later calls return)
  └─ stopAllAgents() → closeAgents()
  └─ stopAllConsumers()     stop pulling; handlers still running are not awaited
  └─ nc.drain()             flush pending publishes and acks, then close
  └─ credential manager dispose()   [provider only: stop refreshes]
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

The module uses module-level variables (`let _nc`, `let _js`, `let _jsm` and the auth mode in `plugins/_connection.ts`, the active manager in `credentials/manager.ts`) as the singleton store. This is safe because:

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
