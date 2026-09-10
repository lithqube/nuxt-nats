import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { useJetStream, useJetStreamManager } from '../../src/runtime/server/utils/useJetStream'
import { jsPublish } from '../../src/runtime/server/utils/publish'
import { defineNatsConsumer, stopAllConsumers } from '../../src/runtime/server/utils/consumer'

vi.mock('../../src/runtime/server/utils/useJetStream', () => ({
  useJetStream: vi.fn(),
  useJetStreamManager: vi.fn(),
}))

vi.mock('../../src/runtime/server/utils/publish', () => ({
  jsPublish: vi.fn().mockResolvedValue(undefined),
  corePublish: vi.fn(),
}))

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
  // ensureConsumer() runs before consumers.get(), so every test needs a JSM. Default to
  // "the durable already exists", which is the pre-existing behaviour these tests assert.
  setupJsmMock()
  return { consumer, iterStop }
}

/**
 * JSM mock for ensureConsumer(). `existing` is the live consumer info, or null to simulate
 * a durable that has not been created yet.
 */
function setupJsmMock(existing: unknown = { config: {} }) {
  // Model the server, not a static stub: once add() succeeds, info() starts answering.
  // A mock that rejects info() forever makes the consumer loop re-create on every pass
  // and turns a correct implementation into a failing assertion.
  let created: unknown = existing
  const info = vi.fn().mockImplementation(() =>
    created === null
      ? Promise.reject(new Error('consumer not found'))
      : Promise.resolve(created),
  )
  const add = vi.fn().mockImplementation((_stream: string, cfg: Record<string, unknown>) => {
    created = { config: cfg }
    return Promise.resolve(created)
  })
  vi.mocked(useJetStreamManager).mockReturnValue({
    consumers: { info, add },
  } as any)
  return { info, add }
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
    vi.restoreAllMocks()
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

  describe('non-JSON payload', () => {
    it('passes raw string to handler when payload is not valid JSON', async () => {
      const handler = vi.fn().mockImplementation(async (msg: any) => { msg.ack() })
      const msg = makeMsg({ data: 'not-valid-json{{{' })
      const handleRef: { current?: { stop: () => void } } = {}
      setupJsMock([msg], handleRef)

      const handle = defineNatsConsumer({ stream: 'ORDERS', durable: 'billing', handler })
      handleRef.current = handle
      await wait()

      expect(handler).toHaveBeenCalledOnce()
      expect(handler.mock.calls[0]![1]).toBe('not-valid-json{{{')
    })
  })

  describe('heartbeat', () => {
    it('calls msg.working() at ackWait/2 intervals during a slow handler', async () => {
      const working = vi.fn()
      const ack = vi.fn()

      // The handler blocks until we release it
      let resolveHandler!: () => void
      let handlerBodyStarted = false

      vi.mocked(useJetStream).mockReturnValue({
        consumers: {
          get: vi.fn().mockResolvedValue({
            consume: vi.fn().mockResolvedValue({
              stop: vi.fn(),
              [Symbol.asyncIterator]: async function* () {
                yield makeMsg({ working, ack })
                // stop the consumer after the one message
                await new Promise(r => setTimeout(r, 50))
              },
            }),
          }),
        },
      } as any)

      const slowDone = new Promise<void>(r => (resolveHandler = r))
      const handle = defineNatsConsumer({
        stream: 'ORDERS',
        durable: 'heartbeat-test',
        ackWait: 200, // heartbeat fires at 100ms
        handler: async (m: any) => {
          handlerBodyStarted = true
          await slowDone
          m.ack()
        },
      })

      // Wait for handler to start
      for (let i = 0; i < 20 && !handlerBodyStarted; i++) {
        await wait(20)
      }
      expect(handlerBodyStarted).toBe(true)

      // Wait past one heartbeat interval (100ms)
      await wait(150)
      expect(working).toHaveBeenCalled()

      resolveHandler()
      handle.stop()
      await wait(50)
    })
  })

  describe('consumer loop error', () => {
    it('logs the error and does not propagate when consumer.consume() throws', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const consumeErr = new Error('connection lost')

      vi.mocked(useJetStream).mockReturnValue({
        consumers: {
          get: vi.fn().mockImplementation(async () => ({
            consume: vi.fn().mockRejectedValue(consumeErr),
          })),
        },
      } as any)

      const handle = defineNatsConsumer({
        stream: 'ORDERS',
        durable: 'billing',
        handler: vi.fn(),
      })

      // Wait for the first async iteration to run and hit the catch block
      await wait(100)
      expect(error).toHaveBeenCalledWith(expect.stringContaining('loop error'), consumeErr)

      handle.stop()
    })
  })

  /**
   * Regressions for the three options that used to be accepted and never read.
   * Before this, filterSubjects was destructured nowhere, defineNatsConsumer could only
   * bind to a durable someone else had created, and a missing one produced an endless
   * "loop error, retrying in 5s" that read like a network fault.
   */
  describe('consumer provisioning and filter honesty', () => {
    it('creates the durable from the declared config when provision is \'startup\'', async () => {
      const handleRef: { current?: { stop: () => void } } = {}
      setupJsMock([], handleRef)
      const { add } = setupJsmMock(null)

      const handle = defineNatsConsumer({
        stream: 'ORDERS',
        durable: 'billing',
        filterSubjects: ['orders.created'],
        ackWait: 30_000,
        maxDeliver: 5,
        provision: 'startup',
        handler: vi.fn(),
      })
      handleRef.current = handle
      await wait()
      handle.stop()

      expect(add).toHaveBeenCalledOnce()
      const [streamArg, cfg] = add.mock.calls[0]! as [string, Record<string, unknown>]
      expect(streamArg).toBe('ORDERS')
      expect(cfg).toMatchObject({
        durable_name: 'billing',
        filter_subject: 'orders.created',
        max_deliver: 5,
        // ms -> ns. Passing the ms value straight through would make ack_wait 30us.
        ack_wait: 30_000_000_000,
      })
    })

    it('uses filter_subjects (plural) when more than one subject is declared', async () => {
      const handleRef: { current?: { stop: () => void } } = {}
      setupJsMock([], handleRef)
      const { add } = setupJsmMock(null)

      const handle = defineNatsConsumer({
        stream: 'ORDERS',
        durable: 'billing',
        filterSubjects: ['orders.created', 'orders.updated'],
        provision: 'startup',
        handler: vi.fn(),
      })
      handleRef.current = handle
      await wait()
      handle.stop()

      const [, cfg] = add.mock.calls[0]! as [string, Record<string, unknown>]
      expect(cfg.filter_subjects).toEqual(['orders.created', 'orders.updated'])
      expect(cfg.filter_subject).toBeUndefined()
    })

    it('does NOT create the durable by default, and says what to do instead', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const handleRef: { current?: { stop: () => void } } = {}
      setupJsMock([], handleRef)
      const { add } = setupJsmMock(null)

      const handle = defineNatsConsumer({
        stream: 'ORDERS',
        durable: 'billing',
        handler: vi.fn(),
      })
      handleRef.current = handle
      await wait()
      handle.stop()

      expect(add).not.toHaveBeenCalled()
      const msg = errSpy.mock.calls.flat().join(' ')
      expect(msg).toContain('does not exist on stream')
      expect(msg).toContain('provision: \'startup\'')
    })

    it('reports a missing durable once, not on every retry', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const handleRef: { current?: { stop: () => void } } = {}
      setupJsMock([], handleRef)
      setupJsmMock(null)

      const handle = defineNatsConsumer({ stream: 'ORDERS', durable: 'billing', handler: vi.fn() })
      handleRef.current = handle
      // Long enough to cover more than one pass of the 5s retry backoff had it re-logged
      // on every iteration.
      await wait(300)
      handle.stop()

      const missing = errSpy.mock.calls
        .flat()
        .filter(a => typeof a === 'string' && a.includes('does not exist on stream'))
      expect(missing).toHaveLength(1)
    })

    it('flags a filter mismatch against the live durable', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const handleRef: { current?: { stop: () => void } } = {}
      setupJsMock([], handleRef)
      setupJsmMock({ config: { filter_subject: 'orders.shipped' } })

      const handle = defineNatsConsumer({
        stream: 'ORDERS',
        durable: 'billing',
        filterSubjects: ['orders.created'],
        handler: vi.fn(),
      })
      handleRef.current = handle
      await wait()
      handle.stop()

      const msg = errSpy.mock.calls.flat().join(' ')
      expect(msg).toContain('filter mismatch')
      expect(msg).toContain('orders.shipped')
    })

    it('stays quiet when the declared filter matches the live durable', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const handleRef: { current?: { stop: () => void } } = {}
      setupJsMock([], handleRef)
      setupJsmMock({ config: { filter_subjects: ['orders.updated', 'orders.created'] } })

      const handle = defineNatsConsumer({
        stream: 'ORDERS',
        durable: 'billing',
        // Same set, different order — order is not meaningful for a filter set.
        filterSubjects: ['orders.created', 'orders.updated'],
        handler: vi.fn(),
      })
      handleRef.current = handle
      await wait()
      handle.stop()

      const msg = errSpy.mock.calls.flat().join(' ')
      expect(msg).not.toContain('filter mismatch')
    })
  })
})
