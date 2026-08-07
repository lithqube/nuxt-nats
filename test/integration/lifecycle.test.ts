import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startNats, stopNats, type NatsTestContext } from './setup'
import { useJetStreamIfAvailable } from '../../src/runtime/server/utils/useJetStream'
import { useNats } from '../../src/runtime/server/utils/useNats'
import { useKV } from '../../src/runtime/server/utils/useKV'
import { jsPublish } from '../../src/runtime/server/utils/publish'

let ctx: NatsTestContext

beforeAll(async () => {
  ctx = await startNats()

  await ctx.jsm.streams.add({
    name: 'LIFECYCLE_TEST',
    subjects: ['lifecycle.>'],
    storage: 'memory',
  } as any)
}, 30_000)

afterAll(async () => {
  await stopNats(ctx)
})

describe('useJetStreamIfAvailable', () => {
  it('returns JetStreamClient when connected', () => {
    const js = useJetStreamIfAvailable()
    expect(js).not.toBeNull()
    expect(js).toBe(ctx.js)
  })
})

describe('connection resilience', () => {
  it('useNats() returns the active connection', () => {
    const nc = useNats()
    expect(nc).toBeDefined()
    expect(nc.isClosed()).toBe(false)
  })

  it('connection reports a server address', () => {
    const nc = useNats()
    const server = nc.getServer()
    expect(server).toBeTruthy()
    expect(server).toContain('localhost')
  })

  it('RTT returns a non-negative roundtrip time', async () => {
    const nc = useNats()
    const rtt = await nc.rtt()
    expect(rtt).toBeGreaterThanOrEqual(0)
  })
})

describe('publish + KV combined workflow', () => {
  it('publishes then verifies via stream info', async () => {
    await jsPublish('lifecycle.combined', { step: 'publish' })

    const info = await ctx.jsm.streams.info('LIFECYCLE_TEST')
    expect(info.state.messages).toBeGreaterThanOrEqual(1)
  })

  it('KV put/get within same container session', async () => {
    const kv = await useKV('lifecycle-kv', { storage: 'memory' })
    await kv.put('session', JSON.stringify({ active: true }))
    const entry = await kv.get('session')
    expect(entry!.json<{ active: boolean }>()).toEqual({ active: true })
  })
})
