import { describe, it, expect, vi, afterEach } from 'vitest'
import { validateJwt } from '../../src/runtime/server/utils/validateJwt'

afterEach(() => { vi.restoreAllMocks() })

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.fake-signature`
}

describe('validateJwt — empty / missing input', () => {
  it('does not log when jwt is empty', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    validateJwt('')

    expect(errSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('validateJwt — malformed structure', () => {
  it('logs error containing "malformed" when jwt has 1 part', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    validateJwt('onlyonepart')

    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('malformed'))
  })

  it('logs error containing "malformed" when jwt has 2 parts', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    validateJwt('header.payload')

    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('malformed'))
  })

  it('logs error containing "malformed" when jwt has 4 parts', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    validateJwt('a.b.c.d')

    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('malformed'))
  })
})

describe('validateJwt — exp claim checks', () => {
  it('logs no warning when exp is more than 24h in the future', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const jwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 86400 * 7 })
    validateJwt(jwt)

    expect(errSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('logs warning containing "expires in" when exp is less than 24h away', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const jwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 * 5 })
    validateJwt(jwt)

    expect(errSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('expires in'))
  })

  it('logs error containing "EXPIRED" when exp is in the past', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const jwt = makeJwt({ exp: Math.floor(Date.now() / 1000) - 120 })
    validateJwt(jwt)

    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('EXPIRED'))
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('logs nothing when payload has no exp claim', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const jwt = makeJwt({ sub: 'alice' })
    validateJwt(jwt)

    expect(errSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('validateJwt — payload decoding', () => {
  it('logs warning containing "Could not decode" when payload is not valid base64url JSON', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const header = Buffer.from('{}').toString('base64url')
    validateJwt(`${header}.!!!not-base64-or-json!!!.sig`)

    expect(errSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not decode'))
  })
})
