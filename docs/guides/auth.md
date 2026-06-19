# Authentication

The module supports five authentication methods plus anonymous, selected automatically based on which credentials you set. The selection is **priority-based** — only one method is applied per connection. Configure credentials via `nuxt.config.ts` (or the matching `NUXT_NATS_*` environment variables) and the Nitro plugin picks the right authenticator at startup.

## Priority order

The plugin tries methods in this order and stops at the first match:

1. **JWT + NKey** (`userJwt` **and** `nkeySeed`) — production
2. **JWT only** (`userJwt` alone) — unsigned JWT, test or pinned-identity use
3. **NKey only** (`nkeySeed` alone) — static NKey servers
4. **Token** (`token`) — single shared secret
5. **User / pass** (`user`, optionally `pass`) — basic auth
6. **Anonymous** — no credentials

Setting multiple credentials is a **silent misconfiguration** — the first match wins and the others are ignored. Pick one method per environment.

## Quick reference

```bash
# 1. JWT + NKey (production) — NATS JWT resolver
NUXT_NATS_USER_JWT='eyJ0eXAiOiJqd3Q...'
NUXT_NATS_NKEY_SEED='SUACSP3ZI...'

# 2. JWT only (unsigned) — server must allow unsigned
NUXT_NATS_USER_JWT='eyJ0eXAiOiJqd3Q...'

# 3. NKey only — static NKey server
NUXT_NATS_NKEY_SEED='SUACSP3ZI...'

# 4. Token
NUXT_NATS_TOKEN='s3cr3t'

# 5. User / pass
NUXT_NATS_USER='alice'
NUXT_NATS_PASS='hunter2'

# 6. Anonymous (the default when none of the above are set)
```

## JWT + NKey (production)

This is the standard for any NATS deployment using a JWT resolver (`nsc` operator/account/user hierarchy). The JWT is sent during `CONNECT`; the NKey seed is used to sign the server's nonce so it can prove possession of the matching private key.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['nuxt-nats'],
  nats: {
    servers: ['nats://nats.example.com:4222'],
    userJwt: process.env.NUXT_NATS_USER_JWT,
    nkeySeed: process.env.NUXT_NATS_NKEY_SEED,
  },
})
```

The module uses `jwtAuthenticator(jwt, seed)` from `@nats-io/nats-core` — the JWT is sent as the `Authorization` header, the seed signs the nonce.

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

```ts
nats: {
  servers: ['nats://localhost:4222'],
  nkeySeed: 'SUACSP3ZI...', // user's Ed25519 private key
}
```

The module uses `nkeyAuthenticator(seed)`. The server must have the matching public NKey in its permissions config (or a resolver that maps it).

## Token

```ts
nats: {
  servers: ['nats://localhost:4222'],
  token: 'shared-secret-token',
}
```

The token is sent as the `Authorization` header. Tokens are simple but lack per-user identity — fine for internal services, not for multi-tenant deployments.

## User / pass

```ts
nats: {
  servers: ['nats://localhost:4222'],
  user: 'alice',
  pass: 'hunter2',
}
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

When `userJwt` is set, the Nitro plugin calls `validateJwt()` before connecting. The check is **best-effort logging** — it does not block startup — but it surfaces problems early so they don't show up as mysterious connection failures at runtime:

| Condition | Log level | Example message |
|---|---|---|
| `exp` claim is past | `console.error` | `NUXT_NATS_USER_JWT EXPIRED 120s ago — connection will fail` |
| `exp` claim within 24h | `console.warn` | `NUXT_NATS_USER_JWT expires in 5h` |
| Payload undecodable | `console.warn` | `Could not decode JWT payload to check expiry` |
| Malformed structure | `console.error` | `NUXT_NATS_USER_JWT is malformed — expected 3 parts (header.payload.signature)` |

Validation runs on every boot, so an expired JWT in a staging environment fails loudly instead of failing at first publish.

## Auth errors

When the server rejects the connection for credential reasons (expired, revoked, missing permissions, signature mismatch), the NATS status event carries an `AUTH ERROR` reason. The plugin logs these with a distinct prefix:

```
[nuxt-nats] AUTH ERROR: authorization violation
```

This is separate from generic NATS errors (network drops, timeouts), which log as `NATS error: …`. The split makes alerting rules straightforward — a spike in `AUTH ERROR` lines is a credential problem, not an infrastructure problem.

## Production checklist

- [ ] **JWT + NKey is the default** for any non-trivial deployment
- [ ] **Credentials injected from a secret store** — never hardcoded, never committed
- [ ] **JWTs have a short `exp`** (hours, not days) so revocation propagates
- [ ] **Startup validation logs are monitored** — `EXPIRED` lines are a paging signal
- [ ] **`AUTH ERROR` log lines are alerted on** — separate alert from network errors
- [ ] **Token rotation is automated** — nsc + CI to roll the credentials file
- [ ] **TLS is enabled** for any non-localhost connection

## Troubleshooting

**Connection succeeds but every publish returns `permissions violation`** — the JWT decoded correctly but the user's permissions in the account config don't allow the subject. Check the account's `limits` and `permissions` in the operator config.

**`AUTH ERROR: authentication expired`** — the JWT's `exp` claim is past. The startup validator should have caught this; if you see it at runtime, the JWT was valid at boot but expired mid-session (expected for long-running processes — rotate the credential).

**`AUTH ERROR: user not authorized`** — the JWT's `nats` claim doesn't match a user the server knows about. Usually a stale credential file from a previous `nsc` run.

**Connection works with `nkeySeed` alone but fails with `userJwt + nkeySeed`** — the JWT and seed are from different users. They must come from the same `nsc generate creds` output.

**`AUK_SEED` decoding errors at startup** — the seed is malformed or not a valid Ed25519 seed (should start with `S` for private seeds).
