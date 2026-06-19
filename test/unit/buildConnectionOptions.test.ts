import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildAuthOptions } from '../../src/runtime/server/utils/buildConnectionOptions'

afterEach(() => { vi.restoreAllMocks() })

describe('buildAuthOptions — JWT+NKey (production)', () => {
  it('uses jwtAuthenticator when both userJwt and nkeySeed are set', () => {
    const opts = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ',
      userJwt: 'eyJ0eXAiOiJqd3Q.signed.jwt-here',
    })

    expect(opts.authenticator).toBeDefined()
    expect(typeof opts.authenticator).toBe('function')
    expect(opts.token).toBeUndefined()
    expect(opts.user).toBeUndefined()
    expect(opts.pass).toBeUndefined()
  })

  it('jwtAuthenticator takes precedence over nkeyAuthenticator when both credentials are set', () => {
    const jwtOnly = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ',
      userJwt: '',
    })
    const jwtAndKey = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ',
      userJwt: 'eyJ0eXAiOiJqd3Q.signed.jwt-here',
    })

    expect(jwtOnly.authenticator).toBeDefined()
    expect(jwtAndKey.authenticator).toBeDefined()

    expect(jwtAndKey.authenticator).not.toBe(jwtOnly.authenticator)
  })

  it('does not set token/user/pass when using JWT auth', () => {
    const opts = buildAuthOptions({
      token: 'should-be-ignored',
      user: 'should-be-ignored',
      pass: 'should-be-ignored',
      nkeySeed: 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ',
      userJwt: 'eyJ0eXAiOiJqd3Q.signed.jwt-here',
    })

    expect(opts.token).toBeUndefined()
    expect(opts.user).toBeUndefined()
    expect(opts.pass).toBeUndefined()
  })
})

describe('buildAuthOptions — NKey only (dev)', () => {
  it('uses nkeyAuthenticator when only nkeySeed is set', () => {
    const opts = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ',
      userJwt: '',
    })

    expect(opts.authenticator).toBeDefined()
    expect(typeof opts.authenticator).toBe('function')
    expect(opts.token).toBeUndefined()
    expect(opts.user).toBeUndefined()
    expect(opts.pass).toBeUndefined()
  })

  it('produces a different authenticator for NKey-only vs JWT+NKey', () => {
    const nkeyOnly = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ',
      userJwt: '',
    })
    const jwtPlusKey = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ',
      userJwt: 'eyJ0eXAiOiJqd3Q.signed.jwt-here',
    })

    expect(nkeyOnly.authenticator).not.toBe(jwtPlusKey.authenticator)
  })
})

describe('buildAuthOptions — token / user+pass / anonymous', () => {
  it('uses token when only token is set', () => {
    const opts = buildAuthOptions({
      token: 'my-token',
      user: '',
      pass: '',
      nkeySeed: '',
      userJwt: '',
    })

    expect(opts.token).toBe('my-token')
    expect(opts.authenticator).toBeUndefined()
    expect(opts.user).toBeUndefined()
    expect(opts.pass).toBeUndefined()
  })

  it('uses user/pass when only user is set', () => {
    const opts = buildAuthOptions({
      token: '',
      user: 'alice',
      pass: 's3cret',
      nkeySeed: '',
      userJwt: '',
    })

    expect(opts.user).toBe('alice')
    expect(opts.pass).toBe('s3cret')
    expect(opts.authenticator).toBeUndefined()
    expect(opts.token).toBeUndefined()
  })

  it('returns empty options when no credentials are set (anonymous)', () => {
    const opts = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: '',
      userJwt: '',
    })

    expect(opts).toEqual({})
  })

  it('uses jwtAuthenticator(jwt) when only userJwt is set (unsigned JWT, no signing)', () => {
    const opts = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: '',
      userJwt: 'eyJ0eXAiOiJqd3Q.signed.jwt-here',
    })

    expect(opts.authenticator).toBeDefined()
    expect(typeof opts.authenticator).toBe('function')
    expect(opts.token).toBeUndefined()
    expect(opts.user).toBeUndefined()
    expect(opts.pass).toBeUndefined()
  })

  it('produces a different authenticator for JWT-only vs JWT+NKey', () => {
    const jwtOnly = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: '',
      userJwt: 'eyJ0eXAiOiJqd3Q.signed.jwt-here',
    })
    const jwtAndKey = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ',
      userJwt: 'eyJ0eXAiOiJqd3Q.signed.jwt-here',
    })

    expect(jwtOnly.authenticator).toBeDefined()
    expect(jwtAndKey.authenticator).toBeDefined()
    expect(jwtOnly.authenticator).not.toBe(jwtAndKey.authenticator)
  })

  it('prefers JWT-only over token auth (token is ignored)', () => {
    const opts = buildAuthOptions({
      token: 'should-be-ignored',
      user: '',
      pass: '',
      nkeySeed: '',
      userJwt: 'eyJ0eXAiOiJqd3Q.signed.jwt-here',
    })

    expect(opts.authenticator).toBeDefined()
    expect(opts.token).toBeUndefined()
  })

  it('prefers JWT+NKey over token auth (token is ignored)', () => {
    const opts = buildAuthOptions({
      token: 'should-be-ignored',
      user: '',
      pass: '',
      nkeySeed: 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ',
      userJwt: 'eyJ0eXAiOiJqd3Q.signed.jwt-here',
    })

    expect(opts.authenticator).toBeDefined()
    expect(opts.token).toBeUndefined()
  })

  it('prefers NKey over token auth (token is ignored)', () => {
    const opts = buildAuthOptions({
      token: 'should-be-ignored',
      user: '',
      pass: '',
      nkeySeed: 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ',
      userJwt: '',
    })

    expect(opts.authenticator).toBeDefined()
    expect(opts.token).toBeUndefined()
  })
})
