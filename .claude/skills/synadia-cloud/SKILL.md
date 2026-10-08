---
name: synadia-cloud
description: Reference for working on nuxt-nats' Synadia Cloud support — connecting to NGS, .creds handling, the Synadia Control Plane API (users, creds issuance, nkey rotation, revocations, service-account tokens), Infisical machine-identity login and secrets, AWS/GCP/Azure workload identity, plan limits and JetStream error codes, and the credential-provider / rotator design. Use when changing src/synadia.ts, src/runtime/server/credentials/**, src/runtime/synadia/**, src/runtime/cli/**, the live tests, or when answering questions about Synadia Cloud or credential rotation in this module.
---

# Synadia Cloud in nuxt-nats

The design is in `docs/adr/009-credential-providers.md` and `docs/adr/010-control-plane-client.md`;
the user-facing guides are `docs/guides/synadia-cloud.md` and `docs/guides/credentials-rotation.md`.
Endpoint-level details are in [reference.md](reference.md).

## Facts that were hard to find

- **The Control Plane API docs page needs a login.** The spec is public in
  `synadia-io/control-plane-sdk-go` (`syncp/api/openapi.yaml`, Apache-2.0) and vendored here in
  `openapi/` with its commit pinned. There is no official TypeScript SDK.
- **nats.js `credsAuthenticator` rejects a creds file without a newline after the final END line**
  (a trimmed or secret-store value). Always parse with our `parseCreds()` and pass the result to
  `jwtAuthenticator`. Read a creds file **once per connect** so the JWT and seed cannot come from
  two different rotations.
- **Two consecutive auth errors close a nats.js connection for good** unless `ignoreAuthErrorAbort`
  is set. Any rotating-credentials setup needs it.
- **Synadia Cloud rejects streams without `max_bytes`** (JetStream error 10113). Free plan: R1
  only, 10 streams, 10 connections. 10023 = insufficient resources (placement/replicas).
- **JWT lifetime is a property of the NATS user** (`jwt_expires_in_secs`), not of a `/creds` call;
  every `/creds` call is a new issuance. Users with 0 never expire.
- **Service-account tokens can be scoped to one NATS user** (resource `NatsUser:<id>` + role). That
  is what the rotator or the `synadia` provider should hold, never a personal access token.
- **`@infisical/sdk` pulls in the AWS SDK.** We call Infisical over REST. Its Node SDK only
  implements AWS among cloud logins; GCP/Azure details come from Infisical's platform docs.
- **An Infisical write under a change-approval policy returns an approval object, not the secret.**
  Treat it as a failure.

## Rules when changing this code

- No new runtime dependencies for providers or cloud identity: plain `fetch`, `node:crypto`.
- Errors carry `{ provider|operation, code, status }` and **never response bodies**; log through
  `describeError()` / `redact()`. Tests assert that tokens and creds never reach output.
- Control Plane retries: 429 always; 502/503/504 and network errors for GET/PUT/DELETE and for
  `issueCreds` / `issueBearerJwt` (a repeat only records an extra issuance); never for creates,
  updates or `rotate`.
- Curated types in `src/runtime/synadia/types.ts` are checked against the generated schema by
  `test/types/synadiaTypes.test-d.ts`. To update the spec: replace the YAML (keep the attribution
  header), `npm run gen:synadia`, fix what the type test flags.
- AWS SigV4 is checked byte-for-byte against `@smithy/signature-v4` (devDependency only).
- Run the `verify` skill afterwards; add `--live` for changes that touch the wire.

## Live account (the user's)

- PAT in the macOS Keychain, service `synadia-cloud-pat`, read by `scripts/synadia-token.mjs`.
  **Never print it** or pass it on a command line; if a token check is needed, report only its
  length and `uat_` prefix. The user stores it themselves from Terminal:
  `security add-generic-password -U -a "$USER" -s synadia-cloud-pat -w`.
- `node scripts/synadia-creds.mjs list` shows team/system/account/user ids (no secrets).
- The test user id is not committed: find it with `node scripts/synadia-creds.mjs list` (or the
  project memory) and pass it as `SYNADIA_NATS_USER_ID`.
- `SYNADIA_LIVE=1 SYNADIA_NATS_USER_ID=<id> npm run test:live` — issues creds (an issuance), read-only
  otherwise; `SYNADIA_STREAMS=1` creates/deletes a stream and needs the user's consent.
