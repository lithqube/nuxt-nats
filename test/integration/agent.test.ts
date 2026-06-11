import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { startNats, stopNats, type NatsTestContext } from './setup'
import { defineNatsAgent, stopAllAgents, type NatsAgentHandle } from '../../src/runtime/server/utils/defineNatsAgent'
import { useAgents, closeAgents } from '../../src/runtime/server/utils/useAgents'

let ctx: NatsTestContext

beforeAll(async () => {
  ctx = await startNats()
  process.env.NUXT_NATS_WORKERS = 'true'
}, 60_000)

afterAll(async () => {
  await stopAllAgents()
  await closeAgents()
  delete process.env.NUXT_NATS_WORKERS
  await stopNats(ctx)
})

afterEach(async () => {
  await stopAllAgents()
})

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (u: Uint8Array) => new TextDecoder().decode(u)

/** Poll until predicate is true or timeout. */
async function waitFor(pred: () => boolean, timeoutMs = 5000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise(r => setTimeout(r, stepMs))
  }
  throw new Error('waitFor: timed out')
}

/** Wait for a freshly-registered agent to finish starting. */
async function started(handle: NatsAgentHandle) {
  await waitFor(() => handle.status() === 'running')
}

/**
 * Drive an agent's prompt endpoint at the raw-wire level, collecting every
 * message published to our reply inbox until the zero-byte terminator (or
 * timeout). Lets us assert the §6/§12 wire contract our host produces,
 * independent of any caller SDK.
 */
async function collectRaw(subject: string, body: string, timeoutMs = 5000) {
  const reply = `_INBOX.agenttest.${Math.random().toString(36).slice(2)}`
  const sub = ctx.nc.subscribe(reply)
  const msgs: { data: Uint8Array, hasHeaders: boolean }[] = []
  const loop = (async () => {
    for await (const m of sub) {
      const headerKeys = m.headers?.keys?.() ?? []
      msgs.push({ data: m.data, hasHeaders: [...headerKeys].length > 0 })
      if (m.data.length === 0) break // zero-byte terminator
    }
  })()
  ctx.nc.publish(subject, enc(body), { reply })
  await Promise.race([loop, new Promise(r => setTimeout(r, timeoutMs))])
  sub.unsubscribe()
  return msgs
}

function echoAgent(name: string) {
  return defineNatsAgent({
    agent: 'echo', owner: 'test', name,
    heartbeatIntervalS: 1,
    async onPrompt(envelope, response) {
      await response.send(`echo: ${envelope.prompt}`)
    },
  })
}

describe('agent fabric end-to-end', () => {
  it('registers a discoverable agent that a caller can find', async () => {
    const handle = echoAgent('discover')
    await started(handle)

    const found = await useAgents().discover()
    const me = found.find(a => a.agent === 'echo' && a.owner === 'test' && a.name === 'discover')
    expect(me).toBeTruthy()
  })

  it('round-trips a prompt and streams the response back (caller SDK)', async () => {
    const handle = echoAgent('rt')
    await started(handle)

    const found = await useAgents().discover()
    const target = found.find(a => a.name === 'rt')!
    expect(target).toBeTruthy()

    let text = ''
    for await (const msg of await target.prompt('hello world')) {
      if (msg.type === 'response') text += msg.text
    }
    expect(text).toBe('echo: hello world')
  })

  it('honors the wire contract: leading ack chunk then a zero-byte terminator', async () => {
    const handle = echoAgent('wire')
    await started(handle)

    const msgs = await collectRaw('agents.prompt.echo.test.wire', 'ping')
    expect(msgs.length).toBeGreaterThanOrEqual(2)

    // First message MUST be the {type:"status",data:"ack"} chunk (§6.4).
    const first = JSON.parse(dec(msgs[0]!.data))
    expect(first).toMatchObject({ type: 'status', data: 'ack' })

    // A response chunk carrying the echo appears before the terminator.
    const hasEcho = msgs.some((m) => {
      if (m.data.length === 0) return false
      try {
        const c = JSON.parse(dec(m.data))
        return c.type === 'response' && JSON.stringify(c.data).includes('echo: ping')
      }
      catch { return false }
    })
    expect(hasEcho).toBe(true)

    // Last message MUST be the zero-byte, header-less terminator (§6.5).
    const last = msgs[msgs.length - 1]!
    expect(last.data.length).toBe(0)
    expect(last.hasHeaders).toBe(false)
  })

  it('supports a mid-stream ask round-trip (human-in-the-loop)', async () => {
    const handle = defineNatsAgent({
      agent: 'guard', owner: 'test', name: 'ask',
      heartbeatIntervalS: 1,
      async onPrompt(envelope, response) {
        const answer = await response.ask(`confirm ${envelope.prompt}?`, { timeoutMs: 4000 })
        await response.send(answer.prompt.trim().toLowerCase() === 'yes' ? 'done' : 'aborted')
      },
    })
    await started(handle)

    const reply = `_INBOX.askraw.${Math.random().toString(36).slice(2)}`
    const sub = ctx.nc.subscribe(reply)
    ctx.nc.publish('agents.prompt.guard.test.ask', enc('delete'), { reply })

    const collected: string[] = []
    let answered = false
    const loop = (async () => {
      for await (const m of sub) {
        if (m.data.length === 0) break // terminator
        const chunk = JSON.parse(dec(m.data))
        if (chunk.type === 'query' && !answered) {
          answered = true
          // Reply once to the query's reply subject (§7.2).
          ctx.nc.publish(chunk.data.reply_subject, enc('yes'))
        }
        else if (chunk.type === 'response') {
          collected.push(typeof chunk.data === 'string' ? chunk.data : chunk.data.text)
        }
      }
    })()
    await Promise.race([loop, new Promise(r => setTimeout(r, 6000))])
    sub.unsubscribe()

    expect(answered).toBe(true)
    expect(collected.join('')).toContain('done')
  })

  it('deregisters the micro service on stop (no longer discoverable)', async () => {
    const handle = echoAgent('lifecycle')
    await started(handle)
    expect((await useAgents().discover()).some(a => a.name === 'lifecycle')).toBe(true)

    await handle.stop()
    expect(handle.status()).toBe('stopped')

    // After stop(), $SRV.PING no longer reaches it.
    await new Promise(r => setTimeout(r, 300)) // small settle
    const found = await useAgents().discover()
    expect(found.some(a => a.name === 'lifecycle')).toBe(false)
  })
})
