# ADR-002: Server-side only — no browser-side NATS client

**Status:** Accepted  
**Date:** 2026-05-11

## Context

NATS can technically run in browsers via WebSocket transport. The `@nats-io/nats-core` `wsconnect()` function works in any W3C WebSocket environment, including modern browsers.

However, several concerns arise when browser-side NATS is used with JetStream:

1. **Credentials exposure.** Any auth token or NKey seed used in browser code is visible to the user and can be extracted. NATS has no per-connection ACL granularity comparable to HTTP auth headers.

2. **Durable consumer ownership.** A JetStream durable consumer is infrastructure. If a browser tab owns a durable consumer, closing the tab leaves an orphaned consumer that blocks stream progress until the ackWait expires. Multiple tabs create multiple competing consumers with undefined delivery behavior.

3. **Reconnect unpredictability.** Browser connectivity is unreliable. NATS auto-reconnects, but during the gap, queued pull requests timeout and messages may be redelivered. Browsers have no opportunity to drain before navigating away.

4. **Memory leaks.** Async consumer iterators in Vue components will continue pulling messages after the component unmounts unless explicitly stopped — and there is no framework lifecycle hook that guarantees cleanup before page unload.

5. **Bundle size.** Including `@nats-io/transport-node` or `@nats-io/nats-core` in the client bundle adds significant weight that benefits no browser use case the module intends to support.

## Decision

The module ships **no client-side runtime code**. Specifically:

- No `runtime/app/` directory is created
- No Vue composables (`useNats`, `useJetStream`) are provided for browser use
- The module's `addServerPlugin()` and `addServerImportsDir()` calls target server context only
- The Nitro externals hook ensures NATS packages are not included in the client bundle

Browser access to NATS-backed data is mediated exclusively through Nuxt server API routes:

```
Browser → $fetch('/api/events') → defineEventHandler → jsPublish / useKV / useObj
```

## Consequences

- **No real-time push to browser from NATS.** If push is needed, users must implement a WebSocket or SSE bridge in a Nitro route that subscribes to NATS core subjects and forwards to the browser. This is explicitly out of scope for v1.
- **Simpler security model.** Credentials never leave the server. No NATS ACL configuration required for browser isolation.
- **Smaller client bundle.** Zero NATS code in client-side JavaScript.
- **Clear boundary.** Users cannot accidentally call `useJetStream()` in a Vue component — it simply doesn't exist in that context.

## Future consideration

A `nuxt-nats/bridge` entrypoint could provide an opt-in SSE or WebSocket server route that forwards NATS core subjects to browsers. This would be additive and does not require revisiting this decision.
