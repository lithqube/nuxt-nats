import { describe, it, expect } from 'vitest'
import { normalizeServers } from '../../src/runtime/server/utils/normalizeServers'

describe('normalizeServers', () => {
  it('passes through a single-element array unchanged', () => {
    expect(normalizeServers(['nats://localhost:4222'])).toEqual(['nats://localhost:4222'])
  })

  it('passes through a multi-element array unchanged', () => {
    expect(normalizeServers(['nats://a:4222', 'nats://b:4222'])).toEqual(['nats://a:4222', 'nats://b:4222'])
  })

  it('splits a comma-separated string into an array', () => {
    expect(normalizeServers('nats://a:4222,nats://b:4222,nats://c:4222')).toEqual([
      'nats://a:4222',
      'nats://b:4222',
      'nats://c:4222',
    ])
  })

  it('trims whitespace around server URLs', () => {
    expect(normalizeServers('nats://a:4222 , nats://b:4222')).toEqual([
      'nats://a:4222',
      'nats://b:4222',
    ])
  })

  it('handles a single string without commas', () => {
    expect(normalizeServers('nats://localhost:4222')).toEqual(['nats://localhost:4222'])
  })

  it('filters empty strings from trailing commas', () => {
    expect(normalizeServers('nats://a:4222,')).toEqual(['nats://a:4222'])
  })

  it('splits comma-separated values within array elements', () => {
    expect(normalizeServers(['nats://a:4222,nats://b:4222', 'nats://c:4222'])).toEqual([
      'nats://a:4222',
      'nats://b:4222',
      'nats://c:4222',
    ])
  })

  it('returns empty array for empty string', () => {
    expect(normalizeServers('')).toEqual([])
  })
})
