# Authentication

The module supports seven authentication methods plus anonymous, selected automatically based on which credentials you set. The selection is **priority-based** — only one method is applied per connection. The Nitro plugin picks the authenticator at startup.

**Pass credentials as runtime environment variables (`NUXT_NATS_*`), never in `nuxt.config.ts`.** Anything set in `nuxt.config.ts` — including `process.env.X` read there — is evaluated at build time and serialized into `.output`, so the secret ships with every build artifact. The module warns on a build when a credential option is set there.

For credentials fetched and rotated at runtime (Infisical, the Synadia Control Plane, your own store), set `nats.credentials.provider`: a provider supplies the JWT and seed and **this priority list no longer applies**. See [Credential providers](./credentials-rotation.md).

## Priority order

The plugin tries methods in this order and stops at the first match:

1. **Creds** (`creds`) — `.creds` file contents, raw or base64; Synadia Cloud
2. **Creds file** (`credsFile`) — path to a `.creds` file, re-read on every reconnect
3. **JWT + NKey** (`userJwt` **and** `nkeySeed`) — production
4. **JWT only** (`userJwt` alone) — unsigned or bearer-token JWT
5. **NKey only** (`nkeySeed` alone) — static NKey servers
6. **Token** (`token`) — single shared secret
7. **User / pass** (`user`, optionally `pass`) — basic auth
8. **Anonymous** — no credentials

Setting multiple credentials is a **silent misconfiguration** — the first match wins and the others are ignored. Pick one method per environment.

## Quick reference

```bash
# Creds file (Synadia Cloud, nsc) — contents or a path
NUXT_NATS_CREDS="$(base64 < app.creds)"
NUXT_NATS_CREDS_FILE=/run/secrets/nats.creds

# JWT + NKey (production) — NATS JWT resolver
NUXT_NATS_USER_JWT='eyJ0eXAiOiJqd3Q...'
NUXT_NATS_NKEY_SEED='SUACSP3ZI...'

# JWT only (unsigned, or a bearer-token user)
NUXT_NATS_USER_JWT='eyJ0eXAiOiJqd3Q...'

# NKey only — static NKey server
NUXT_NATS_NKEY_SEED='SUACSP3ZI...'

# Token
NUXT_NATS_TOKEN='s3cr3t'

# User / pass
NUXT_NATS_USER='alice'
NUXT_NATS_PASS='hunter2'

# Anonymous (the default when none of the above are set)
```

## Creds files (Synadia Cloud, `nsc`)

A `.creds` file holds the user JWT and its NKey seed, and is what Synadia Cloud and `nsc generate creds` produce. It takes priority over every other method.

```bash
NUXT_NATS_CREDS_FILE=/run/secrets/nats.creds     # a path: re-read on every reconnect
NUXT_NATS_CREDS="$(base64 < app.creds)"          # or the contents, raw or base64
```

A creds **file** is read again on each (re)connect, so replacing it (a rotated Kubernetes Secret volume, a file written by [`nuxt-nats-rotate`](./credentials-rotation.md#the-rotator-nuxt-nats-rotate)) takes effect at the next reconnect with no restart. The module parses creds itself, so a file without a trailing newline (a trimmed secret-store value) or with CRLF line endings still works.

## JWT + NKey (production)

This is the standard for any NATS deployment using a JWT resolver (`nsc` operator/account/user hierarchy). The JWT is sent during `CONNECT`; the NKey seed is used to sign the server's nonce so it can prove possession of the matching private key.

```ts
// nuxt.config.ts — no credentials here
export default defineNuxtConfig({
  modules: ['nuxt-nats'],
  nats: { servers: ['nats://nats.example.com:4222'] },
})
```

```bash
# runtime environment
NUXT_NATS_USER_JWT='eyJ0eXAiOiJqd3Q...'
NUXT_NATS_NKEY_SEED='SUACSP3ZI...'
```

The module uses `jwtAuthenticator(jwt, seed)` from `@nats-io/nats-core` — the JWT is sent in the `jwt` field of the `CONNECT` message, and the seed signs the server's nonce (`sig`).

### Generating credentials with `nsc`

```bash
# Add a user to an account (assumes an existing operator + account)
nsc add user alice --account ACME

# Generate a credentials file (JWT + NKey seed in one file)
nsc generate creds --account ACME --name alice > alice.creds

# Extract the JWT and seed into env vars
NUXT_NATS_USER_JWT=$(grep -A1 'BEGIN JWT' alice.creds | tail -1)
NUXT_NATS_NKEY_SEED=$(grep -A1 'BEGIN NKEY SEED' alice.creds | tail -1)
```

**Never commit `*.creds` files or NKey seeds to source.** Inject them at deploy time from a secret store (Vault, AWS Secrets Manager, sealed secrets, etc.).

## JWT only (unsigned)

When only `userJwt` is set, the module calls `jwtAuthenticator(jwt)` with no signer. The JWT is sent unsigned.

This is usable only against servers explicitly configured to accept unsigned JWTs — typically:

- **Test environments** with a preloaded JWT resolver that pins identity to a known claim set
- **Operator-pinned deployments** where the JWT itself is the trust anchor (issued out-of-band and validated against an allow-list)

For a standard `nsc`-managed deployment, always set `nkeySeed` alongside the JWT.

## NKey only (dev)

For static NKey-based servers that don't run a JWT resolver:

```bash
NUXT_NATS_NKEY_SEED='SUACSP3ZI...'   # the user's Ed25519 private key
```

The module uses `nkeyAuthenticator(seed)`. The server must have the matching public NKey in its permissions config (or a resolver that maps it).

## Token

```bash
NUXT_NATS_TOKEN='shared-secret-token'
```

The token is sent in the `auth_token` field of the `CONNECT` message. Tokens are simple but lack per-user identity — fine for internal services, not for multi-tenant deployments.

## User / pass

```bash
NUXT_NATS_USER='alice'
NUXT_NATS_PASS='hunter2'
```

`pass` is optional if the server's user definition allows password-less login.

## TLS / mTLS

For TLS, the connection's `tls` field takes standard Node.js options:

```ts
nats: {
  servers: ['tls://nats.example.com:4222'],
  tls: {
    caFile: '/etc/nats/ca.pem',
    certFile: '/etc/nats/client.pem',  // mTLS
    keyFile: '/etc/nats/client-key.pem',
  },
}
```

For mTLS, the cert's CN typically maps to the NATS user, so the broker doesn't need a separate credential — the cert IS the credential.

## Startup JWT validation

When a JWT is configured — `userJwt`, or the JWT inside `creds` / `credsFile` — the Nitro plugin calls `validateJwt()` before connecting (messages name the source: `NUXT_NATS_USER_JWT`, `NUXT_NATS_CREDS` or `NUXT_NATS_CREDS_FILE`). An unreadable creds file is logged as `Could not read creds file "<path>"`. With a credentials provider, expiry is tracked by the provider's refresh instead. The check is **best-effort logging** — it does not block startup — but it surfaces problems early so they don't show up as mysterious connection failures at runtime:

| Condition | Log level | Example message |
|---|---|---|
| `exp` claim is past | `console.error` | `NUXT_NATS_USER_JWT EXPIRED 120s ago — connection will fail` |
| `exp` claim within 24h | `console.warn` | `NUXT_NATS_USER_JWT expires in 5h` |
| Payload undecodable | `console.warn` | `Could not decode JWT payload to check expiry` |
| Malformed structure | `console.error` | `NUXT_NATS_USER_JWT is malformed — expected 3 parts (header.payload.signature)` |

Validation runs on every boot, so an expired JWT in a staging environment fails loudly instead of failing at first publish.

## Auth errors

The plugin watches the connection's status events. An error whose message contains `Authorization` (as in the server's `Authorization Violation`), `Permissions Violation` or `Authentication Expired` is logged with a distinct prefix:

```
[nuxt-nats] AUTH ERROR — JWT may be expired or missing permissions: <error>
```

Every other status error logs as `[nuxt-nats] NATS error: …`. The split makes alerting rules straightforward — a spike in `AUTH ERROR` lines is a credential problem, not an infrastructure problem. Match on `AUTH ERROR` rather than `AUTH ERROR:`, since the prefix is followed by a dash.

The check is a case-sensitive match on those three strings only, so a credential failure the client reports in other words logs as a plain `NATS error`. Alert on both prefixes if you need full coverage. With a credentials provider, an authorization or authentication-expired error also triggers an immediate credentials refresh (a permissions violation does not: new credentials would not change the account's permissions).

## Which method is in use

`/api/_nats/health` reports `auth.mode`: `creds`, `creds-file`, `jwt-nkey`, `jwt`, `nkey`, `token`, `user-pass`, `anonymous`, or `provider:<name>`. It never includes the identity or any secret.

## Production checklist

- [ ] **JWT + NKey is the default** for any non-trivial deployment
- [ ] **Credentials injected from a secret store** — never hardcoded, never committed
- [ ] **JWTs have a short `exp`** (hours, not days) so revocation propagates
- [ ] **Startup validation logs are monitored** — `EXPIRED` lines are a paging signal
- [ ] **`AUTH ERROR` log lines are alerted on** — separate alert from network errors
- [ ] **Rotation is automated** — a creds file the module re-reads, a [credentials provider](./credentials-rotation.md), or [`nuxt-nats-rotate`](./credentials-rotation.md#the-rotator-nuxt-nats-rotate) on a schedule
- [ ] **No credentials in `nuxt.config.ts`** — the build warns if there are
- [ ] **TLS is enabled** for any non-localhost connection

## Troubleshooting

**Connection succeeds but every publish returns `permissions violation`** — the JWT decoded correctly but the user's permissions in the account config don't allow the subject. Check the account's `limits` and `permissions` in the operator config.

**Connection starts failing after running fine for hours** — the JWT's `exp` claim has passed. The startup validator only checks at boot, so a JWT that was valid then can expire mid-session. Rotate the credential: with `NUXT_NATS_CREDS_FILE` a replaced file is picked up at the next reconnect, and a [credentials provider](./credentials-rotation.md) refreshes ahead of expiry on its own.

**`Failed to connect to NATS` with an authorization error at boot** — the server rejected the credential on the initial connect (that path logs `Failed to connect to NATS` and fires `onConnectError`; the `AUTH ERROR` prefix applies to status errors after connecting). If the JWT's `nats` claim doesn't match a user the server knows about, it is usually a stale credential file from a previous `nsc` run.

**Connection works with `nkeySeed` alone but fails with `userJwt + nkeySeed`** — the JWT and seed are from different users. They must come from the same `nsc generate creds` output.

**`AUK_SEED` decoding errors at startup** — the seed is malformed or not a valid Ed25519 seed (should start with `S` for private seeds).
