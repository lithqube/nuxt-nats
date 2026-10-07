# Synadia Cloud

[Synadia Cloud](https://www.synadia.com/cloud) is managed NATS with JetStream. A Nuxt app
connects to it like any other NATS server: point the module at Cloud's endpoints and give it
a user's `.creds` file.

## Quick start

1. In the Synadia Cloud UI, open your account and create a NATS user for the app.
   Give it only the subjects it publishes and subscribes to.
2. Download the user's `.creds` file.
3. Enable the Cloud preset and pass the creds at runtime:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['nuxt-nats'],
  nats: {
    synadia: true, // or { region: 'eu' }
  },
})
```

```bash
# Either the path to the file (re-read on every reconnect)…
NUXT_NATS_CREDS_FILE=/run/secrets/nats.creds
# …or its contents, raw or base64 (base64 survives env files and secret stores)
NUXT_NATS_CREDS="$(base64 < app.creds)"
```

Never put the creds in `nuxt.config`: values there are written into `.output` at build time.
The module warns on a build when a credential is set there.

## Endpoints

`synadia: true` uses the geo-routed global endpoint. `synadia: { region }` pins a region.

| `region` | TCP (TLS) | WebSocket |
|---|---|---|
| `global` (default) | `tls://connect.ngs.global` | `wss://connect.ngs.global:443` |
| `eu`, `us`, `asia`, `west.us`, `east.us` | `tls://<region>.geo.ngs.global` | `wss://<region>.geo.ngs.global:443` |

Explicit `servers` / `wsServers` (or `NUXT_NATS_SERVERS`) override the preset. The WebSocket
endpoint is used with `transport: 'ws'`, and automatically on Bun. TLS is mandatory on every endpoint.

## Credentials

| Setting | Env var | Notes |
|---|---|---|
| `creds` | `NUXT_NATS_CREDS` | File contents, raw or base64. Highest auth priority. |
| `credsFile` | `NUXT_NATS_CREDS_FILE` | Path, read on every connect and reconnect. A rotated file (a Kubernetes Secret volume, a file written by a rotator) takes effect at the next reconnect with no restart. |
| `userJwt` | `NUXT_NATS_USER_JWT` | Bearer-token users only (created with "bearer token" enabled): the JWT alone authenticates. |

At startup the module decodes the JWT and logs a warning when it expires within 24 hours, and an
error when it has already expired.

## Streams on Cloud

Plan limits apply to JetStream. The free plan allows R1 streams only and 10 streams per
account; higher plans add R3 and more streams. Declare placement with tags:

```ts
nats: {
  synadia: true,
  streams: [{
    name: 'ORDERS',
    subjects: ['orders.>'],
    replicas: 1,
    placement: { tags: ['geo:europe'] },
    maxBytes: 1024 * 1024 * 1024,
    provision: 'startup',
  }],
}
```

When a stream cannot be created the log explains the limit it hit: insufficient resources
(placement or replicas not available on your plan), the stream count limit, storage limits, or
an account that requires `maxBytes` on every stream.

## Connection budget

Every Nuxt instance holds one connection, and plans cap connections per account (10 on the free
plan). Keep `NUXT_NATS_WORKERS=true` on a small number of worker instances so consumers and
agents do not run on every replica, and count rolling deploys (old and new pods overlap) against
the limit. Each instance connects with the name `nuxt-nats@<hostname>:<pid>`, or `nats.name`
(`NUXT_NATS_NAME`), so it is identifiable in Cloud's connection list.

## Health

`/api/_nats/health` reports the auth method in use, never the identity or the credentials:

```json
{ "connected": true, "status": "ok", "auth": { "mode": "creds-file" } }
```
