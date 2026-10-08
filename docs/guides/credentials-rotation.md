# Credential providers and rotation

Static credentials are fixed for the life of the process: `NUXT_NATS_CREDS`, `NUXT_NATS_USER_JWT` and the others are read once, and only a creds *file* (`NUXT_NATS_CREDS_FILE`) is re-read, on each reconnect.
A **credentials provider** fetches them from a secret store or the Synadia Control Plane before
the first connect, refreshes them ahead of expiry, and reconnects with the new ones, with no
restart. Use one when credentials are short-lived or rotated.

## Choosing a setup

| Tier | What the app holds | Who rotates |
|---|---|---|
| **A — recommended for production** | Short-lived creds for a least-privilege NATS user, read from Infisical with a platform identity (Kubernetes, AWS, GCP, Azure, OIDC). No static secret in the app. | [`nuxt-nats-rotate`](#the-rotator-nuxt-nats-rotate) on a schedule writes fresh creds to Infisical. The app never holds a Synadia token. |
| B — convenience | A Synadia service-account token scoped to one NATS user. | The app issues its own creds from the Control Plane. A leaked token can only mint that user's creds, and deleting it revokes it. |
| C — simple | A static creds file (`NUXT_NATS_CREDS_FILE`). | You, by replacing the file. It is re-read on every reconnect. |

Give the NATS user a JWT lifetime (Synadia Cloud: the user's JWT expiry setting) so a leaked
credential stops working on its own.

## Infisical

Store the user's `.creds` file in an Infisical secret (base64 is safest for a multiline value),
then configure the provider. Non-secret settings can live in `nuxt.config` or env
(`NUXT_NATS_CREDENTIALS_INFISICAL_PROJECT_ID`, `..._ENVIRONMENT`, `..._SECRET_NAME`,
`..._AUTH_METHOD`, `..._AUTH_IDENTITY_ID`, …); secrets come from env only. Defaults: `siteUrl`
`https://app.infisical.com`, `secretPath` `/`, `auth.method` `universal`. The secret may also
hold a bare JWT for a bearer-token user.

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
| `aws` | the workload's IAM role: a SigV4-signed `sts:GetCallerIdentity` (no stored secret) | `identityId`; `region` (default `AWS_REGION`, `AWS_DEFAULT_REGION`, then EC2 metadata) |
| `gcp` | an ID token from the GCP metadata server (no stored secret) | `identityId`; `audience` (default: `identityId`); or `jwt` / `tokenPath` for an IAM-signed JWT |
| `azure` | a managed-identity token (no stored secret) | `identityId`; `audience` = resource (default `https://management.azure.com/`); `managedIdentityClientId` for a user-assigned identity |
| `oidc` | an OIDC token from your platform (GitHub Actions, GitLab, Vercel) | `identityId` and `tokenPath` or `jwt` (`NUXT_NATS_CREDENTIALS_INFISICAL_AUTH_JWT`) |
| `universal` | a client id and secret — the one method with a stored secret | `clientId`, `clientSecret` (`NUXT_NATS_CREDENTIALS_INFISICAL_AUTH_CLIENT_SECRET`) |

`aws` reads credentials the way the AWS SDK does, without depending on it: environment variables,
then a web identity token (EKS IRSA), the container credentials endpoint (ECS, EKS Pod Identity),
and the EC2 instance profile (IMDSv2). `azure` uses the App Service identity endpoint when
`IDENTITY_ENDPOINT` is set, otherwise the instance metadata service (VMs, AKS). Metadata
requests time out after 2 seconds so a misconfigured platform fails fast.

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

`status` is `pending` (before the first fetch), `ok`, `stale` (refresh failing, credentials still valid), `expired`, or `failed` (no credentials at boot).

## The rotator: `nuxt-nats-rotate`

The module ships a CLI that issues fresh creds for one NATS user and stores them where your apps
read them. Run it on a schedule with a **service-account token scoped to that NATS user**
(`NatsUser:<id>`); it is the only place that token lives.

```bash
SYNADIA_CLOUD_TOKEN=... \
INFISICAL_PROJECT_ID=... INFISICAL_ENVIRONMENT=prod INFISICAL_SECRET_PATH=/nats INFISICAL_SECRET_NAME=NATS_CREDS \
INFISICAL_AUTH_METHOD=kubernetes INFISICAL_IDENTITY_ID=... \
npx nuxt-nats-rotate --user-id <nats user id> --min-remaining 6h --verify
```

What a run does:

1. Reads the stored creds. If they expire later than `--min-remaining`, it prints
   `{"action":"skipped"}` and exits 0, so frequent runs are cheap.
2. Optionally gives the user a new nkey (`--rotate-nkey`).
3. Issues creds (`POST /nats-users/{id}/creds`).
4. With `--verify`, connects to NATS with them before anyone depends on them.
5. Stores them (base64 in Infisical, raw in a file).
6. With `--revoke-old`, revokes the previous nkey. Apps still on the old creds get an auth error,
   refetch from the store and reconnect.

Output is one JSON line (`action`, `expiresAt`, `nkeyRotated`, `revokedOldKey`, `warnings`); exit
codes are 0 (ok or skipped), 1 (failure, nothing stored) and 2 (usage). Stores: `infisical`
(default), `file --file <path>` (atomic, mode 0600, for a VM using `credsFile`), or
`module:<path>` exporting `{ read(), write(value) }`.

Other options: `--token-file` (instead of `SYNADIA_CLOUD_TOKEN`), `--api-url` / `SYNADIA_API_URL`,
`SYNADIA_NATS_USER_ID` (instead of `--user-id`), `--servers` for `--verify` (default
`tls://connect.ngs.global`), `--encoding base64|raw`, `--force`, `--dry-run`. Creds without an
expiry are skipped unless `--force` or `--rotate-nkey` is given. The full table is in the
[API reference](../api.md#nuxt-nats-rotate-cli).

The Infisical store reads its own env vars: `INFISICAL_SITE_URL`, `INFISICAL_PROJECT_ID`,
`INFISICAL_ENVIRONMENT`, `INFISICAL_SECRET_PATH`, `INFISICAL_SECRET_NAME` (default `NATS_CREDS`),
`INFISICAL_AUTH_METHOD` (default `universal`), `INFISICAL_IDENTITY_ID`, `INFISICAL_CLIENT_ID`,
`INFISICAL_CLIENT_SECRET`, `INFISICAL_TOKEN_PATH`, `INFISICAL_JWT`, `INFISICAL_AWS_REGION`,
`INFISICAL_AUDIENCE`, `INFISICAL_MANAGED_IDENTITY_CLIENT_ID`. The rotator's identity needs write
access to the secret; the apps' identities only read. An
Infisical change-approval policy makes the write fail rather than report success.

**Timing.** Give the NATS user a JWT lifetime (say 24h), run the rotator every few hours with
`--min-remaining` at about half the lifetime, and the apps' own refresh (20% of the lifetime early)
will always find fresh creds waiting.

### Kubernetes CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: nats-creds-rotate }
spec:
  schedule: "0 */4 * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: nats-rotator        # an Infisical Kubernetes-auth identity with write access
          restartPolicy: OnFailure
          containers:
            - name: rotate
              image: node:22-alpine
              command: ["npx", "-y", "-p", "nuxt-nats", "nuxt-nats-rotate", "--user-id", "$(NATS_USER_ID)", "--min-remaining", "12h", "--verify"]
              env:
                - { name: NATS_USER_ID, value: "<nats user id>" }
                - { name: SYNADIA_CLOUD_TOKEN, valueFrom: { secretKeyRef: { name: synadia-rotator, key: token } } }
                - { name: INFISICAL_AUTH_METHOD, value: kubernetes }
                - { name: INFISICAL_IDENTITY_ID, value: "<identity id>" }
                - { name: INFISICAL_PROJECT_ID, value: "<project id>" }
                - { name: INFISICAL_ENVIRONMENT, value: prod }
                - { name: INFISICAL_SECRET_NAME, value: NATS_CREDS }
```

### GitHub Actions

```yaml
on:
  schedule: [{ cron: "0 */4 * * *" }]
  workflow_dispatch:
permissions: { id-token: write }   # OIDC login to Infisical, no stored Infisical secret
jobs:
  rotate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - id: oidc
        run: echo "jwt=$(curl -s -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=infisical" | jq -r .value)" >> "$GITHUB_OUTPUT"
      - run: npx -y -p nuxt-nats nuxt-nats-rotate --user-id ${{ vars.NATS_USER_ID }} --min-remaining 12h --verify
        env:
          SYNADIA_CLOUD_TOKEN: ${{ secrets.SYNADIA_ROTATOR_TOKEN }}
          INFISICAL_AUTH_METHOD: oidc
          INFISICAL_IDENTITY_ID: ${{ vars.INFISICAL_IDENTITY_ID }}
          INFISICAL_JWT: ${{ steps.oidc.outputs.jwt }}
          INFISICAL_PROJECT_ID: ${{ vars.INFISICAL_PROJECT_ID }}
          INFISICAL_ENVIRONMENT: prod
          INFISICAL_SECRET_NAME: NATS_CREDS
```

## Managing Synadia Cloud from the app: `useSynadiaCloud()`

A typed Control Plane client for server routes and tasks. Set `NUXT_NATS_SYNADIA_API_TOKEN` to a
service-account token scoped to what the app needs.

```ts
const cloud = useSynadiaCloud()
const user = await cloud.natsUsers.get(userId)
const issuances = await cloud.natsUsers.listIssuances(userId)
await cloud.natsUsers.revoke(user.account.id, compromisedKey)
```

See the [API reference](../api.md#usesynadiacloud) for the full surface.
