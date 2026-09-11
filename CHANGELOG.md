# Changelog

All notable changes to nuxt-nats are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are published to npm — pre-releases under the `beta` dist-tag starting at 0.1.0-beta.1.

---

## [0.1.0-beta.2] — 2026-09-11

### Status

Closes three API surfaces that accepted input and discarded it, and adds dead-letter
handling. No dependency changes: all `@nats-io/*` packages are already at 3.4.0, the
newest published, and `3.4.1-0` is documentation-only.

### Fixed

- **`nats.consumers` never started a consumer.** The array was copied into
  `runtimeConfig` and no runtime code read it back, and `ConsumerDefinition.handler` (a
  module path) was resolved nowhere. A declarative consumer block typechecked, deployed,
  and consumed nothing, silently. It is now compiled into a generated Nitro plugin at
  build time with each handler statically imported, which is what makes a module path
  work in a bundled server. Relative handler paths resolve against the server directory
  (`nuxt.options.serverDir`), so they also work in the Nuxt 4 `app/` layout.
- **Consumers registered from a Nitro plugin never started.** Nitro does not await async
  plugins, so every plugin after the connection plugin runs before the connection exists,
  and `defineNatsConsumer()` called `useJetStream()` first thing: it threw, the loop died as
  an unhandled rejection, and nothing was consumed. That covered consumers in
  `server/plugins/`, the generated `nats.consumers` plugin and `defineDeadLetterConsumer()`.
  The loop now waits for the JetStream client, and the connection plugin publishes that
  client only after provisioning streams, so a consumer that starts at boot does not race
  its own stream's creation.
- **`filterSubjects` was accepted and never read.** `defineNatsConsumer` only called
  `js.consumers.get()`, which binds to a durable whose filter is server-side state it
  cannot change, so a consumer could name one subject in code and receive another. It is
  now applied when this call creates the durable, and a declared filter that disagrees
  with an existing durable is reported rather than ignored. `ackPolicy`, `ackWait` and
  `maxDeliver` had the same problem.
- **A missing durable was reported as a network fault**, logging
  `loop error, retrying in 5s` every five seconds forever. It now reports once with the
  `nats consumer add` command that fixes it.
- **Every `consumers.info()` rejection was treated as "durable absent"**, so a
  permissions or transport failure could create a consumer under `provision: 'startup'`
  or produce a false missing-durable error. Only `JetStreamApiError` with
  `JetStreamApiCodes.ConsumerNotFound` counts as absence now.
- **`onReconnect` fired once per retry attempt rather than once per recovery**
  (nats.js#423, where one outage produced roughly 2400 events). Now gated on the
  disconnect to reconnect transition. `onDisconnect` is unchanged.
- **The README documented `server/workers/*.ts` for consumers.** Nitro does not scan that
  directory, so those files were never imported. Documented as `server/plugins`, and the
  new declarative form makes `server/workers` viable via generated imports.
- **Typed subjects never type-checked a payload.** Two faults, either one enough on its
  own. `nuxt-nats` did not export `NatsEvents`, so the documented
  `declare module 'nuxt-nats'` declared a new interface that `jsPublish` never read. And the
  untyped `jsPublish` overload accepted a declared subject whenever the typed overload
  rejected its payload. `NatsEvents` is now re-exported from the package entry, and the
  fallback rejects declared subjects. Covered by type-level tests in `test/types/`, which
  run as part of `npm test`.

### Added

- **`provision` on consumers** (`'startup' | 'never'`, default `'never'`), mirroring
  `StreamDefinition.provision`. Under `'startup'` the durable is created from the declared
  config. The default preserves bind-only behaviour.
- **`defineDeadLetterConsumer()`** for durable dead-letter handling. NATS has no
  dead-letter queue in any released server or in 2.15-RC, so the advisory is the only
  signal. This consumes `MAX_DELIVERIES` and `MSG_TERMINATED` advisories from a stream
  rather than an ephemeral subscription, and recovers the original message by sequence.
- **`MaxDeliverAdvisory` and `TerminatedAdvisory` types.** The client types
  `Advisory.data` as `unknown` and ships no payload types. Note `max_deliver` carries no
  `consumer_seq`; only `terminated` does.
- **`msg.term(reason)` on the DLQ path.** Supported since client 3.4.0; the server carries
  the reason into the terminated advisory, so a dead message records why it died.
- **`ackPolicy` on `defineNatsConsumer()`** (`'explicit' | 'none' | 'all'`, default
  `'explicit'`). It was only on `ConsumerDefinition` before; like the other durable fields it is
  applied when this call creates the durable.
- **Dead-letter helpers**, auto-imported in `server/`: the `ADVISORY_MAX_DELIVERIES` and
  `ADVISORY_MSG_TERMINATED` subject constants, `toDeadLetterEvent()` (the pure advisory-to-event
  mapping), and the `DeadLetterEvent` / `DeadLetterConsumerOptions` types.
- **`NatsConsumerOptions` importable from `nuxt-nats`**, alongside `NatsEvents`, and
  **`ActiveConsumer` exported** (auto-imported in `server/`). `ActiveConsumer` is the handle
  `defineNatsConsumer()` and `defineDeadLetterConsumer()` return.

### Changed

- **`runtimeConfig.nats.consumers` is no longer populated.** `nats.consumers` now compiles into a
  generated Nitro plugin at build time, and a second copy in `runtimeConfig` could only drift from
  it. No module code read that copy before either.

### Tests

- 144 unit tests across 16 files (up from 94), 63 integration tests (unchanged)
- New unit test files: `consumerTemplate.test.ts` (generated plugin source), `deadLetter.test.ts`
  (advisory mapping and message recovery), `statusHandling.test.ts` (`onReconnect` once per
  outage), `moduleConsumers.test.ts` (handler paths against `serverDir`), `natsPlugin.test.ts`
  (JetStream published only after stream provisioning). `consumer.test.ts` extended for
  provisioning, filter mismatch, not-found detection, one-shot missing-durable logging, and
  consumers registered before the connection exists.

### Docs

- README: declarative consumers, consumer provisioning and dead-letter handling documented, and
  the consumer example moved from `server/workers` to `server/plugins`. The configuration example
  now lists every module option.
- Consumers guide corrected (plugin placement, filter semantics, DLQ). It now states that
  `deadLetterSubject` needs the durable's `max_deliver` to be at least `maxDeliver`, and replaces
  the core-subscription alerting example with `defineDeadLetterConsumer()`.
- API reference: `defineDeadLetterConsumer()` and its helpers, the `nats.consumers` option, and
  the new consumer options. Architecture, docs index, deployment (shutdown order, Bun transport),
  authentication (`AUTH ERROR` log format), CONTRIBUTING (beta release steps) and `CLAUDE.md`
  brought up to date. Option JSDoc corrected: `nkeySeed` is the seed itself, not a file path, and
  the password variable is `NUXT_NATS_PASS`.
- Typed events: declare `NatsEvents` in a `.d.ts` file under `server/` or `shared/` that starts
  with `import type {} from 'nuxt-nats'`. The previous example, a root `types/nats.d.ts` with no
  import, replaced the `nuxt-nats` module instead of extending it, and Nuxt 4's server tsconfig
  does not include a root `types/` folder.

### Notes

- `consumers.addOrUpdate` is unreleased upstream, and `ConsumerApiAction.CreateOrUpdate`
  is unreachable in 3.4.0 because `cr.action = opts.action || Create` coerces the empty
  string back to `"create"`. The info-then-add shape here is deliberate and mirrors the
  future signature.
- Migrating an existing durable from `filter_subject` to `filter_subjects` requires
  delete-and-recreate: `update()` is a read-modify-write and the old scalar survives the
  merge, colliding (nats.js#429).

---

## [0.1.0-beta.1] — 2026-08-07

### Status: Production-validated

This release graduates from alpha to beta. The module has been running in a multi-replica Docker Swarm production environment since June 2026, handling JetStream publish, ephemeral consumers (SSE), KV buckets (5 buckets, mixed TTLs), and JWT+NKey authentication under real traffic. No breaking changes from alpha.4 — the version bump reflects production confidence, not API changes.

### Improved

- **Testcontainers setup resilience** — integration test `startNats()` now passes explicit `maxReconnectAttempts` and `reconnectTimeWait` to avoid port-race flakiness on containers with slow startup. `stopNats()` is now null-safe (no crash if `beforeAll` failed to initialize the context).

### Tests

- 94 unit tests (unchanged)
- New integration test file: `lifecycle.test.ts` — verifies `useJetStreamIfAvailable()` returns the client when connected, validates connection liveness (`isClosed()`, `getServer()`, `rtt()`), and exercises a combined publish + KV workflow within a single testcontainers session.
- Total integration tests: 63 (up from 57)

### Docs

- CHANGELOG updated to reflect production validation status
- Deployment guide: clarified `NUXT_NATS_SERVERS` env var works as a comma-separated string (NATS client accepts `string | string[]`)

### Production guidance (from real deployments)

The following patterns have been validated in production and are recommended:

- **Stream retention limits** — always set `maxAge` and/or `maxBytes` on production streams to prevent unbounded disk growth.
- **Explicit `duplicateWindow`** — set to match your retry window (e.g. `'5m'`) rather than relying on the NATS server default (2 minutes).
- **`provision: 'never'` for production** — `'startup'` is safe (warns and skips on config drift) but `'update'` can race when multiple instances call `jsm.streams.update()` simultaneously during rolling deploys. Prefer `'never'` in production and provision streams via CLI or IaC.
- **Lifecycle hooks for alerting** — register `useNatsHooks({ onDisconnect, onReconnect })` in a server plugin to surface connection drops in your monitoring. The module logs these internally, but hooks let you integrate with your alerting stack.
- **`NUXT_NATS_SERVERS` multi-server** — pass all cluster nodes as a comma-separated string (e.g. `nats://a:4222,nats://b:4222,nats://c:4222`). The module splits the value into an array before passing to the NATS client, which handles failover automatically.

---

## [0.1.0-alpha.4] — 2026-06-19

### Added

- **Full JWT authentication support** — new `buildAuthOptions()` utility selects among JWT+NKey, JWT-only, NKey-only, token, user/pass, and anonymous auth strategies based on which credentials are set, in priority order. ([Authentication guide](docs/guides/auth.md))
  - `userJwt` (`NUXT_NATS_USER_JWT`) — user JWT credential
  - `nkeySeed` (`NUXT_NATS_NKEY_SEED`) — matching NKey seed (Ed25519 private key)
  - **JWT + NKey (production)** — when both are set, the module uses `jwtAuthenticator(jwt, seed)` from `@nats-io/nats-core`. The JWT is sent during `CONNECT`; the NKey seed signs the server's nonce to prove possession of the private key. Standard for NATS servers configured with the JWT resolver (`nsc` operator/account/user hierarchy).
  - **JWT only (unsigned)** — when only `userJwt` is set, uses `jwtAuthenticator(jwt)`. The JWT is sent unsigned — usable only against servers explicitly configured to accept unsigned JWTs, such as when identity is pinned out-of-band by operator policy or in test environments.
  - **NKey only (dev)** — when only `nkeySeed` is set, uses `nkeyAuthenticator(seed)`. For static NKey-based servers without a JWT resolver.

- **Startup JWT validation** — new `validateJwt()` utility runs at server boot. Decodes the payload, checks the `exp` claim, and logs:
  - `console.error` if the JWT is already expired (connection will fail)
  - `console.warn` if it expires within 24 hours
  - `console.warn` if the payload is undecodable
  - `console.error` for malformed JWTs (wrong part count or any empty segment)

- **AUTH ERROR distinction in `handleStatus()`** — server-side `AUTH ERROR` events (expired credentials, revoked users, missing permissions) are now logged with a distinct `[nuxt-nats] AUTH ERROR: …` prefix so they are easy to separate from network errors in alerting and log aggregation. Triggered by the `permissions violation` / `authorization violation` / `auth required` / `auth expired` reason strings on the connection status event.

- **Auto-import for auth config** — `userJwt` and `nkeySeed` flow from `ModuleOptions` through `defu` to `runtimeConfig.nats`, with the same `""` default as the other auth fields.

### Changed

- **Nitro plugin delegates auth to `buildAuthOptions()`** — replaced the inline auth branching (nkey > token > user/pass) with `Object.assign(opts, buildAuthOptions(cfg))`. The utility owns the full 5-method priority chain and is unit-tested in isolation across all 31 credential combinations.

### Dependencies

- Added `@nats-io/jwt` (`^0.0.11`) as a **dev** dependency for integration tests (encoding account and user JWTs in the JWT-resolver fixture). Not a runtime dependency — the auth path uses `jwtAuthenticator` from `@nats-io/nats-core`.
- `@nats-io/jetstream`, `@nats-io/kv`, `@nats-io/nats-core`, `@nats-io/obj`, `@nats-io/services`, `@nats-io/transport-node`: bumped to `^3.4.0`.

### Fixed

- **Empty JWT payload bypasses validation** — `header..signature` (an empty payload segment) was previously caught by the 3-part split but then returned silently, leaving the caller with no warning. Now treated as malformed and logged with the same error path as a wrong-part-count JWT.
- **Mock leakage in `moduleDefaults.test.ts`** — switched from `vi.clearAllMocks()` to `vi.restoreAllMocks()` in `afterEach` to prevent mock-implementation leakage across tests (per project `CLAUDE.md` guidance).

### Tests

- 94 unit tests (up from 67 at alpha.3)
- New unit test files: `buildConnectionOptions.test.ts` (auth priority chain, all 31 credential combinations), `validateJwt.test.ts` (empty / malformed / expired / expiring-soon / no-`exp` / decode-failure cases), `moduleDefaults.test.ts` (runtimeConfig defaulting of `userJwt` and `nkeySeed`).
- New integration test file: `jwtAuth.test.ts` — spins up a `nats:2.10-alpine` container with a preloaded JWT resolver, generates operator/account/user credentials with `@nats-io/jwt`, and exercises successful connect, JetStream round-trip, mismatched-seed rejection, and malformed-JWT rejection.

### Docs

- New [Authentication guide](docs/guides/auth.md) — full walkthrough of the 5 auth methods, credential generation with `nsc`, JWT startup validation behaviour, AUTH ERROR logging, and a production checklist.
- README updated: new `NUXT_NATS_NKEY_SEED`, `NUXT_NATS_USER_JWT`, and `NUXT_NATS_WORKERS` env vars; expanded Authentication section with the full priority chain and `nsc generate creds` example; AUTH ERROR log behaviour documented.
- Documentation index updated to link the new Authentication guide.

---

## [0.1.0-alpha.3] — 2026-06-11

### Added

- **Agent Fabric — Synadia Agent Protocol integration.** Expose a Nuxt server as a discoverable AI **agent** on the NATS bus, or **call** other agents from server routes — over the connection the module already manages. Built on `@synadia-ai/agents` + `@synadia-ai/agent-service`. ([guide](docs/guides/agents.md), [evaluation](docs/agent-fabric/EVALUATION.md))

  - **`defineNatsAgent(opts)`** — auto-imported; register and serve a protocol-compliant agent (`prompt` + `status` endpoints, heartbeats, micro-service discovery via `$SRV.PING.agents`). Streams chunks back with `response.send()` and supports mid-stream human-in-the-loop questions via `response.ask()`. Like consumers, it runs **only when `NUXT_NATS_WORKERS=true`** (a logged no-op otherwise) and waits for the connection so it is call-order independent. Supports custom controller endpoints (`spawn`/`stop`/`list`) via `extraEndpoints`.
  - **`useAgents()`** — caller-side client over the module connection: discover the fleet (`agents.discover()`) and prompt agents. Process-wide cached (one heartbeat subscription); safe in request handlers.
  - **`getAgentStatuses()`** — snapshot of registered agents (identity + `starting`/`running`/`stopped`/`error`) surfaced in the health endpoint.

- **Health endpoint reports agents** — `/api/_nats/health` now includes an `agents` array (identity + lifecycle status) when any agent is registered.

### Changed

- **Shutdown sequence extended for agents.** `drainAndClose()` now tears down agents and the caller client **before** consumers and `nc.drain()`: `stopAllAgents() → closeAgents() → stopAllConsumers() → nc.drain()`. Each step is error-isolated so a failing teardown can never skip the connection drain or leave the closing flag stuck.

### Fixed

- **Agent registry leak on individual `stop()`** — `handle.stop()` now splices the agent out of the active registry, so `getAgentStatuses()` and the health endpoint no longer report an agent that was stopped individually (`stopAllAgents()` clears the array up front, so that path is unaffected).

### Dependencies

- Added `@synadia-ai/agents` and `@synadia-ai/agent-service` (`^0.5.2`) and `@nats-io/services` (`^3.4.0`) as runtime dependencies. The Synadia SDKs are **0.x and explicitly unstable** — the wrapper is intentionally thin so an API drift is a one-file change; the durable contract is the wire protocol.
- **Lockfile refresh cleared all 5 npm advisories** (1 critical, 1 high, 3 moderate — `shell-quote`, `devalue`, `__nuxt_island`). All were dev-tooling only (Nuxt/devtools chain) and never shipped in the published package; `package.json` ranges were unchanged. In-range bumps: `@nuxt/kit` `4.4.6` → `4.4.8`, `nuxt` `4.4.5` → `4.4.8`, plus `vitest`, `eslint`, `vue-tsc`, `@types/node`, `@vitest/coverage-v8`, `@nuxt/eslint-config`.

### Tests

- 67 unit tests, 53 integration tests (120 total, up from 106 at alpha.2)
- New test files: `test/unit/agent.test.ts`, `test/integration/agent.test.ts` (wire-protocol validation against a real NATS broker via Testcontainers)

### Docs

- New [Agent Fabric guide](docs/guides/agents.md) and [evaluation/design rationale](docs/agent-fabric/EVALUATION.md); agent utilities documented in the [API Reference](docs/api.md).

---

## [0.1.0-alpha.2] — 2026-05-29

### Added

- **`provision: 'update'` mode** — new stream provisioning option. When a stream already exists with a different configuration (NATS error 10058), `'update'` calls `jsm.streams.update()` to reconcile in place. Useful when the app owns a shared stream's authoritative config (e.g. multiple services contribute subjects). `'startup'` keeps its existing warn-and-skip behaviour. ([ADR-008](docs/adr/008-stream-provisioning.md))

- **`useEphemeralConsumer(opts)`** — request-scoped ordered JetStream consumer designed for SSE endpoints. Handles timeout (`onTimeout`), client-disconnect cleanup (`onDisconnect`), and per-message error isolation automatically. Returns an idempotent `handle.stop()`. Previously both SSE endpoints in a real app had to reimplement `js.consumers.get() → .consume() → clearTimeout → stream.onClosed()` manually.

- **`useNatsHooks(hooks)`** — register `onConnectError`, `onReconnect`, and `onDisconnect` callbacks for alerting and metrics. Multiple calls accumulate; hook errors are isolated from the module. Callbacks are fired by the Nitro plugin on the corresponding NATS connection lifecycle events.

- **`useJetStreamIfAvailable()`** — soft variant of `useJetStream()` that returns `null` instead of throwing when the connection is not yet established. Lets handlers return a clean `503` instead of an unhandled `500`.

- **Typed tracing headers on `jsPublish`** — `PublishOpts` now accepts `traceId` and `correlationId` fields that set `X-Trace-Id` and `X-Correlation-Id` headers respectively. Applied after the `headers` map so they always win over conflicting keys; `msgId` still controls deduplication last.

### Fixed

- **`JetStreamApiError` detection** — stream provisioning previously checked `err.api_error.err_code` (the old `@nats-io/jetstream` v2 shape) to detect error 10058. In v3 the error is a `JetStreamApiError` instance with a `.code` getter. The old check silently fell through to `console.error` for both `startup` and `update` modes on every boot against an existing stream. Now uses `err instanceof JetStreamApiError && err.code === 10058`.

- **`OrderedConsumerOptions` field name** — `useEphemeralConsumer` passes `filter_subjects` (snake_case) to `js.consumers.get()`, which is the correct `@nats-io/jetstream` v3 field name. The public API still accepts `filterSubjects` (camelCase) and maps internally.

### Changed

- **`provisionStreams` extracted to `utils/provisionStreams.ts`** — moved out of the Nitro plugin into a standalone testable utility. No behaviour change; the plugin imports from the util.

### Dependencies

- `@nuxt/kit`, `@nuxt/schema`: `4.4.5` → `4.4.6`
- `@testcontainers/nats`, `testcontainers`: `11.14.0` → `12.0.1`
- `eslint`: `10.3.0` → `10.4.0`
- `vitest`: `4.1.5` → `4.1.7`
- `vue-tsc`: `3.2.8` → `3.3.2`
- `@types/node`: `25.6.2` → `25.9.1`
- `@vitest/coverage-v8` added as dev dependency

### Tests

- Statement coverage: 85% → 99.2%
- 58 unit tests, 48 integration tests (106 total, up from 48 at alpha.1)
- New unit test files: `provisionStreams.test.ts`, `useNatsHooks.test.ts`, `useJetStreamIfAvailable.test.ts`, `ephemeralConsumer.test.ts`
- Fixed spy leak pattern — `afterEach(() => { vi.restoreAllMocks() })` replaces manual `spy.mockRestore()` calls that silently leaked when tests threw

---

## [0.1.0-alpha.1] — 2026-05-27

### Added

- **`headers` option on `jsPublish`** — pass arbitrary NATS message headers forwarded to all consumers (e.g. `X-Trace-Id`, `X-Correlation-Id`). Headers are applied before `msgId` so the deduplication key always wins over a `Nats-Msg-Id` key in the headers map.

### Fixed

- **Header dedup key precedence** — `msgId` is set after `extraHeaders` so callers cannot accidentally override the deduplication key via the `headers` option.

---

## [0.1.0-alpha.0] — 2026-05-11

Initial release.

### Features

- **JetStream publish** (`jsPublish`) — JSON encoding, automatic retry with exponential backoff, per-message deduplication via `Nats-Msg-Id` header
- **Core publish** (`corePublish`) — fire-and-forget, no PubAck
- **Durable pull consumers** (`defineNatsConsumer`) — ackWait heartbeat (`msg.working()`), configurable backoff, dead-letter routing, NUXT_NATS_WORKERS guard
- **KV Store** (`useKV`) — bucket handle cached per process, `create` vs `open` semantics
- **Object Store** (`useObj`) — bucket handle cached per process, Web Streams API compatible
- **Stream provisioning** — declarative `streams` config with `provision: 'startup' | 'never'`
- **Health endpoint** — `GET /api/_nats/health` returns connection status, RTT, JetStream stats
- **Typed subjects** — `NatsEvents` module augmentation for end-to-end type safety on `jsPublish`
- **Transport auto-detection** — TCP on Node.js/Bun (via `@nats-io/transport-node`), WebSocket on edge (`wsconnect`)
- **Auth** — NKey seed, token, and user/pass; priority: nkey > token > user/pass
- **TLS/mTLS** — `caFile`, `certFile`, `keyFile` config
- **Graceful shutdown** — SIGTERM/SIGINT handlers drain in-flight consumers before closing (works around nitrojs/nitro#4015)
- **Nitro externals** — all `@nats-io/*` packages forced external to prevent TCP socket bundling breakage
