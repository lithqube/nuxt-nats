import { describe, it, expect } from 'vitest'
import { generateConsumerPlugin } from '../../src/consumerTemplate'
import type { ConsumerDefinition } from '../../src/module'

const opts = {
  consumerUtilPath: '/mod/runtime/server/utils/consumer',
  resolveHandler: (h: string) => (h.startsWith('/') ? h : `/app/server/${h}`),
}

function gen(consumers: ConsumerDefinition[]) {
  return generateConsumerPlugin(consumers, opts)
}

describe('generateConsumerPlugin', () => {
  it('statically imports each handler and registers it', () => {
    const src = gen([
      { stream: 'ORDERS', durable: 'billing', handler: 'workers/billing' },
      { stream: 'ORDERS', durable: 'shipping', handler: 'workers/shipping' },
    ])

    // Static imports are the point: a runtime require() cannot survive Nitro bundling,
    // which is why this option used to do nothing.
    expect(src).toContain(`import handler_0 from '/app/server/workers/billing'`)
    expect(src).toContain(`import handler_1 from '/app/server/workers/shipping'`)
    expect(src).toContain(`import { defineNatsConsumer } from '/mod/runtime/server/utils/consumer'`)
    expect(src).toContain(`durable: 'billing'`)
    expect(src).toContain(`handler: handler_0`)
    expect(src).toContain(`handler: handler_1`)
    expect(src).toContain('defineNitroPlugin')
  })

  it('passes an absolute handler path through unchanged', () => {
    const src = gen([{ stream: 'S', durable: 'd', handler: '/elsewhere/handler.ts' }])
    expect(src).toContain(`import handler_0 from '/elsewhere/handler.ts'`)
  })

  it('emits only the optional fields that were set', () => {
    const src = gen([{ stream: 'S', durable: 'd', handler: 'h' }])
    expect(src).not.toContain('ackWait')
    expect(src).not.toContain('maxDeliver')
    expect(src).not.toContain('deadLetterSubject')
    expect(src).not.toContain('filterSubjects')
    expect(src).not.toContain('provision')
  })

  it('emits every optional field when set', () => {
    const src = gen([{
      stream: 'S',
      durable: 'd',
      handler: 'h',
      filterSubjects: ['a.b', 'c.d'],
      ackPolicy: 'explicit',
      ackWait: 30_000,
      maxDeliver: 5,
      backoff: [1000, 5000],
      deadLetterSubject: 'dlq.s',
      provision: 'startup',
    }])
    expect(src).toContain(`filterSubjects: ['a.b', 'c.d']`)
    expect(src).toContain(`ackPolicy: 'explicit'`)
    expect(src).toContain('ackWait: 30000')
    expect(src).toContain('maxDeliver: 5')
    expect(src).toContain('backoff: [1000, 5000]')
    expect(src).toContain(`deadLetterSubject: 'dlq.s'`)
    expect(src).toContain(`provision: 'startup'`)
  })

  it('emits ackWait 0 rather than dropping it as falsy', () => {
    const src = gen([{ stream: 'S', durable: 'd', handler: 'h', ackWait: 0, maxDeliver: 0 }])
    expect(src).toContain('ackWait: 0')
    expect(src).toContain('maxDeliver: 0')
  })

  describe('refuses to generate something broken', () => {
    it('throws when handler is missing', () => {
      expect(() => gen([{ stream: 'S', durable: 'd' }]))
        .toThrow(/missing "handler"/)
    })

    it('throws when stream is missing', () => {
      expect(() => gen([{ stream: '', durable: 'd', handler: 'h' }]))
        .toThrow(/missing "stream"/)
    })

    it('throws when durable is missing', () => {
      expect(() => gen([{ stream: 'S', durable: '', handler: 'h' }]))
        .toThrow(/missing "durable"/)
    })

    it('throws on two consumers bound to the same durable', () => {
      expect(() => gen([
        { stream: 'S', durable: 'd', handler: 'a' },
        { stream: 'S', durable: 'd', handler: 'b' },
      ])).toThrow(/Duplicate consumer/)
    })

    it('allows the same durable name on different streams', () => {
      expect(() => gen([
        { stream: 'A', durable: 'd', handler: 'a' },
        { stream: 'B', durable: 'd', handler: 'b' },
      ])).not.toThrow()
    })

    // These values are interpolated into single-quoted string literals in generated
    // source. Without a guard, a quote in a subject name would produce a plugin that
    // fails to parse, or worse, executes something unintended.
    it.each([
      ['stream', { stream: 'S\'; evil()//', durable: 'd', handler: 'h' }],
      ['durable', { stream: 'S', durable: 'd\'', handler: 'h' }],
      ['deadLetterSubject', { stream: 'S', durable: 'd', handler: 'h', deadLetterSubject: 'x\'' }],
      ['filterSubjects', { stream: 'S', durable: 'd', handler: 'h', filterSubjects: ['a\''] }],
    ])('throws on a quote in %s', (_field, def) => {
      expect(() => gen([def as ConsumerDefinition])).toThrow(/unusable/)
    })

    it('throws on a backslash', () => {
      expect(() => gen([{ stream: 'S\\', durable: 'd', handler: 'h' }])).toThrow(/unusable/)
    })
  })
})
