# nuxt-nats production gotchas

The non-obvious failures. Read this before shipping.

## SSR / Nitro lifecycle race: the one that bites hardest

**Nitro (nitropack 2) calls server plugins in order without awaiting async ones.** Every plugin after the module's connection plugin, including your own, runs while the connection may still be pending. A bare `useJetStream()` or `useNats()` at plugin top level then throws inside an un-awaited context, the registration is lost for the life of the process, and nothing retries.

- `defineNatsConsumer()` and `defineNatsAgent()` handle this for you: they poll for the JetStream client or connection (every 250 ms) before starting. Prefer them to hand-rolled loops.
- For your own code at plugin time, use `useJetStreamIfAvailable()` (returns `null` until ready) and wait, or do the work inside a request handler.
- The JetStream client is published only **after stream provisioning completes**, so a boot-time consumer never races the creation of its own stream.

## Reconnect hooks fire once per outage

The client emits a `reconnect` status per retry attempt, so one outage can produce thousands. `useNatsHooks({ onReconnect })` is already filtered: it fires once per `disconnect` to `reconnect` transition, while `onDisconnect` fires on every disconnect. If you subscribe to the raw connection status yourself, gate side effects the same way. Auth failures show up in the status stream too: `Authorization`, `Authentication Expired` and `Permissions Violation` errors usually mean an expired or under-permissioned credential, not a network fault. With a credentials provider, authorization errors trigger an immediate refresh (permission violations do not).

## Externals

All `@nats-io/*` and `@synadia-ai/*` packages must be Nitro externals; the module registers them. `@nats-io/transport-node` uses Node's `net`, and bundling severs the socket prototype chain (`Cannot read properties of undefined` at runtime). Only relevant if you hand-roll Nitro config.

## Shutdown ordering

Nitro's `close` hook is unreliable (nitrojs/nitro#4015), so the real shutdown path is `SIGTERM` / `SIGINT` handlers in the module: stop agents, close agents, stop consumers, then `nc.drain()` (and dispose the credential manager). Consumers stop before the drain so acks do not race a closing connection. Add your own teardown **before** the drain, never after.

## Pass every cluster node

Give `servers` (or comma-separated `NUXT_NATS_SERVERS`) **all** nodes. A comma-joined URL as a single entry works on a one-node staging server and fails against a real cluster. Keep staging's topology close to production.

## Config drift is invisible without a live-broker test

Under `provision: 'never'` the real stream and consumer live on the broker while `nuxt.config` holds a description. `defineNatsConsumer` binds the live durable and does not push your `filterSubjects` or `ackPolicy`. An integration test against a real broker that asserts the live config equals the declared one is what catches drift.

A durable's config is **immutable**: changing `ackWait`, the filter or the deliver policy and redeploying fails with "consumer name already in use with different configuration", the old durable keeps the subject, and lag grows. Delete the durable with the `nats` CLI and recreate it, then redeploy.

## Credentials

- Anything set literally in `nuxt.config.ts` ships in `.output`. Use `NUXT_NATS_*` env vars or a credentials provider.
- With a provider active, the static auth priority list does not apply, and `ignoreAuthErrorAbort` is set so repeated auth errors do not permanently close the client; the manager reconnects when creds change.
- A JWT near expiry only logs a warning at boot. Monitor `/api/_nats/health` (`health.details: true` adds provider status) or use `onCredentialsError`.

## Runtime and client versions

- Node `>=22.12.0` (nats.js 3.5 requires Node 22+), or Bun. Bun uses the WebSocket transport under `transport: 'auto'`, so the server needs a `websocket {}` listener, or set `transport: 'tcp'`.
- `@nats-io/*` 3.5 contains errors thrown by user callbacks (printed as `UnhandledCallbackError`, the client keeps running) and makes JetStream reads fail loudly instead of returning partial results. Handler errors in `defineNatsConsumer` are already caught by the module.
- The module is pre-1.0: pin an exact version and read the CHANGELOG on upgrade. Pin the **NATS server** to an exact patch, and run staging on the same server version as production.

## Testing

Test against a real `nats:<pinned>-alpine` with JetStream (Testcontainers), not mocks. In unit tests, keep the connection singleton importable without `nitropack/runtime`. The module's own repo does this with a test-only setter; for your app, wrap `useJetStream()` behind a small seam you can swap.
