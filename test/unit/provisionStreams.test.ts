import { describe, it, expect, vi, afterEach } from 'vitest'
import { JetStreamApiError } from '@nats-io/jetstream'
import { provisionStreams } from '../../src/runtime/server/utils/provisionStreams'
import type { StreamDefinition } from '../../src/runtime/server/utils/provisionStreams'

function makeStreamExistsError() {
  // JetStreamApiError takes an api_error object; err_code 10058 = stream name in use
  return new JetStreamApiError({ code: 500, description: 'stream name already in use with a different configuration', err_code: 10058 })
}

function makeJsm(overrides: {
  addResult?: 'ok' | 'exists' | 'other-error'
  updateResult?: 'ok' | 'error'
} = {}) {
  const add = vi.fn().mockImplementation(async () => {
    if (overrides.addResult === 'exists') {
      throw makeStreamExistsError()
    }
    if (overrides.addResult === 'other-error') {
      throw new Error('unexpected NATS error')
    }
  })

  const update = vi.fn().mockImplementation(async () => {
    if (overrides.updateResult === 'error') {
      throw new Error('update failed')
    }
  })

  return {
    streams: { add, update },
    _add: add,
    _update: update,
  }
}

// Restore all console spies after each test — prevents leaking mocks if a test throws
afterEach(() => { vi.restoreAllMocks() })

const baseDef: StreamDefinition = {
  name: 'DOCUMENTS',
  subjects: ['tenant.*.assessment.>'],
  storage: 'memory',
  replicas: 1,
}

describe('provisionStreams — provision: never / missing', () => {
  it('skips streams with provision: never', async () => {
    const jsm = makeJsm()
    await provisionStreams(jsm as any, [{ ...baseDef, provision: 'never' }])
    expect(jsm._add).not.toHaveBeenCalled()
  })

  it('skips streams with no provision field (default never)', async () => {
    const jsm = makeJsm()
    await provisionStreams(jsm as any, [{ ...baseDef }])
    expect(jsm._add).not.toHaveBeenCalled()
  })

  it('processes multiple streams and only runs startup/update ones', async () => {
    const jsm = makeJsm()
    await provisionStreams(jsm as any, [
      { ...baseDef, name: 'A', provision: 'never' },
      { ...baseDef, name: 'B', provision: 'startup' },
      { ...baseDef, name: 'C' },
      { ...baseDef, name: 'D', provision: 'update' },
    ])
    expect(jsm._add).toHaveBeenCalledTimes(2)
    expect(jsm._add.mock.calls[0][0].name).toBe('B')
    expect(jsm._add.mock.calls[1][0].name).toBe('D')
  })
})

describe('provisionStreams — provision: startup', () => {
  it('calls jsm.streams.add with correct config', async () => {
    const jsm = makeJsm()
    await provisionStreams(jsm as any, [{ ...baseDef, provision: 'startup' }])
    expect(jsm._add).toHaveBeenCalledOnce()
    expect(jsm._add.mock.calls[0][0]).toMatchObject({
      name: 'DOCUMENTS',
      subjects: ['tenant.*.assessment.>'],
      storage: 'memory',
      num_replicas: 1,
    })
  })

  it('maps retention: workqueue correctly', async () => {
    const jsm = makeJsm()
    await provisionStreams(jsm as any, [{ ...baseDef, provision: 'startup', retention: 'workqueue' }])
    expect(jsm._add.mock.calls[0][0].retention).toBe('workqueue')
  })

  it('maps retention: interest correctly', async () => {
    const jsm = makeJsm()
    await provisionStreams(jsm as any, [{ ...baseDef, provision: 'startup', retention: 'interest' }])
    expect(jsm._add.mock.calls[0][0].retention).toBe('interest')
  })

  it('defaults retention to limits for unknown values', async () => {
    const jsm = makeJsm()
    await provisionStreams(jsm as any, [{ ...baseDef, provision: 'startup', retention: 'bogus' }])
    expect(jsm._add.mock.calls[0][0].retention).toBe('limits')
  })

  it('sets max_age from duration string', async () => {
    const jsm = makeJsm()
    await provisionStreams(jsm as any, [{ ...baseDef, provision: 'startup', maxAge: '1h' }])
    expect(jsm._add.mock.calls[0][0].max_age).toBe(3_600_000_000_000)
  })

  it('sets duplicate_window from duration string', async () => {
    const jsm = makeJsm()
    await provisionStreams(jsm as any, [{ ...baseDef, provision: 'startup', duplicateWindow: '5m' }])
    expect(jsm._add.mock.calls[0][0].duplicate_window).toBe(300_000_000_000)
  })

  it('warns and does NOT call update when stream already exists (err_code 10058)', async () => {
    const jsm = makeJsm({ addResult: 'exists' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await provisionStreams(jsm as any, [{ ...baseDef, provision: 'startup' }])
    expect(jsm._update).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already exists'))
  })

  it('logs error for non-10058 failures', async () => {
    const jsm = makeJsm({ addResult: 'other-error' })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await provisionStreams(jsm as any, [{ ...baseDef, provision: 'startup' }])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Failed to provision'), expect.any(Error))
  })
})

describe('provisionStreams — provision: update', () => {
  it('calls jsm.streams.add first (stream does not exist)', async () => {
    const jsm = makeJsm()
    await provisionStreams(jsm as any, [{ ...baseDef, provision: 'update' }])
    expect(jsm._add).toHaveBeenCalledOnce()
    expect(jsm._update).not.toHaveBeenCalled()
  })

  it('calls jsm.streams.update when stream already exists (err_code 10058)', async () => {
    const jsm = makeJsm({ addResult: 'exists' })
    await provisionStreams(jsm as any, [{ ...baseDef, provision: 'update' }])
    expect(jsm._update).toHaveBeenCalledOnce()
    expect(jsm._update.mock.calls[0][0]).toBe('DOCUMENTS')
    expect(jsm._update.mock.calls[0][1]).toMatchObject({
      name: 'DOCUMENTS',
      subjects: ['tenant.*.assessment.>'],
    })
  })

  it('does NOT warn when updating an existing stream', async () => {
    const jsm = makeJsm({ addResult: 'exists' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await provisionStreams(jsm as any, [{ ...baseDef, provision: 'update' }])
    expect(warn).not.toHaveBeenCalled()
  })

  it('logs error when update itself fails', async () => {
    const jsm = makeJsm({ addResult: 'exists', updateResult: 'error' })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await provisionStreams(jsm as any, [{ ...baseDef, provision: 'update' }])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Failed to update'), expect.any(Error))
  })

  it('logs error for non-10058 add failures even in update mode', async () => {
    const jsm = makeJsm({ addResult: 'other-error' })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await provisionStreams(jsm as any, [{ ...baseDef, provision: 'update' }])
    expect(jsm._update).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Failed to provision'), expect.any(Error))
  })
})
