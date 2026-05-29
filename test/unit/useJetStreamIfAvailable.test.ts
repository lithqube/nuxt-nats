import { describe, it, expect, afterEach } from 'vitest'
import {
  setNatsConnection,
  setJetStream,
  setJetStreamManager,
  getNatsConnection,
  getJetStream,
  getJetStreamManager,
  _setConnectionForTesting,
} from '../../src/runtime/server/plugins/_connection'
import { useJetStream, useJetStreamManager, useJetStreamIfAvailable } from '../../src/runtime/server/utils/useJetStream'

afterEach(() => {
  setNatsConnection(undefined)
  setJetStream(undefined)
  setJetStreamManager(undefined)
})

describe('_connection singletons', () => {
  it('set/get round-trips for NatsConnection', () => {
    const fake = { protocol: 'nats' } as any
    setNatsConnection(fake)
    expect(getNatsConnection()).toBe(fake)
    setNatsConnection(undefined)
    expect(getNatsConnection()).toBeUndefined()
  })

  it('set/get round-trips for JetStreamClient', () => {
    const fake = { consumers: {} } as any
    setJetStream(fake)
    expect(getJetStream()).toBe(fake)
    setJetStream(undefined)
    expect(getJetStream()).toBeUndefined()
  })

  it('set/get round-trips for JetStreamManager', () => {
    const fake = { streams: {} } as any
    setJetStreamManager(fake)
    expect(getJetStreamManager()).toBe(fake)
    setJetStreamManager(undefined)
    expect(getJetStreamManager()).toBeUndefined()
  })

  it('_setConnectionForTesting injects all three singletons at once', () => {
    const nc = { protocol: 'nats' } as any
    const js = { consumers: {} } as any
    const jsm = { streams: {} } as any
    _setConnectionForTesting(nc, js, jsm)
    expect(getNatsConnection()).toBe(nc)
    expect(getJetStream()).toBe(js)
    expect(getJetStreamManager()).toBe(jsm)
  })
})

describe('useJetStreamIfAvailable', () => {
  it('returns null when JetStream is not initialised', () => {
    expect(useJetStreamIfAvailable()).toBeNull()
  })

  it('returns the JetStream client when available', () => {
    const fakeJs = { consumers: {} } as any
    setJetStream(fakeJs)
    expect(useJetStreamIfAvailable()).toBe(fakeJs)
  })
})

describe('useJetStream', () => {
  it('throws when JetStream is not initialised', () => {
    expect(() => useJetStream()).toThrow('[nuxt-nats]')
  })

  it('returns the JetStream client when available', () => {
    const fakeJs = { consumers: {} } as any
    setJetStream(fakeJs)
    expect(useJetStream()).toBe(fakeJs)
  })
})

describe('useJetStreamManager', () => {
  it('throws when JetStream manager is not initialised', () => {
    expect(() => useJetStreamManager()).toThrow('[nuxt-nats]')
  })

  it('returns the JetStream manager when available', () => {
    const fakeJsm = { streams: {} } as any
    setJetStreamManager(fakeJsm)
    expect(useJetStreamManager()).toBe(fakeJsm)
  })
})
