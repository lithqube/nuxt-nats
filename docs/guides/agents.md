# Agent Fabric (Synadia Agent Protocol)

Expose your Nuxt server as a discoverable AI **agent** on the NATS bus, or **call** other agents from server routes — over the same connection the module already manages. Built on the [Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs) (`@synadia-ai/agents` + `@synadia-ai/agent-service`).

> Background and design rationale: [docs/agent-fabric/EVALUATION.md](../agent-fabric/EVALUATION.md). Deep protocol guidance lives in the `nats-agent-fabric` skill under `.claude/skills/`.

## Host an agent — `defineNatsAgent`

`defineNatsAgent()` is auto-imported in your `server/` code. Call it from a Nitro server plugin (`server/plugins/`); it waits for the NATS connection, registers the `agents` micro service, serves the `prompt` + `status` endpoints, beacons heartbeats, and is torn down automatically on shutdown.

```ts
// server/plugins/assistant.ts
export default defineNitroPlugin(() => {
  defineNatsAgent({
    agent: 'nuxt-assistant',   // metadata.agent — lowercase a-z0-9-_
    owner: 'acme',             // tenant / account namespace
    name: 'web-1',             // instance name (5th subject token)
    async onPrompt(envelope, response) {
      // Stream the answer back in chunks; the SDK emits the leading `ack`
      // and the zero-byte terminator for you.
      for await (const token of llm.stream(envelope.prompt)) {
        await response.send(token)
      }
    },
  })
})
```

**Workers only.** Like consumers, agents run only when `NUXT_NATS_WORKERS=true` — an agent is a long-lived service that beacons heartbeats, which is wrong for a serverless/edge deployment. Without the flag, `defineNatsAgent` is a logged no-op.

### Human-in-the-loop (mid-stream `ask`)

Pause the stream to ask the caller a question — a confirmation, a clarification — without ending it. `ask` throws on timeout, so decide whether to abort or fall back:

```ts
async onPrompt(envelope, response) {
  if (isDestructive(envelope.prompt)) {
    try {
      const answer = await response.ask('Confirm? (yes/no)', { timeoutMs: 30_000 })
      if (answer.prompt.trim().toLowerCase() !== 'yes') {
        await response.send('Aborted.')
        return
      }
    }
    catch {
      await response.send('No confirmation received — aborted.')
      return
    }
  }
  await response.send(doWork(envelope.prompt))
}
```

### Controller endpoints

Register custom endpoints (`spawn` / `stop` / `list`) alongside `prompt` / `status` via `extraEndpoints` — subjects are advertised verbatim, so assemble the full `agents.*` subject yourself. `start()` validates name collisions.

```ts
defineNatsAgent({
  agent: 'orchestrator', owner: 'acme', name: 'main',
  onPrompt: handlePrompt,
  extraEndpoints: [
    { name: 'spawn', subject: 'agents.spawn.orchestrator.acme.main', queue: 'controllers', handler: onSpawn },
  ],
})
```

## Call agents — `useAgents`

`useAgents()` returns a cached caller client over the module connection. Discover the fleet and prompt agents; it's safe in request handlers (closed automatically on shutdown).

```ts
// server/api/ask.post.ts
export default defineEventHandler(async (event) => {
  const { prompt } = await readBody(event)
  const agents = useAgents()
  const [agent] = await agents.discover()
  if (!agent) return { error: 'no agents on the fabric' }

  let text = ''
  for await (const msg of await agent.prompt(prompt)) {
    if (msg.type === 'response') text += msg.text
  }
  return { agent: `${agent.agent}/${agent.owner}/${agent.name}`, response: text }
})
```

## Options

`defineNatsAgent(options)`:

| Option | Default | Notes |
|--------|---------|-------|
| `agent` / `owner` / `name` | — | Identity tuple → subject `agents.prompt.{agent}.{owner}.{name}`. |
| `onPrompt` | — | `(envelope, response) => …`. Stream with `response.send`; ask with `response.ask`. |
| `subjectToken` | `agent` | Override the subject's 3rd token (e.g. `cc` for `claude-code`). |
| `heartbeatIntervalS` | `30` | Liveness cadence. |
| `attachmentsOk` | `true` | Whether the prompt endpoint accepts attachments. |
| `maxPayload` | broker-negotiated | Omit to advertise `nc.info.max_payload`; an over-large override is clamped down. |
| `extraMetadata` | — | Extra service metadata keys. |
| `extraEndpoints` | — | Custom `spawn`/`stop`/`list`-style endpoints. |

## Lifecycle & shutdown

Agents and the caller client are torn down in `drainAndClose()` **before** consumers and `nc.drain()`:

```text
stopAllAgents() → closeAgents() → stopAllConsumers() → nc.drain()
```

This stops heartbeats and in-flight prompt streams cleanly before the connection closes, using the module's existing manual SIGTERM/SIGINT path (the Nitro `close` hook is unreliable — nitro#4015).

## Health

When agents are registered, the health endpoint (`/api/_nats/health`) includes an `agents` array with each agent's identity and lifecycle status (`starting` / `running` / `stopped` / `error`).

## Versions & stability

The Synadia SDKs are **0.x and explicitly unstable** — pinned to `^0.5.2`. The wrapper is intentionally thin so an API drift is a one-file change; the durable contract is the wire protocol (see the skill). Verify installed versions when upgrading.
