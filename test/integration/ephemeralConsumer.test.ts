import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startNats, stopNats, type NatsTestContext } from './setup'
import { jsPublish } from '../../src/runtime/server/utils/publish'
import { useEphemeralConsumer } from '../../src/runtime/server/utils/useEphemeralConsumer'
import type { JsMsg } from '@nats-io/jetstream'

let ctx: NatsTestContext

beforeAll(async () => {
  ctx = await startNats()

  await ctx.jsm.streams.add({
    name: 'EPHEMERAL_TEST',
    subjects: ['ephemeral.>'],
    storage: 'memory',
  } as any)
}, 30_000)

afterAll(async () => {
  await stopNats(ctx)
})

function waitMs(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

describe('useEphemeralConsumer — basic delivery', () => {
  it('receives a message published before consumer starts', async () => {
    await jsPublish('ephemeral.early.event', { id: 'early-1' })

    const received: unknown[] = []
    const handle = await useEphemeralConsumer({
      stream: 'EPHEMERAL_TEST',
      filterSubjects: ['ephemeral.early.>'],
      async onMessage(msg) {
        received.push(JSON.parse(new TextDecoder().decode(msg.data)))
        msg.ack()
        return true
      },
      timeoutMs: 5_000,
    })

    await waitMs(1500)
    handle.stop()

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ id: 'early-1' })
  })

  it('receives a message published after consumer starts', async () => {
    const uid = `late-${Date.now()}`
    const received: unknown[] = []
    const handle = await useEphemeralConsumer({
      stream: 'EPHEMERAL_TEST',
      filterSubjects: [`ephemeral.${uid}.>`],
      async onMessage(msg) {
        received.push(JSON.parse(new TextDecoder().decode(msg.data)))
        msg.ack()
        return true
      },
      timeoutMs: 5_000,
    })

    await waitMs(100)
    await jsPublish(`ephemeral.${uid}.event`, { id: 'late-1' })
    await waitMs(1500)
    handle.stop()

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ id: 'late-1' })
  })

  it('filters by subject — ignores messages on other subjects', async () => {
    const uid = `filtered-${Date.now()}`
    await jsPublish(`ephemeral.${uid}.other`, { id: 'other' })
    await jsPublish(`ephemeral.${uid}.target`, { id: 'target' })

    const received: string[] = []
    await useEphemeralConsumer({
      stream: 'EPHEMERAL_TEST',
      filterSubjects: [`ephemeral.${uid}.target`],
      async onMessage(msg) {
        const p = JSON.parse(new TextDecoder().decode(msg.data))
        received.push(p.id)
        msg.ack()
        return true
      },
      timeoutMs: 3_000,
    })

    await waitMs(1500)
    expect(received).toEqual(['target'])
  })
})

describe('useEphemeralConsumer — timeout', () => {
  it('fires onTimeout when no matching message arrives in time', async () => {
    let timedOut = false
    const handle = await useEphemeralConsumer({
      stream: 'EPHEMERAL_TEST',
      filterSubjects: ['ephemeral.timeout.never.>'],
      onMessage: async () => false,
      timeoutMs: 300,
      onTimeout: async () => { timedOut = true },
    })

    await waitMs(600)
    handle.stop()

    expect(timedOut).toBe(true)
  })

  it('does not fire onTimeout when message arrives before timeout', async () => {
    let timedOut = false
    await jsPublish('ephemeral.timeout.fast.event', { id: 'fast' })

    const handle = await useEphemeralConsumer({
      stream: 'EPHEMERAL_TEST',
      filterSubjects: ['ephemeral.timeout.fast.>'],
      async onMessage(msg) {
        msg.ack()
        return true
      },
      timeoutMs: 5_000,
      onTimeout: async () => { timedOut = true },
    })

    await waitMs(1500)
    handle.stop()

    expect(timedOut).toBe(false)
  })
})

describe('useEphemeralConsumer — stop / disconnect', () => {
  it('stop() is idempotent — calling twice does not throw', async () => {
    const handle = await useEphemeralConsumer({
      stream: 'EPHEMERAL_TEST',
      filterSubjects: ['ephemeral.idempotent.>'],
      onMessage: async () => false,
      timeoutMs: 5_000,
    })

    expect(() => {
      handle.stop()
      handle.stop()
    }).not.toThrow()
  })

  it('fires onDisconnect when stop() is called before a message arrives', async () => {
    let disconnected = false
    const handle = await useEphemeralConsumer({
      stream: 'EPHEMERAL_TEST',
      filterSubjects: ['ephemeral.disconnect.>'],
      onMessage: async () => false,
      timeoutMs: 5_000,
      onDisconnect: () => { disconnected = true },
    })

    handle.stop()
    await waitMs(50)

    expect(disconnected).toBe(true)
  })

  it('does not fire onDisconnect after a successful match', async () => {
    await jsPublish('ephemeral.match.event', { id: 'match' })

    let disconnected = false
    const handle = await useEphemeralConsumer({
      stream: 'EPHEMERAL_TEST',
      filterSubjects: ['ephemeral.match.>'],
      async onMessage(msg) {
        msg.ack()
        return true
      },
      timeoutMs: 5_000,
      onDisconnect: () => { disconnected = true },
    })

    await waitMs(1500)
    handle.stop()

    expect(disconnected).toBe(false)
  })

  it('per-message errors do not kill the consumer loop', async () => {
    await jsPublish('ephemeral.error.a', { id: 'err-a' })
    await jsPublish('ephemeral.error.b', { id: 'err-b' })

    let successCount = 0
    const handle = await useEphemeralConsumer({
      stream: 'EPHEMERAL_TEST',
      filterSubjects: ['ephemeral.error.>'],
      async onMessage(msg: JsMsg) {
        const p = JSON.parse(new TextDecoder().decode(msg.data))
        if (p.id === 'err-a') throw new Error('deliberate error on first message')
        msg.ack()
        successCount++
        return true
      },
      timeoutMs: 5_000,
    })

    await waitMs(1500)
    handle.stop()

    // Second message must still be processed despite first throwing
    expect(successCount).toBe(1)
  })
})
