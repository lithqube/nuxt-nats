# ADR-008: Stream provisioning defaults to 'never', opt-in per stream

**Status:** Accepted  
**Date:** 2026-05-11

## Context

JetStream streams are infrastructure. Creating or modifying them has side effects:

- **Storage allocation.** File-backed streams allocate disk space.
- **Retention changes.** Changing `retention` on an existing stream may drop messages.
- **Replica changes.** Changing `num_replicas` requires manual stream update procedures in clustered deployments.
- **Race conditions.** Multiple Nuxt instances booting simultaneously will all attempt provisioning. If configs differ (e.g., two replicas with different `nuxt.config.ts` values due to a deployment rollout), one instance gets error `10058` (`JSStreamNameExistErr`).

Automatically provisioning streams on every boot is appropriate for local development but risky in production.

## Decision

Each stream definition has a `provision` field that defaults to `'never'`:

```ts
interface StreamDefinition {
  provision?: 'startup' | 'update' | 'never'  // default: 'never'
}
```

- **`'never'`** (default): The module does not call `jsm.streams.add()`. The stream must be created externally (NATS CLI, Terraform, Helm chart, migration script).
- **`'startup'`**: The module calls `jsm.streams.add()` on every boot. `10058` errors (stream exists with different config) produce a warning and are skipped — the module does not auto-update.
- **`'update'`**: The module calls `jsm.streams.add()` on every boot. On `10058`, it calls `jsm.streams.update()` to reconcile the config in place. Use when the app owns the stream and is responsible for keeping its configuration current — e.g. when multiple services share a stream and dynamically add subjects.

For local development with `provision: 'startup'`, the playground `nuxt.config.ts` sets this explicitly.

## Consequences

- **Production safe by default.** A new deployment with an unrecognized stream name will warn rather than silently create an incorrectly configured stream.
- **Config drift warning, not auto-fix (for `'startup'`).** If `provision: 'startup'` is set and the stream config diverges from what's on the server, operators see a clear log message and must reconcile manually. This prevents the module from destroying data by applying a destructive config change.
- **Opt-in auto-reconcile (for `'update'`).** When the app is the authoritative owner of a shared stream, `provision: 'update'` enables automatic reconciliation. Important: `jsm.streams.update()` cannot change `storage` or `retention` — those fields require delete-and-recreate and will return an error that is logged.
- **Local dev convenience.** Setting `provision: 'startup'` in the playground or in `nuxt.config.ts` with a dev environment check works well for development workflows.

```ts
// nuxt.config.ts — safe pattern for mixed environments
nats: {
  streams: [{
    name: 'ORDERS',
    subjects: ['orders.>'],
    provision: process.env.NODE_ENV === 'development' ? 'startup' : 'never',
  }]
}
```

For streams shared between services where the app is the config owner, `'update'` allows the app to keep the stream authoritative on every boot without manual CLI intervention:

```ts
// nuxt.config.ts — app owns this shared stream's subject list
nats: {
  streams: [{
    name: 'DOCUMENTS',
    subjects: ['tenant.*.assessment.>', 'tenant.*.pulsiq.>'],
    provision: 'update',
  }]
}
```

- **Idempotency on identical config.** Multiple instances booting with `provision: 'startup'` and the same config is safe — NATS returns `10058` for all but the first, and all instances continue normally.

## Alternatives considered

**Always provision on startup:** Simple, but risky in production. A misconfigured `nuxt.config.ts` in production could irreversibly change stream retention or storage settings. Rejected.

**Provision only when stream doesn't exist (check-then-create):** This is what `jsm.streams.add()` does already — it's the idempotent path. The difference is what happens when the config diverges. We chose warn-and-skip over auto-update. Accepted as described above.

**Separate CLI command (`nuxt nats provision`):** A better long-term solution for production workflows, where provisioning is a one-time migration step. Deferred to v2.
