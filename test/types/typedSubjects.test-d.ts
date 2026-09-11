import { describe, expectTypeOf, it } from 'vitest'
import type { NatsEvents as PackageNatsEvents } from 'nuxt-nats'
import type { NatsEvents as PublishNatsEvents } from '../../src/runtime/server/utils/publish'
import { jsPublish } from '../../src/runtime/server/utils/publish'

/**
 * The augmentation the docs tell users to write. It has to reach the NatsEvents that jsPublish
 * reads, which is declared in src/runtime/server/utils/publish.ts and only re-exported by the
 * package entry. Before that re-export existed, this declared a new, unrelated interface and
 * every subject stayed untyped.
 */
declare module 'nuxt-nats' {
  interface NatsEvents {
    'orders.created': { id: string, total: number }
  }
}

describe('typed subjects', () => {
  it('augmenting \'nuxt-nats\' reaches the NatsEvents jsPublish reads', () => {
    expectTypeOf<PublishNatsEvents['orders.created']>().toEqualTypeOf<{ id: string, total: number }>()
    expectTypeOf<PackageNatsEvents>().toEqualTypeOf<PublishNatsEvents>()
  })

  it('accepts a declared subject with its declared payload', () => {
    expectTypeOf(jsPublish('orders.created', { id: '1', total: 99 })).toEqualTypeOf<Promise<void>>()
  })

  it('rejects a declared subject with a payload of the wrong shape', () => {
    // @ts-expect-error -- `foo` is not in NatsEvents['orders.created'], and `total` is missing
    jsPublish('orders.created', { id: '1', foo: 'bar' })
  })

  it('does not let the untyped fallback take a declared subject', () => {
    // @ts-expect-error -- a string is valid for the fallback, but not for 'orders.created'
    jsPublish('orders.created', 'not an order')
  })

  it('accepts a subject that is not declared, with any JSON payload', () => {
    expectTypeOf(jsPublish('metrics.pageview', { path: '/home' })).toEqualTypeOf<Promise<void>>()
    expectTypeOf(jsPublish('metrics.count', 42)).toEqualTypeOf<Promise<void>>()
  })

  it('accepts a string-typed subject', () => {
    const subject = 'orders.created' as string
    expectTypeOf(jsPublish(subject, { anything: true })).toEqualTypeOf<Promise<void>>()
  })
})
