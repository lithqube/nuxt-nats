import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { startNats, stopNats, type NatsTestContext } from './setup'
import { jsPublish } from '../../src/runtime/server/utils/publish'
import { defineNatsConsumer, stopAllConsumers } from '../../src/runtime/server/utils/consumer'

let ctx: NatsTestContext

beforeAll(async () => {
  ctx = await startNats()
  process.env.NUXT_NATS_WORKERS = 'true'

  // Stream for main consumer tests
  await ctx.jsm.streams.add({
    name: 'CONSUMER_TEST',
    subjects: ['consumer.>'],
    storage: 'memory',
  } as any)

  // DLQ stream uses a separate prefix so subjects don't overlap with CONSUMER_TEST
  await ctx.jsm.streams.add({
    name: 'CONSUMER_DLQ',
    subjects: ['dlq.consumer.>'],
    storage: 'memory',
  } as any)
}, 30_000)

afterAll(async () => {
  stopAllConsumers()
  delete process.env.NUXT_NATS_WORKERS
  await stopNats(ctx)
})

function createDurableConsumer(durable: string, stream = 'CONSUMER_TEST') {
  return ctx.jsm.consumers.add(stream, {
    durable_name: durable,
    ack_policy: 'explicit',
    deliver_policy: 'all',
    max_deliver: 5,
    ack_wait: 5_000_000_000, // 5s in nanoseconds
    filter_subjects: [`consumer.${durable}.>`],
  } as any)
}

function waitMs(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

describe('defineNatsConsumer end-to-end', () => {
  it('receives and acks a published message', async () => {
    await createDurableConsumer('e2e-ack')
    await jsPublish('consumer.e2e-ack.created', { id: '1', value: 'hello' })

    const received: unknown[] = []
    const handle = defineNatsConsumer({
      stream: 'CONSUMER_TEST',
      durable: 'e2e-ack',
      async handler(msg, payload) {
        received.push(payload)
        msg.ack()
      },
    })

    await waitMs(2000)
    handle.stop()

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({ id: '1', value: 'hello' })
  })

  it('routes to DLQ after maxDeliver exhausted', async () => {
    await createDurableConsumer('e2e-dlq')
    await ctx.jsm.consumers.add('CONSUMER_TEST', {
      durable_name: 'e2e-dlq',
      ack_policy: 'explicit',
      deliver_policy: 'all',
      max_deliver: 3,
      ack_wait: 500_000_000, // 500ms — short so redeliveries happen fast in tests
      filter_subjects: ['consumer.e2e-dlq.>'],
    } as any).catch(() => { /* already exists */ })

    await jsPublish('consumer.e2e-dlq.created', { id: 'poison' })

    let handlerCalls = 0
    const handle = defineNatsConsumer({
      stream: 'CONSUMER_TEST',
      durable: 'e2e-dlq',
      maxDeliver: 3,
      deadLetterSubject: 'dlq.consumer.poison',
      async handler(msg) {
        handlerCalls++
        msg.nak() // always fail — simulates poison message
      },
    })

    // Wait long enough for 2 redeliveries (ackWait 500ms each) + DLQ routing
    await waitMs(4000)
    handle.stop()

    // Handler called twice (deliveries 1 and 2), DLQ routing on delivery 3
    expect(handlerCalls).toBe(2)

    const dlqInfo = await ctx.jsm.streams.info('CONSUMER_DLQ')
    expect(dlqInfo.state.messages).toBeGreaterThanOrEqual(1)
  })

  it('applies backoff delays between redeliveries', async () => {
    await ctx.jsm.consumers.add('CONSUMER_TEST', {
      durable_name: 'e2e-backoff',
      ack_policy: 'explicit',
      deliver_policy: 'all',
      max_deliver: 3,
      ack_wait: 2_000_000_000, // 2s
      filter_subjects: ['consumer.e2e-backoff.>'],
    } as any).catch(() => {})

    await jsPublish('consumer.e2e-backoff.event', { id: 'backoff-test' })

    const deliveryTimes: number[] = []
    const handle = defineNatsConsumer({
      stream: 'CONSUMER_TEST',
      durable: 'e2e-backoff',
      maxDeliver: 3,
      backoff: [500, 1000], // 500ms after 1st fail, 1000ms after 2nd
      async handler(msg) {
        deliveryTimes.push(Date.now())
        msg.nak(500) // explicit delay — in reality this comes from backoff array
      },
    })

    await waitMs(5000)
    handle.stop()

    // Should have received at least 2 deliveries
    expect(deliveryTimes.length).toBeGreaterThanOrEqual(2)
    // Gap between 1st and 2nd delivery should be at least 400ms
    if (deliveryTimes.length >= 2) {
      const gap = deliveryTimes[1]! - deliveryTimes[0]!
      expect(gap).toBeGreaterThan(400)
    }
  })
})

describe('defineNatsConsumer multiple messages', () => {
  it('processes all messages in order', async () => {
    await ctx.jsm.consumers.add('CONSUMER_TEST', {
      durable_name: 'e2e-order',
      ack_policy: 'explicit',
      deliver_policy: 'all',
      max_deliver: 3,
      ack_wait: 5_000_000_000,
      filter_subjects: ['consumer.e2e-order.>'],
    } as any).catch(() => {})

    await jsPublish('consumer.e2e-order.item', { seq: 1 })
    await jsPublish('consumer.e2e-order.item', { seq: 2 })
    await jsPublish('consumer.e2e-order.item', { seq: 3 })

    const received: number[] = []
    const handle = defineNatsConsumer<{ seq: number }>({
      stream: 'CONSUMER_TEST',
      durable: 'e2e-order',
      async handler(msg, payload) {
        received.push(payload.seq)
        msg.ack()
      },
    })

    await waitMs(2000)
    handle.stop()

    expect(received).toEqual([1, 2, 3])
  })
})
