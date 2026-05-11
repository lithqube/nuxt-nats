import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startNats, stopNats, type NatsTestContext } from './setup'
import { jsPublish } from '../../src/runtime/server/utils/publish'

let ctx: NatsTestContext

beforeAll(async () => {
  ctx = await startNats()

  await ctx.jsm.streams.add({
    name: 'PUB_TEST',
    subjects: ['pub.>'],
    storage: 'memory',
  } as any)
}, 30_000)

afterAll(async () => {
  await stopNats(ctx)
})

describe('jsPublish', () => {
  it('publishes a message that lands in the stream', async () => {
    await jsPublish('pub.created', { id: 'test-1', value: 42 })

    const info = await ctx.jsm.streams.info('PUB_TEST')
    expect(info.state.messages).toBeGreaterThanOrEqual(1)
  })

  it('deduplicates messages with the same msgId', async () => {
    const before = (await ctx.jsm.streams.info('PUB_TEST')).state.messages

    await jsPublish('pub.dedup', { id: 'dedup-1' }, { msgId: 'dedup-key-1' })
    await jsPublish('pub.dedup', { id: 'dedup-1' }, { msgId: 'dedup-key-1' })
    await jsPublish('pub.dedup', { id: 'dedup-1' }, { msgId: 'dedup-key-1' })

    const after = (await ctx.jsm.streams.info('PUB_TEST')).state.messages
    // Only 1 message should land despite 3 publishes with the same msgId
    expect(after - before).toBe(1)
  })

  it('publishes different msgIds as separate messages', async () => {
    const before = (await ctx.jsm.streams.info('PUB_TEST')).state.messages

    await jsPublish('pub.dedup', { id: 'a' }, { msgId: 'unique-a' })
    await jsPublish('pub.dedup', { id: 'b' }, { msgId: 'unique-b' })

    const after = (await ctx.jsm.streams.info('PUB_TEST')).state.messages
    expect(after - before).toBe(2)
  })

  it('rejects publish to a subject not covered by any stream', async () => {
    await expect(
      jsPublish('no-stream.event', { id: '1' }, { timeout: 1000, retries: 0 }),
    ).rejects.toThrow()
  })
})
