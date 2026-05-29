import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  useNatsHooks,
  _fireConnectError,
  _fireReconnect,
  _fireDisconnect,
  _clearNatsHooks,
} from '../../src/runtime/server/utils/useNatsHooks'

beforeEach(() => {
  _clearNatsHooks()
})

describe('useNatsHooks — onConnectError', () => {
  it('fires onConnectError with the error', () => {
    const fn = vi.fn()
    useNatsHooks({ onConnectError: fn })
    const err = new Error('connect failed')
    _fireConnectError(err)
    expect(fn).toHaveBeenCalledOnce()
    expect(fn).toHaveBeenCalledWith(err)
  })

  it('does not fire onReconnect or onDisconnect when onConnectError fires', () => {
    const reconnect = vi.fn()
    const disconnect = vi.fn()
    useNatsHooks({ onReconnect: reconnect, onDisconnect: disconnect })
    _fireConnectError(new Error('fail'))
    expect(reconnect).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('calls multiple registered onConnectError hooks in order', () => {
    const order: number[] = []
    useNatsHooks({ onConnectError: () => order.push(1) })
    useNatsHooks({ onConnectError: () => order.push(2) })
    _fireConnectError(new Error('fail'))
    expect(order).toEqual([1, 2])
  })

  it('does not throw if a hook throws', () => {
    useNatsHooks({ onConnectError: () => { throw new Error('hook error') } })
    expect(() => _fireConnectError(new Error('fail'))).not.toThrow()
  })
})

describe('useNatsHooks — onReconnect', () => {
  it('fires onReconnect with the server address', () => {
    const fn = vi.fn()
    useNatsHooks({ onReconnect: fn })
    _fireReconnect('nats://localhost:4222')
    expect(fn).toHaveBeenCalledOnce()
    expect(fn).toHaveBeenCalledWith('nats://localhost:4222')
  })

  it('does not throw if a hook throws', () => {
    useNatsHooks({ onReconnect: () => { throw new Error('hook error') } })
    expect(() => _fireReconnect('nats://localhost:4222')).not.toThrow()
  })
})

describe('useNatsHooks — onDisconnect', () => {
  it('fires onDisconnect with the server address', () => {
    const fn = vi.fn()
    useNatsHooks({ onDisconnect: fn })
    _fireDisconnect('nats://localhost:4222')
    expect(fn).toHaveBeenCalledOnce()
    expect(fn).toHaveBeenCalledWith('nats://localhost:4222')
  })

  it('does not throw if a hook throws', () => {
    useNatsHooks({ onDisconnect: () => { throw new Error('hook error') } })
    expect(() => _fireDisconnect('nats://localhost:4222')).not.toThrow()
  })
})

describe('useNatsHooks — _clearNatsHooks', () => {
  it('clears all registered hooks', () => {
    const fn = vi.fn()
    useNatsHooks({ onConnectError: fn, onReconnect: fn, onDisconnect: fn })
    _clearNatsHooks()
    _fireConnectError(new Error('x'))
    _fireReconnect('x')
    _fireDisconnect('x')
    expect(fn).not.toHaveBeenCalled()
  })
})
