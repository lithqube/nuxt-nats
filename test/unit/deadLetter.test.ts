import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  toDeadLetterEvent,
  defineDeadLetterConsumer,
  ADVISORY_MAX_DELIVERIES,
  ADVISORY_MSG_TERMINATED,
  type MaxDeliverAdvisory,
  type TerminatedAdvisory,
} from '../../src/runtime/server/utils/deadLetter'
import { defineNatsConsumer } from '../../src/runtime/server/utils/consumer'
import { useJetStreamManager } from '../../src/runtime/server/utils/useJetStream'

vi.mock('../../src/runtime/server/utils/consumer', () => ({
  defineNatsConsumer: vi.fn(() => ({ stop: vi.fn() })),
}))

vi.mock('../../src/runtime/server/utils/useJetStream', () => ({
  useJetStreamManager: vi.fn(),
}))

const maxDeliver: MaxDeliverAdvisory = {
  type: 'io.nats.jetstream.advisory.v1.max_deliver',
  id: 'adv-1',
  timestamp: '2026-09-11T00:00:00Z',
  stream: 'MONEY',
  consumer: 'funding-handler',
  stream_seq: 42,
  deliveries: 5,
}

const terminated: TerminatedAdvisory = {
  type: 'io.nats.jetstream.advisory.v1.terminated',
  id: 'adv-2',
  timestamp: '2026-09-11T00:00:00Z',
  stream: 'MONEY',
  consumer: 'funding-handler',
  stream_seq: 43,
  consumer_seq: 7,
  deliveries: 5,
  reason: 'nuxt-nats: maxDeliver 5 exhausted',
}

describe('toDeadLetterEvent', () => {
  it('maps a max_deliver advisory', () => {
    const e = toDeadLetterEvent(maxDeliver)
    expect(e.kind).toBe('max_deliver')
    expect(e.stream).toBe('MONEY')
    expect(e.consumer).toBe('funding-handler')
    expect(e.streamSeq).toBe(42)
    expect(e.deliveries).toBe(5)
  })

  // The server's max_deliver struct genuinely has no consumer_seq. Emitting one as
  // undefined would put a hole in an audit trail that looks like a bug elsewhere.
  it('omits consumerSeq and reason on max_deliver, because the server does not send them', () => {
    const e = toDeadLetterEvent(maxDeliver)
    expect('consumerSeq' in e).toBe(false)
    expect('reason' in e).toBe(false)
  })

  it('maps a terminated advisory including consumerSeq and the term() reason', () => {
    const e = toDeadLetterEvent(terminated)
    expect(e.kind).toBe('terminated')
    expect(e.consumerSeq).toBe(7)
    expect(e.reason).toContain('maxDeliver 5 exhausted')
  })

  it('falls back to unknown rather than guessing on an unrecognised type', () => {
    const e = toDeadLetterEvent({ ...maxDeliver, type: 'io.nats.jetstream.advisory.v1.nak' })
    expect(e.kind).toBe('unknown')
  })

  it('classifies on the payload type, not the subject', () => {
    // One consumer receives both advisory subjects, so subject-based dispatch would need
    // the subject threaded through. The type field is already on the payload.
    expect(toDeadLetterEvent(terminated).kind).toBe('terminated')
    expect(toDeadLetterEvent(maxDeliver).kind).toBe('max_deliver')
  })
})

describe('defineDeadLetterConsumer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function lastConsumerOpts() {
    return vi.mocked(defineNatsConsumer).mock.calls[0]![0] as unknown as Record<string, unknown> & {
      handler: (msg: unknown, payload: unknown) => Promise<void>
    }
  }

  it('filters on both advisory subjects and never sets a deadLetterSubject', () => {
    defineDeadLetterConsumer({ stream: 'JS_ADVISORY', durable: 'dl', onDeadLetter: vi.fn() })
    const opts = lastConsumerOpts()

    expect(opts.filterSubjects).toEqual([ADVISORY_MAX_DELIVERIES, ADVISORY_MSG_TERMINATED])
    // A dead-letter route on the dead-letter handler is a loop, and an amplifier in
    // exactly the situation you least want one.
    expect(opts.deadLetterSubject).toBeUndefined()
  })

  it('recovers the original message by sequence and passes it to the handler', async () => {
    const stored = { subject: 'funding.completed', seq: 42, data: new Uint8Array([1]) }
    const getMessage = vi.fn().mockResolvedValue(stored)
    vi.mocked(useJetStreamManager).mockReturnValue({ streams: { getMessage } } as never)

    const onDeadLetter = vi.fn()
    defineDeadLetterConsumer({ stream: 'JS_ADVISORY', durable: 'dl', onDeadLetter })

    const msg = { ack: vi.fn() }
    await lastConsumerOpts().handler(msg, maxDeliver)

    // Recovered from the ORIGINAL stream named in the advisory, not the advisory stream.
    expect(getMessage).toHaveBeenCalledWith('MONEY', { seq: 42 })
    expect(onDeadLetter).toHaveBeenCalledOnce()
    expect(onDeadLetter.mock.calls[0]![0].message).toBe(stored)
  })

  it('skips recovery when recoverMessage is false', async () => {
    const getMessage = vi.fn()
    vi.mocked(useJetStreamManager).mockReturnValue({ streams: { getMessage } } as never)

    const onDeadLetter = vi.fn()
    defineDeadLetterConsumer({
      stream: 'JS_ADVISORY',
      durable: 'dl',
      recoverMessage: false,
      onDeadLetter,
    })
    await lastConsumerOpts().handler({ ack: vi.fn() }, maxDeliver)

    expect(getMessage).not.toHaveBeenCalled()
    expect(onDeadLetter.mock.calls[0]![0].message).toBeNull()
  })

  it('still calls the handler when the original message has aged out', async () => {
    // The advisory outlives the message whenever the source stream's max_age is shorter
    // than the advisory stream's. Failing here would redeliver forever against a message
    // that can never come back.
    const getMessage = vi.fn().mockRejectedValue(new Error('no message found'))
    vi.mocked(useJetStreamManager).mockReturnValue({ streams: { getMessage } } as never)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const onDeadLetter = vi.fn()
    defineDeadLetterConsumer({ stream: 'JS_ADVISORY', durable: 'dl', onDeadLetter })
    await lastConsumerOpts().handler({ ack: vi.fn() }, maxDeliver)

    expect(onDeadLetter).toHaveBeenCalledOnce()
    expect(onDeadLetter.mock.calls[0]![0].message).toBeNull()
    expect(onDeadLetter.mock.calls[0]![0].streamSeq).toBe(42)
  })

  it('leaves acking to the caller, so a failed handler is redelivered', async () => {
    vi.mocked(useJetStreamManager).mockReturnValue({
      streams: { getMessage: vi.fn().mockResolvedValue(null) },
    } as never)

    const msg = { ack: vi.fn() }
    defineDeadLetterConsumer({ stream: 'JS_ADVISORY', durable: 'dl', onDeadLetter: vi.fn() })
    await lastConsumerOpts().handler(msg, maxDeliver)

    expect(msg.ack).not.toHaveBeenCalled()
  })
})
