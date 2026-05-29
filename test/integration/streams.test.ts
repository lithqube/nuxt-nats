import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { startNats, stopNats, type NatsTestContext } from './setup'
import { parseDuration } from '../../src/runtime/server/utils/parseDuration'
import { provisionStreams } from '../../src/runtime/server/utils/provisionStreams'

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

describe('provisionStreams — provision: startup', () => {
  it('creates a new stream that does not exist yet', async () => {
    await provisionStreams(ctx.jsm, [{
      name: 'PROV_STARTUP_NEW',
      subjects: ['prov.startup.new.>'],
      storage: 'memory',
      provision: 'startup',
    }])

    const info = await ctx.jsm.streams.info('PROV_STARTUP_NEW')
    expect(info.config.name).toBe('PROV_STARTUP_NEW')
    expect(info.config.subjects).toContain('prov.startup.new.>')
  })

  it('warns and leaves the existing stream unchanged when subjects differ', async () => {
    await ctx.jsm.streams.add({
      name: 'PROV_STARTUP_EXISTS',
      subjects: ['prov.startup.exists.original.>'],
      storage: 'memory',
    } as any)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await provisionStreams(ctx.jsm, [{
      name: 'PROV_STARTUP_EXISTS',
      subjects: ['prov.startup.exists.changed.>'],
      storage: 'memory',
      provision: 'startup',
    }])

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already exists'))

    // Stream subjects must be unchanged
    const info = await ctx.jsm.streams.info('PROV_STARTUP_EXISTS')
    expect(info.config.subjects).toContain('prov.startup.exists.original.>')
    expect(info.config.subjects).not.toContain('prov.startup.exists.changed.>')

    warn.mockRestore()
  })

  it('skips streams with provision: never', async () => {
    await provisionStreams(ctx.jsm, [{
      name: 'PROV_NEVER',
      subjects: ['prov.never.>'],
      storage: 'memory',
      provision: 'never',
    }])

    await expect(ctx.jsm.streams.info('PROV_NEVER')).rejects.toThrow()
  })
})

describe('provisionStreams — provision: update', () => {
  it('creates the stream when it does not exist yet', async () => {
    await provisionStreams(ctx.jsm, [{
      name: 'PROV_UPDATE_NEW',
      subjects: ['prov.update.new.>'],
      storage: 'memory',
      provision: 'update',
    }])

    const info = await ctx.jsm.streams.info('PROV_UPDATE_NEW')
    expect(info.config.name).toBe('PROV_UPDATE_NEW')
    expect(info.config.subjects).toContain('prov.update.new.>')
  })

  it('updates an existing stream to add new subjects', async () => {
    await ctx.jsm.streams.add({
      name: 'PROV_UPDATE_EXISTS',
      subjects: ['prov.update.exists.original.>'],
      storage: 'memory',
    } as any)

    await provisionStreams(ctx.jsm, [{
      name: 'PROV_UPDATE_EXISTS',
      subjects: ['prov.update.exists.original.>', 'prov.update.exists.added.>'],
      storage: 'memory',
      provision: 'update',
    }])

    const info = await ctx.jsm.streams.info('PROV_UPDATE_EXISTS')
    expect(info.config.subjects).toContain('prov.update.exists.original.>')
    expect(info.config.subjects).toContain('prov.update.exists.added.>')
  })

  it('does not warn when updating an existing stream', async () => {
    await ctx.jsm.streams.add({
      name: 'PROV_UPDATE_QUIET',
      subjects: ['prov.update.quiet.old.>'],
      storage: 'memory',
    } as any)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await provisionStreams(ctx.jsm, [{
      name: 'PROV_UPDATE_QUIET',
      subjects: ['prov.update.quiet.old.>', 'prov.update.quiet.new.>'],
      storage: 'memory',
      provision: 'update',
    }])

    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
