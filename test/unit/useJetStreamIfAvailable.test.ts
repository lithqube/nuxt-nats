import { describe, it, expect, vi, afterEach } from 'vitest'
import { _setConnectionForTesting } from '../../src/runtime/server/plugins/_connection'
import { setJetStream } from '../../src/runtime/server/plugins/_connection'
import { useJetStream, useJetStreamIfAvailable } from '../../src/runtime/server/utils/useJetStream'

afterEach(() => {
  setJetStream(undefined)
})

describe('useJetStreamIfAvailable', () => {
  it('returns null when JetStream is not initialised', () => {
    setJetStream(undefined)
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
    setJetStream(undefined)
    expect(() => useJetStream()).toThrow('[nuxt-nats]')
  })

  it('returns the JetStream client when available', () => {
    const fakeJs = { consumers: {} } as any
    setJetStream(fakeJs)
    expect(useJetStream()).toBe(fakeJs)
  })
})
