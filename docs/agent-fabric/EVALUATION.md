# Feature Evaluation — Synadia Agent Fabric in `nuxt-nats`

**Date:** 2026-06-11
**Branch:** `feat/synadia-agent-fabric`
**Lens:** the `nats-agent-fabric` skill (imported into `.claude/skills/`, updated this change to Synadia's current SDK surface)
**Decision:** **Recommended — strong architectural fit, additive, low risk.** Ship behind a config flag in phases.

This document does two things, per the request:

1. **Part A** — verifies the imported `nats-agent-fabric` skill now captures Synadia's newly-introduced agent toolset.
2. **Part B** — uses that updated skill to evaluate adding agent-fabric capability as a feature of this Nuxt/Nitro NATS module, with a concrete, implementation-ready design.

---

## Part A — Skill coverage of Synadia's new toolset

Source of truth reviewed: `synadia-ai/synadia-agent-sdk-docs` (`core-protocol.md`, spec **v0.3.0**) and `synadia-ai/synadia-agents` (the SDK monorepo). The skill was already protocol-v0.3-aligned; the gaps were in the **SDK surface**, which moved ahead of the prose. Updates applied:

| New / changed in Synadia's toolset | Where captured now | Status |
|---|---|---|
| Monorepo split: `client-sdk/` (caller) + `agent-sdk/` (host) + `agents/` channels + numbered `examples/` ladder | `SKILL.md` maturity note; `examples/*` | ✅ added |
| Protocol rename → **"Synadia Agent Protocol for NATS"** (wire unchanged, still `0.3`) | `SKILL.md` | ✅ added |
| `extraEndpoints` + `.service` getter — **controller pattern** (`spawn`/`stop`/`list`) with collision validation | `architecture.md`, `patterns/meta-agent.md §5`, `examples/typescript.md`, eval #4 | ✅ added |
| `PromptResponse.ask` / `PromptStream.ask` — mid-stream `query` round-trip (was wrongly documented as `response.query()`, **which does not exist**) | `examples/typescript.md`, `examples/python.md`, `meta-agent.md` | ✅ **bug fixed** |
| `ReferenceAgent` (TS `/testing`) + `_reference_agent.py` — spec-compliant test counterparty | `patterns/testing.md` (new) | ✅ added |
| Wire helpers `encodeChunk` / `splitResponseText` / `buildHeartbeatPayload` / `encodeHeartbeatPayload` / `DEFAULT_*` for event-driven hosts | `architecture.md`, `patterns/testing.md`, `examples/typescript.md` | ✅ added |
| `ProtocolError` → `400` (vs ordinary handler error → `500`) | `protocol.md`, `examples/typescript.md` | ✅ added |
| `max_payload` now **broker-negotiated** (`nc.info.max_payload`), not hardcoded `1MB` | `protocol.md`, `meta-agent.md`, `SKILL.md` | ✅ added |
| Caller resilience: `withAgentReconnectDefaults`, local `PayloadTooLargeError` / `AttachmentsNotSupportedError`, Python `prompt(max_wait_s=…)` + `StreamStalledError`/`StreamMaxWaitExceededError`, liveness API | `architecture.md`, `examples/*`, `meta-agent.md` | ✅ added |
| Version bumps: caller `synadia-ai-agents` **0.7.x**; host `synadia-ai-agent-service` **0.4.1**; npm pair **0.5.2** | `SKILL.md`, `examples/*` | ✅ updated |
| Claude Code channel ships as a **Claude Code plugin** with `terminal`/`query` permission modes | `architecture.md` plugin table | ✅ added |

A new eval (#4) exercises the controller + `ask` path so the skill's coverage of the new features is testable. The Go path (`examples/protocol-go.md`) is unchanged: **there is still no Go SDK** — the protocol-direct approach remains correct.

**Conclusion:** the imported skill is current with Synadia's new toolset and the one factual API bug (`response.query`) is corrected.

---

## Part B — Adding agent-fabric to the `nuxt-nats` module

### Why this module is an unusually good host

The skill's core requirements map almost 1:1 onto what the module already owns:

- **One managed `NatsConnection`.** The plugin (`src/runtime/server/plugins/nats.ts`) already connects with full auth priority (nkey > token > user/pass), TLS, and TCP/WS transport selection. The agent SDK explicitly takes a *caller-owned* `NatsConnection` — we hand it `_nc`. No second connection.
- **Dependency alignment is exact.** The module is on `@nats-io/*@^3.4.0`. `@synadia-ai/agent-service` depends on `@nats-io/services@^3.4.0` and `@nats-io/nats-core@^3.4.0` — same major/minor line. Adding the two Synadia packages introduces one genuinely new transitive dep, `@nats-io/services` (the micro framework); everything else is already resolved.
- **Singleton-isolation discipline already exists.** `src/runtime/server/plugins/_connection.ts` holds `_nc`/`_js`/`_jsm` with **no Nitro imports** precisely so tests can import without dragging in `#nitro-internal-virtual/storage`. An agent registry belongs in the same file, inheriting that property for free.
- **A `define*` + plugin-lifecycle pattern is established.** `defineNatsConsumer` registers work that the plugin starts/stops; `defineNatsAgent` is the same shape. Consumers are gated by `NUXT_NATS_WORKERS=true` — agents get an equivalent gate.
- **Shutdown ordering is already a solved, documented problem.** `drainAndClose()` calls `stopAllConsumers()` *before* `nc.drain()` to avoid ack/connection races, and uses **manual SIGTERM/SIGINT handlers** because the Nitro `close` hook is unreliable (nitro#4015). Agents have the identical requirement (`service.stop()` before drain) and slot into the same path.
- **Durable state is already in the box.** The skill's `patterns/durable-state.md` recommends KV keyed by `{owner}.{agent}.{session}` for agent memory and a JetStream `agents.>` capture stream for audit — both of which this module *already* provides via `useKV` and `provisionStreams`. Most consumers of the agent SDK would have to build this; here it's reuse.

**The fit is closer than for a generic Node app:** the module already solved connection lifecycle, graceful shutdown, account-based isolation, and durable JetStream/KV state — which is most of the operational burden the skill warns about.

### Proposed surface (two new auto-imported server utils)

#### 1. Host — `defineNatsAgent(config)`

Wraps `AgentService` over the module's `_nc`. Lets a Nuxt app expose server-side logic (an LLM handler, a tool loop, anything) as a discoverable, promptable agent on the same bus the module already manages.

```ts
// src/runtime/server/utils/defineNatsAgent.ts  (reference shape — not yet wired)
import { AgentService, type PromptHandler } from '@synadia-ai/agent-service'
import { getNatsConnection } from '../plugins/_connection'
import { _registerAgent } from '../plugins/_connection' // registry lives in the Nitro-free file

export interface NatsAgentConfig {
  agent: string            // metadata.agent — canonical harness id (lowercase a-z0-9-_)
  owner: string            // metadata.owner — tenant/account namespace
  name: string             // 5th subject token — instance name
  onPrompt: PromptHandler  // (envelope, response) => stream chunks back
  heartbeatIntervalS?: number
  attachmentsOk?: boolean
  description?: string
}

export function defineNatsAgent(config: NatsAgentConfig) {
  const nc = getNatsConnection()
  if (!nc) throw new Error('[nuxt-nats] defineNatsAgent called before NATS connected')

  const service = new AgentService({
    nc,
    agent: config.agent,
    owner: config.owner,
    name: config.name,
    description: config.description,
    heartbeatIntervalS: config.heartbeatIntervalS,
    attachmentsOk: config.attachmentsOk,
  })
  service.onPrompt(config.onPrompt)

  // The plugin calls service.start() after JetStream is up, and service.stop()
  // in drainAndClose() BEFORE nc.drain() — same ordering as stopAllConsumers().
  _registerAgent(service)
  return service
}
```

Usage in a Nuxt app (`server/agents/assistant.ts`), wrapping Claude:

```ts
export default defineNatsAgent({
  agent: 'nuxt-assistant', owner: 'acme', name: 'web-1',
  onPrompt: async (envelope, response) => {
    const stream = await anthropic.messages.stream({ /* ... */ messages: [{ role: 'user', content: envelope.prompt }] })
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') await response.send(ev.delta.text)
    }
  },
})
```

#### 2. Caller — `useAgents()`

Wraps the `Agents` client over `_nc` so server routes / other utils can discover and prompt agents on the bus (fan-out, meta-agent, etc.).

```ts
// src/runtime/server/utils/useAgents.ts  (reference shape)
import { Agents } from '@synadia-ai/agents'
import { getNatsConnection } from '../plugins/_connection'

let _agents: Agents | undefined
export function useAgents() {
  const nc = getNatsConnection()
  if (!nc) throw new Error('[nuxt-nats] useAgents called before NATS connected')
  return (_agents ??= new Agents({ nc }))
}
```

### Lifecycle wiring (the load-bearing change)

Three edits to `src/runtime/server/plugins/`:

1. **`_connection.ts`** — add `_agentServices: AgentService[]`, `_registerAgent()`, and `stopAllAgents()` (awaits each `service.stop()`). Keeps the registry Nitro-free, consistent with the file's stated purpose.
2. **`nats.ts` plugin** — after `setJetStream(...)`, await any module-config-declared agents' `start()`. In `drainAndClose()`, call `await stopAllAgents()` **before** `stopAllConsumers()` / `nc.drain()` so heartbeats and in-flight prompt streams stop cleanly before the connection drains.
3. **`useAgents` teardown** — call `agents.close()` (aborts in-flight streams) inside `drainAndClose()` too.

Ordering in `drainAndClose()` becomes: `stopAllAgents()` → `stopAllConsumers()` → `nc.drain()`. The SDK heartbeat timers already `unref()`, so they won't block Nitro shutdown — matching the module's existing care around signal handling.

### Config

Extend module options (`src/module.ts` / `src/runtime/types.ts`) with an `agent` block, defaulted via the existing `defu` pattern and gated like workers:

```ts
agent: {
  enabled: false,            // opt-in; or reuse NUXT_NATS_WORKERS semantics
  owner: 'default',
  heartbeatIntervalS: 30,
  attachmentsOk: true,
}
```

Surface agent count/health in the existing health route (`api/health.get.ts`) for parity with stream/consumer reporting.

### Testing (uses the skill's new `patterns/testing.md`)

- **Unit:** import `defineNatsAgent` via `_connection.ts` (never `nats.ts`) — the module's hard rule. Assert registration + handler wiring with the connection mocked.
- **Integration (Testcontainers, `singleFork`):** stand up `ReferenceAgent` from `@synadia-ai/agent-service/testing` as a counterparty, drive `useAgents().discover()` against it, and assert the §12 wire contract (ack-first, zero-byte terminator, heartbeat shape). This is exactly the interop check the updated skill prescribes.

### Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Synadia SDKs are **0.x, explicitly unstable**; minor bumps may break APIs | Med | Pin exact versions; the skill teaches the **wire protocol** (stable) over the API. Keep the wrapper thin so a drift is a one-file change. |
| New transitive dep `@nats-io/services` | Low | Same `^3.4.0` line as existing `@nats-io/*`; no version conflict. |
| Nitro `close` hook unreliable (nitro#4015) | Low | Already solved — reuse the manual SIGTERM/SIGINT path; add `stopAllAgents()` there, not in the hook. |
| Long-running prompt handlers vs. graceful drain | Med | `service.stop()` before drain; document that handlers should be cancellation-aware. Heartbeat timers `unref()`. |
| `max_payload` assumptions | Low | Broker-negotiated by default; nothing to hardcode. |
| Auth/isolation across tenants | Low | Inherited from the module's NATS account/connection; matches the skill's "isolate with accounts, not app logic". |

### Phasing

- **Phase 1 (MVP):** deps + `defineNatsAgent` + `_connection.ts` registry + plugin start/stop wiring + `agent` config + health surface. Playground smoke-test (`npm run dev`).
- **Phase 2:** `useAgents()` caller util + a meta-agent example in the playground; integration tests against `ReferenceAgent`.
- **Phase 3 (optional, high-leverage):** durable agent memory via `useKV` keyed `{owner}.{agent}.{session}`; `agents.>` audit capture stream via `provisionStreams`; controller endpoints via `extraEndpoints` if an orchestrator emerges.

### Verdict

Adding agent-fabric is a **natural extension, not a graft.** The module already owns the connection, the graceful-shutdown discipline, account isolation, and the JetStream/KV durable layer the skill calls for — so the integration is a thin, well-isolated wrapper plus three plugin edits, behind an opt-in flag. Recommend proceeding with Phase 1 on this branch.

---

## Implementation status

**Phase 1 + caller util — built on this branch.** See [docs/guides/agents.md](../guides/agents.md) for usage.

| Deliverable | File |
|---|---|
| Host util `defineNatsAgent` (registry, resilient self-start, worker-gated, `stopAllAgents`, `getAgentStatuses`) | `src/runtime/server/utils/defineNatsAgent.ts` |
| Caller util `useAgents` / `closeAgents` | `src/runtime/server/utils/useAgents.ts` |
| Shutdown wiring (`stopAllAgents` → `closeAgents` → `stopAllConsumers` → `nc.drain()`) | `src/runtime/server/plugins/nats.ts` |
| Nitro externals + dependencies (`@synadia-ai/agents`, `@synadia-ai/agent-service`, `@nats-io/services`) | `src/module.ts`, `package.json` |
| Health surface (`agents` array) | `src/runtime/server/api/health.get.ts` |
| Unit tests (8, mocked SDK — worker-guard, registration, wait-for-connection, stop, caller cache) | `test/unit/agent.test.ts` |
| Integration tests (5, real broker via Testcontainers — discover, round-trip prompt, wire contract, mid-stream `ask`, deregister-on-stop) | `test/integration/agent.test.ts` |
| Playground host + caller examples | `playground/server/plugins/agent.ts`, `playground/server/api/ask.post.ts` |

Verified: `npm test` → **66 passed**; `npm run test:integration` → **53 passed** (incl. the 5 new agent E2E tests against a real NATS broker); zero new type errors in any added/edited file. (Pre-existing repo `test:types`/lint issues in `parseDuration.ts`, test files, and ESLint-on-Node-20 are untouched and out of scope.)

**Not yet done (Phase 3, optional):** durable agent memory via `useKV` keyed `{owner}.{agent}.{session}`; an `agents.>` audit-capture stream via `provisionStreams`; a cross-SDK interop test against the SDK's `ReferenceAgent`.

---

*Generated while reviewing Synadia's agent toolset and updating the imported `nats-agent-fabric` skill, then building the integration.*
