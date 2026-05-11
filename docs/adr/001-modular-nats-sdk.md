# ADR-001: Use @nats-io/* modular SDK over legacy `nats` package

**Status:** Accepted  
**Date:** 2026-05-11

## Context

The NATS JavaScript ecosystem has two SDK generations:

- **Legacy:** `nats` npm package (v2.x). Monolithic. Last published ~1 year ago. Maintenance-only.
- **Current:** `@nats-io/*` monorepo packages (v3.x). Modular. Actively developed. Requires Node 20+.

The v3 SDK is a breaking rewrite. Key removals relevant to this module:

- `StringCodec` / `JSONCodec` — removed. Use `TextEncoder` / `msg.string()` / `msg.json()`.
- `js.subscribe()` (push consumer) — removed. Use `js.consumers.get().consume()` (pull-based async iterator).
- `js.fetch()` — removed. Same replacement.

## Decision

Use the `@nats-io/*` modular packages exclusively:

| Package | Purpose |
|---|---|
| `@nats-io/nats-core` | Core types, `wsconnect`, headers |
| `@nats-io/transport-node` | TCP transport for Node.js and Bun |
| `@nats-io/jetstream` | JetStream client and manager |
| `@nats-io/kv` | KV store (`Kvm`) |
| `@nats-io/obj` | Object Store (`Objm`) |
| `@nats-io/nkeys` | NKey / JWT credential parsing |

The legacy `nats` package is not installed, not re-exported, and not referenced anywhere in the module source.

## Consequences

- **Minimum Node.js version is 20.** This is enforced in `package.json` `engines` field.
- **Pull-consumer-only API.** `defineNatsConsumer` uses `js.consumers.get().consume()` exclusively. Push consumers (`js.subscribe`) are not exposed — they don't exist in v3.
- **JSON encode/decode is explicit.** `jsPublish` uses `JSON.stringify` + `TextEncoder`. `handler` in `defineNatsConsumer` calls `JSON.parse(msg.string())`. No codec abstraction layer.
- **Blog posts and Stack Overflow answers referencing the legacy SDK are incompatible.** Documentation must be explicit about this.

## Alternatives considered

**Stay on legacy `nats` package:** Would allow Node 18 support and avoid the migration. Rejected — the package is in maintenance mode, `js.subscribe()` still works but is the wrong long-term pattern, and the module would ship with a deprecated dependency from day one.

**Support both SDKs with an adapter:** Too complex, doubles the maintenance surface. Rejected.
