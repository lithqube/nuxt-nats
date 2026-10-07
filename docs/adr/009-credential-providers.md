# ADR-009: Credential providers own rotation; the app never needs a cloud SDK

**Status:** Accepted  
**Date:** 2026-10-07

## Context

Static credentials (a token, a JWT, a `.creds` file) are read once at connect. Synadia Cloud
users have JWTs with an expiry, and secrets managers rotate values, so long-running servers need
credentials that change without a restart. Three forces shape the design:

- **Nitro does not await async plugins.** Anything that has to exist before the first connect
  cannot come from a plugin that runs after the connection plugin.
- **A credential the app holds is a credential that can leak.** The most secure setup has the app
  hold only short-lived NATS creds and authenticate to its secret store with platform identity.
- **SDKs are heavy.** `@infisical/sdk` pulls in the AWS SDK; the AWS, GCP and Azure SDKs would
  dwarf this module.

## Decision

- A `CredentialManager` sits in front of the connection when `nats.credentials.provider` is not
  `static`. It fetches before connect, hands the client an authenticator that reads the current
  credentials on every reconnect, refreshes 20% of the JWT lifetime early (jittered), reconnects
  when the fingerprint changes, keeps the last good credentials on failure, and sets
  `ignoreAuthErrorAbort` so the client keeps retrying through auth errors.
- Built-in providers are `infisical` (machine identity: Kubernetes, AWS, GCP, Azure, OIDC,
  universal) and `synadia` (Control Plane issuance). A `custom` provider is a user file loaded
  through the Nitro virtual module `#nuxt-nats/credentials-provider`, imported statically by the
  connection plugin, and bundled whenever configured so it can be selected at runtime.
- Every external call is plain `fetch`. AWS SigV4 is implemented with `node:crypto` and tested
  byte-for-byte against `@smithy/signature-v4`, which is a devDependency only.
- Errors carry `{ provider, code, status }` and never response bodies; logs go through `redact()`.

## Consequences

- **Tier A is possible:** an app on Kubernetes, AWS, GCP or Azure reads short-lived creds from
  Infisical with no stored secret at all.
- **No runtime dependencies added** for any provider or cloud identity.
- **A refresh can cause a reconnect.** Consumers and subscriptions resume on their own, but a
  rotation is a brief connection blip; reconnects are rate-limited to one per 30 s.
- **Cloud identity paths are verified against mocked metadata endpoints**, not inside each cloud.
