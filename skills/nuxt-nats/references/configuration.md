# nuxt-nats configuration

The module reads the `nats` key in `nuxt.config.ts`. Every option is mirrored in private `runtimeConfig.nats` and can be overridden at runtime with `NUXT_NATS_<OPTION>` (nested keys join with `_`, e.g. `credentials.synadia.token` is `NUXT_NATS_CREDENTIALS_SYNADIA_TOKEN`).

**Set credentials only through env vars or a credentials provider, never in `nuxt.config.ts`.** Anything there, including `process.env.X` read there, is evaluated at build time and serialized into `.output`. The module warns about this during a build.

## Options

```ts
nats: {
  synadia?: boolean | { region?: 'global' | 'eu' | 'us' | 'asia' | 'west.us' | 'east.us' }
  servers?: string[]        // default ['nats://localhost:4222']; production: ALL cluster nodes
  wsServers?: string[]      // WebSocket URLs; falls back to servers
  transport?: 'auto' | 'tcp' | 'ws'   // 'auto' = WebSocket on Bun, TCP elsewhere
  name?: string             // connection name in server reports

  // auth (first match wins; see below)
  creds?: string            // .creds contents, raw or base64
  credsFile?: string        // path, re-read on every reconnect
  userJwt?: string; nkeySeed?: string   // nkeySeed is the seed STRING (starts with 'S'), not a path
  token?: string; user?: string; pass?: string

  tls?: { caFile?: string; certFile?: string; keyFile?: string }
  maxReconnectAttempts?: number   // default -1 (forever)
  jsDomain?: string; jsApiPrefix?: string

  streams?: StreamDefinition[]
  consumers?: ConsumerDefinition[]    // declarative consumers; see consumers.md
  credentials?: { provider?: 'static' | 'infisical' | 'synadia' | 'custom', ... }
  synadiaApi?: { url?: string; token?: string }   // for useSynadiaCloud()
  health?: { enabled?: boolean; endpoint?: string; details?: boolean }   // /api/_nats/health
}
```

`StreamDefinition`: `name`, `subjects`, `retention` (`'limits'` default, `'workqueue'`, `'interest'`), `storage` (`'file'` default, `'memory'`), `replicas` (default 1), `maxAge` / `duplicateWindow` (Go durations such as `'7d'`, `'2m'`), `maxBytes`, `placement` (`{ cluster?, tags? }`), `provision`.

## Environment variables

| Variable | Sets |
|---|---|
| `NUXT_NATS_SERVERS` | `servers`: a **comma-separated string of every node**; the module splits it |
| `NUXT_NATS_CREDS` / `NUXT_NATS_CREDS_FILE` | `creds` / `credsFile` |
| `NUXT_NATS_USER_JWT` / `NUXT_NATS_NKEY_SEED` | `userJwt` / `nkeySeed` |
| `NUXT_NATS_TOKEN`, `NUXT_NATS_USER`, `NUXT_NATS_PASS` | token and user/pass auth |
| `NUXT_NATS_WORKERS` | must be `true` for consumers and agents to run |
| `NUXT_NATS_TRANSPORT`, `NUXT_NATS_WS_SERVERS` | transport selection |
| `NUXT_NATS_HEALTH_DETAILS` | adds credential-provider status to the health endpoint |

## Auth priority

Exactly one method is applied. First match wins:

1. `creds`  2. `credsFile`  3. `userJwt` + `nkeySeed`  4. `userJwt`  5. `nkeySeed`  6. `token`  7. `user`/`pass`  8. anonymous.

Setting several is a silent misconfiguration: the extras are ignored. A `.creds` file is parsed by the module itself (so a file without a trailing newline works), and the JWT and seed come from the same read. With a JWT configured, boot calls `validateJwt()`: it logs an error for an expired `exp` and a warning when under 24 h remain. It never blocks startup. `/api/_nats/health` reports `auth.mode` (`creds`, `creds-file`, `jwt-nkey`, ..., `provider:<name>`), never an identity or secret.

## Synadia Cloud

`synadia: true` (geo-routed) or `{ region }` fills the TLS and WebSocket endpoints unless `servers` is set. Authenticate with `credsFile` or `NUXT_NATS_CREDS`. Cloud rejects a stream without `maxBytes`, and the build warns about it. See `docs/guides/synadia-cloud.md` in the module repo.

## Runtime credentials and rotation

`nats.credentials.provider` other than `static` puts a credential manager in front of the connection: it fetches creds before connecting, refreshes before expiry (default 20% of the JWT lifetime early, clamped to 60 s to 1 h, with jitter), and reconnects when they change. **The static priority list above no longer applies** when a provider is active.

- `infisical`: reads the secret (a `.creds` file or bearer JWT) from Infisical, authenticating with `universal`, `kubernetes`, `aws`, `gcp`, `azure` or `oidc` machine identity (no stored secret on cloud identities).
- `synadia`: issues creds from the Synadia Control Plane for `userId` with a service-account `token` (`NUXT_NATS_CREDENTIALS_SYNADIA_TOKEN`).
- `custom`: `credentials.customProvider: 'path/to/file'` (relative to `server/`) default-exporting `defineNatsCredentialsProvider({ name, fetch({ reason, signal }), dispose? })`, returning `{ creds }` or `{ userJwt, nkeySeed?, expiresAt? }`.

`nuxt-nats-rotate` (`npx -p nuxt-nats nuxt-nats-rotate --user-id <id> --store infisical|file|module:<path>`) issues fresh creds and writes them to the store on a schedule (cron, Kubernetes CronJob); `--verify`, `--rotate-nkey` and `--revoke-old` are available. Hooks `onCredentialsRefreshed` and `onCredentialsError` in `useNatsHooks()` observe it. Full detail: `docs/guides/credentials-rotation.md` in the module repo.

## Provisioning stance

`provision` decides who creates streams and consumers:

- **`'never'`** (the default): the app connects and uses; an out-of-band provisioner (the `nats` CLI, Helm, Terraform) owns the topology. Avoids N replicas racing to create the same stream on a rolling deploy.
- **`'startup'`**: create from the declared config on boot; log a warning if it exists with a different config. Fine for development and single-instance apps.
- **`'update'`** (streams only): also update an existing stream in place. This races on rolling deploys and can flap subjects.

Under `'never'`, treat the `streams:` block as documentation of something another process owns. The first process to create a stream wins its `replicas`, `maxAge` and `duplicateWindow`. Set `duplicateWindow` explicitly when you rely on `msgId` dedup; the NATS default is 2 minutes.
