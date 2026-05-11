# ADR-004: Consumer guard via NUXT_NATS_WORKERS env var

**Status:** Accepted  
**Date:** 2026-05-11

## Context

Nuxt/Nitro is designed to be deployable on serverless platforms (Vercel, Netlify, AWS Lambda) where:

- Processes are short-lived and may be killed between requests
- There is no guarantee of process persistence between invocations
- Long-lived async iterators will be garbage collected or killed without draining

Durable JetStream consumers in these environments cause real problems:

- Messages pulled but not acknowledged before process death are redelivered after `ackWait` expires
- Repeated cold starts create redelivery storms if `maxDeliver` is low
- Orphaned consumers accumulate if processes crash frequently

At the same time, the same Nuxt app code should be deployable on persistent Node.js or Bun servers where consumers work correctly.

## Decision

`defineNatsConsumer()` checks `process.env.NUXT_NATS_WORKERS` at call time:

```ts
if (process.env.NUXT_NATS_WORKERS !== 'true') {
  console.warn(`[nuxt-nats] Consumer "${opts.durable}" skipped — set NUXT_NATS_WORKERS=true to enable workers`)
  return { stop: () => {} }
}
```

When the env var is absent or not `'true'`, the consumer registration is a no-op. No async iterator is created, no connection to the stream is made.

Worker mode is enabled by starting the process with:

```bash
NUXT_NATS_WORKERS=true node .output/server/index.mjs
```

## Consequences

- **Safe by default.** Deploying to Vercel without setting the env var produces a clear warning log instead of silently creating broken consumers.
- **Same codebase, two process roles.** The Nuxt app and worker can use identical built output, differentiated only by environment variables. No separate worker entry point required.
- **Explicit opt-in.** Operators must consciously enable consumer mode, which forces awareness of the persistent runtime requirement.
- **Discovery friction.** Developers running locally without the env var will see warnings for every `defineNatsConsumer()` call. This is intentional — it surfaces the constraint early.

## Alternatives considered

**Auto-detect serverless by checking platform indicators:** `process.env.VERCEL`, `process.env.NETLIFY`, etc. Rejected — the list of serverless platforms is not exhaustive, and a false negative (consumer starts on a platform that doesn't support it) is worse than a false positive (consumer skipped on a persistent server). Opt-in is safer.

**Separate worker entry point (`nuxt-nats/worker`):** Would require users to write a separate file and wire it up. Rejected for v1 — the env-var approach is simpler and keeps everything in the same build output.
