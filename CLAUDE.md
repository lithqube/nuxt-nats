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

# Coverage (requires @vitest/coverage-v8, already installed)
npx vitest run --coverage

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

Pre-releases have been on the `beta` dist-tag since 0.1.0-beta.1. Do not run `version:bump-alpha` or `release:alpha` on a beta version: `--preid=alpha` moves `0.1.0-beta.N` back to `0.1.0-alpha.0`. The beta release steps are in CONTRIBUTING.md → Releases.

---

## Architecture

### How the module wires into Nitro

`src/module.ts` registers, via `@nuxt/kit`:
1. The connection plugin (`src/runtime/server/plugins/nats.ts`) — runs once at startup
2. When `nats.consumers` is non-empty, a generated plugin (`nats-consumers.mjs`, see [Declarative consumers](#declarative-consumers)), registered after the connection plugin
3. Auto-imports from `src/runtime/server/utils/` — all utils, and their exported types, are available without imports in `server/`
4. A health route handler (`src/runtime/server/api/health.get.ts`), unless `health.enabled` is `false`

It also marks the `@nats-io/*` and `@synadia-ai/*` packages as Nitro externals in the `nitro:config` hook.

The connection plugin validates the user JWT, connects, starts JetStream, provisions declared streams, and registers SIGTERM/SIGINT handlers. The Nitro `close` hook is also registered but is unreliable (nitrojs/nitro#4015) — the manual signal handlers are the real shutdown path. `drainAndClose()` runs `stopAllAgents()` → `closeAgents()` → `stopAllConsumers()` → `nc.drain()`, each step error-isolated.

**Nitro (nitropack 2) calls server plugins in order without awaiting async ones.** Every plugin after `nats.ts`, the generated consumers plugin and the app's own `server/plugins/` included, runs while the connection is still pending, so code that runs at plugin time must not assume `_nc`/`_js` exist. `defineNatsAgent()` polls `getNatsConnection()` every 250 ms before registering. `defineNatsConsumer()` does not wait yet: its loop calls `useJetStream()` before the retry `try`, so a consumer registered at plugin time dies with an unhandled rejection until that is fixed.

### Singleton isolation for testing

`_nc`, `_js`, and `_jsm` live in `src/runtime/server/plugins/_connection.ts` — a file with **no Nitro imports**. This is the critical design decision: importing from `nats.ts` in tests would pull in `nitropack/runtime` (and `#nitro-internal-virtual/storage`) and crash. All utils and tests import from `_connection.ts` directly.

`_setConnectionForTesting(nc, js, jsm)` is the integration test entry point — it wires a real Testcontainers connection into the singletons without touching the Nitro plugin.

The one exception is `test/unit/statusHandling.test.ts`, which needs `handleStatus()` from `nats.ts`: it mocks `nitropack/runtime` with `vi.mock` first, then loads the plugin with a dynamic `await import()`.

### Connection lifecycle hooks

`useNatsHooks()` (in `utils/useNatsHooks.ts`) registers callbacks via module-level arrays `_connectErrorHooks`, `_reconnectHooks`, `_disconnectHooks`. The Nitro plugin's `handleStatus()` and connect-error catch call the corresponding `_fire*()` functions. Hook errors are caught and silently discarded — they must never affect module behavior.

`handleStatus()` forwards `reconnect` only on the disconnect → reconnect transition (the `_wasDisconnected` flag), because the client emits a `reconnect` status per retry attempt (nats.js#423); `disconnect` fires every time. Status errors whose message contains `Authorization` or `Permissions Violation` are logged with an `AUTH ERROR` prefix.

`_clearNatsHooks()` and `_resetStatusStateForTests()` are exposed for tests only — call them in `beforeEach`.

### Ephemeral consumers

`useEphemeralConsumer()` (in `utils/useEphemeralConsumer.ts`) creates an ordered JetStream consumer via `js.consumers.get(stream, { filter_subjects: [...] })` — note `filter_subjects` (snake_case) is the correct `OrderedConsumerOptions` field, not `filterSubjects`. The public API accepts `filterSubjects` (camelCase) and maps it internally.

The async message loop runs in a detached `async IIFE`. `handle.stop()` sets `stopped = true` and calls `messages.stop()` — the iterator will throw on its next iteration, which is caught and ignored. The `onDisconnect` callback is only fired when `stop()` is called before the consumer finds a matching message (i.e., the timer has not fired and `stopped` was false before the call).

### Consumer loop

`defineNatsConsumer` (in `utils/consumer.ts`) runs a `while (!stopped)` loop. Each pass calls `ensureConsumer()`, then `js.consumers.get(stream, durable)` and `consumer.consume({ max_messages: 1, idle_heartbeat: 5_000 })`. Key behavior:
- `NUXT_NATS_WORKERS=true` must be set or the function is a no-op
- `ensureConsumer()` calls `jsm.consumers.info()`. Only `err instanceof JetStreamApiError && err.code === JetStreamApiCodes.ConsumerNotFound` counts as absent; anything else rethrows into the loop's retry. `ConsumerNotFoundError` is declared in the `.d.ts` but is not a runtime export of `@nats-io/jetstream`
- Absent + `provision: 'startup'` → `jsm.consumers.add()`. `ackWait` and `backoff` are converted ms → ns there (passing ms would set a microsecond ack wait); one filter subject is sent as `filter_subject`, several as `filter_subjects`
- Absent + `provision: 'never'` (default) → `ConsumerMissingError`, logged once rather than every 5 s, with the `nats consumer add` command
- Present + declared `filterSubjects` that differ from the live filter → `console.error` mismatch; the live filter wins. Nothing is ever updated on an existing durable
- `msg.working()` is called every `ackWait / 2` ms to prevent redelivery during slow handlers
- DLQ fires when `deadLetterSubject` is set and `msg.info.deliveryCount >= maxDeliver` — publishes via `jsPublish` (durable), then `msg.term(reason)`; the reason reaches the server's terminated advisory
- Backoff: `msg.nak(backoff[Math.min(deliveryCount - 1, backoff.length - 1)])` — last entry reused when exhausted
- Any other loop error logs `loop error, retrying in 5s` and retries
- `stopAllConsumers()` must be called before `nc.drain()` on shutdown to prevent ack/connection races

`consumers.addOrUpdate` is unreleased upstream and `ConsumerApiAction.CreateOrUpdate` is unreachable in 3.4.0, so the info-then-add shape is deliberate.

### Declarative consumers

`nats.consumers` is compiled at build time. `generateConsumerPlugin()` in `src/consumerTemplate.ts` is a pure string function (unit-tested on its output) that emits a Nitro plugin statically importing each `handler` path and calling `defineNatsConsumer()` with the entry. It throws on a missing `stream`/`durable`/`handler`, a duplicate stream + durable, or a `'`, `\` or newline in an interpolated value. `module.ts` injects `resolveHandler` and the consumer util path. The array is intentionally not mirrored into `runtimeConfig`.

### Dead-letter handling

NATS has no dead-letter queue; the `MAX_DELIVERIES` / `MSG_TERMINATED` advisories are the only signal. `defineDeadLetterConsumer()` (in `utils/deadLetter.ts`) is a `defineNatsConsumer` over a user-provisioned stream that captures both advisory subjects. `toDeadLetterEvent()` derives `kind` from the payload's `type`, not the subject, and copies `consumerSeq`/`reason` only for `terminated`: `max_deliver` has no `consumer_seq`, and a test asserts the key is absent. The original message is fetched with `jsm.streams.getMessage(stream, { seq })`; a failed fetch is expected (the message aged out) and yields `message: null` plus a warning. There is no `deadLetterSubject` by design — a failing dead-letter handler would loop.

### Agent Fabric

`defineNatsAgent()` (in `utils/defineNatsAgent.ts`) and `useAgents()` (in `utils/useAgents.ts`) wrap `@synadia-ai/agent-service` and `@synadia-ai/agents`, which are 0.x and unstable, so keep the wrapper thin. Agents run only with `NUXT_NATS_WORKERS=true`, wait for the connection before registering, and are tracked for `getAgentStatuses()` (health endpoint) and `stopAllAgents()` (shutdown).

### Stream provisioning

`provisionStreams()` lives in `utils/provisionStreams.ts` (extracted from the plugin for testability). It detects stream-exists errors via `err instanceof JetStreamApiError && err.code === 10058` — **not** `err.api_error.err_code` (the old `@nats-io/jetstream` v2 shape). The `JetStreamApiError.code` getter is the correct v3 API.

### Typed subjects

`NatsEvents` is a module-augmentation interface in `src/runtime/server/utils/publish.ts`. Consumers augment it in their app:

```ts
declare module 'nuxt-nats' {
  interface NatsEvents {
    'orders.created': { id: string; total: number }
  }
}
```

`jsPublish('orders.created', payload)` is then fully typed. Unregistered subjects fall through to the `string` overload. Caveat: that overload also accepts registered subjects, so a wrong payload for a declared subject currently compiles through the fallback.

`jsPublish` accepts `traceId` and `correlationId` in `PublishOpts` — these set `X-Trace-Id` and `X-Correlation-Id` headers and take precedence over the same keys in `headers`. `msgId` still wins over everything for deduplication.

### KV and Object Store

`useKV(bucket, opts?)` and `useObj(bucket, opts?)` cache bucket handles by name. The `opts` distinction matters:
- **With opts**: calls `kvm.create(bucket, opts)` — creates if absent
- **Without opts**: calls `kvm.open(bucket)` / `obm.open(bucket)` — assumes bucket already exists

`@nats-io/obj` expects `ReadableStream<Uint8Array>` (Web Streams API), **not** a Node.js `Buffer`. Wrap buffers: `new ReadableStream({ start(c) { c.enqueue(new Uint8Array(buf)); c.close() } })`.

---

## Key Constraints

- **Never import from `nats.ts` in tests** unless `nitropack/runtime` is mocked first (see `statusHandling.test.ts`). Use `_connection.ts` or individual utils.
- **Auth priority**: JWT + NKey > JWT only > NKey only > token > user/pass > anonymous (`buildAuthOptions()`). Only one method is applied — setting multiple is a silent misconfiguration.
- **`@nats-io/nats-core`** is the correct import for `nkeyAuthenticator` and `jwtAuthenticator`, not `@nats-io/nkeys`.
- **Integration tests run in a single fork** (`singleFork: true`) — Testcontainers container is shared across all integration suites via `beforeAll`/`afterAll` in each file calling `startNats()`/`stopNats()`.
- Unit test consumer mocks need a `handleRef` pattern (see `test/unit/consumer.test.ts`) to avoid the while-loop spinning after the mock iterator is exhausted.
- **JSM test doubles for the consumer must be stateful:** `info()` should start answering once `add()` succeeds, and "not found" must be a real `JetStreamApiError` carrying `JetStreamApiCodes.ConsumerNotFound`. A stub that rejects forever makes the loop re-create on every pass and fails a correct implementation.
- **Console spy cleanup:** always use `afterEach(() => vi.restoreAllMocks())` instead of manual `spy.mockRestore()` — manual calls leak if the test throws before reaching them.
- **`vi.useFakeTimers()` + `while(!stopped)` loops:** do not call `vi.runAllTimersAsync()` while a consumer loop is active — it enters an infinite cycle. Stop the consumer first, or advance in bounded `vi.advanceTimersByTimeAsync()` steps.
