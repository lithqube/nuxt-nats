import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startNats, stopNats, type NatsTestContext } from './setup'
import { parseDuration } from '../../src/runtime/server/utils/parseDuration'

let ctx: NatsTestContext

beforeAll(async () => {
  ctx = await startNats()
}, 30_000)

afterAll(async () => {
  await stopNats(ctx)
})

describe('stream provisioning', () => {
  it('creates a stream with maxAge converted from duration string', async () => {
    const maxAgeNs = parseDuration('1h')

    await ctx.jsm.streams.add({
      name: 'TEST_MAXAGE',
      subjects: ['test.maxage.>'],
      max_age: maxAgeNs,
    } as any)

    const info = await ctx.jsm.streams.info('TEST_MAXAGE')
    expect(info.config.max_age).toBe(maxAgeNs)
    expect(info.config.max_age).toBe(3_600_000_000_000)
  })

  it('creates a stream with duplicateWindow converted from duration string', async () => {
    const dupWindowNs = parseDuration('5m')

    await ctx.jsm.streams.add({
      name: 'TEST_DUPWINDOW',
      subjects: ['test.dupwindow.>'],
      duplicate_window: dupWindowNs,
    } as any)

    const info = await ctx.jsm.streams.info('TEST_DUPWINDOW')
    expect(info.config.duplicate_window).toBe(dupWindowNs)
    expect(info.config.duplicate_window).toBe(300_000_000_000)
  })

  it('creates a stream with 7d maxAge correctly', async () => {
    const maxAgeNs = parseDuration('7d')

    await ctx.jsm.streams.add({
      name: 'TEST_7DAY',
      subjects: ['test.7day.>'],
      max_age: maxAgeNs,
    } as any)

    const info = await ctx.jsm.streams.info('TEST_7DAY')
    expect(info.config.max_age).toBe(604_800_000_000_000)
  })

  it('creates a workqueue retention stream', async () => {
    await ctx.jsm.streams.add({
      name: 'TEST_WQ',
      subjects: ['test.wq.>'],
      retention: 'workqueue',
      storage: 'memory',
    } as any)

    const info = await ctx.jsm.streams.info('TEST_WQ')
    expect(info.config.retention).toBe('workqueue')
    expect(info.config.storage).toBe('memory')
  })
})
