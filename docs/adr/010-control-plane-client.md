# ADR-010: A curated Control Plane client and an external rotator

**Status:** Accepted  
**Date:** 2026-10-07

## Context

The Synadia Control Plane API (`/core/beta`) manages users, creds, revocations and JetStream
assets. Synadia publishes a Go SDK generated from an OpenAPI spec but no TypeScript SDK. The
generated TypeScript types for the full spec are 870 KB, more than ten times this module's runtime.

Rotation can run in the app (the `synadia` provider) or outside it. Running it outside means the
app never holds a Control Plane token, which is the point of Tier A.

## Decision

- Vendor the spec in `openapi/` (Apache-2.0, attributed, commit pinned) and generate full types
  there with `npm run gen:synadia`. Neither is published.
- Ship a hand-written client (`createSynadiaClient`, `useSynadiaCloud()`) over a curated subset:
  teams, systems, accounts, NATS users and their creds, bearer JWTs, nkey rotation, issuances,
  revocations, streams, KV buckets, connections. Its types are small and curated;
  `test/types/synadiaTypes.test-d.ts` checks them against the generated schema so spec drift fails
  the type tests.
- Retries: 429 always (the server did nothing), 502/503/504 and network errors only for safe
  methods, so a create or an issuance is never repeated after the server may have run it.
- Ship `nuxt-nats-rotate`, a CLI built from `src/runtime/cli/`. It skips while stored creds are
  fresh, issues (optionally after an nkey rotation), verifies by connecting, stores to Infisical,
  a file or a custom store, and only then revokes the old key. One JSON line out, exit codes 0/1/2.

## Consequences

- The module covers the operations apps and rotation need, not the whole API. Anything else is a
  small addition to the client and its curated types.
- Updating the spec is a deliberate step: replace the YAML, regenerate, fix what the type test
  flags.
- The rotator runs where the token lives (a CronJob, a CI schedule), keeping it out of the app.
