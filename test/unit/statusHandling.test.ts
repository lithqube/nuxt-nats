import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The plugin module imports nitropack/runtime at load time, which is not resolvable
// outside a Nitro build. Only handleStatus is under test here, so stub the two symbols
// the module body needs.
vi.mock('nitropack/runtime', () => ({
  defineNitroPlugin: (fn: unknown) => fn,
  useRuntimeConfig: () => ({ nats: {} }),
}))

const { handleStatus, _resetStatusStateForTests } = await import('../../src/runtime/server/plugins/nats')
const { useNatsHooks, _clearNatsHooks } = await import('../../src/runtime/server/utils/useNatsHooks')

/**
 * nats.js#423: the client emits a `reconnect` status per RETRY ATTEMPT rather than per
 * actual recovery. One reported outage produced ~2400 of them. Anything wired to
 * onReconnect (cache re-warm, health flip, re-provisioning) would stampede.
 */
describe('connection status handling', () => {
  beforeEach(() => {
    _clearNatsHooks?.()
    _resetStatusStateForTests()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fires onReconnect once per outage, not once per retry attempt', () => {
    const onReconnect = vi.fn()
    useNatsHooks({ onReconnect })

    handleStatus({ type: 'disconnect', server: 'nats://a:4222' } as never)
    // The retry storm.
    for (let i = 0; i < 50; i++) {
      handleStatus({ type: 'reconnect', server: 'nats://a:4222' } as never)
    }

    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('fires again after a genuine second outage', () => {
    const onReconnect = vi.fn()
    useNatsHooks({ onReconnect })

    handleStatus({ type: 'disconnect', server: 's' } as never)
    handleStatus({ type: 'reconnect', server: 's' } as never)
    handleStatus({ type: 'disconnect', server: 's' } as never)
    handleStatus({ type: 'reconnect', server: 's' } as never)

    expect(onReconnect).toHaveBeenCalledTimes(2)
  })

  it('ignores a reconnect that was never preceded by a disconnect', () => {
    const onReconnect = vi.fn()
    useNatsHooks({ onReconnect })

    handleStatus({ type: 'reconnect', server: 's' } as never)

    expect(onReconnect).not.toHaveBeenCalled()
  })

  it('still fires onDisconnect on every disconnect', () => {
    const onDisconnect = vi.fn()
    useNatsHooks({ onDisconnect })

    handleStatus({ type: 'disconnect', server: 's' } as never)
    handleStatus({ type: 'reconnect', server: 's' } as never)
    handleStatus({ type: 'disconnect', server: 's' } as never)

    expect(onDisconnect).toHaveBeenCalledTimes(2)
  })
})
