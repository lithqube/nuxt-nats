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

  it('forwards custom headers to the NATS message', async () => {
    const traceId = 'test-trace-abc123'
    const durable = 'pub-headers-with-msgid'
    await ctx.jsm.consumers.add('PUB_TEST', {
      durable_name: durable,
      ack_policy: 'explicit',
      deliver_policy: 'new',
      filter_subjects: ['pub.traced'],
    } as any)

    await jsPublish('pub.traced', { id: 'trace-1' }, { msgId: 'traced-1', headers: { 'X-Trace-Id': traceId } })

    const consumer = await ctx.js.consumers.get('PUB_TEST', durable)
    const msgs = await consumer.fetch({ max_messages: 1, expires: 5000 })
    let received = 0
    for await (const msg of msgs) {
      expect(msg.headers?.get('X-Trace-Id')).toBe(traceId)
      expect(msg.headers?.get('Nats-Msg-Id')).toBe('traced-1')
      msg.ack()
      received++
    }
    expect(received).toBe(1)
  })

  it('sets custom headers without msgId', async () => {
    const traceId = 'headers-only-trace'
    const durable = 'pub-headers-no-msgid'
    await ctx.jsm.consumers.add('PUB_TEST', {
      durable_name: durable,
      ack_policy: 'explicit',
      deliver_policy: 'new',
      filter_subjects: ['pub.headers-only'],
    } as any)

    await jsPublish('pub.headers-only', { id: 'trace-2' }, { headers: { 'X-Trace-Id': traceId } })

    const consumer = await ctx.js.consumers.get('PUB_TEST', durable)
    const msgs = await consumer.fetch({ max_messages: 1, expires: 5000 })
    let received = 0
    for await (const msg of msgs) {
      expect(msg.headers?.get('X-Trace-Id')).toBe(traceId)
      msg.ack()
      received++
    }
    expect(received).toBe(1)
  })

  it('msgId wins over Nats-Msg-Id in extraHeaders', async () => {
    const durable = 'pub-msgid-wins'
    await ctx.jsm.consumers.add('PUB_TEST', {
      durable_name: durable,
      ack_policy: 'explicit',
      deliver_policy: 'new',
      filter_subjects: ['pub.msgid-wins'],
    } as any)

    await jsPublish(
      'pub.msgid-wins',
      { id: 'win-1' },
      { msgId: 'correct-id', headers: { 'Nats-Msg-Id': 'wrong-id' } },
    )

    const consumer = await ctx.js.consumers.get('PUB_TEST', durable)
    const msgs = await consumer.fetch({ max_messages: 1, expires: 5000 })
    let received = 0
    for await (const msg of msgs) {
      expect(msg.headers?.get('Nats-Msg-Id')).toBe('correct-id')
      msg.ack()
      received++
    }
    expect(received).toBe(1)
  })

  it('sets X-Trace-Id header via traceId option', async () => {
    const traceId = 'trace-option-test'
    const durable = 'pub-traceid-option'
    await ctx.jsm.consumers.add('PUB_TEST', {
      durable_name: durable,
      ack_policy: 'explicit',
      deliver_policy: 'new',
      filter_subjects: ['pub.traceid-opt'],
    } as any)

    await jsPublish('pub.traceid-opt', { id: 'ti-1' }, { traceId })

    const consumer = await ctx.js.consumers.get('PUB_TEST', durable)
    const msgs = await consumer.fetch({ max_messages: 1, expires: 5000 })
    let received = 0
    for await (const msg of msgs) {
      expect(msg.headers?.get('X-Trace-Id')).toBe(traceId)
      msg.ack()
      received++
    }
    expect(received).toBe(1)
  })

  it('sets X-Correlation-Id header via correlationId option', async () => {
    const correlationId = 'corr-option-test'
    const durable = 'pub-correlationid-option'
    await ctx.jsm.consumers.add('PUB_TEST', {
      durable_name: durable,
      ack_policy: 'explicit',
      deliver_policy: 'new',
      filter_subjects: ['pub.correlationid-opt'],
    } as any)

    await jsPublish('pub.correlationid-opt', { id: 'ci-1' }, { correlationId })

    const consumer = await ctx.js.consumers.get('PUB_TEST', durable)
    const msgs = await consumer.fetch({ max_messages: 1, expires: 5000 })
    let received = 0
    for await (const msg of msgs) {
      expect(msg.headers?.get('X-Correlation-Id')).toBe(correlationId)
      msg.ack()
      received++
    }
    expect(received).toBe(1)
  })

  it('sets both X-Trace-Id and X-Correlation-Id together', async () => {
    const traceId = 'trace-both'
    const correlationId = 'corr-both'
    const durable = 'pub-both-trace'
    await ctx.jsm.consumers.add('PUB_TEST', {
      durable_name: durable,
      ack_policy: 'explicit',
      deliver_policy: 'new',
      filter_subjects: ['pub.both-trace'],
    } as any)

    await jsPublish('pub.both-trace', { id: 'both-1' }, { traceId, correlationId })

    const consumer = await ctx.js.consumers.get('PUB_TEST', durable)
    const msgs = await consumer.fetch({ max_messages: 1, expires: 5000 })
    let received = 0
    for await (const msg of msgs) {
      expect(msg.headers?.get('X-Trace-Id')).toBe(traceId)
      expect(msg.headers?.get('X-Correlation-Id')).toBe(correlationId)
      msg.ack()
      received++
    }
    expect(received).toBe(1)
  })

  it('traceId takes precedence over headers[\'X-Trace-Id\']', async () => {
    const durable = 'pub-traceid-override'
    await ctx.jsm.consumers.add('PUB_TEST', {
      durable_name: durable,
      ack_policy: 'explicit',
      deliver_policy: 'new',
      filter_subjects: ['pub.traceid-override'],
    } as any)

    // headers sets X-Trace-Id first, then traceId overwrites — traceId wins
    await jsPublish(
      'pub.traceid-override',
      { id: 'to-1' },
      { traceId: 'correct-trace', headers: { 'X-Trace-Id': 'wrong-trace' } },
    )

    const consumer = await ctx.js.consumers.get('PUB_TEST', durable)
    const msgs = await consumer.fetch({ max_messages: 1, expires: 5000 })
    let received = 0
    for await (const msg of msgs) {
      expect(msg.headers?.get('X-Trace-Id')).toBe('correct-trace')
      msg.ack()
      received++
    }
    expect(received).toBe(1)
  })

  it('rejects publish to a subject not covered by any stream', async () => {
    await expect(
      jsPublish('no-stream.event', { id: '1' }, { timeout: 1000, retries: 0 }),
    ).rejects.toThrow()
  })
})
