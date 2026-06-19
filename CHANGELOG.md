# Changelog

All notable changes to nuxt-nats are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are published to npm — pre-releases under the `alpha` dist-tag.

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
