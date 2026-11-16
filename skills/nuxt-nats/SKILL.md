---
name: nuxt-nats
description: Use this skill whenever working in a Nuxt 4 / Nitro project that uses the nuxt-nats module to talk to NATS JetStream or Synadia Cloud — configuring the module in nuxt.config (the `nats:` key), authenticating (creds, credsFile, JWT+NKey, runtime credential providers, the nuxt-nats-rotate CLI), publishing with jsPublish or corePublish, registering durable pull consumers with defineNatsConsumer or the declarative `nats.consumers` option, building a dead-letter consumer with defineDeadLetterConsumer, streaming to the browser with useEphemeralConsumer (SSE), using KV or Object Store via useKV and useObj, exposing or calling AI agents with defineNatsAgent and useAgents, typing subjects through the NatsEvents interface, or the NUXT_NATS_WORKERS worker gate. Trigger on any of those symbols, on the env vars NUXT_NATS_SERVERS, NUXT_NATS_CREDS, NUXT_NATS_CREDS_FILE, NUXT_NATS_USER_JWT, NUXT_NATS_NKEY_SEED or NUXT_NATS_WORKERS, or when a Nuxt app needs server-side NATS messaging, even if the user only says "add NATS to my Nuxt app". For raw @nats-io/* client code outside Nuxt use jetstream-architecture; for NATS server or cluster deployment use jetstream-deployment; for the Synadia agent wire protocol use nats-agent-fabric.
---

# nuxt-nats

`nuxt-nats` is a **Nuxt 4 / Nitro server-side module** (config key `nats`) that owns the NATS connection and JetStream lifecycle and gives you auto-imported server utilities for publishing, consuming, KV, Object Store and the Synadia agent fabric. It wraps the modular `@nats-io/*` v3 client, so you rarely import `@nats-io/*` yourself in an app.

It is **server-only**: there are no browser composables. Publish and consume from `server/` (plugins, API routes, Nitro tasks). Requires Node `>=22.12.0` (or Bun).

> This skill ships with the module and tracks its API. When in doubt, the module's own docs are the source of truth: `docs/api.md` and `docs/guides/` in the nuxt-nats repository. The module is pre-1.0; check the installed version's CHANGELOG before relying on a detail.

## What it gives you (auto-imported in `server/`)

| Utility | Purpose |
|---|---|
| `useNats()` / `useJetStream()` / `useJetStreamManager()` | Raw connection, JetStream client, manager. Throw before the connection is ready |
| `useJetStreamIfAvailable()` | Non-throwing `useJetStream()`; returns `null` until ready |
| `jsPublish(subject, payload, opts?)` | Durable JetStream publish: JSON encoding, retry, `msgId` dedup, typed via `NatsEvents`. Resolves `void` |
| `corePublish(subject, payload)` | Fire-and-forget core publish (no PubAck, not persisted) |
| `defineNatsConsumer(opts)` | Durable **pull** consumer (worker). Gated by `NUXT_NATS_WORKERS` |
| `defineDeadLetterConsumer(opts)` | Dead-letter handling over the max-deliver and terminated advisories |
| `useEphemeralConsumer(opts)` | Request-scoped ordered consumer, for SSE |
| `useKV(bucket, opts?)` / `useObj(bucket, opts?)` | KV and Object Store handles, cached per bucket name |
| `defineNatsAgent(opts)` / `useAgents()` / `getAgentStatuses()` | Host or call agents on the Synadia Agent Protocol |
| `useNatsHooks(hooks)` | Connection and credential lifecycle callbacks |
| `defineNatsCredentialsProvider(p)` / `useSynadiaCloud()` | Custom runtime credentials; Synadia Control Plane client |

## Reference files

Read the one you need, not all of them:

- `references/configuration.md`: the `nats:` options, env-var overrides, the auth priority chain, Synadia Cloud, runtime credential providers and `nuxt-nats-rotate`, and the provisioning stance.
- `references/publishing.md`: `jsPublish` and `corePublish`, `NatsEvents` typing, `msgId` dedup, tracing headers.
- `references/consumers.md`: the worker gate, `defineNatsConsumer` and declarative consumers, **ack discipline**, dead letters, `useEphemeralConsumer`.
- `references/kv-object.md`: `useKV` and `useObj`, and their real gotchas.
- `references/agents.md`: `defineNatsAgent` and `useAgents`.
- `references/gotchas.md`: SSR lifecycle race, reconnect semantics, externals, config drift, testing. Read before shipping to production.

## Minimal setup

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['nuxt-nats'],
  nats: {
    servers: ['nats://localhost:4222'],   // production: NUXT_NATS_SERVERS, all cluster nodes, comma-separated
    // credentials come from env, never from this file (see references/configuration.md)
    streams: [
      { name: 'ORDERS', subjects: ['orders.>'], provision: 'startup' },   // 'never' when IaC owns it
    ],
  },
})
```

```ts
// server/api/orders.post.ts: publish
export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  await jsPublish('orders.created', body, { msgId: body.id })   // msgId becomes Nats-Msg-Id
  return { ok: true }
})
```

```ts
// server/plugins/order-worker.ts: consume (runs only when NUXT_NATS_WORKERS=true)
export default defineNitroPlugin(() => {
  defineNatsConsumer({
    stream: 'ORDERS',
    durable: 'order-processor',          // must already exist unless provision: 'startup'
    async handler(msg, payload) {        // (JsMsg, parsed payload), in this order
      await processOrder(payload)
      msg.ack()                          // YOU ack. A return does not ack; a throw naks
    },
  })
})
```

## Core principles

- **Server-side only.** Never `useNats()` in a Vue component.
- **The handler acks.** `defineNatsConsumer` calls `handler(msg, payload)`; if it resolves and nothing acked, the message is redelivered after `ackWait`. Call `msg.ack()` (or `msg.term()` / `msg.nak(delay)`). A throw is logged and nak'd with the `backoff` delay. See `references/consumers.md`.
- **The worker gate is deliberate.** Consumers and agents run **only when `NUXT_NATS_WORKERS=true`**. Serverless/edge deployments publish fine but must not run long-lived pull loops; the recommended shape is a serverless publisher plus a separate persistent worker process. If a consumer "never fires", check this first.
- **Registration is a Nitro plugin concern.** Nitro does not scan `server/workers/`. Either call `defineNatsConsumer()` from `server/plugins/`, or declare it in `nats.consumers` (the module generates the plugin and imports the handler for you).
- **Binds, does not enforce.** Against an existing durable, `filterSubjects` and other settings you pass are not applied; the live durable wins and a filter mismatch is logged. `provision: 'never'` (the default) reports a missing durable once with the `nats consumer add` command.
- **NATS has no dead-letter queue.** `maxDeliver` means retry then stop. Use `deadLetterSubject` for a durable route, and `defineDeadLetterConsumer()` to observe messages the server gave up on.
- **Credentials belong in env or a provider.** A credential set literally in `nuxt.config` is serialized into the build output (the module warns at build time). Use `NUXT_NATS_*` env vars or `nats.credentials.provider`.
- **Type your subjects.** Augment `NatsEvents` from a `.d.ts` under `server/` or `shared/` that starts with `import type {} from 'nuxt-nats'`.
- **Respect the SSR lifecycle race.** Nitro does not await async plugins in order, so later plugins can run before the connection exists. Use `useJetStreamIfAvailable()` or let `defineNatsConsumer` / `defineNatsAgent` wait for you. See `references/gotchas.md`.
