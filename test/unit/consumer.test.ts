import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/runtime/server/utils/useJetStream', () => ({
  useJetStream: vi.fn(),
}))

vi.mock('../../src/runtime/server/utils/publish', () => ({
  jsPublish: vi.fn().mockResolvedValue(undefined),
  corePublish: vi.fn(),
}))

import { useJetStream } from '../../src/runtime/server/utils/useJetStream'
import { jsPublish } from '../../src/runtime/server/utils/publish'
import { defineNatsConsumer, stopAllConsumers } from '../../src/runtime/server/utils/consumer'

type MockMsg = ReturnType<typeof makeMsg>

function makeMsg(overrides: Partial<{
  deliveryCount: number
  subject: string
  data: string
  ack: () => void
  nak: (delay?: number) => void
  term: () => void
  working: () => void
}> = {}) {
  return {
    subject: overrides.subject ?? 'orders.created',
    info: {
      deliveryCount: overrides.deliveryCount ?? 1,
      pending: 0,
      redelivered: false,
    },
    string: () => overrides.data ?? '{"id":"1"}',
    ack: overrides.ack ?? vi.fn(),
    nak: overrides.nak ?? vi.fn(),
    term: overrides.term ?? vi.fn(),
    working: overrides.working ?? vi.fn(),
  }
}

/**
 * Sets up the useJetStream mock so it yields `messages` then stops the consumer.
 * Must be called BEFORE defineNatsConsumer so the mock is ready on the first
 * synchronous call to useJetStream() inside the consumer async IIFE.
 * `handleRef` is a late-bound ref — populated after defineNatsConsumer returns.
 */
function setupJsMock(messages: MockMsg[], handleRef: { current?: { stop: () => void } }) {
  const iterStop = vi.fn()
  const iter = {
    stop: iterStop,
    [Symbol.asyncIterator]: async function* () {
      for (const msg of messages) {
        yield msg
      }
      // Stop the outer while-loop after the message batch is exhausted.
      // setTimeout(0) defers until after the for-await exits cleanly.
      setTimeout(() => handleRef.current?.stop(), 0)
    },
  }
  const consumer = {
    consume: vi.fn().mockImplementation(
      // Small delay prevents immediate tight-loop spin on repeated calls
      () => new Promise(r => setTimeout(() => r(iter), 5)),
    ),
  }
  vi.mocked(useJetStream).mockReturnValue({
    consumers: { get: vi.fn().mockResolvedValue(consumer) },
  } as any)
  return { consumer, iterStop }
}

function wait(ms = 200) {
  return new Promise(r => setTimeout(r, ms))
}

describe('defineNatsConsumer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stopAllConsumers()
    process.env.NUXT_NATS_WORKERS = 'true'
  })

  afterEach(() => {
    stopAllConsumers()
  })

  it('returns noop when NUXT_NATS_WORKERS is not set', () => {
    delete process.env.NUXT_NATS_WORKERS
    const handle = defineNatsConsumer({ stream: 'ORDERS', durable: 'billing', handler: vi.fn() })
    expect(handle.stop).toBeDefined()
    expect(useJetStream).not.toHaveBeenCalled()
  })

  it('calls handler with parsed JSON payload', async () => {
    const handler = vi.fn().mockImplementation(async (msg: any) => { msg.ack() })
    const msg = makeMsg({ data: '{"id":"123","total":99}' })
    const handleRef: { current?: { stop: () => void } } = {}
    setupJsMock([msg], handleRef)

    const handle = defineNatsConsumer({ stream: 'ORDERS', durable: 'billing', handler })
    handleRef.current = handle
    await wait()

    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0]![1]).toEqual({ id: '123', total: 99 })
  })

  describe('DLQ routing', () => {
    it('routes to DLQ when deliveryCount >= maxDeliver', async () => {
      const handler = vi.fn()
      const term = vi.fn()
      const msg = makeMsg({ deliveryCount: 5, term })
      const handleRef: { current?: { stop: () => void } } = {}
      setupJsMock([msg], handleRef)

      const handle = defineNatsConsumer({
        stream: 'ORDERS',
        durable: 'billing',
        maxDeliver: 5,
        deadLetterSubject: 'orders.dlq',
        handler,
      })
      handleRef.current = handle
      await wait()

      expect(jsPublish).toHaveBeenCalledWith('orders.dlq', expect.objectContaining({
        originalSubject: 'orders.created',
        deliveryCount: 5,
      }))
      expect(term).toHaveBeenCalledOnce()
      expect(handler).not.toHaveBeenCalled()
    })

    it('does NOT route to DLQ when deliveryCount < maxDeliver (off-by-one regression)', async () => {
      const handler = vi.fn().mockImplementation(async (msg: any) => { msg.ack() })
      const term = vi.fn()
      // deliveryCount=4, maxDeliver=5 — handler should still be called
      const msg = makeMsg({ deliveryCount: 4, term })
      const handleRef: { current?: { stop: () => void } } = {}
      setupJsMock([msg], handleRef)

      const handle = defineNatsConsumer({
        stream: 'ORDERS',
        durable: 'billing',
        maxDeliver: 5,
        deadLetterSubject: 'orders.dlq',
        handler,
      })
      handleRef.current = handle
      await wait()

      expect(jsPublish).not.toHaveBeenCalled()
      expect(term).not.toHaveBeenCalled()
      expect(handler).toHaveBeenCalledOnce()
    })

    it('still calls msg.term() even when jsPublish throws', async () => {
      vi.mocked(jsPublish).mockRejectedValueOnce(new Error('publish failed'))
      const handler = vi.fn()
      const term = vi.fn()
      const msg = makeMsg({ deliveryCount: 5, term })
      const handleRef: { current?: { stop: () => void } } = {}
      setupJsMock([msg], handleRef)

      const handle = defineNatsConsumer({
        stream: 'ORDERS',
        durable: 'billing',
        maxDeliver: 5,
        deadLetterSubject: 'orders.dlq',
        handler,
      })
      handleRef.current = handle
      await wait()

      expect(term).toHaveBeenCalledOnce()
    })
  })

  describe('backoff on handler failure', () => {
    it('calls msg.nak() with no args when no backoff configured', async () => {
      const nak = vi.fn()
      const msg = makeMsg({ deliveryCount: 1, nak })
      const handleRef: { current?: { stop: () => void } } = {}
      setupJsMock([msg], handleRef)

      const handle = defineNatsConsumer({
        stream: 'ORDERS',
        durable: 'billing',
        handler: async () => { throw new Error('fail') },
      })
      handleRef.current = handle
      await wait()

      expect(nak).toHaveBeenCalledWith()
    })

    it('applies backoff[0] on first failure (deliveryCount=1)', async () => {
      const nak = vi.fn()
      const msg = makeMsg({ deliveryCount: 1, nak })
      const handleRef: { current?: { stop: () => void } } = {}
      setupJsMock([msg], handleRef)

      const handle = defineNatsConsumer({
        stream: 'ORDERS',
        durable: 'billing',
        backoff: [1000, 5000, 15_000],
        handler: async () => { throw new Error('fail') },
      })
      handleRef.current = handle
      await wait()

      expect(nak).toHaveBeenCalledWith(1000)
    })

    it('applies backoff[1] on second failure (deliveryCount=2)', async () => {
      const nak = vi.fn()
      const msg = makeMsg({ deliveryCount: 2, nak })
      const handleRef: { current?: { stop: () => void } } = {}
      setupJsMock([msg], handleRef)

      const handle = defineNatsConsumer({
        stream: 'ORDERS',
        durable: 'billing',
        backoff: [1000, 5000, 15_000],
        handler: async () => { throw new Error('fail') },
      })
      handleRef.current = handle
      await wait()

      expect(nak).toHaveBeenCalledWith(5000)
    })

    it('clamps to last backoff entry when deliveryCount exceeds backoff length', async () => {
      const nak = vi.fn()
      const msg = makeMsg({ deliveryCount: 10, nak })
      const handleRef: { current?: { stop: () => void } } = {}
      setupJsMock([msg], handleRef)

      const handle = defineNatsConsumer({
        stream: 'ORDERS',
        durable: 'billing',
        maxDeliver: 20,
        backoff: [1000, 5000, 15_000],
        handler: async () => { throw new Error('fail') },
      })
      handleRef.current = handle
      await wait()

      expect(nak).toHaveBeenCalledWith(15_000)
    })
  })
})
