# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Commands

```bash
# First-time setup / after module source changes
npm run dev:prepare

# Unit tests (no Docker required)
npm test

# Single unit test file
npx vitest run test/unit/consumer.test.ts

# Integration tests (requires Docker — uses Testcontainers)
npm run test:integration

# Single integration test file
npx vitest run --config vitest.integration.config.ts test/integration/kv.test.ts

# Both suites
npm run test:all

# TypeScript check (module + playground)
npm run test:types

# Lint
npm run lint

# Build the distributable module
npm run prepack

# Start playground dev server (smoke-test the module end-to-end)
npm run dev

# Version management
npm run version:bump-alpha    # 0.1.0 → 0.1.0-alpha.1
npm run version:bump-minor    # → 0.2.0-alpha.0
npm run version:bump-major    # → 1.0.0-alpha.0
npm run version:print-tag     # prints v0.1.0
```

---

## Architecture

### How the module wires into Nitro

`src/module.ts` registers three things via `@nuxt/kit`:
1. A Nitro server plugin (`src/runtime/server/plugins/nats.ts`) — runs once at startup
2. Auto-imports from `src/runtime/server/utils/` — all utils are available without imports in `server/`
3. A health route handler (`src/runtime/server/api/health.get.ts`)

The plugin connects to NATS, provisions declared streams, starts JetStream, and registers SIGTERM/SIGINT handlers. The Nitro `close` hook is also registered but is unreliable (nitrojs/nitro#4015) — the manual signal handlers are the real shutdown path.

### Singleton isolation for testing

`_nc`, `_js`, and `_jsm` live in `src/runtime/server/plugins/_connection.ts` — a file with **no Nitro imports**. This is the critical design decision: importing from `nats.ts` in tests would pull in `#nitro-internal-virtual/storage` and crash. All utils and tests import from `_connection.ts` directly.

`_setConnectionForTesting(nc, js, jsm)` is the integration test entry point — it wires a real Testcontainers connection into the singletons without touching the Nitro plugin.

### Consumer loop

`defineNatsConsumer` (in `utils/consumer.ts`) runs a `while (!stopped)` loop calling `consumer.consume({ max_messages: 1, idle_heartbeat: 5_000 })`. Key behavior:
- `NUXT_NATS_WORKERS=true` must be set or the function is a no-op
- `msg.working()` is called every `ackWait / 2` ms to prevent redelivery during slow handlers
- DLQ fires when `msg.info.deliveryCount >= maxDeliver` — publishes via `jsPublish` (durable), then `msg.term()`
- Backoff: `msg.nak(backoff[Math.min(deliveryCount - 1, backoff.length - 1)])` — last entry reused when exhausted
- `stopAllConsumers()` must be called before `nc.drain()` on shutdown to prevent ack/connection races

### Typed subjects

`NatsEvents` is a module-augmentation interface in `src/runtime/server/utils/publish.ts`. Consumers augment it in their app:

```ts
declare module 'nuxt-nats' {
  interface NatsEvents {
    'orders.created': { id: string; total: number }
  }
}
```

`jsPublish('orders.created', payload)` is then fully typed. Unregistered subjects fall through to the `string` overload.

### KV and Object Store

`useKV(bucket, opts?)` and `useObj(bucket, opts?)` cache bucket handles by name. The `opts` distinction matters:
- **With opts**: calls `kvm.create(bucket, opts)` — creates if absent
- **Without opts**: calls `kvm.open(bucket)` / `obm.open(bucket)` — assumes bucket already exists

`@nats-io/obj` expects `ReadableStream<Uint8Array>` (Web Streams API), **not** a Node.js `Buffer`. Wrap buffers: `new ReadableStream({ start(c) { c.enqueue(new Uint8Array(buf)); c.close() } })`.

---

## Key Constraints

- **Never import from `nats.ts` in tests** — it pulls in Nitro virtual modules. Use `_connection.ts` or individual utils.
- **Auth priority**: nkey > token > user/pass. Only one method is applied — setting multiple is a silent misconfiguration.
- **`@nats-io/nats-core`** is the correct import for `nkeyAuthenticator`, not `@nats-io/nkeys`.
- **Integration tests run in a single fork** (`singleFork: true`) — Testcontainers container is shared across all integration suites via `beforeAll`/`afterAll` in each file calling `startNats()`/`stopNats()`.
- Unit test consumer mocks need a `handleRef` pattern (see `test/unit/consumer.test.ts`) to avoid the while-loop spinning after the mock iterator is exhausted.
