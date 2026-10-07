# Credential providers and rotation

Static credentials (`NUXT_NATS_CREDS`, `NUXT_NATS_USER_JWT`, ...) are read once at connect.
A **credentials provider** fetches them from a secret store or the Synadia Control Plane before
the first connect, refreshes them ahead of expiry, and reconnects with the new ones, with no
restart. Use one when credentials are short-lived or rotated.

## Choosing a setup

| Tier | What the app holds | Who rotates |
|---|---|---|
| **A — recommended for production** | Short-lived creds for a least-privilege NATS user, read from Infisical with a platform identity (Kubernetes, OIDC). No static secret in the app. | An external rotator writes fresh creds to Infisical (the rotator CLI ships in a later release; any job that writes the secret works). The app never holds a Synadia token. |
| B — convenience | A Synadia service-account token scoped to one NATS user. | The app issues its own creds from the Control Plane. A leaked token can only mint that user's creds, and deleting it revokes it. |
| C — simple | A static creds file (`NUXT_NATS_CREDS_FILE`). | You, by replacing the file. It is re-read on every reconnect. |

Give the NATS user a JWT lifetime (Synadia Cloud: the user's JWT expiry setting) so a leaked
credential stops working on its own.

## Infisical

Store the user's `.creds` file in an Infisical secret (base64 is safest for a multiline value),
then configure the provider. Non-secret settings can live in `nuxt.config`; secrets come from env.

```ts
// nuxt.config.ts
nats: {
  synadia: true,
  credentials: {
    provider: 'infisical',
    infisical: {
      projectId: '<project id>',
      environment: 'prod',
      secretPath: '/nats',
      secretName: 'NATS_CREDS',
      auth: { method: 'kubernetes', identityId: '<machine identity id>' },
    },
  },
}
```

| `auth.method` | Proves identity with | Settings |
|---|---|---|
| `kubernetes` | the pod's service-account token (no stored secret) | `identityId`; `tokenPath` defaults to the in-pod token |
| `oidc` | an OIDC token from your platform (GitHub Actions, GitLab, cloud workload identity) | `identityId` and `tokenPath` or `jwt` (`NUXT_NATS_CREDENTIALS_INFISICAL_AUTH_JWT`) |
| `universal` | a client id and secret | `clientId`, `clientSecret` (`NUXT_NATS_CREDENTIALS_INFISICAL_AUTH_CLIENT_SECRET`) |

AWS, GCP and Azure IAM login are planned; until then use `oidc` with your cloud's workload
identity token, or `universal`.

## Synadia Control Plane

```bash
NUXT_NATS_CREDENTIALS_PROVIDER=synadia
NUXT_NATS_CREDENTIALS_SYNADIA_USER_ID=<nats user id>
NUXT_NATS_CREDENTIALS_SYNADIA_TOKEN=<service-account token scoped to that user>
```

Each refresh issues new creds for the user. Create the token as a service account limited to
the resource `NatsUser:<user id>`; never deploy a personal access token, which can do anything in
your account.

## Your own provider

```ts
// server/nats/credentials.ts
export default defineNatsCredentialsProvider({
  name: 'vault',
  async fetch({ signal }) {
    const res = await fetch('https://vault.internal/v1/secret/data/nats', { signal, headers: { 'X-Vault-Token': process.env.VAULT_TOKEN! } })
    const { data } = await res.json()
    return { creds: data.data.creds } // or { userJwt, nkeySeed, expiresAt }
  },
})
```

```ts
// nuxt.config.ts
nats: { credentials: { customProvider: 'nats/credentials.ts', provider: 'custom' } }
```

The file is bundled whenever `customProvider` is set, so `provider` can also be switched at
runtime with `NUXT_NATS_CREDENTIALS_PROVIDER=custom`. Throw on failure; never include secret
values in error messages.

## How refresh works

- **Before connecting** the module waits for the first credentials, retrying with backoff for up
  to `refresh.initTimeoutSec` (30 s). If none arrive, the connection is not attempted and
  `onConnectError` fires.
- **Ahead of expiry** it refreshes 20% of the JWT lifetime early (`leadRatio`), at least 60 s
  and at most an hour (`minLeadSec`, `maxLeadSec`), with ±10% jitter so a fleet spreads out.
  Credentials without an expiry are re-fetched every `pollSec` (300 s), which picks up rotation.
- **When they change** it forces a reconnect so the new credentials take effect; consumers and
  subscriptions resume on their own. Unchanged credentials inside the refresh window log a
  warning: rotation is not running.
- **On failure** it keeps the last good credentials and retries with backoff up to
  `maxBackoffSec` (60 s). The connection keeps retrying through auth errors instead of closing,
  and an auth error from the server triggers an immediate refresh.

## Observing it

```ts
useNatsHooks({
  onCredentialsRefreshed: ({ expiresAt, changed }) => metrics.gauge('nats.creds.expires_at', expiresAt ?? 0),
  onCredentialsError: err => logger.warn(err.message), // carries no secret material
})
```

With `health: { details: true }` (or `NUXT_NATS_HEALTH_DETAILS=true`) the health endpoint adds the
provider status. It never includes identities or secrets, but the endpoint is public, so it is
off by default:

```json
"auth": { "mode": "provider:infisical", "provider": "infisical", "status": "ok", "expiresInSec": 20540, "nextRefreshInSec": 16244, "lastRefreshAt": "2026-10-07T21:05:38.851Z", "lastErrorCode": null }
```

`status` is `ok`, `stale` (refresh failing, credentials still valid), `expired` or `failed`.
