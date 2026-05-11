import { describe, it, expect } from 'vitest'
import { parseDuration } from '../../src/runtime/server/utils/parseDuration'

describe('parseDuration', () => {
  it('parses nanoseconds', () => {
    expect(parseDuration('1ns')).toBe(1)
    expect(parseDuration('500ns')).toBe(500)
  })

  it('parses microseconds', () => {
    expect(parseDuration('1us')).toBe(1_000)
    expect(parseDuration('100us')).toBe(100_000)
  })

  it('parses milliseconds', () => {
    expect(parseDuration('1ms')).toBe(1_000_000)
    expect(parseDuration('500ms')).toBe(500_000_000)
  })

  it('parses seconds', () => {
    expect(parseDuration('1s')).toBe(1_000_000_000)
    expect(parseDuration('30s')).toBe(30_000_000_000)
  })

  it('parses minutes', () => {
    expect(parseDuration('1m')).toBe(60_000_000_000)
    expect(parseDuration('5m')).toBe(300_000_000_000)
  })

  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000_000_000)
    expect(parseDuration('24h')).toBe(86_400_000_000_000)
  })

  it('parses days', () => {
    expect(parseDuration('1d')).toBe(86_400_000_000_000)
    expect(parseDuration('7d')).toBe(604_800_000_000_000)
  })

  it('parses decimal values', () => {
    expect(parseDuration('1.5h')).toBe(5_400_000_000_000)
    expect(parseDuration('0.5m')).toBe(30_000_000_000)
  })

  it('throws on invalid format', () => {
    expect(() => parseDuration('1hour')).toThrow('Invalid duration')
    expect(() => parseDuration('5')).toThrow('Invalid duration')
    expect(() => parseDuration('abc')).toThrow('Invalid duration')
    expect(() => parseDuration('')).toThrow('Invalid duration')
    expect(() => parseDuration('1w')).toThrow('Invalid duration')
  })
})
