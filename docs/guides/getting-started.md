# Getting Started

## Prerequisites

- Nuxt 4 project (4.6 tested)
- Node.js `^20.19.0 || >= 22.12.0`, or Bun
- NATS Server >= 2.10 with JetStream enabled, **or** a [Synadia Cloud](https://www.synadia.com/cloud) account (see [Using Synadia Cloud instead](#using-synadia-cloud-instead))

### Start a local NATS server

```bash
# Docker
docker run -p 4222:4222 nats:latest -js

# Or with nats-server binary
nats-server -js
```

Verify JetStream is on:

```bash
nats server info
# Look for: "jetstream": true
```

## Install

```bash
npm install nuxt-nats
```

## Minimal setup

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['nuxt-nats'],

  nats: {
    servers: ['nats://localhost:4222'],
  },
})
```

## First publish

Server utilities are auto-imported — no import statement needed:

```ts
// server/api/hello.post.ts
export default defineEventHandler(async (event) => {
  const body = await readBody(event)

  await jsPublish('demo.hello', { message: body.message })

  return { ok: true }
})
```

Test it:

```bash
curl -X POST http://localhost:3000/api/hello \
  -H 'Content-Type: application/json' \
  -d '{"message": "hello world"}'
```

## Check health

```bash
curl http://localhost:3000/api/_nats/health
```

```json
{
  "connected": true,
  "status": "ok",
  "server": "nats://localhost:4222",
  "auth": { "mode": "anonymous" },
  "rttMs": 1,
  "jetstream": { "available": true, "streams": 0, "consumers": 0, "memory": 0, "storage": 0 }
}
```

## Create your first stream

Add a stream definition to provision on startup:

```ts
nats: {
  servers: ['nats://localhost:4222'],
  streams: [
    {
      name: 'DEMO',
      subjects: ['demo.>'],
      storage: 'file',
      replicas: 1,
      provision: 'startup',
    },
  ],
},
```

Restart the dev server — the `DEMO` stream is created automatically. Verify:

```bash
nats stream info DEMO
```

## Using Synadia Cloud instead

No local server needed: create a NATS user in your Synadia Cloud account, download its `.creds` file, then:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['nuxt-nats'],
  nats: { synadia: true },   // geo-routed TLS + WebSocket endpoints
})
```

```bash
NUXT_NATS_CREDS_FILE=./app.creds npm run dev
```

Streams on Synadia Cloud must set `maxBytes`, and your plan limits connections and streams. The [Synadia Cloud guide](./synadia-cloud.md) covers regions, limits and placement; [Credential providers](./credentials-rotation.md) covers fetching and rotating creds at runtime.

## Next steps

- [Authentication](./auth.md) — creds files, JWT/NKey, tokens, and why secrets belong in env vars
- [Synadia Cloud](./synadia-cloud.md) and [Credential providers](./credentials-rotation.md) — managed NATS and rotating credentials
- [Streams](./streams.md) — configure retention, limits, placement
- [Consumers](./consumers.md) — set up durable workers
- [KV Store](./kv.md) — use JetStream KV for shared state
- [Object Store](./object-store.md) — store and retrieve large files
- [Typed Events](./typed-events.md) — end-to-end type safety per subject
- [Deployment](./deployment.md) — production topology, Kubernetes, serverless
