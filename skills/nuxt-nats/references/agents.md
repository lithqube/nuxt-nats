# Agent Fabric with nuxt-nats

`defineNatsAgent()` and `useAgents()` are thin wrappers over the **Synadia Agent Protocol** SDKs (`@synadia-ai/agent-service` for hosting, `@synadia-ai/agents` for calling), both 0.x and unstable, so the wrapper stays thin. For the wire protocol (subjects, chunk types, the leading `ack` and zero-byte terminator, discovery), use the `nats-agent-fabric` skill. This file covers only the nuxt-nats surface.

Like consumers, agents run **only when `NUXT_NATS_WORKERS=true`**; otherwise `defineNatsAgent` is a logged no-op.

## Host an agent: `defineNatsAgent`

Call it from a Nitro server plugin. It waits for the connection, registers the `agents` micro service, serves `prompt` and `status`, and heartbeats.

```ts
export default defineNitroPlugin(() => {
  defineNatsAgent({
    agent: 'nuxt-assistant',   // lowercase a-z0-9-_
    owner: 'acme',             // tenant namespace
    name: 'web-1',             // instance name; subject agents.prompt.nuxt-assistant.acme.web-1
    async onPrompt(envelope, response) {
      for await (const token of llm.stream(envelope.prompt)) {
        await response.send(token)    // the SDK emits the leading ack and the terminator
      }
    },
  })
})
```

Optional: `subjectToken`, `description`, `version`, `heartbeatIntervalS` (30), `attachmentsOk` (true), `maxPayload`, `extraMetadata` (cannot override `agent`, `owner` or `protocol_version`), `extraEndpoints` (custom `spawn`/`stop`/`list`), `interceptors` (throw `RequestRejectedError` before `next()` to refuse), `heartbeatExtras`. The handle has `stop()`, `status()` and `identity`.

### Human in the loop: `response.ask`

`ask` pauses the stream with a question and resolves with the caller's reply **object**; read the text from `answer.prompt`. It throws on timeout, so decide what the default is. For anything destructive, default to deny:

```ts
async onPrompt(envelope, response) {
  if (isDestructive(envelope.prompt)) {
    try {
      const answer = await response.ask('Confirm? (yes/no)', { timeoutMs: 30_000 })
      if (answer.prompt.trim().toLowerCase() !== 'yes') { await response.send('Aborted.'); return }
    }
    catch {
      await response.send('No confirmation received, aborted.')
      return
    }
  }
  await response.send(doWork(envelope.prompt))
}
```

## Call agents: `useAgents`

A process-wide cached caller client (one heartbeat subscription however many callers you have), closed automatically on shutdown:

```ts
export default defineEventHandler(async (event) => {
  const { prompt } = await readBody(event)
  const [agent] = await useAgents().discover()          // $SRV.PING / INFO under the hood
  if (!agent) return { error: 'no agents on the fabric' }
  let text = ''
  for await (const msg of await agent.prompt(prompt)) { // msg.type: 'response' | 'status' | 'query'
    if (msg.type === 'response') text += msg.text
  }
  return { agent: `${agent.agent}/${agent.owner}/${agent.name}`, response: text }
})
```

Ignore unknown chunk types rather than failing (the protocol will add some). `getAgentStatuses()` lists the agents registered in the current process; the health endpoint includes them.

## Shutdown

Agents stop before consumers and before the connection drains: `stopAllAgents()` then `closeAgents()` then `stopAllConsumers()` then `nc.drain()`.

## Reality check

Use agents for genuinely agentic work (exposing a harness on the bus, orchestrating a fleet). For ordinary event and worker plumbing, `jsPublish` plus `defineNatsConsumer` is simpler and better understood.
